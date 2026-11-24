// In-between frames. The game updates and draws about 16 times a second and moves the hero, the monsters
// and the camera in whole steps. To show frames between two game frames, the page lets the game draw once
// more with those placed part of the way between their positions in the last two frames, keeps the
// picture and puts the guest state back, so the game itself never sees it.
//
// The state the game draws a field frame from is saved when PAINT_GAME_MAIN reaches DrawView (after the
// frame's updates, before its drawing). An in-between frame restores that state, moves things, replays the
// rest of PAINT_GAME_MAIN from DrawView on plus the overlays ENGINE_Render adds, and copies the frame
// buffer out. Drawn from the saved state with nothing moved, it is the game's own frame, pixel for pixel.
#include "base.h"

void heap_state(void *buf, int save);
u32 heap_state_size(void);
u32 jni_state_size(void);
void jni_state(u8 *buf, int save);
u32 guest_heap_top(void);

#define B LOAD_BASE
#define RW_START (B + 0xbb078u) // the library's writable segment (.data, .bss)
#define RW_END (B + 0x139528u)
#define HERO (B + 0xd4dc4u)     // Hero: the same 460-byte character record as each monster
#define MON (B + 0xddd28u)      // Mon[60]
#define MON_COUNT 60
#define CHAR_SIZE 460u
#define VIEW (B + 0xe6510u)     // View: camera in 16-pixel tiles + phase, and in pixels
#define PAINT_MAIN_DRAW 0x9250eu // PAINT_GAME_MAIN: the call to DrawView, where the drawing starts
#define PAINT_MAIN_LIT 0x925a8u  // its r4 at that point: the literal it adds pc to later
#define DRAW_VIEW_RET 0x92512u   // DrawView's return address when PAINT_GAME_MAIN calls it
#define FAR 32                   // a step longer than this (teleport, knockback) is not smoothed

typedef struct { s16 x[MON_COUNT + 1], y[MON_COUNT + 1]; s32 cx, cy; } Pose;

static struct {
  u8 *buf;
  u32 cap, heap_top;
  u8 heap[4096];
  int ok;
} slot[2]; // 0: the state at the start of drawing the last field frame; 1: the live state
static Pose prev, cur;
static int frames; // field frames drawn in a row (2 or more: prev and cur both hold one)
static u32 fn_is_script, fn_msgbox, fn_touch_ui, fn_touch_point;
int interp_active;


// the camera in pixels from its tile and phase, plus the scroll DrawView is about to apply: with a scroll
// pending (+0xbc) and no full redraw asked (+0xbd), RedrawLCD shifts the map by +0xcc/+0xd0 and moves the
// tile and phase on; a full redraw drops the pending scroll
static s32 cam_pixel(u32 ti, u32 ph) { return (s32)rd32(VIEW + ti) * 16 - (s32)rd32(VIEW + ph); }
static s32 cam_drawn(int y) {
  s32 v = y ? cam_pixel(0x3c, 0x04) : cam_pixel(0x38, 0x00);
  if ((s8)rd8(VIEW + 0xbc) && (s8)rd8(VIEW + 0xbd) != 1) v += (s32)rd32(VIEW + (y ? 0xd0 : 0xcc));
  return v;
}

static u8 *grow(u32 bytes) {
  int old = __builtin_wasm_memory_grow(0, (bytes + 0xffffu) >> 16);
  return old < 0 ? 0 : (u8 *)((u32)old << 16);
}

