// Native stand-ins for the game's hottest drawing routines (sprite decompression and blending into the
// 16-bit back buffer), included by native_helpers.inc. Each does what the routine does with its arguments
// (r0-r3 and the stack) and returns to the caller. They are installed only when the routine's bytes match
// the ones these were written against (bh_sig), so another build of the game just runs its own code.
//
// The sprite format: an optional 10-byte header, then 16-bit codes: 0xffff ends, 0xfffe goes one line down,
// a code below 0x8000 skips that many pixels, otherwise the low 15 bits (14 for the one-colour runs of the
// alpha formats) count pixels that follow. Alpha formats start with 0xfff9 and a 32-bit offset of a plane of
// 8-bit alpha values, one per drawn pixel.

// Stores go straight to guest memory; a run's pages are handed to the copy-on-write log (cow.c) first.
static inline void bh_mark(u32 a, u32 bytes) { if (__builtin_expect(cow_on, 0)) cow_range(a, bytes); }
static inline void bh_st(u32 a, u32 v) { u16 h = (u16)v; __builtin_memcpy(G + (a & GUEST_MASK), &h, 2); }
// n palette pixels from s to d, through host pointers (a run never leaves guest memory)
static inline void bh_pal_run(u32 d, u32 s, u32 pal, u32 n) {
  u8 *dp = G + (d & GUEST_MASK);
  const u8 *sp = G + (s & GUEST_MASK), *pp = G + (pal & GUEST_MASK);
  for (u32 i = 0; i < n; i++) {
    u16 v;
    __builtin_memcpy(&v, pp + 2u * sp[i], 2);
    __builtin_memcpy(dp + 2 * i, &v, 2);
  }
}
static inline u32 bh_arg(int i) { return rd32(R[13] + 4u * (u32)i); } // stack arguments, from the 5th on
static inline u32 bh_le16(u32 a) { return (u32)rd8(a) | ((u32)rd8(a + 1) << 8); }

// (inv * d + a * s) >> 8 on each of the three fields, the routines' own rounding
static inline u16 bh_mix(u32 d, u32 s, u32 a, u32 inv) {
  u32 r = (inv * (d >> 11) + a * (s >> 11)) >> 8;
  u32 g = (inv * ((d >> 5) & 63) + a * ((s >> 5) & 63)) >> 8;
  u32 b = (inv * (d & 31) + a * (s & 31)) >> 8;
  return (u16)(b | (r << 11) | (g << 5));
}

// DrawOP_COPY_Compress_16(dst, src, palette, pitch): 8-bit indexed pixels through a palette
static void bh_copy_c16(void) {
  u32 d = R[0], s = R[1], pal = R[2], pitch = R[3] * 2;
  if ((s16)bh_le16(s) == -5) s += 10;
  for (;;) {
    u32 c = bh_le16(s);
    if (c == 0xffff) break;
    s += 2;
    if (c == 0xfffe) { d += pitch; continue; }
    if (!(c & 0x8000)) { d += c * 2; continue; }
    u32 n = c & 0x7fff;
    bh_mark(d, n * 2);
    bh_pal_run(d, s, pal, n);
    d += n * 2;
    s += n;
  }
  helper_return();
}

// DrawOP_COPY_ClippingCompress_16(dst, src, palette, pitch, x0, w, y0, h): the same inside a window
static void bh_copy_cc16(void) {
  u32 d = R[0], s = R[1], pal = R[2], pitch = R[3] * 2;
  s32 x0 = (s32)bh_arg(0), x1 = x0 + (s32)bh_arg(1), y0 = (s32)bh_arg(2), y1 = y0 + (s32)bh_arg(3);
  if ((s16)bh_le16(s) == -5) s += 10;
  s32 x = 0, y = 0;
  for (;;) {
    u32 c = bh_le16(s);
    if (c == 0xffff) break;
    s += 2;
    if (c == 0xfffe) {
      if (++y >= y1) break;
      d += pitch;
      x = 0;
      continue;
    }
    if (!(c & 0x8000)) { d += c * 2; x += (s32)c; continue; }
    u32 n = c & 0x7fff;
    if (y < y0) { d += n * 2; s += n; continue; } // (x is left as it is here)
    // the pixels of the run inside [x0, x1)
    s32 lo = x > x0 ? x : x0, hi = x + (s32)n < x1 ? x + (s32)n : x1;
    if (lo < hi) {
      bh_mark(d + 2 * (u32)(lo - x), 2 * (u32)(hi - lo));
      bh_pal_run(d + 2 * (u32)(lo - x), s + (u32)(lo - x), pal, (u32)(hi - lo));
    }
    d += n * 2; s += n; x += (s32)n;
  }
  helper_return();
}

