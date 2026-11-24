// VFPv3-D16 (coprocessors 10 and 11), included by cpu.c. Used from both instruction sets: the low 28 bits
// of the encoding are the same, `w` is the ARM word or the two Thumb halfwords (first halfword high).

static inline float sreg(u32 i) { return V.f[i]; }
static inline double dreg(u32 i) { return V.d[i & 15]; }
static inline void set_s(u32 i, float v) { V.f[i] = v; }
static inline void set_d(u32 i, double v) { V.d[i & 15] = v; }

static inline int vfp_isnan(double x) { return x != x; }

static u32 f2s32(double x) {
  if (vfp_isnan(x)) return 0;
  if (x >= 2147483648.0) return 0x7fffffff;
  if (x <= -2147483649.0) return 0x80000000u;
  return (u32)(s32)x;
}
static u32 f2u32(double x) {
  if (vfp_isnan(x)) return 0;
  if (x >= 4294967296.0) return 0xffffffffu;
  if (x <= -1.0) return 0;
  if (x < 0) return 0;
  return (u32)x;
}

static inline void vfp_compare(double a, double b) {
  u32 nzcv;
  if (vfp_isnan(a) || vfp_isnan(b)) nzcv = 0x3;
  else if (a == b) nzcv = 0x6;
  else if (a < b) nzcv = 0x8;
  else nzcv = 0x2;
  fpscr = (fpscr & 0x0fffffff) | (nzcv << 28);
}

static void vfp_fail(const char *why, u32 pc, u32 w) { cpu_fail(why, pc, w); }