static int save(int s) {
  if (heap_state_size() > sizeof slot[s].heap) return 0;
  u32 top = guest_heap_top();
  u32 need = jni_state_size() + (RW_END - RW_START) + (DATA_END - DATA_BASE) + (top - HEAP_BASE);
  if (need > slot[s].cap) {
    u32 cap = need + (1u << 20);
    u8 *b = grow(cap);
    if (!b) return 0;
    slot[s].buf = b;
    slot[s].cap = cap;
  }
  u8 *p = slot[s].buf;
  jni_state(p, 1); p += jni_state_size();
  memcpy(p, gptr(RW_START), RW_END - RW_START); p += RW_END - RW_START;
  memcpy(p, gptr(DATA_BASE), DATA_END - DATA_BASE); p += DATA_END - DATA_BASE;
  memcpy(p, gptr(HEAP_BASE), top - HEAP_BASE);
  slot[s].heap_top = top;
  heap_state(slot[s].heap, 1);
  slot[s].ok = 1;
  return 1;
}

static void restore(int s) {
  u8 *p = slot[s].buf;
  jni_state(p, 0); p += jni_state_size();
  memcpy(gptr(RW_START), p, RW_END - RW_START); p += RW_END - RW_START;
  memcpy(gptr(DATA_BASE), p, DATA_END - DATA_BASE); p += DATA_END - DATA_BASE;
  memcpy(gptr(HEAP_BASE), p, slot[s].heap_top - HEAP_BASE);
  heap_state(slot[s].heap, 0);
}

static void read_pose(Pose *p) {
  p->x[0] = (s16)rd16(HERO + 4);
  p->y[0] = (s16)rd16(HERO + 6);
  for (u32 i = 0; i < MON_COUNT; i++) {
    p->x[i + 1] = (s16)rd16(MON + i * CHAR_SIZE + 4);
    p->y[i + 1] = (s16)rd16(MON + i * CHAR_SIZE + 6);
  }
  p->cx = cam_drawn(0);
  p->cy = cam_drawn(1);
}

// called from the fast path on DrawView's first instruction (fast.c); returns 0 so DrawView then runs
static int seen;
int interp_on_draw_view(void) {
  if (interp_active) return 0;
  if ((R[14] & ~1u) != B + DRAW_VIEW_RET) { frames = 0; return 0; }
  seen = 1;
  prev = cur;
  read_pose(&cur);
  frames = save(0) ? frames + 1 : 0;
  return 0;
}

// called from the fast path on CheckViewFX's first instruction: DrawView calls it right after
// UpdateCamera has moved the camera for this frame, which is the camera the frame is drawn with
#define CHECK_VIEW_FX_RET 0x54f48u
int interp_on_check_view_fx(void) {
  if (!interp_active && (R[14] & ~1u) == B + CHECK_VIEW_FX_RET && seen) {
    cur.cx = cam_drawn(0);
    cur.cy = cam_drawn(1);
  }
  return 0;
}

// the page calls this before (0) and after (1) every game frame: one that drew no field frame breaks the run
EXPORT(interp_tick) void interp_tick(int after) {
  if (!after) seen = 0;
  else if (!seen) frames = 0;
  // a screen shake or zoom moves the drawn view off the camera recorded for the frame: show it as it is
  else if ((s32)rd32(VIEW + 0x40) != cur.cx || (s32)rd32(VIEW + 0x44) != cur.cy) frames = 1;
}

static inline s32 lerp(s32 a, s32 b, u32 f) { return a + (s32)(((s64)(b - a) * f) >> 8); }
static inline s32 far(s32 a, s32 b) { return a - b > FAR || b - a > FAR; }

// one camera axis: tile index at +ti, phase at +ph (pixel = tile * 16 - phase, phase in -16..-1),
// pixel at +px and +px2 (the far edge, a fixed distance on)
static void set_camera_axis(u32 ti, u32 ph, u32 px, u32 px2, s32 v) {
  s32 edge = (s32)rd32(VIEW + px2) - (s32)rd32(VIEW + px);
  s32 tile = (v - 1) >> 4;
  wr32(VIEW + ti, (u32)tile);
  wr32(VIEW + ph, (u32)(tile * 16 - v));
  wr32(VIEW + px, (u32)v);
  wr32(VIEW + px2, (u32)(v + edge));
}

