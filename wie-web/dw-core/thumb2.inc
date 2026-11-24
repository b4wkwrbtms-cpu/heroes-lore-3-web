// 32-bit Thumb-2 instructions and IT blocks (ARMv7-M/A integer subset), included by cpu.c. The original
// library is ARMv5TE, where a 32-bit pair only ever is BL/BLX; some modified builds add code compiled for
// ARMv7, which uses the whole Thumb-2 set. R[15] reads as the instruction address + 4.

u32 itstate; // IT block state: bits 7:4 the condition of the next instruction, 3:0 the rest of the mask

static inline u32 t2_ror(u32 v, u32 r) { r &= 31; return r ? (v >> r) | (v << (32 - r)) : v; }

static u32 t2_expand_imm(u32 imm12, u32 *c) {
  u32 v = imm12 & 0xff;
  *c = fC;
  if (!(imm12 >> 10)) {
    switch ((imm12 >> 8) & 3) {
    case 0: return v;
    case 1: return v | (v << 16);
    case 2: return (v << 8) | (v << 24);
    default: return v | (v << 8) | (v << 16) | (v << 24);
    }
  }
  u32 r = t2_ror(0x80 | (imm12 & 0x7f), imm12 >> 7);
  *c = r >> 31;
  return r;
}

// shift by an immediate as DecodeImmShift: type 0 LSL, 1 LSR (0 means 32), 2 ASR (0 means 32), 3 ROR (0 means RRX)
static u32 t2_shift_imm(u32 v, u32 type, u32 n, u32 *c) {
  *c = fC;
  switch (type) {
  case 0:
    if (!n) return v;
    *c = (v >> (32 - n)) & 1;
    return v << n;
  case 1:
    if (!n) { *c = v >> 31; return 0; }
    *c = (v >> (n - 1)) & 1;
    return v >> n;
  case 2:
    if (!n) { *c = v >> 31; return (u32)((s32)v >> 31); }
    *c = (v >> (n - 1)) & 1;
    return (u32)((s32)v >> n);
  default:
    if (!n) { *c = v & 1; return (fC << 31) | (v >> 1); }
    *c = (v >> (n - 1)) & 1;
    return t2_ror(v, n);
  }
}

static u32 t2_sat(s64 v, u32 bits, int sign) {
  s64 hi = sign ? ((s64)1 << (bits - 1)) - 1 : ((s64)1 << bits) - 1, lo = sign ? -((s64)1 << (bits - 1)) : 0;
  if (v > hi) { fQ = 1; return (u32)hi; }
  if (v < lo) { fQ = 1; return (u32)lo; }
  return (u32)v;
}

// Thumb data-processing opcode (modified immediate and shifted register forms) on operand b
static void t2_data(u32 op, u32 s, u32 rn, u32 rd, u32 b, u32 c) {
  static const s8 arm_op[16] = {0, 14, 12, -1, 1, -1, -1, -1, 4, -1, 5, 6, -1, 2, 3, -1};
  if (rd == 15 && s) { // TST, TEQ, CMN, CMP
    int cmp = op == 0 ? 8 : op == 4 ? 9 : op == 8 ? 11 : op == 13 ? 10 : -1;
    if (cmp >= 0) { data_proc(((u32)cmp << 21) | (1u << 20) | (rn << 16), b, c); return; }
  }
  if (op == 2 && rn == 15) { data_proc((13u << 21) | (s << 20) | (rd << 12), b, c); return; } // MOV
  if (op == 3) {                                                                             // ORN, MVN
    u32 r = rn == 15 ? ~b : R[rn] | ~b;
    R[rd] = r;
    if (s) { fN = r >> 31; fZ = !r; fC = c; }
    return;
  }
  if (arm_op[op] < 0) { cpu_fail("thumb-2 data processing", cpu_pc - 4, op); return; }
  data_proc(((u32)arm_op[op] << 21) | (s << 20) | (rn << 16) | (rd << 12), b, c);
}

