// The game's touch d-pad (CZnTouchKeypad): where it is and whether it is on screen, so the page can steer a
// finger that starts on it (z4.js). The game reads the direction from a ring around the dial's centre
// (CheckDirectionKeyPad: a finger inside the inner circle or outside the outer one counts as no direction),
// in four sectors; the page keeps the finger in that ring.
#include "base.h"

u32 find_symbol(const char *name);
int aot_hook(u32 addr, void (*fn)(void));
u32 call_guest_unhooked(u32 addr, int nargs, const u32 *args);
extern u32 frame_count;

static u32 kp_draw, kp_rect, kp_var, kp_out, kp_frame, kp_got;
static u32 kp_drawn = 0xffff0000u; // frame_count when the dial was last drawn (CZnTouchKeypad::Draw draws the
                                   // keypad only on the field with no window open)

typedef struct { const char *name; u32 size, sig; u32 *addr; } InputSym;
static const InputSym isyms[] = {
    {"_ZN14CZnTouchKeypad22DrawTouchKeypadPatternEv", 572, 0xdd806e88u, &kp_draw},
    {"_ZN14CZnTouchKeypad18GetTouchKeyPadRectE16EnumTouchPadTypei", 140, 0xd083f70eu, &kp_rect},
    {"_Z12GxGetFrameT1v", 12, 0x4e5c3bd0u, &kp_frame},
};

// Whether DrawTouchKeypadPattern will draw the dial (pattern 0): in a scene (frame mode 2 with a script
// running, or the skip-only state) it draws one other pattern only; otherwise the dial when it is switched on.
static int dial_shown(u32 kp) {
  if (!rd8(kp + 0x17)) return 0;
  if (rd32(call_guest_unhooked(kp_frame | 1, 0, 0) + 0xd0) != 2) return 1;
  u32 a = rd32(rd32(kp_got + rd32(kp_draw + 0x230))), b = rd32(rd32(kp_got + rd32(kp_draw + 0x234)));
  return (s32)rd32(a + 0xc) <= 0 && !rd8(b + 0x1f89);
}

static void i_kp_draw(void) {
  if (dial_shown(R[0])) kp_drawn = frame_count;
  u32 self = R[0];
  R[0] = call_guest_unhooked(kp_draw | 1, 1, &self);
  u32 lr = R[14];
  fT = lr & 1;
  cpu_pc = lr & ~1u;
}

static int i_resolve(void) {
  static int resolved;
  if (resolved) return resolved > 0;
  resolved = -1;
  for (u32 i = 0; i < sizeof isyms / sizeof isyms[0]; i++) {
    u32 a = find_symbol(isyms[i].name) & ~1u;
    if (!a) return 0;
    u32 h = 2166136261u;
    for (u32 k = 0; k < isyms[i].size; k++) h = (h ^ rd8(a + k)) * 16777619u;
    if (h != isyms[i].sig) { logf("input: %s differs (%08x)", isyms[i].name, h); return 0; }
    *isyms[i].addr = a;
  }
  kp_got = kp_draw + 0x14 + rd32(kp_draw + 0x224); // the GOT base the function computes (add r9, pc)
  kp_var = find_symbol("_ZN12CGsSingletonI14CZnTouchKeypadE13ms_pSingletonE");
  kp_out = gmalloc(16);
  if (!kp_var || !kp_out || aot_hook(kp_draw, i_kp_draw)) return 0;
  resolved = 1;
  return 1;
}

// The dial while the keypad is on screen: out[0..3] = centre x, y, inner and outer radius (game pixels).
// 0 when it is there, -1 when not (menus, scenes, another build of the game).
EXPORT(dpad_geom) int dpad_geom(s32 *out) {
  if (!i_resolve() || cpu_halt) return -1;
  u32 kp = rd32(kp_var);
  if (!kp || frame_count - kp_drawn > 2) return -1;
  // the four direction pads (types 1..4) are switched on (CheckDirectionKeyPad reads +0x17 + type)
  if (!(rd8(kp + 0x18) | rd8(kp + 0x19) | rd8(kp + 0x1a) | rd8(kp + 0x1b))) return -1;
  s32 r[3][4];
  for (u32 k = 0; k < 3; k++) {
    u32 a[4] = {kp_out, kp, 0, k};
    call_guest_unhooked(kp_rect | 1, 4, a);
    for (u32 j = 0; j < 4; j++) r[k][j] = (s16)rd16(kp_out + 2 * j);
  }
  out[0] = r[0][0] + (r[0][2] >> 1);
  out[1] = r[0][1] + (r[0][3] >> 1);
  out[2] = r[1][2] >> 1;
  out[3] = r[2][2] >> 1;
  return out[3] > out[2] && out[2] >= 0 ? 0 : -1;
}

// Starts watching for the keypad (the page calls it once the game runs).
EXPORT(dpad_enable) int dpad_enable(void) { return i_resolve() ? 0 : -1; }