// DrawOP_COPY_Compress_16_16_Alpha(dst, src, -, pitch): 16-bit pixels mixed by their alpha
static void bh_copy_c16a(void) {
  u32 d = R[0], s = R[1], pitch = R[3] * 2;
  if (rd16(s) != 0xfff9) { helper_return(); return; }
  u32 al = s + rd32(s + 2);
  u32 p = s + 10;
  for (;;) {
    u32 c = rd16(p);
    if (c == 0xffff) break;
    p += 2;
    if (c == 0xfffe) { d += pitch; continue; }
    if (!(c & 0x8000)) { d += c * 2; continue; }
    u32 one = c >= 0xc000, n = one ? c & 0x3fff : c & 0x7fff, step = one ? 0 : 2;
    bh_mark(d, n * 2);
    for (; n; n--) {
      u32 a = rd8(al++);
      bh_st(d, bh_mix(rd16(d), rd16(p), a, 255 - a));
      d += 2;
      p += step;
    }
    if (one) p += 2;
  }
  helper_return();
}

// DrawOP_COPY_ClippingCompress_16_16_Alpha(dst, src, -, pitch, x0, w, y0, h)
static void bh_copy_cc16a(void) {
  u32 d = R[0], s = R[1], pitch = R[3] * 2;
  if (rd16(s) != 0xfff9) { helper_return(); return; }
  s32 x0 = (s32)bh_arg(0), x1 = x0 + (s32)bh_arg(1), y0 = (s32)bh_arg(2), y1 = y0 + (s32)bh_arg(3);
  u32 al = s + rd32(s + 2);
  u32 p = s + 10;
  s32 x = 0, y = 0;
  for (;;) {
    u32 c = rd16(p);
    if (c == 0xffff) break;
    u32 code = p;
    p += 2;
    if (c == 0xfffe) {
      if (++y >= y1) break;
      d += pitch;
      x = 0;
      continue;
    }
    if (!(c & 0x8000)) { d += c * 2; x += (s32)c; continue; }
    u32 one = c >= 0xc000, n = one ? c & 0x3fff : c & 0x7fff, step = one ? 0 : 2;
    if (!n) continue;
    if (y < y0) {
      al += n; x += (s32)n; d += n * 2;
      p = one ? code + 4 : p + n * 2;
      continue;
    }
    bh_mark(d, n * 2);
    while (n) {
      if (x < x0 || x >= x1) { al++; x++; d += 2; n--; p += step; continue; }
      u32 a = rd8(al++);
      bh_st(d, bh_mix(rd16(d), rd16(p), a, (~a) & 255));
      d += 2; p += step; x++; n--;
      if (x >= x1) { al += n; d += n * 2; p += n * step; x += (s32)n; n = 0; }
    }
    if (one) p += 2;
  }
  helper_return();
}