static void t2_load_store(u32 h1, u32 h2, u32 pc) {
  u32 rn = h1 & 15, rt = h2 >> 12, size = (h1 >> 5) & 3, load = (h1 >> 4) & 1, sign = (h1 >> 8) & 1;
  u32 addr, wb = 0, base = R[rn];
  if (rn == 15) {
    if (!load) { cpu_fail("thumb-2 store to pc", pc, (h1 << 16) | h2); return; }
    base = R[15] & ~3u;
    addr = (h1 & 0x80) ? base + (h2 & 0xfff) : base - (h2 & 0xfff);
  } else if (h1 & 0x80) {
    addr = base + (h2 & 0xfff);
  } else if (h2 & 0x800) {
    u32 off = h2 & 0xff, up = h2 & 0x200, pre = h2 & 0x400;
    u32 to = up ? base + off : base - off;
    addr = pre ? to : base;
    wb = (h2 & 0x100) ? 1 : 0;
    if (wb) base = to;
  } else {
    addr = base + (R[h2 & 15] << ((h2 >> 4) & 3));
  }
  if (load) {
    u32 v;
    if (rt == 15 && size < 2) return; // PLD, PLI: hints
    switch (size) {
    case 0: v = sign ? (u32)(s32)(s8)rd8(addr) : rd8(addr); break;
    case 1: v = sign ? (u32)(s32)(s16)rd16(addr) : rd16(addr); break;
    default: v = rd32(addr); break;
    }
    if (wb) R[rn] = base;
    if (rt == 15) write_pc_interwork(v, h2);
    else R[rt] = v;
  } else {
    u32 v = R[rt];
    switch (size) {
    case 0: wr8(addr, (u8)v); break;
    case 1: wr16(addr, (u16)v); break;
    default: wr32(addr, v); break;
    }
    if (wb) R[rn] = base;
  }
}

static void t2_block(u32 h1, u32 h2, u32 pc) {
  u32 rn = h1 & 15, list = h2, n = __builtin_popcount(list), base = R[rn];
  u32 db = ((h1 >> 7) & 3) == 2;
  u32 addr = db ? base - 4 * n : base, nb = db ? base - 4 * n : base + 4 * n;
  (void)pc;
  if (h1 & 0x10) {
    if ((h1 & 0x20) && !(list & (1u << rn))) R[rn] = nb;
    u32 v15 = 0;
    for (u32 i = 0; i < 16; i++)
      if (list & (1u << i)) {
        u32 v = rd32(addr);
        addr += 4;
        if (i == 15) v15 = v;
        else R[i] = v;
      }
    if (list & 0x8000) write_pc_interwork(v15, h2);
  } else {
    for (u32 i = 0; i < 15; i++)
      if (list & (1u << i)) { wr32(addr, R[i]); addr += 4; }
    if (h1 & 0x20) R[rn] = nb;
  }
}

static void t2_dual_excl(u32 h1, u32 h2, u32 pc) {
  u32 rn = h1 & 15, rt = h2 >> 12, rt2 = (h2 >> 8) & 15;
  if (h1 & 0x120) { // LDRD, STRD (immediate, literal)
    u32 base = rn == 15 ? R[15] & ~3u : R[rn], off = (h2 & 0xff) * 4;
    u32 to = (h1 & 0x80) ? base + off : base - off, addr = (h1 & 0x100) ? to : base;
    if (h1 & 0x10) {
      u32 lo = rd32(addr), hi = rd32(addr + 4);
      if (h1 & 0x20) R[rn] = to;
      R[rt] = lo;
      R[rt2] = hi;
    } else {
      wr32(addr, R[rt]);
      wr32(addr + 4, R[rt2]);
      if (h1 & 0x20) R[rn] = to;
    }
    return;
  }
  u32 op = ((h1 >> 7) & 3) << 2 | ((h1 >> 4) & 3), op3 = (h2 >> 4) & 15;
  switch (op) {
  case 0: wr32(R[rn] + (h2 & 0xff) * 4, R[rt]); R[rt2] = 0; return; // STREX
  case 1: R[rt] = rd32(R[rn] + (h2 & 0xff) * 4); return;            // LDREX
  case 4:                                                           // STREXB/H/D
    if (op3 == 4) wr8(R[rn], (u8)R[rt]);
    else if (op3 == 5) wr16(R[rn], (u16)R[rt]);
    else if (op3 == 7) { wr32(R[rn], R[rt]); wr32(R[rn] + 4, R[rt2]); }
    else break;
    R[h2 & 15] = 0;
    return;
  case 5: {
    u32 base = R[rn], rm = R[h2 & 15];
    if (op3 == 0) { cpu_pc = R[15] + 2 * rd8(base + rm); return; }       // TBB
    if (op3 == 1) { cpu_pc = R[15] + 2 * rd16(base + rm * 2); return; }  // TBH
    if (op3 == 4) { R[rt] = rd8(base); return; }                         // LDREXB
    if (op3 == 5) { R[rt] = rd16(base); return; }                        // LDREXH
    if (op3 == 7) { R[rt] = rd32(base); R[rt2] = rd32(base + 4); return; } // LDREXD
    break;
  }
  }
  cpu_fail("thumb-2 load/store dual", pc, (h1 << 16) | h2);
}

