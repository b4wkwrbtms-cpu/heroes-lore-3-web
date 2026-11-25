// In-between frames. The game moves the camera, the hero and everything on the field in whole steps about
// 23 times a second. To show frames between two of them, a copy-on-write log (cow.c) runs from the start of
// every real CMvApp::Draw until the next one, holding the pages as they were before drawing, and the camera
// and object positions are noted there. The game draws first and then moves everything for the next frame,
// so the log has to cover that move too: motion_paint winds all of memory back to the start of the drawing
// (the hero in the pose this frame shows, not the next one), moves the camera and the objects part of the
// way from where they were the frame before, lets the game draw once more into a separate picture and puts
// every byte back, so the game itself never sees the extra frame.
#include "base.h"

u32 find_symbol(const char *name);
int aot_hook(u32 addr, void (*fn)(void));
u32 call_guest_unhooked(u32 addr, int nargs, const u32 *args);
void cow_begin(int log);
void cow_end(void);
int cow_ok(int log);
u32 cow_pages(int log);
void cow_restore(int log);
void cow_rewind(int log);
int cow_suspend(void);
void cow_resume(int log);
void heap_state(void *buf, int save);
u32 heap_state_size(void);
u32 jni_state_size(void);
void jni_state(u8 *buf, int save);
u32 fs_state_size(void);
void fs_state(u8 *buf, int save);
extern u16 *paint_out; // hle.c: glTexSubImage2D copies here instead of the screen while set

static u32 app_draw, gl_draw, map_slot, obj_var;
static u32 num_update, num_draw, num_init, alpha_begin, alpha_end, num_width;
extern u32 scr_w, scr_h;

// the routines this reads its addresses from, as they were when this was written
typedef struct { const char *name; u32 size, sig; u32 *addr; } MotionSym;
static u32 upd_screen_pos, map_draw, set_damage;
static const MotionSym msyms[] = {
    {"_ZN12CMvCharacter9SetDamageEib", 328, 0xf868ef92u, &set_damage},
    {"_ZN6CMvApp4DrawEv", 124, 0x31d7ce87u, &app_draw},
    {"_ZN9CMvObject27UpdateScreenPosFromWorldPosEv", 52, 0xf100487du, &upd_screen_pos},
    {"_ZN6CMvMap4DrawEb", 688, 0x15e42cd4u, &map_draw},
    {"_ZN15CMvNumberObject6UpdateEv", 98, 0x77942f22u, &num_update},
    {"_ZN15CMvNumberObject4DrawEv", 324, 0x5ca56624u, &num_draw},
    {"_ZN15CMvNumberObject10InitializeEv", 24, 0x8337c2fau, &num_init},
    {"_ZN11CMvGraphics10BeginAlphaEi", 22, 0x1e5666aeu, &alpha_begin},
    {"_ZN11CMvGraphics8EndAlphaEv", 34, 0x2b888343u, &alpha_end},
    {"_ZN11CMvGraphics20CalcDrawNumbersWidthEiiib", 56, 0x78ab1e04u, &num_width},
};

static int m_resolve(void) {
  for (u32 i = 0; i < sizeof msyms / sizeof msyms[0]; i++) {
    u32 a = find_symbol(msyms[i].name) & ~1u;
    if (!a) return 0;
    u32 h = 2166136261u;
    for (u32 k = 0; k < msyms[i].size; k++) h = (h ^ rd8(a + k)) * 16777619u;
    if (h != msyms[i].sig) { logf("motion: %s differs (%08x)", msyms[i].name, h); return 0; }
    *msyms[i].addr = a;
  }
  gl_draw = find_symbol("glDrawFrame");
  if (!gl_draw) return 0;
  // UpdateScreenPosFromWorldPos: ldr r3, [pc, #0x20]; add r3, pc -> the GOT slot of the map singleton
  map_slot = upd_screen_pos + 0x14 + rd32(upd_screen_pos + 0x30);
  // CMvMap::Draw: r8 = GOT (pc-relative), r5 = [r8 + k] -> the variable holding the object manager
  u32 got = map_draw + 0x14 + rd32(map_draw + 0x288);
  obj_var = rd32(got + rd32(map_draw + 0x28c));
  return 1;
}

// ---- positions
#define MAX_OBJ 1024
typedef struct { u32 obj; s16 x, y; } Pos;
typedef struct {
  u32 map, mgr, n;
  s16 cx, cy;
  Pos o[MAX_OBJ];
} Frame;
static Frame frames[2];
static int num_frac = 1024; // how far a drawing is between the last two frames (1024: the frame itself)
static int numbers_on;
static int numbers_showing(u32 mgr);
static int cur; // frames[cur] is the latest, frames[cur ^ 1] the one before