static int run_from(u32 pc, u32 r4) {
  u32 saved[16];
  memcpy(saved, R, sizeof saved);
  u32 ft = fT, spc = cpu_pc;
  u32 sp = (R[13] - 256) & ~7u;
  sp -= 12; // PAINT_GAME_MAIN's push {r4, r5, lr}
  wr32(sp + 8, RETURN_MAGIC);
  sp -= 0x14; // and its sub sp, #0x14
  R[13] = sp;
  R[4] = r4;
  fT = 1;
  cpu_pc = pc;
  cpu_run_until_return();
  memcpy(R, saved, sizeof saved);
  fT = ft;
  cpu_pc = cpu_halt ? cpu_pc : spc;
  return !cpu_halt;
}

// Draws the field at fraction f/256 of the way from the previous field frame to the last one into `out`
// (w x h pixels, already holding the last frame: like the game's own copy, see-through pixels keep it).
// Returns 0, or -1 when there is nothing to draw in between (menus, scripts, a jump, not set up).
EXPORT(interp_draw) int interp_draw(u32 f, u16 *out, u32 w, u32 h) {
  if (frames < 2 || f > 256 || cpu_halt) return -1;
  if (!fn_is_script) {
    fn_is_script = find_symbol("IsGameScript");
    fn_msgbox = find_symbol("MB_DrawMessageBox");
    fn_touch_ui = find_symbol("DrawTouchUI");
    fn_touch_point = find_symbol("DrawTouchPoint");
    if (!fn_is_script || !fn_msgbox || !fn_touch_ui || !fn_touch_point) return -1;
  }
  if (far(prev.cx, cur.cx) || far(prev.cy, cur.cy)) return -1;
  if (!save(1)) return -1;
  interp_active = 1;
  restore(0);
  int ok = (call_guest(fn_is_script, 0, 0) & 0xff) != 1;
  if (ok) {
    for (u32 i = 0; i <= MON_COUNT; i++) {
      if (far(prev.x[i], cur.x[i]) || far(prev.y[i], cur.y[i])) continue;
      u32 a = i ? MON + (i - 1) * CHAR_SIZE : HERO;
      wr16(a + 4, (u16)lerp(prev.x[i], cur.x[i], f));
      wr16(a + 6, (u16)lerp(prev.y[i], cur.y[i], f));
    }
    set_camera_axis(0x38, 0x00, 0x40, 0x48, lerp(prev.cx, cur.cx, f));
    set_camera_axis(0x3c, 0x04, 0x44, 0x4c, lerp(prev.cy, cur.cy, f));
    wr8(VIEW + 0xbc, 1); // redraw the whole map at this camera position
    wr8(VIEW + 0xbd, 1);
    wr32(VIEW + 0xcc, 0);
    wr32(VIEW + 0xd0, 0);
    wr32(VIEW + 0x60, 0); // and keep the camera where it is put (UpdateCamera follows nothing)
    ok = run_from(B + PAINT_MAIN_DRAW, rd32(B + PAINT_MAIN_LIT));
    if (ok) {
      call_guest(fn_msgbox, 0, 0);
      call_guest(fn_touch_ui, 0, 0);
      call_guest(fn_touch_point, 0, 0);
      ok = !cpu_halt;
    }
    if (ok) {
      u32 g = rd32(B + 0xbc820u + 0x71cu); // the drawing state (fast.c: GOT_DRAW)
      u32 src = rd32(rd32(g + 4) + 0x10), sw = rd32(g + 0x54), sh = rd32(g + 0x58);
      if (sw > w) sw = w;
      if (sh > h) sh = h;
      for (u32 y = 0; y < sh; y++)
        for (u32 x = 0; x < sw; x++) {
          u16 p = rd16(src + (y * rd32(g + 0x54) + x) * 2);
          if (p != 0x2484) out[y * w + x] = p;
        }
    }
  }
  restore(1);
  interp_active = 0;
  return ok ? 0 : -1;
}