static inline __attribute__((always_inline)) void exec_vfp(u32 w, u32 pc) {
  u32 dbl = (w >> 8) & 1;
  u32 D = (w >> 22) & 1, N = (w >> 7) & 1, M = (w >> 5) & 1;
  u32 vd = (w >> 12) & 15, vn = (w >> 16) & 15, vm = w & 15;
  u32 sd = (vd << 1) | D, sn = (vn << 1) | N, sm = (vm << 1) | M;
  u32 dd = (D << 4) | vd, dn = (N << 4) | vn, dm = (M << 4) | vm;

  // 64-bit transfers: VMOV two core registers <-> two singles or one double
  if ((w & 0x0fe00000) == 0x0c400000) {
    u32 rt = (w >> 12) & 15, rt2 = (w >> 16) & 15;
    u32 tocore = (w >> 20) & 1;
    if (dbl) {
      u32 r = dm & 15;
      if (tocore) { R[rt] = V.s[r * 2]; R[rt2] = V.s[r * 2 + 1]; }
      else { V.s[r * 2] = R[rt]; V.s[r * 2 + 1] = R[rt2]; }
    } else {
      if (tocore) { R[rt] = V.s[sm & 31]; R[rt2] = V.s[(sm + 1) & 31]; }
      else { V.s[sm & 31] = R[rt]; V.s[(sm + 1) & 31] = R[rt2]; }
    }
    return;
  }

  // loads and stores
  if (((w >> 25) & 7) == 6) {
    u32 P = (w >> 24) & 1, U = (w >> 23) & 1, W = (w >> 21) & 1, L = (w >> 20) & 1;
    u32 rn = (w >> 16) & 15;
    u32 base = rn == 15 ? (R[15] & ~3u) : R[rn];
    u32 imm = (w & 0xff) << 2;
    if (P && !W) { // VLDR / VSTR
      u32 addr = U ? base + imm : base - imm;
      if (dbl) {
        u32 r = dd & 15;
        if (L) { V.s[r * 2] = rd32(addr); V.s[r * 2 + 1] = rd32(addr + 4); }
        else { wr32(addr, V.s[r * 2]); wr32(addr + 4, V.s[r * 2 + 1]); }
      } else {
        if (L) V.s[sd] = rd32(addr);
        else wr32(addr, V.s[sd]);
      }
      return;
    }
    // VLDM / VSTM (IA, IA!, DB!)
    u32 words = w & 0xff;
    u32 addr = U ? base : base - imm;
    if (W) R[rn] = U ? base + imm : base - imm;
    u32 first = dbl ? (dd & 15) * 2 : sd;
    u32 n = dbl ? (words & ~1u) : words;
    for (u32 i = 0; i < n; i++) {
      u32 r = (first + i) & 31;
      if (L) V.s[r] = rd32(addr);
      else wr32(addr, V.s[r]);
      addr += 4;
    }
    return;
  }

  if (((w >> 24) & 15) != 14) { vfp_fail("coprocessor", pc, w); return; }

  if (w & 0x10) { // register transfers
    u32 rt = (w >> 12) & 15, L = (w >> 20) & 1;
    if (!dbl) {
      u32 op = (w >> 21) & 7;
      if (op == 0) { // VMOV Sn <-> Rt
        if (L) R[rt] = V.s[sn];
        else V.s[sn] = R[rt];
        return;
      }
      if (op == 7) { // VMRS / VMSR
        u32 reg = (w >> 16) & 15;
        if (L) {
          u32 v = reg == 1 ? fpscr : reg == 0 ? 0x41023000u : reg == 8 ? 0x40000000u : 0;
          if (rt == 15) { fN = v >> 31; fZ = (v >> 30) & 1; fC = (v >> 29) & 1; fV = (v >> 28) & 1; }
          else R[rt] = v;
        } else if (reg == 1) fpscr = R[rt];
        return;
      }
    } else if (!((w >> 23) & 1) && !((w >> 22) & 1) && !((w >> 5) & 3)) { // VMOV.32 Dn[x] <-> Rt
      u32 x = (w >> 21) & 1;
      u32 r = (dn & 15) * 2 + x;
      if (L) R[rt] = V.s[r];
      else V.s[r] = R[rt];
      return;
    }
    vfp_fail("vfp transfer", pc, w);
    return;
  }

  // data processing
  u32 opc1 = ((w >> 20) & 3) | ((w >> 21) & 4);
  u32 op6 = (w >> 6) & 1;
  if (dbl) {
    double a = dreg(dn), b = dreg(dm), d = dreg(dd);
    switch (opc1) {
    case 0: set_d(dd, op6 ? d - a * b : d + a * b); return;     // VMLA / VMLS
    case 1: set_d(dd, op6 ? -d - a * b : -d + a * b); return;   // VNMLA / VNMLS
    case 2: set_d(dd, op6 ? -(a * b) : a * b); return;          // VNMUL / VMUL
    case 3: set_d(dd, op6 ? a - b : a + b); return;             // VSUB / VADD
    case 4: if (!op6) { set_d(dd, a / b); return; } break;      // VDIV
    case 5: set_d(dd, op6 ? -d - a * b : -d + a * b); return;   // VFNMA / VFNMS
    case 6: set_d(dd, op6 ? d - a * b : d + a * b); return;     // VFMS / VFMA
    }
  } else {
    float a = sreg(sn), b = sreg(sm), d = sreg(sd);
    switch (opc1) {
    case 0: set_s(sd, op6 ? d - a * b : d + a * b); return;
    case 1: set_s(sd, op6 ? -d - a * b : -d + a * b); return;
    case 2: set_s(sd, op6 ? -(a * b) : a * b); return;
    case 3: set_s(sd, op6 ? a - b : a + b); return;
    case 4: if (!op6) { set_s(sd, a / b); return; } break;
    case 5: set_s(sd, op6 ? -d - a * b : -d + a * b); return;
    case 6: set_s(sd, op6 ? d - a * b : d + a * b); return;
    }
  }
  if (opc1 != 7) { vfp_fail("vfp data", pc, w); return; }
  if (!op6) { // VMOV immediate
    u32 imm8 = ((w >> 12) & 0xf0) | (w & 15);
    u32 sign = imm8 >> 7, b = (imm8 >> 6) & 1, cd = (imm8 >> 4) & 3, efgh = imm8 & 15;
    if (dbl) {
      u64 v = ((u64)sign << 63) | ((u64)(b ^ 1) << 62) | ((u64)(b ? 0xff : 0) << 54) | ((u64)cd << 52) | ((u64)efgh << 48);
      V.u[dd & 15] = v;
    } else {
      V.s[sd] = (sign << 31) | ((b ^ 1) << 30) | ((b ? 0x1fu : 0) << 25) | (cd << 23) | (efgh << 19);
    }
    return;
  }
  u32 opc2 = (w >> 16) & 15, op7 = (w >> 7) & 1;
  switch (opc2) {
  case 0: // VMOV reg / VABS
    if (dbl) {
      if (op7) { V.u[dd & 15] = V.u[dm & 15] & ~(1ull << 63); }
      else V.u[dd & 15] = V.u[dm & 15];
    } else {
      if (op7) V.s[sd] = V.s[sm] & 0x7fffffff;
      else V.s[sd] = V.s[sm];
    }
    return;
  case 1: // VNEG / VSQRT
    if (dbl) {
      if (op7) set_d(dd, __builtin_sqrt(dreg(dm)));
      else V.u[dd & 15] = V.u[dm & 15] ^ (1ull << 63);
    } else {
      if (op7) set_s(sd, __builtin_sqrtf(sreg(sm)));
      else V.s[sd] = V.s[sm] ^ 0x80000000u;
    }
    return;
  case 4: // VCMP / VCMPE
    if (dbl) vfp_compare(dreg(dd), dreg(dm));
    else vfp_compare(sreg(sd), sreg(sm));
    return;
  case 5: // VCMP with zero
    if (dbl) vfp_compare(dreg(dd), 0.0);
    else vfp_compare(sreg(sd), 0.0);
    return;
  case 7: // VCVT between double and single
    if (dbl) set_s(sd, (float)dreg(dm));
    else set_d(dd, (double)sreg(sm));
    return;
  case 8: { // VCVT integer -> float; source is always a single register
    u32 v = V.s[sm];
    double x = op7 ? (double)(s32)v : (double)v;
    if (dbl) set_d(dd, x);
    else set_s(sd, (float)x);
    return;
  }
  case 12:
  case 13: { // VCVT float -> integer, destination always a single register
    double x = dbl ? dreg(dm) : (double)sreg(sm);
    if (!op7) x = __builtin_rint(x); // VCVTR: FPSCR rounding (round to nearest)
    V.s[sd] = opc2 == 13 ? f2s32(x) : f2u32(x);
    return;
  }
  case 10:
  case 11:
  case 14:
  case 15: { // VCVT fixed point <-> float (sx = bit 7, sf = bit 8, U = bit 16, imm in imm4:i)
    u32 tofix = (opc2 >> 2) & 1, uns = opc2 & 1, sx = op7;
    u32 size = sx ? 32 : 16;
    u32 imm = ((w & 15) << 1) | ((w >> 5) & 1);
    s32 frac = (s32)size - (s32)imm;
    double scale = 1.0;
    for (s32 i = 0; i < frac; i++) scale *= 2.0;
    if (tofix) {
      double x = (dbl ? dreg(dd) : (double)sreg(sd)) * scale;
      u32 r;
      if (size == 16) {
        s64 t = vfp_isnan(x) ? 0 : (s64)(x > 1e12 ? 1e12 : x < -1e12 ? -1e12 : x);
        if (uns) r = t < 0 ? 0 : t > 0xffff ? 0xffff : (u32)t;
        else r = (u32)(t < -32768 ? -32768 : t > 32767 ? 32767 : t) & 0xffff;
      } else r = uns ? f2u32(x) : f2s32(x);
      if (dbl) { V.s[(dd & 15) * 2] = r; V.s[(dd & 15) * 2 + 1] = 0; }
      else V.s[sd] = r;
    } else {
      u32 raw = dbl ? V.s[(dd & 15) * 2] : V.s[sd];
      double x;
      if (size == 16) x = uns ? (double)(raw & 0xffff) : (double)(s16)raw;
      else x = uns ? (double)raw : (double)(s32)raw;
      x /= scale;
      if (dbl) set_d(dd, x);
      else set_s(sd, (float)x);
    }
    return;
  }
  }
  vfp_fail("vfp other", pc, w);
}