static u32 m_map(void) { u32 v = rd32(map_slot); return v ? rd32(v) : 0; }
static u32 m_mgr(void) { return obj_var ? rd32(obj_var) : 0; }

static void m_capture(void) {
  cur ^= 1;
  Frame *f = &frames[cur];
  f->map = m_map();
  f->mgr = m_mgr();
  f->n = 0;
  if (!f->map || !f->mgr) return;
  f->cx = (s16)rd16(f->map + 0x166);
  f->cy = (s16)rd16(f->map + 0x168);
  for (u32 layer = 0; layer < 5; layer++) {
    u32 arr = f->mgr + (layer + 6) * 16;
    u32 data = rd32(arr + 4);
    s32 count = (s32)rd32(arr + 8);
    if (!data || count <= 0 || count > MAX_OBJ) continue;
    for (s32 i = 0; i < count && f->n < MAX_OBJ; i++) {
      u32 o = rd32(data + 4 * (u32)i);
      if (!o) continue;
      f->o[f->n].obj = o;
      f->o[f->n].x = (s16)rd16(o + 0x36);
      f->o[f->n].y = (s16)rd16(o + 0x38);
      f->n++;
    }
  }
}

// ---- the hook on CMvApp::Draw
static u8 *pre_state, *live_state;
static u32 state_size;
static u32 app_obj;
static int drawn_ok;
static void host_state(u8 *buf, int save) {
  heap_state(buf, save);
  buf += heap_state_size();
  jni_state(buf, save);
  buf += jni_state_size();
  fs_state(buf, save);
}
static void helper_ret(void) {
  u32 lr = R[14];
  fT = lr & 1;
  cpu_pc = lr & ~1u;
}
static void m_app_draw(void) {
  u32 app = R[0];
  cow_end(); // the last frame's log
  m_capture();
  host_state(pre_state, 1);
  cow_begin(0); // kept on after drawing, until the next frame draws
  call_guest_unhooked(app_draw | 1, 1, &app);
  app_obj = app;
  drawn_ok = !cpu_halt;
  helper_ret();
}

EXPORT(motion_enable) int motion_enable(int on) {
  static int resolved;
  if (!resolved) resolved = m_resolve() ? 1 : -1;
  if (resolved < 0) return -1;
  if (!pre_state) {
    state_size = heap_state_size() + jni_state_size() + fs_state_size();
    pre_state = hmalloc(state_size);
    live_state = hmalloc(state_size);
    if (!pre_state || !live_state) return -1;
  }
  drawn_ok = 0;
  frames[0].n = frames[1].n = 0;
  frames[0].map = frames[1].map = 0;
  cow_end();
  return aot_hook(app_draw, on ? m_app_draw : 0);
}

static s16 lerp16(s16 a, s16 b, int f) { return (s16)(a + (((s32)(b - a) * f + (f >= 0 ? 512 : -512)) >> 10)); }
// a step this short is a move (a dash or a charging skill goes up to about 50 a frame); longer is a jump
static int near16(s16 a, s16 b) { s32 d = (s32)a - b; return d > -128 && d < 128; }

static const Pos *m_find(const Frame *a, u32 i, u32 obj) {
  // the lists usually keep their order, so look at the same index first
  if (i < a->n && a->o[i].obj == obj) return &a->o[i];
  for (u32 k = 0; k < a->n; k++)
    if (a->o[k].obj == obj) return &a->o[k];
  return 0;
}

// How much moved between the last two frames: 0 nothing (an in-between frame would look the same),
// 1 something, -1 nothing usable (different map, a jump, or no field on screen).
EXPORT(motion_state) int motion_state(void) {
  Frame *a = &frames[cur ^ 1], *b = &frames[cur];
  if (!drawn_ok || !cow_ok(0) || !b->map || !b->mgr || a->map != b->map || a->mgr != b->mgr) return -1;
  if (!near16(a->cx, b->cx) || !near16(a->cy, b->cy)) return -1;
  if (a->cx != b->cx || a->cy != b->cy) return 1;
  if (numbers_on && numbers_showing(b->mgr)) return 1; // damage numbers float at the screen's own pace
  for (u32 i = 0; i < b->n; i++) {
    const Pos *q = m_find(a, i, b->o[i].obj);
    if (q && (q->x != b->o[i].x || q->y != b->o[i].y) && near16(q->x, b->o[i].x) && near16(q->y, b->o[i].y)) return 1;
  }
  return 0;
}