static void t2_branch_misc(u32 h1, u32 h2, u32 pc) {
  u32 s = (h1 >> 10) & 1, j1 = (h2 >> 13) & 1, j2 = (h2 >> 11) & 1;
  if (!(h2 & 0x5000)) { // conditional branch or misc control
    if (((h1 >> 7) & 7) != 7) {
      s32 off = (s32)(((s << 20) | (j2 << 19) | (j1 << 18) | ((h1 & 0x3f) << 12) | ((h2 & 0x7ff) << 1)) << 11) >> 11;
      if (cond_pass((h1 >> 6) & 15)) cpu_pc = R[15] + off;
      return;
    }
    u32 op = (h1 >> 4) & 0x7f;
    if ((op & 0x7e) == 0x38) { // MSR: only the flags matter here
      if (h2 & 0x800) { u32 v = R[h1 & 15]; fN = v >> 31; fZ = (v >> 30) & 1; fC = (v >> 29) & 1; fV = (v >> 28) & 1; fQ = (v >> 27) & 1; }
      return;
    }
    if (op == 0x3a || op == 0x3b) return; // hints, barriers, CLREX
    if ((op & 0x7e) == 0x3e) { R[(h2 >> 8) & 15] = cpsr_value(); return; } // MRS
    cpu_fail("thumb-2 misc control", pc, (h1 << 16) | h2);
    return;
  }
  u32 i1 = !(j1 ^ s), i2 = !(j2 ^ s);
  s32 off = (s32)(((s << 24) | (i1 << 23) | (i2 << 22) | ((h1 & 0x3ff) << 12) | ((h2 & 0x7ff) << 1)) << 7) >> 7;
  if ((h2 & 0x5000) == 0x1000) { cpu_pc = R[15] + off; return; } // B.W
  R[14] = (pc + 4) | 1;
  if (h2 & 0x1000) { // BL
    if (trace_calls && ntrace < TRACE_MAX) trace_buf[ntrace++] = R[15] + off;
    cpu_pc = R[15] + off;
    return;
  }
  u32 t = ((R[15] & ~3u) + off) & ~3u; // BLX to ARM
  if (trace_calls && ntrace < TRACE_MAX) trace_buf[ntrace++] = t;
  fT = 0;
  cpu_pc = t;
}

static void t2_data_reg(u32 h1, u32 h2, u32 pc) {
  u32 op1 = (h1 >> 4) & 15, op2 = (h2 >> 4) & 15, rn = h1 & 15, rd = (h2 >> 8) & 15, rm = h2 & 15;
  if (op2 == 0 && op1 < 8) { // LSL, LSR, ASR, ROR by register
    u32 sN = fN, sZ = fZ, sC = fC;
    u32 r = t_shift(op1 >> 1, R[rn], R[rm]);
    if (!(op1 & 1)) { fN = sN; fZ = sZ; fC = sC; }
    R[rd] = r;
    return;
  }
  if (op2 & 8) { // extend, with optional add
    u32 v = t2_ror(R[rm], ((h2 >> 4) & 3) * 8), a = rn == 15 ? 0 : R[rn];
    switch (op1) {
    case 0: R[rd] = a + (u32)(s32)(s16)v; return;
    case 1: R[rd] = a + (v & 0xffff); return;
    case 4: R[rd] = a + (u32)(s32)(s8)v; return;
    case 5: R[rd] = a + (v & 0xff); return;
    case 2: R[rd] = (((a >> 16) + (u32)(s32)(s8)(v >> 16)) << 16) | ((a + (u32)(s32)(s8)v) & 0xffff); return;
    case 3: R[rd] = (((a >> 16) + ((v >> 16) & 0xff)) << 16) | ((a + (v & 0xff)) & 0xffff); return;
    }
  }
  if ((op1 & 0xc) == 8 && (op2 & 0xc) == 8) {
    u32 v = R[rm];
    switch (((op1 & 3) << 2) | (op2 & 3)) {
    case 4: R[rd] = __builtin_bswap32(v); return;                                          // REV
    case 5: R[rd] = ((v & 0x00ff00ffu) << 8) | ((v >> 8) & 0x00ff00ffu); return;            // REV16
    case 6: R[rd] = __builtin_bitreverse32(v); return;                                     // RBIT
    case 7: R[rd] = (u32)(s32)(s16)(((v & 0xff) << 8) | ((v >> 8) & 0xff)); return;          // REVSH
    case 12: R[rd] = v ? __builtin_clz(v) : 32; return;                                    // CLZ
    }
  }
  cpu_fail("thumb-2 data processing (register)", pc, (h1 << 16) | h2);
}

