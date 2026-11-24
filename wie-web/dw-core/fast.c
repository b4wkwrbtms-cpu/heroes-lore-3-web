// Native fast paths for the hottest drawing routines of libDarkWorld.so.
//
// Each one replaces the first instruction of a routine (or of a loop) with a UDF instruction that
// lands in cpu_hook_thumb/cpu_hook_arm, computes the same result in C and returns, so the screen is the
// same pixel for pixel. They are installed only when the instruction words at those addresses match the
// library build they were read from; otherwise the game runs as it is. A fast path that meets a case it
// does not cover runs the displaced instruction and lets the original code carry on.
#include "base.h"

#define B LOAD_BASE
#define GOT (B + 0xbc820u)              // the library's global offset table
#define GOT_BLEND_TABLE 0x518u          // u8 table: blend level x source 5 bits x destination 5 bits
#define GOT_DRAW 0x71cu                 // the drawing state (clip rectangle, frame buffer, colour offsets)
#define GOT_ALPHA_TABLE 0x6a0u          // u8 table for the colour offset pass of the alpha blend
#define TRANSPARENT 0x2484u             // the colour the game treats as see-through

static inline u32 got(u32 off) { return rd32(GOT + off); }

static void ret(void) {
  fT = R[14] & 1;
  cpu_pc = R[14] & ~1u;
}

// void andCopyBuffer(u16 *dst): copy the game's frame buffer to the Java screen buffer, skipping TRANSPARENT
static int fast_copy_buffer(void) {
  u32 g = got(GOT_DRAW), dst = R[0];
  u32 src = rd32(rd32(g + 4) + 0x10);
  s32 w = (s32)rd32(g + 0x54), h = (s32)rd32(g + 0x58);
  if (w > 0 && h > 0) {
    u32 n = (u32)w * (u32)h;
    const u16 *s = (const u16 *)(G + (src & GUEST_MASK));
    u16 *d = (u16 *)(G + (dst & GUEST_MASK));
    if ((src & GUEST_MASK) + n * 2 > GUEST_SIZE || (dst & GUEST_MASK) + n * 2 > GUEST_SIZE) return 0;
    for (u32 i = 0; i < n; i++) {
      u16 p = s[i];
      if (p != TRANSPARENT) d[i] = p;
    }
  }
  R[0] = 0;
  return 1;
}

// the per-channel lookups shared by the two table blends
static inline void blend_channels(u32 t, u32 lvl, u32 src, u32 d, u32 *r, u32 *g, u32 *b) {
  u32 l = lvl << 5;
  *b = rd8(t + (((l + (src & 31)) << 5) + (d & 31)));
  *r = rd8(t + (((l + (src >> 11)) << 5) + (d >> 11)));
  *g = rd8(t + (((l + ((src & 0x7e0) >> 6)) << 5) + ((d & 0x7e0) >> 6)));
}

// DM_PixelBlendingTable565(int level, u16 colour, u16 *dst)
static inline void blend565(u32 lvl, u32 src, u32 dst) {
  u32 d = rd16(dst), r, g, b;
  blend_channels(got(GOT_BLEND_TABLE), lvl, src, d, &r, &g, &b);
  wr16(dst, (u16)((b & 31) | (r << 11) | ((g << 6) & 0x7e0)));
}

static inline s32 clamp5(s32 v) {
  if (v < 0) v = 0;
  return v > 30 ? 31 : v;
}

// DM_PixelBlendingTable565Alpha(int level, u16 colour, u16 *dst): the table blend, then the drawing
// state's colour offset (when on) and its alpha pass
static inline void blend565_alpha(u32 lvl, u32 src, u32 dst) {
  u32 d = rd16(dst), r, g, b;
  u32 st = got(GOT_DRAW);
  blend_channels(got(GOT_BLEND_TABLE), lvl, src, d, &r, &g, &b);
  s32 rr = (s32)r, gg = (s32)g, bb = (s32)b;
  if ((s8)rd8(st + 0xe8)) {
    rr = clamp5(rr + (s32)rd32(st + 0xec));
    gg = clamp5(gg + (s32)rd32(st + 0xf0));
    bb = clamp5(bb + (s32)rd32(st + 0xf4));
  }
  u32 off = rd32(st + 0xe4), t = got(GOT_ALPHA_TABLE);
  u32 ob = rd8(t + ((((u32)bb << 5) + (d & 31)) << 3) + off) & 31;
  u32 orr = rd8(t + ((((u32)rr << 5) + (d >> 11)) << 3) + off);
  u32 og = rd8(t + ((((u32)gg << 5) + ((d & 0x7e0) >> 6)) << 3) + off);
  wr16(dst, (u16)(ob | (orr << 11) | ((og << 6) & 0x7e0)));
}