// DrawOP_BLEND16_Compress_16_16_Alpha(dst, src, -, pitch, level 1..15): the alpha scaled by the level
static void bh_blend_c16a(void) {
  u32 d = R[0], s = R[1], pitch = R[3] * 2;
  s32 level = (s32)bh_arg(0);
  if (level == 0 || level > 15 || rd16(s) != 0xfff9) { helper_return(); return; }
  u32 lv = (u32)(level - 1) * 17;
  u32 al = s + rd32(s + 2);
  u32 p = s + 10;
  for (;;) {
    u32 c = rd16(p);
    if (c == 0xffff) break;
    u32 next = p + 2;
    if (c == 0xfffe) { d += pitch; p = next; continue; }
    if (!(c & 0x8000)) { d += c * 2; p = next; continue; }
    u32 one = c >= 0xc000, n = one ? c & 0x3fff : c & 0x7fff, step = one ? 0 : 2;
    u32 px = p, dd = d;
    bh_mark(d, n * 2);
    for (u32 i = 0; i < n; i++) {
      u32 t = (rd8(al + i) * lv) >> 8;
      bh_st(dd, bh_mix(rd16(dd), rd16(px + 2), t & 255, (~t) & 255));
      dd += 2;
      px += step;
    }
    al += n;
    d += n * 2;
    p = next + n * step + (one ? 2 : 0);
  }
  helper_return();
}

// DrawOP_BLEND16_ClippingCompress_16_16_Alpha(dst, src, -, pitch, x0, w, y0, h, level)
static void bh_blend_cc16a(void) {
  u32 d = R[0], s = R[1], pitch = R[3] * 2;
  s32 x0 = (s32)bh_arg(0), x1 = x0 + (s32)bh_arg(1), y0 = (s32)bh_arg(2), y1 = y0 + (s32)bh_arg(3);
  s32 level = (s32)bh_arg(4);
  if (level == 0 || level > 15 || rd16(s) != 0xfff9) { helper_return(); return; }
  u32 lv = (u32)(level - 1) * 17;
  u32 al = s + rd32(s + 2);
  u32 p = s + 10;
  s32 x = 0, y = 0;
  for (;;) {
    u32 c = rd16(p);
    if (c == 0xffff) break;
    u32 next = p + 2;
    if (c == 0xfffe) {
      if (++y >= y1) break;
      d += pitch;
      x = 0;
      p = next;
      continue;
    }
    if (!(c & 0x8000)) { d += c * 2; x += (s32)c; p = next; continue; }
    u32 one = c >= 0xc000, n = one ? c & 0x3fff : c & 0x7fff, step = one ? 0 : 2;
    if (!n) { p = next; continue; }
    if (y < y0) {
      al += n; x += (s32)n; d += n * 2;
      p = one ? p + 4 : next + n * 2;
      continue;
    }
    u32 px = p;
    bh_mark(d, n * 2);
    for (u32 i = 0; i < n; i++, px += step) {
      s32 xi = x + (s32)i;
      if (xi < x0 || xi >= x1) continue;
      u32 t = (rd8(al + i) * lv) >> 8;
      u32 dd = d + 2 * i;
      bh_st(dd, bh_mix(rd16(dd), rd16(px + 2), t & 255, (~t) & 255));
    }
    x += (s32)n; al += n; d += n * 2;
    p = next + n * step + (one ? 2 : 0);
  }
  helper_return();
}

// DrawOP_BLEND16_16(dst, src, w, h, dst pitch, src pitch, level 1..15, colour key): a plain rectangle
// mixed by the level; the masks and shifts per level are a table in the library itself
static u32 bh_blend16_16_addr;
static void bh_blend16_16(void) {
  u32 d = R[0], s = R[1], w = R[2], h = R[3];
  u32 dp = bh_arg(0) * 2, sp = bh_arg(1) * 2;
  s32 level = (s32)bh_arg(2);
  u32 key = bh_arg(3);
  if (level == 0 || level > 15 || (s32)w < 0) { helper_return(); return; }
  u32 lv = (u32)(level - 1);
  if (lv == 7) {
    for (; h; h--, d += dp, s += sp) {
      bh_mark(d, w * 2);
      for (u32 i = 0; i < w; i++) {
        u32 v = rd16(s + 2 * i);
        if (v == key) continue;
        bh_st(d + 2 * i, ((rd16(d + 2 * i) >> 1) & 0x7bef) + ((v & ~0x820u) >> 1));
      }
    }
  } else {
    u32 base = bh_blend16_16_addr;
    u32 tbl = rd32(base + 0x134) + base + 0x32;
    u32 m[8];
    u32 sh[8];
    for (int i = 0; i < 8; i++) { m[i] = rd16(tbl + lv * 16 + 2 * i); sh[i] = rd8(tbl + 0xf0 + lv * 8 + i); }
#define BH_SH(v, k) (sh[k] >= 32 ? 0u : ((v) & m[k]) >> sh[k])
    for (; h; h--, d += dp, s += sp) {
      bh_mark(d, w * 2);
      for (u32 i = 0; i < w; i++) {
        u32 v = rd16(s + 2 * i);
        if (v == key) continue;
        u32 o = rd16(d + 2 * i);
        u32 r = BH_SH(v, 5) + BH_SH(v, 4) + BH_SH(v, 6) + BH_SH(v, 7) + BH_SH(o, 0) + BH_SH(o, 1) + BH_SH(o, 2) + BH_SH(o, 3);
        bh_st(d + 2 * i, r);
      }
    }
#undef BH_SH
  }
  helper_return();
}