static inline s32 t2_half(u32 v, u32 top) { return top ? (s32)v >> 16 : (s32)(s16)v; }

static void t2_multiply(u32 h1, u32 h2, u32 pc) {
  u32 op1 = (h1 >> 4) & 7, rn = h1 & 15, ra = h2 >> 12, rd = (h2 >> 8) & 15, rm = h2 & 15;
  u32 a = R[rn], b = R[rm];
  if (!(h1 & 0x80)) {
    switch (op1) {
    case 0:
      if (!((h2 >> 4) & 3)) { R[rd] = a * b + (ra == 15 ? 0 : R[ra]); return; } // MUL, MLA
      if (((h2 >> 4) & 3) == 1) { R[rd] = R[ra] - a * b; return; }             // MLS
      break;
    case 1: { // SMULxy, SMLAxy
      s32 p = t2_half(a, h2 & 0x20) * t2_half(b, h2 & 0x10);
      if (ra == 15) { R[rd] = (u32)p; return; }
      s64 r = (s64)p + (s32)R[ra];
      if (r != (s32)r) fQ = 1;
      R[rd] = (u32)r;
      return;
    }
    case 3: { // SMULWy, SMLAWy
      s32 p = (s32)(((s64)(s32)a * t2_half(b, h2 & 0x10)) >> 16);
      R[rd] = ra == 15 ? (u32)p : (u32)p + R[ra];
      return;
    }
    case 5: { // SMMUL, SMMLA
      s64 p = (s64)(s32)a * (s32)b + (ra == 15 ? 0 : (s64)R[ra] << 32);
      if (h2 & 0x10) p += 0x80000000ll;
      R[rd] = (u32)(p >> 32);
      return;
    }
    }
  } else {
    u32 op2 = (h2 >> 4) & 15;
    u64 r;
    switch (op1) {
    case 0: if (op2) break; r = (u64)((s64)(s32)a * (s32)b); R[ra] = (u32)r; R[rd] = (u32)(r >> 32); return;           // SMULL
    case 2: if (op2) break; r = (u64)a * b; R[ra] = (u32)r; R[rd] = (u32)(r >> 32); return;                             // UMULL
    case 1: R[rd] = b ? (a == 0x80000000u && b == 0xffffffffu ? a : (u32)((s32)a / (s32)b)) : 0; return;               // SDIV
    case 3: R[rd] = b ? a / b : 0; return;                                                                               // UDIV
    case 4:
      if (op2 == 0) r = (u64)((s64)(s32)a * (s32)b);                                                                     // SMLAL
      else if ((op2 & 0xc) == 8) r = (u64)(s64)(t2_half(a, op2 & 2) * t2_half(b, op2 & 1));                              // SMLALxy
      else break;
      r += ((u64)R[rd] << 32) | R[ra];
      R[ra] = (u32)r; R[rd] = (u32)(r >> 32);
      return;
    case 6:
      if (op2 == 0) { r = (u64)a * b + (((u64)R[rd] << 32) | R[ra]); R[ra] = (u32)r; R[rd] = (u32)(r >> 32); return; } // UMLAL
      if (op2 == 6) { r = (u64)a * b + R[ra] + R[rd]; R[ra] = (u32)r; R[rd] = (u32)(r >> 32); return; }                // UMAAL
      break;
    }
  }
  cpu_fail("thumb-2 multiply", pc, (h1 << 16) | h2);
}