static int fast_blend565(void) { blend565(R[0], R[1], R[2]); return 1; }
static int fast_blend565_alpha(void) { blend565_alpha(R[0], R[1], R[2]); return 1; }

// the palette readers: 8, 4, 2 and 1 bits per pixel, the first pixel in the high bits
#define PAL1 0x26c50u
#define PAL2 0x26c1cu
#define PAL4 0x26bf8u
#define PAL8 0x26c14u
static inline u32 palette_colour(u32 kind, u32 data, u32 pal, s32 i) {
  u32 v;
  switch (kind) {
  case PAL8: return rd16(pal + rd8(data + (u32)i) * 2);
  case PAL4: v = rd8(data + (u32)(i >> 1)); return rd16(pal + ((i & 1) ? (v & 15) : (v >> 4)) * 2);
  case PAL2: v = rd8(data + (u32)(i >> 2)); return rd16(pal + ((v >> (6 - (i & 3) * 2)) & 3) * 2);
  default: v = rd8(data + (u32)(i >> 3)); return rd16(pal + ((v >> (7 - (i & 7))) & 1) * 2);
  }
}

// u16 DM_GetPaletteColor_TCOLOR4/8(u8 *data, u16 *palette, int index)
static int fast_palette4(void) { R[0] = palette_colour(PAL4, R[0], R[1], (s32)R[2]); return 1; }
static int fast_palette8(void) { R[0] = palette_colour(PAL8, R[0], R[1], (s32)R[2]); return 1; }

// int GetClipRect(int rect[4]): the drawing state's clip rectangle, if one is set
static int fast_clip_rect(void) {
  u32 st = got(GOT_DRAW), out = R[0];
  if ((s8)rd8(st + 0x64) != 1) { R[0] = 0; return 1; }
  for (u32 k = 0; k < 4; k++) wr32(out + k * 4, rd32(st + 0x68 + k * 4));
  R[0] = 1;
  return 1;
}

// int __divsi3(int a, int b) (ARM): division by zero is left to the original, which reports it
static int fast_divsi3(void) {
  s32 a = (s32)R[0], b = (s32)R[1];
  if (!b) return 0;
  u32 ua = a < 0 ? 0u - (u32)a : (u32)a, ub = b < 0 ? 0u - (u32)b : (u32)b, q = ua / ub;
  R[0] = (a ^ b) < 0 ? 0u - q : q;
  return 1;
}