// Screen_FADEOUT16_16(dst, w, h... ) darkens a rectangle by one of 16 steps; each step is a fixed function
// of the pixel value, so the first use of a step runs the game's own routine once over all 65536 values and
// keeps the result as a table.
static u32 bh_fade_addr;
static u16 *bh_fade_tbl[16];
static u16 bh_fade_store[16][65536];
static void bh_fade_build(u32 step);
static void bh_fade(void) {
  u32 d = R[0], pitch = (u32)((s32)R[1] >> 1) * 2, w = R[2] * 2, h = R[3];
  u32 step = bh_arg(0);
  if (step > 15) { helper_return(); return; }
  if (!bh_fade_tbl[step]) bh_fade_build(step);
  const u16 *t = bh_fade_tbl[step];
  // the routine walks each row from d to d + w (both in bytes) and steps rows by pitch
  for (; h; h--, d += pitch) {
    bh_mark(d, w);
    for (u32 a = d; a != d + w; a += 2) bh_st(a, t[rd16(a)]);
  }
  helper_return();
}

// Level tables: for level 1..15 a routine mixes four masked-and-shifted parts of one pixel with four of
// another (masks at tbl + 16 * (level - 1), shifts as signed bytes at tbl + 0xf0 + 8 * (level - 1)); a
// shift of 32 or more (a negative byte) leaves nothing.
typedef struct { u32 m[8], sh[8]; } BhMix;
static void bh_mix_load(BhMix *t, u32 tbl, u32 lv) {
  for (int i = 0; i < 8; i++) { t->m[i] = rd16(tbl + lv * 16 + 2 * i); t->sh[i] = rd8(tbl + 0xf0 + lv * 8 + i); }
}
static inline u32 bh_part(const BhMix *t, u32 v, int k) { return t->sh[k] >= 32 ? 0u : (v & t->m[k]) >> t->sh[k]; }
static inline u32 bh_mix8(const BhMix *t, u32 a, u32 b) {
  return bh_part(t, a, 0) + bh_part(t, a, 1) + bh_part(t, a, 2) + bh_part(t, a, 3) + bh_part(t, b, 4) + bh_part(t, b, 5) +
         bh_part(t, b, 6) + bh_part(t, b, 7);
}
static inline u32 bh_gray(u32 p) {
  u32 s = (p & 31) + 3 + (p >> 11) + ((p >> 6) & 31);
  u32 v = (s >> 2) + (s >> 4) + (s >> 6);
  return v | (v << 6) | (v << 11);
}