static void t2_plain_imm(u32 h1, u32 h2, u32 pc) {
  u32 op = (h1 >> 4) & 31, rn = h1 & 15, rd = (h2 >> 8) & 15;
  u32 imm12 = ((h1 & 0x400) << 1) | ((h2 >> 4) & 0x700) | (h2 & 0xff);
  u32 lsb = ((h2 >> 10) & 0x1c) | ((h2 >> 6) & 3), w = h2 & 31;
  switch (op) {
  case 0: R[rd] = (rn == 15 ? R[15] & ~3u : R[rn]) + imm12; return;  // ADDW, ADR
  case 10: R[rd] = (rn == 15 ? R[15] & ~3u : R[rn]) - imm12; return; // SUBW, ADR
  case 4: R[rd] = (rn << 12) | imm12; return;                          // MOVW
  case 12: R[rd] = (R[rd] & 0xffff) | (((rn << 12) | imm12) << 16); return; // MOVT
  case 20: R[rd] = (u32)((s32)(R[rn] << (31 - lsb - w)) >> (31 - w)); return;        // SBFX
  case 28: R[rd] = (R[rn] >> lsb) & (w == 31 ? 0xffffffffu : (2u << w) - 1); return; // UBFX
  case 22: { // BFI, BFC
    if (w < lsb) break;
    u32 mask = (w - lsb == 31 ? 0xffffffffu : (2u << (w - lsb)) - 1) << lsb;
    R[rd] = (R[rd] & ~mask) | (rn == 15 ? 0 : (R[rn] << lsb) & mask);
    return;
  }
  case 16: case 18: case 24: case 26: { // SSAT, USAT (shifted)
    if ((op & 2) && !lsb) break; // SSAT16, USAT16: not used
    u32 c, v = t2_shift_imm(R[rn], (h1 >> 4) & 2, lsb, &c);
    int sg = !(op & 8);
    R[rd] = t2_sat((s32)v, sg ? w + 1 : w, sg);
    return;
  }
  }
  cpu_fail("thumb-2 plain immediate", pc, (h1 << 16) | h2);
}

static void exec_thumb32(u32 h1, u32 pc) {
  u32 h2 = rd16(pc + 2);
  cpu_pc = pc + 4;
  switch ((h1 >> 11) & 3) {
  case 1:
    if (!(h1 & 0x400)) {
      if (h1 & 0x200) { // data processing, shifted register
        u32 c, b = t2_shift_imm(R[h2 & 15], (h2 >> 4) & 3, ((h2 >> 10) & 0x1c) | ((h2 >> 6) & 3), &c);
        if (((h1 >> 5) & 15) == 6) { // PKHBT, PKHTB
          u32 a = R[h1 & 15];
          R[(h2 >> 8) & 15] = (h2 & 0x20) ? (a & 0xffff0000u) | (b & 0xffff) : (b & 0xffff0000u) | (a & 0xffff);
          return;
        }
        t2_data((h1 >> 5) & 15, (h1 >> 4) & 1, h1 & 15, (h2 >> 8) & 15, b, c);
      } else if (h1 & 0x40) t2_dual_excl(h1, h2, pc);
      else t2_block(h1, h2, pc);
      return;
    }
    break;
  case 2:
    if (h2 & 0x8000) { t2_branch_misc(h1, h2, pc); return; }
    if (h1 & 0x200) { t2_plain_imm(h1, h2, pc); return; }
    {
      u32 c, b = t2_expand_imm(((h1 & 0x400) << 1) | ((h2 >> 4) & 0x700) | (h2 & 0xff), &c);
      t2_data((h1 >> 5) & 15, (h1 >> 4) & 1, h1 & 15, (h2 >> 8) & 15, b, c);
    }
    return;
  default:
    if ((h1 & 0xfe00) == 0xf800 && (h1 & 0x70) != 0x70 && !((h1 & 0x110) == 0x100)) { t2_load_store(h1, h2, pc); return; }
    if ((h1 & 0xff00) == 0xfa00) { t2_data_reg(h1, h2, pc); return; }
    if ((h1 & 0xff00) == 0xfb00) { t2_multiply(h1, h2, pc); return; }
    break;
  }
  cpu_fail("thumb-2 instruction", pc, (h1 << 16) | h2);
}

// the 16-bit instructions that set flags outside an IT block and not inside one
static inline int t_flags_outside_it(u32 insn) {
  u32 op = insn >> 11;
  if (op <= 4 || op == 6 || op == 7) return 1;
  if (op == 8 && !(insn & 0x400)) {
    u32 sub = (insn >> 6) & 15;
    return sub != 8 && sub != 10 && sub != 11;
  }
  return 0;
}

static void exec_thumb_it(u32 insn, u32 pc) {
  u32 c = (itstate >> 4) & 15;
  itstate = (itstate & 7) ? (itstate & 0xe0) | ((itstate << 1) & 0x1f) : 0;
  int wide = (insn >> 11) >= 29;
  if (!cond_pass(c)) { if (wide) cpu_pc = pc + 4; return; }
  if (!wide && t_flags_outside_it(insn)) {
    u32 n = fN, z = fZ, cc = fC, v = fV;
    exec_thumb(insn, pc);
    fN = n; fZ = z; fC = cc; fV = v;
    return;
  }
  exec_thumb(insn, pc);
}