// DrawGBMEx, unrotated and unscaled: the inner loop over one row of a sprite (Thumb, loop head at
// 0x2ac8a). Per pixel it reads the colour through the palette reader in a function pointer and, unless it is
// TRANSPARENT, writes it through the pixel writer in another. Live registers: r4 x, r5 the clip
// rectangle (x end at +8), r6 the palette reader's pointer, r7 the destination, r8 the row's first
// index, r9 the pixel data, r10 TRANSPARENT, r11 mirrored; on the stack: 0x18 the GOT offset of the
// pixel writer's pointer, 0x1c the blend level, 0x20 width - 1 (mirrored), 0x28 the GOT, 0x2c the
// palette, 0x34 the left offset. The loop leaves through 0x2acbe, which reloads everything it uses.
#define GBM_ROW_EXIT 0x2acbeu
#define PIX_SRC 0x26d8cu
#define PIX_565 0x26d90u
#define PIX_565A 0x26de4u
static int fast_gbm_row(void) {
  u32 sp = R[13], gotb = rd32(sp + 0x28);
  u32 pk = (rd32(R[6]) & ~1u) - B, wk = (rd32(rd32(gotb + rd32(sp + 0x18))) & ~1u) - B;
  if (pk != PAL1 && pk != PAL2 && pk != PAL4 && pk != PAL8) return 0;
  if (wk != PIX_SRC && wk != PIX_565 && wk != PIX_565A) return 0;
  u32 data = R[9], pal = rd32(sp + 0x2c), lvl = rd32(sp + 0x1c), dst = R[7];
  s32 x = (s32)R[4], left = (s32)rd32(sp + 0x34), last = (s32)rd32(sp + 0x20), row = (s32)R[8];
  s32 end = (s32)rd32(R[5] + 8);
  for (;;) {
    s32 i = (R[11] ? last - x : x + left) + row;
    u32 c = palette_colour(pk, data, pal, i);
    if (c != R[10]) {
      if (wk == PIX_565) blend565(lvl, c, dst);
      else if (wk == PIX_565A) blend565_alpha(lvl, c, dst);
      else wr16(dst, (u16)c);
    }
    x++;
    if (end <= x) break;
    dst += 2;
  }
  R[4] = (u32)x;
  R[7] = dst;
  R[3] = (u32)end;
  cpu_pc = B + GBM_ROW_EXIT;
  return 2;
}

// DrawGBM: the inner loop over one row of an unblended sprite (Thumb, loop head at 0x2a05a). Live
// registers: r4 the palette reader's pointer, r5 the clip rectangle (x end at +8), r6 x, r7 the pixel
// index, r8 the destination, r9 the palette, r10 the pixel data, r11 TRANSPARENT; on the stack: 0x1c the
// GOT, 0x20 the GOT offset of the drawing state. Drawn pixels are stored as they are while the state's
// alpha is 0xff; otherwise the original blends them. It leaves through 0x2a08a, which reloads what it uses.
#define GBM_ROW2_EXIT 0x2a08au
static int fast_gbm_row_plain(void) {
  u32 sp = R[13];
  u32 st = rd32(rd32(sp + 0x1c) + rd32(sp + 0x20));
  u32 pk = (rd32(R[4]) & ~1u) - B;
  if (rd32(st + 0xe0) != 0xff) return 0;
  if (pk != PAL1 && pk != PAL2 && pk != PAL4 && pk != PAL8) return 0;
  s32 x = (s32)R[6], idx = (s32)R[7], end = (s32)rd32(R[5] + 8);
  u32 dst = R[8];
  for (;;) {
    u32 c = palette_colour(pk, R[10], R[9], idx);
    if (c != R[11]) wr16(dst, (u16)c);
    x++;
    idx++;
    if (end <= x) break;
    dst += 2;
  }
  R[6] = (u32)x;
  R[7] = (u32)idx;
  R[8] = dst;
  R[3] = (u32)end;
  cpu_pc = B + GBM_ROW2_EXIT;
  return 2;
}

// MC_grpFillRect: the inner loop over one row (Thumb, at 0x9406c): r4 x, r3 x end, r5 the destination,
// r7 the graphics context (colour at +0x14). It leaves at 0x94078 with r4 = r3.
#define FILL_ROW_EXIT 0x94078u
static int fast_fill_row(void) {
  if ((s32)R[4] >= (s32)R[3]) return 0;
  u32 c = rd32(R[7] + 0x14), dst = R[5], n = R[3] - R[4];
  for (u32 i = 0; i < n; i++) wr16(dst + i * 2, (u16)c);
  R[4] = R[3];
  R[5] = dst + n * 2;
  R[6] = c;
  cpu_pc = B + FILL_ROW_EXIT;
  return 2;
}