// DrawOP_GRAY_Compress_16(dst, src, palette, pitch, level) and DrawOP_GRAY_ClippingCompress_16(dst, src,
// palette, pitch, x0, w, y0, h, level): palette pixels in grey, or with level 1..15 the pixel mixed with
// its grey through the level table. The same walk as the COPY routines above.
static u32 bh_gray_c16_addr, bh_gray_cc16_addr;
static inline u32 bh_gray_px(const BhMix *t, int lv, u32 p) {
  u32 g = bh_gray(p);
  return lv ? bh_mix8(t, p, g) : g;
}
static void bh_gray_c16(void) {
  u32 d = R[0], s = R[1], pal = R[2], pitch = R[3] * 2;
  s32 level = (s32)bh_arg(0);
  BhMix t;
  int lv = level != 0 && level <= 15;
  if (lv) bh_mix_load(&t, rd32(bh_gray_c16_addr + 0x1ec) + bh_gray_c16_addr + 0xb0, (u32)(level - 1));
  if ((s16)bh_le16(s) == -5) s += 10;
  for (;;) {
    u32 c = bh_le16(s);
    if (c == 0xffff) break;
    s += 2;
    if (c == 0xfffe) { d += pitch; continue; }
    if (!(c & 0x8000)) { d += c * 2; continue; }
    u32 n = c & 0x7fff;
    bh_mark(d, n * 2);
    for (; n; n--) { bh_st(d, bh_gray_px(&t, lv, rd16(pal + 2u * rd8(s)))); d += 2; s++; }
  }
  helper_return();
}
static void bh_gray_cc16(void) {
  u32 d = R[0], s = R[1], pal = R[2], pitch = R[3] * 2;
  s32 x0 = (s32)bh_arg(0), x1 = x0 + (s32)bh_arg(1), y0 = (s32)bh_arg(2), y1 = y0 + (s32)bh_arg(3);
  s32 level = (s32)bh_arg(4);
  BhMix t;
  int lv = level != 0 && level <= 15;
  if (lv) bh_mix_load(&t, rd32(bh_gray_cc16_addr + 0x28c) + bh_gray_cc16_addr + 0x116, (u32)(level - 1));
  if ((s16)bh_le16(s) == -5) s += 10;
  s32 x = 0, y = 0;
  for (;;) {
    u32 c = bh_le16(s);
    if (c == 0xffff) break;
    s += 2;
    if (c == 0xfffe) {
      if (++y >= y1) break;
      d += pitch;
      x = 0;
      continue;
    }
    if (!(c & 0x8000)) { d += c * 2; x += (s32)c; continue; }
    u32 n = c & 0x7fff;
    if (y < y0) { d += n * 2; s += n; continue; }
    bh_mark(d, n * 2);
    for (u32 i = 0; i < n; i++) {
      s32 xi = x + (s32)i;
      if (xi >= x0 && xi < x1) bh_st(d + 2 * i, bh_gray_px(&t, lv, rd16(pal + 2u * rd8(s + i))));
    }
    d += n * 2; s += n; x += (s32)n;
  }
  helper_return();
}

// Screen_RGBBLEND16_16(dst, pitch in bytes, w, h, colour, step 0..15) tints a rectangle: each pixel becomes
// f(pixel) + g(colour) for the step (step 0 is the colour itself). f comes from running the game's routine
// once over all 65536 values with colour 0; g from running it on one black pixel with the colour.
static u32 bh_rgbblend_addr;
static u16 *bh_rgbblend_tbl[16];
static u16 bh_rgbblend_store[16][65536];
static u32 bh_rgbblend_run(u32 buf, u32 w, u32 colour, u32 step);
static void bh_rgbblend(void) {
  u32 d = R[0], pitch = (u32)((s32)R[1] >> 1) * 2, w = R[2] * 2, h = R[3];
  u32 colour = bh_arg(0), step = bh_arg(1);
  if (step > 15) { helper_return(); return; }
  u32 buf = (R[13] - 0x60000u) & ~15u;
  if (!bh_rgbblend_tbl[step]) {
    for (u32 v = 0; v < 65536; v++) wr16(buf + 2 * v, (u16)v);
    bh_rgbblend_run(buf, 65536, 0, step);
    for (u32 v = 0; v < 65536; v++) bh_rgbblend_store[step][v] = rd16(buf + 2 * v);
    bh_rgbblend_tbl[step] = bh_rgbblend_store[step];
  }
  const u16 *t = bh_rgbblend_tbl[step];
  wr16(buf, 0);
  bh_rgbblend_run(buf, 1, colour, step);
  u16 add = (u16)(rd16(buf) - t[0]);
  for (; h; h--, d += pitch) {
    bh_mark(d, w);
    for (u32 a = d; a != d + w; a += 2) bh_st(a, (u16)(t[rd16(a)] + add));
  }
  helper_return();
}