static void m_apply(int f) {
  Frame *a = &frames[cur ^ 1], *b = &frames[cur];
  u32 map = b->map;
  s16 cx = lerp16(a->cx, b->cx, f), cy = lerp16(a->cy, b->cy, f);
  wr16(map + 0x166, (u16)cx);
  wr16(map + 0x168, (u16)cy);
  s32 tx = ((s32)cx - 47) / 48, ty = ((s32)cy - 47) / 48;
  wr8(map + 0x164, (u8)(tx < 0 ? 0 : tx));
  wr8(map + 0x165, (u8)(ty < 0 ? 0 : ty));
  wr8(map + 0x174, 1);
  for (u32 i = 0; i < b->n; i++) {
    const Pos *p = &b->o[i], *q = m_find(a, i, p->obj);
    if (!q || !near16(q->x, p->x) || !near16(q->y, p->y)) continue;
    if (q->x == p->x && q->y == p->y) continue;
    wr16(p->obj + 0x36, (u16)lerp16(q->x, p->x, f));
    wr16(p->obj + 0x38, (u16)lerp16(q->y, p->y, f));
  }
}

// Draws the frame `f`/1024 of the way from the frame before the last one to the last one, RGB565, into
// out (the size of the screen). 0 when drawn; the game's state is as it was either way.
EXPORT(motion_paint) int motion_paint(int f, u16 *out) {
  if (motion_state() < 0 || !app_obj || cpu_halt) return -1;
  host_state(live_state, 1);
  int kept = cow_suspend();
  cow_begin(1);
  cow_rewind(0);
  host_state(pre_state, 0);
  m_apply(f);
  num_frac = f;
  paint_out = out;
  u32 app = app_obj;
  call_guest_unhooked(app_draw | 1, 1, &app);
  if (!cpu_halt) call_guest(gl_draw, 0, 0);
  paint_out = 0;
  num_frac = 1024;
  cow_end();
  int ok = cow_ok(1) && !cpu_halt;
  cow_restore(1);
  host_state(live_state, 0);
  if (kept >= 0) cow_resume(kept);
  if (cpu_halt) { // the extra drawing went wrong: everything is back as it was, stop making them
    logf("motion: in-between frame failed, turned off");
    cpu_halt = 0;
    aot_hook(app_draw, 0);
    cow_end();
    drawn_ok = 0;
  }
  return ok ? 0 : -1;
}

// The camera of the last frame (which 0) or the one before (1), as x << 16 | y, for the page's effects.
EXPORT(motion_cam) u32 motion_cam(int which) {
  Frame *f = &frames[cur ^ (which & 1)];
  return f->map ? ((u32)(u16)f->cx << 16) | (u16)f->cy : 0;
}