// void DM_SetPixelAlpha(surface, int x, int y, int alpha, u32 rgb): one pixel of a 24-bit colour, inside
// the clip rectangle, as it is (alpha 0xff) or through the alpha table
static int fast_set_pixel_alpha(void) {
  u32 alpha = R[3];
  if (!alpha) return 1;
  u32 st = got(GOT_DRAW);
  s32 x = (s32)R[1], y = (s32)R[2];
  if ((s32)rd32(st + 0x68) > x || x >= (s32)rd32(st + 0x70)) return 1;
  if ((s32)rd32(st + 0x6c) > y || y >= (s32)rd32(st + 0x74)) return 1;
  if (rd8(st + 0xbe) != 1) return 1;
  u32 rgb = rd32(R[13]);
  u32 p = rd32(R[0] + 0x10) + (rd32(st + 0x54) * (u32)y + (u32)x) * 2;
  u32 r = (rgb << 8) >> 27, g = (rgb << 16) >> 27, b = (rgb << 24) >> 27;
  if (alpha != 0xff) {
    u32 d = rd16(p), off = rd32(st + 0xe4), t = got(GOT_ALPHA_TABLE);
    r = rd8(t + ((((r << 5) + (d >> 11)) << 3) + off));
    g = rd8(t + ((((g << 5) + ((d >> 6) & 31)) << 3) + off));
    b = rd8(t + ((((b << 5) + (d & 31)) << 3) + off));
  }
  wr16(p, (u16)((b & 31) | (r << 11) | ((g << 6) & 0x7e0)));
  return 1;
}

// int Abs(int v)
static int fast_abs(void) {
  u32 m = (u32)((s32)R[0] >> 31);
  R[0] = (R[0] + m) ^ m;
  return 1;
}

typedef int (*Fast)(void);
typedef struct {
  u32 off;   // file offset of the patched instruction
  u32 word;  // the 32-bit word expected there in this library build
  u8 arm;    // ARM code (else Thumb)
  Fast fn;
} FastPath;

static const FastPath paths[] = {
    {0x286b8, 0x465fb5f0, 0, fast_copy_buffer},
    {0x26d90, 0x4b13b5f0, 0, fast_blend565},
    {0x26de4, 0x465fb5f0, 0, fast_blend565_alpha},
    {0x26bf8, 0x1053b510, 0, fast_palette4},
    {0x26c14, 0x005b5c83, 0, fast_palette8},
    {0x26bcc, 0x21644b09, 0, fast_clip_rect},
    {0x9433c, 0xe3510000, 1, fast_divsi3},
    {0x2ac8a, 0x46589b0d, 0, fast_gbm_row},
    {0x2a05a, 0x68234649, 0, fast_gbm_row_plain},
    {0x9406c, 0x3401697e, 0, fast_fill_row},
    {0x27198, 0x9e05b5f0, 0, fast_set_pixel_alpha},
    {0x2bed0, 0x18c017c3, 0, fast_abs},
};
#define NPATHS (sizeof paths / sizeof paths[0])
static u32 displaced[NPATHS];

void cpu_hook_thumb(u32 n, u32 pc) {
  if (n >= NPATHS || paths[n].arm || B + paths[n].off != pc) { logf("bad thumb hook %u at %08x", n, pc); cpu_halt = 1; return; }
  int r = paths[n].fn();
  if (r == 1) ret();
  else if (!r) exec_displaced_thumb(displaced[n] & 0xffff, pc);
}

void cpu_hook_arm(u32 n, u32 pc) {
  if (n >= NPATHS || !paths[n].arm || B + paths[n].off != pc) { logf("bad arm hook %u at %08x", n, pc); cpu_halt = 1; return; }
  if (paths[n].fn()) ret();
  else exec_displaced_arm(displaced[n], pc);
}

// a fast path returns 1 to return to the caller, 2 when it has set cpu_pc itself, 0 to run the original

// patch the library after loading it; returns how many fast paths were installed
EXPORT(install_fast_paths) int install_fast_paths(void) {
  for (u32 n = 0; n < NPATHS; n++) if (rd32(B + paths[n].off) != paths[n].word) return 0;
  for (u32 n = 0; n < NPATHS; n++) {
    u32 a = B + paths[n].off;
    displaced[n] = rd32(a);
    if (paths[n].arm) wr32(a, 0xe7f000f0u | ((n & 0xfff0) << 4) | (n & 15));
    else wr16(a, (u16)(0xde00 | n));
  }
  return (int)NPATHS;
}