// DrawOP_FLIP_ClippingCompress_16_16_Alpha(dst, src, -, pitch, x0, w, y0, h, mode): the alpha sprite
// mirrored: mode 0 left-right, 1 upside down, 2 both. The window is in the sprite's own coordinates.
static void bh_flip_cc16a(void) {
  u32 d = R[0], s = R[1];
  s32 x0 = (s32)bh_arg(0), x1 = x0 + (s32)bh_arg(1), y0 = (s32)bh_arg(2), y1 = y0 + (s32)bh_arg(3);
  u32 mode = bh_arg(4);
  if (mode > 2 || rd16(s) != 0xfff9) { helper_return(); return; }
  s32 dx = mode == 1 ? 2 : -2;
  u32 pitch = mode == 0 ? R[3] * 2 : 0u - R[3] * 2;
  u32 al = s + rd32(s + 2);
  u32 p = s + 10;
  s32 x = 0, y = 0;
  for (;;) {
    u32 c = rd16(p);
    if (c == 0xffff) break;
    u32 next = p + 2;
    if (c == 0xfffe) {
      if (++y >= y1) break;
      d += pitch;
      x = 0;
      p = next;
      continue;
    }
    if (!(c & 0x8000)) { d += (u32)(dx * (s32)c); x += (s32)c; p = next; continue; }
    u32 one = c >= 0xc000, n = one ? c & 0x3fff : c & 0x7fff, step = one ? 0 : 2;
    if (!n) { p = next; continue; }
    if (y < y0) {
      al += n; x += (s32)n; d += (u32)(dx * (s32)n);
      p = one ? p + 4 : next + n * 2;
      continue;
    }
    u32 px = p;
    bh_mark(dx > 0 ? d : d - 2 * (n - 1), n * 2);
    for (u32 i = 0; i < n; i++, px += step) {
      s32 xi = x + (s32)i;
      if (xi < x0 || xi >= x1) continue;
      u32 a = rd8(al + i);
      u32 dd = d + (u32)(dx * (s32)i);
      bh_st(dd, bh_mix(rd16(dd), rd16(px + 2), a, (~a) & 255));
    }
    x += (s32)n; al += n; d += (u32)(dx * (s32)n);
    p = next + n * step + (one ? 2 : 0);
  }
  helper_return();
}

// DrawOP_BLEND16_ClippingCompress_16_Ex_Alpha(dst, src, palette, pitch, x0, w, y0, h, level): like the
// clipping alpha blend above with 8-bit palette pixels; the header is 0xfffa, the alpha plane at its offset + 2,
// and a one-colour run holds one byte.
static void bh_blend_cc16ex(void) {
  u32 d = R[0], s = R[1], pal = R[2], pitch = R[3] * 2;
  s32 x0 = (s32)bh_arg(0), x1 = x0 + (s32)bh_arg(1), y0 = (s32)bh_arg(2), y1 = y0 + (s32)bh_arg(3);
  s32 level = (s32)bh_arg(4);
  if (level == 0 || level > 15 || (s16)bh_le16(s) != -6) { helper_return(); return; }
  u32 lv = (u32)(level - 1) * 17;
  u32 al = s + ((u32)rd8(s + 2) | ((u32)rd8(s + 3) << 8) | ((u32)rd8(s + 4) << 16) | ((u32)rd8(s + 5) << 24)) + 2;
  u32 p = s + 10;
  s32 x = 0, y = 0;
  for (;;) {
    u32 c = bh_le16(p);
    if (c == 0xffff) break;
    u32 next = p + 2;
    if (c == 0xfffe) {
      if (++y >= y1) break;
      d += pitch;
      x = 0;
      p = next;
      continue;
    }
    if (!(c & 0x8000)) { d += c * 2; x += (s32)c; p = next; continue; }
    u32 one = c >= 0xc000, n = one ? c & 0x3fff : c & 0x7fff, step = one ? 0 : 1;
    if (!n) { p = next; continue; }
    if (y < y0) {
      al += n; x += (s32)n; d += n * 2;
      p = one ? p + 3 : next + n;
      continue;
    }
    u32 px = p;
    bh_mark(d, n * 2);
    for (u32 i = 0; i < n; i++, px += step) {
      s32 xi = x + (s32)i;
      if (xi < x0 || xi >= x1) continue;
      u32 t = (rd8(al + i) * lv) >> 8;
      u32 dd = d + 2 * i;
      bh_st(dd, bh_mix(rd16(dd), rd16(pal + 2u * rd8(px + 2)), t & 255, (~t) & 255));
    }
    x += (s32)n; al += n; d += n * 2;
    p = next + n * step + (one ? 1 : 0);
  }
  helper_return();
}