// Hit feedback: CMvCharacter::SetDamage(damage, critical) tells the page where a blow landed (event 10:
// map position x | y << 16, damage, 1 critical | 2 the hero was hit), then does what it always does.
static void m_set_damage(void) {
  u32 ch = R[0], dmg = R[1], crit = R[2] & 0xff;
  if ((s32)dmg > 0 && ch) {
    u32 xy = (u32)(u16)rd16(ch + 0x36) | ((u32)rd16(ch + 0x38) << 16);
    host_event(10, (int)xy, (int)dmg, (int)((crit ? 1 : 0) | (rd8(ch + 4) == 0 ? 2 : 0)));
  }
  u32 a[3] = {R[0], R[1], R[2]};
  u32 r = call_guest_unhooked(set_damage | 1, 3, a);
  R[0] = r;
  helper_ret();
}
// Damage numbers (CMvNumberObject, 30 of them from the object manager's +0xc8): the game shows one 9 frames
// (0.4 s), rising in 8-pixel jumps every other frame, and drops it at the end at full strength, so it seems
// to blink away. Instead it stays 15 frames (0.65 s), rises 30 pixels easing out over the first 8 and fades
// out over the last 6, worked out for the moment drawn (in-between frames too), so it moves at the
// screen's pace. The game's own pop on the first frames (bigger, then settling) stays as it is.
#define NUM_LIFE 15
#define NUM_RISE 30
#define NUM_RISE_T 8
#define NUM_FADE 6
static int numbers_showing(u32 mgr) {
  if (!mgr || !num_update) return 0;
  for (u32 o = mgr + 0xc8; o < mgr + 0x320; o += 0x14)
    if ((s8)rd8(o + 0xc) >= 0) return 1;
  return 0;
}
// how far it has risen at t/1024 frames
static s32 num_rise(s32 t) {
  const s64 span = NUM_RISE_T * 1024;
  s64 left = span - (t < 0 ? 0 : t > span ? span : t);
  return (s32)(NUM_RISE - NUM_RISE * left * left / (span * span));
}
// CMvNumberObject::Update: one frame older; y is where it has risen to at this frame
static void m_num_update(void) {
  u32 o = R[0];
  if ((s8)rd8(o + 0xc) >= 0) {
    u32 e = rd8(o + 0xe);
    if (!e) wr8(o + 0xf, NUM_LIFE);
    s32 dy = num_rise((s32)(e + 1) * 1024) - num_rise((s32)e * 1024);
    wr16(o + 6, (u16)((s32)(s16)rd16(o + 6) - dy));
    wr8(o + 0xe, (u8)++e);
    if (e >= rd8(o + 0xf)) call_guest_unhooked(num_init | 1, 1, &o);
  }
  helper_ret();
}
// CMvNumberObject::Draw puts a number's top left at its point less (digits + 1) * 2.5 plus half its width,
// across and up alike: a long number (a big blow) is drawn far above its target, off the top of the screen.
// It is put back as high as a three-digit one goes, and kept on the screen (below the bar at the top).
static s32 num_offset(u32 o, s32 v, s32 *width) {
  u32 gfx = rd32(rd32(num_draw + 0x78 + rd32(num_draw + 0x13c))); // the CMvGraphics Draw uses
  u32 a[5] = {gfx, (u32)(s32)(s8)rd8(o + 0x10), (u32)v, (u32)-6, 0};
  s32 w = (s32)call_guest_unhooked(num_width | 1, 5, a), digits = 0;
  for (s32 k = v; k; k /= 10) digits++;
  if (width) *width = w;
  return (((digits + 1) * 5) >> 1) + (w >> 1);
}
#define NUM_TOP 44 // the top bar (buttons, the target's name)
static void m_num_place(u32 o) {
  u32 map = m_map();
  if (!map) return;
  s32 w, off = num_offset(o, (s32)rd32(o + 8), &w), base = num_offset(o, 100, 0);
  s32 x = (s32)(s16)rd16(o + 4), y = (s32)(s16)rd16(o + 6) + off - base;
  s32 cx = (s16)rd16(map + 0x166), cy = (s16)rd16(map + 0x168);
  s32 top = y - off - cy, left = x - off - cx, right = left + w;
  if (top < NUM_TOP) y += NUM_TOP - top;
  if (top > (s32)scr_h - 40) y -= top - ((s32)scr_h - 40);
  if (left < 4) x += 4 - left;
  else if (right > (s32)scr_w - 4) x -= right - ((s32)scr_w - 4);
  wr16(o + 4, (u16)x);
  wr16(o + 6, (u16)y);
}
// CMvNumberObject::Draw: placed and faded for the moment drawn, then as it was
static void m_num_draw(void) {
  u32 o = R[0];
  s32 e = (s8)rd8(o + 0xc) >= 0 ? (s32)rd8(o + 0xe) : -1;
  if (e < 0) { call_guest_unhooked(num_draw | 1, 1, &o); helper_ret(); return; }
  s32 t = e ? (e - 1) * 1024 + num_frac : 0, life = (s32)rd8(o + 0xf) * 1024;
  u16 x = rd16(o + 4), y = rd16(o + 6);
  wr16(o + 6, (u16)((s32)(s16)y + num_rise(e * 1024) - num_rise(t)));
  m_num_place(o);
  s32 left = life - t, fade = left < NUM_FADE * 1024 && e > 3 && life > 0; // (frames 1-3 are the game's own pop)
  if (fade) { u32 a[2] = {0, (u32)(left < 0 ? 0 : left * 240 / (NUM_FADE * 1024))}; call_guest_unhooked(alpha_begin | 1, 2, a); }
  call_guest_unhooked(num_draw | 1, 1, &o);
  if (fade) { u32 a[1] = {0}; call_guest_unhooked(alpha_end | 1, 1, a); }
  wr16(o + 4, x);
  wr16(o + 6, y);
  helper_ret();
}

EXPORT(fx_enable) int fx_enable(int on) {
  if (!set_damage && !m_resolve()) return -1;
  numbers_on = on;
  int r = aot_hook(num_update, on ? m_num_update : 0);
  if (!r) r = aot_hook(num_draw, on ? m_num_draw : 0);
  return r ? r : aot_hook(set_damage, on ? m_set_damage : 0);
}

EXPORT(motion_pages) u32 motion_pages(int log) { return cow_pages(log); }


// the camera as it is now, x << 16 | y (0 off the field)
EXPORT(live_cam) u32 live_cam(void) {
  if (!map_slot && !m_resolve()) return 0;
  u32 map = m_map();
  return map ? ((u32)rd16(map + 0x166) << 16) | rd16(map + 0x168) : 0;
}

// What this core's pictures do, for the page: 2 = in-between frames from memory as it was when the frame was
// drawn (the log covers the whole frame; before, a dash could stop them and effects showed the next frame
// early), 3 = also damage numbers that float up and fade out smoothly.
EXPORT(motion_rev) int motion_rev(void) { return 3; }