typedef struct { const char *name; u32 size, sig; void (*fn)(void); u32 *addr; } BlitHelper;
static const BlitHelper blit_helpers[] = {
    {"_Z23DrawOP_COPY_Compress_16PtPhS_i", 328, 0x591182a0u, bh_copy_c16, 0},
    {"_Z31DrawOP_COPY_ClippingCompress_16PtPhS_iiiii", 620, 0xcc197582u, bh_copy_cc16, 0},
    {"_Z32DrawOP_COPY_Compress_16_16_AlphaPtPhS_i", 1042, 0x62a3fe33u, bh_copy_c16a, 0},
    {"_Z40DrawOP_COPY_ClippingCompress_16_16_AlphaPtPhS_iiiii", 1358, 0x2a637275u, bh_copy_cc16a, 0},
    {"_Z35DrawOP_BLEND16_Compress_16_16_AlphaPtPhS_il", 316, 0x8f577294u, bh_blend_c16a, 0},
    {"_Z43DrawOP_BLEND16_ClippingCompress_16_16_AlphaPtPhS_iiiiil", 406, 0x17852c70u, bh_blend_cc16a, 0},
    {"_Z43DrawOP_BLEND16_ClippingCompress_16_Ex_AlphaPtPhS_iiiiil", 418, 0x1b5d85a2u, bh_blend_cc16ex, 0},
    {"_Z17DrawOP_BLEND16_16PtS_iiiiii", 312, 0xf5ac1476u, bh_blend16_16, &bh_blend16_16_addr},
    {"_Z19Screen_FADEOUT16_16Ptiiii", 840, 0x669a5ce9u, bh_fade, &bh_fade_addr},
    {"_Z23DrawOP_GRAY_Compress_16PtPhS_il", 496, 0xc041517fu, bh_gray_c16, &bh_gray_c16_addr},
    {"_Z31DrawOP_GRAY_ClippingCompress_16PtPhS_iiiiil", 656, 0x2daef10fu, bh_gray_cc16, &bh_gray_cc16_addr},
    {"_Z40DrawOP_FLIP_ClippingCompress_16_16_AlphaPtPhS_iiiiil", 1168, 0x91ac9525u, bh_flip_cc16a, 0},
    {"_Z20Screen_RGBBLEND16_16Ptiiiii", 1184, 0xf16451e3u, bh_rgbblend, &bh_rgbblend_addr},
};
#define BLIT_HELPERS ((int)(sizeof blit_helpers / sizeof blit_helpers[0]))
// the routine's address when its bytes are the expected ones, otherwise 0
static u32 blit_helper_addr(int i) {
  u32 a = find_symbol(blit_helpers[i].name) & ~1u;
  if (!a) return 0;
  u32 h = 2166136261u;
  for (u32 k = 0; k < blit_helpers[i].size; k++) h = (h ^ rd8(a + k)) * 16777619u;
  if (h != blit_helpers[i].sig) return 0;
  if (blit_helpers[i].addr) *blit_helpers[i].addr = a;
  return a;
}
