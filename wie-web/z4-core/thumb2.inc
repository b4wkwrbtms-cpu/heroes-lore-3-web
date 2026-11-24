// Thumb-2 instruction set (ARMv7-A), included by cpu.c. R[15] reads as the instruction address + 4.
// Inside an IT block (t_in_it) the 16-bit data instructions do not set flags.

static inline void set_nz(u32 r) { fN = r >> 31; fZ = !r; }

static inline void t_branch(u32 target) { cpu_pc = target & ~1u; } // BranchWritePC in Thumb state

static inline u32 t_load(u32 addr, u32 size, u32 sgn) {
  switch (size) {
  case 0: return sgn ? (u32)(s32)(s8)rd8(addr) : rd8(addr);
  case 1: return sgn ? (u32)(s32)(s16)rd16(addr) : rd16(addr);
  default: return rd32(addr);
  }
}
static inline void t_store(u32 addr, u32 size, u32 v) {
  switch (size) {
  case 0: wr8(addr, (u8)v); break;
  case 1: wr16(addr, (u16)v); break;
  default: wr32(addr, v); break;
  }
}

static inline __attribute__((always_inline)) void t_push(u32 list) { // STMDB SP!
  u32 n = __builtin_popcount(list);
  u32 addr = R[13] - 4 * n;
  R[13] = addr;
  for (u32 i = 0; i < 16; i++)
    if (list & (1u << i)) { wr32(addr, R[i]); addr += 4; }
}
static inline __attribute__((always_inline)) void t_pop(u32 list) { // LDMIA SP!
  u32 addr = R[13];
  R[13] = addr + 4 * __builtin_popcount(list);
  for (u32 i = 0; i < 15; i++)
    if (list & (1u << i)) { R[i] = rd32(addr); addr += 4; }
  if (list & 0x8000) write_pc_interwork(rd32(addr));
}

static inline __attribute__((always_inline)) void exec_t16(u32 i, u32 pc) {
  u32 setf = !t_in_it;
  switch (i >> 11) {
  case 0: case 1: case 2: { // LSL/LSR/ASR #imm5 (LSL #0 is MOVS)
    u32 rd = i & 7, v = R[(i >> 3) & 7], amt = (i >> 6) & 31, c;
    u32 r = shift_imm(v, i >> 11, amt, &c);
    if (setf) { set_nz(r); fC = c; }
    R[rd] = r;
    return;
  }
  case 3: { // ADD/SUB register or imm3
    u32 rd = i & 7, a = R[(i >> 3) & 7];
    u32 b = (i & 0x400) ? (i >> 6) & 7 : R[(i >> 6) & 7];
    R[rd] = (i & 0x200) ? add_with_carry(a, ~b, 1, setf) : add_with_carry(a, b, 0, setf);
    return;
  }
  case 4: { u32 r = i & 0xff; R[(i >> 8) & 7] = r; if (setf) set_nz(r); return; } // MOV imm8
  case 5: add_with_carry(R[(i >> 8) & 7], ~(i & 0xff), 1, 1); return;              // CMP imm8
  case 6: { u32 d = (i >> 8) & 7; R[d] = add_with_carry(R[d], i & 0xff, 0, setf); return; }
  case 7: { u32 d = (i >> 8) & 7; R[d] = add_with_carry(R[d], ~(i & 0xff), 1, setf); return; }
  case 8:
    if (!(i & 0x400)) { // data processing
      u32 rd = i & 7, a = R[rd], b = R[(i >> 3) & 7], r, c;
      switch ((i >> 6) & 15) {
      case 0: r = a & b; if (setf) set_nz(r); R[rd] = r; return;
      case 1: r = a ^ b; if (setf) set_nz(r); R[rd] = r; return;
      case 2: r = shift_reg(a, 0, b, &c); goto shift;
      case 3: r = shift_reg(a, 1, b, &c); goto shift;
      case 4: r = shift_reg(a, 2, b, &c); goto shift;
      case 5: R[rd] = add_with_carry(a, b, fC, setf); return;
      case 6: R[rd] = add_with_carry(a, ~b, fC, setf); return;
      case 7: r = shift_reg(a, 3, b, &c); goto shift;
      case 8: r = a & b; set_nz(r); return;
      case 9: R[rd] = add_with_carry(~b, 0, 1, setf); return; // RSB #0
      case 10: add_with_carry(a, ~b, 1, 1); return;
      case 11: add_with_carry(a, b, 0, 1); return;
      case 12: r = a | b; if (setf) set_nz(r); R[rd] = r; return;
      case 13: r = a * b; if (setf) set_nz(r); R[rd] = r; return;
      case 14: r = a & ~b; if (setf) set_nz(r); R[rd] = r; return;
      default: r = ~b; if (setf) set_nz(r); R[rd] = r; return;
      }
    shift:
      if (setf) { set_nz(r); fC = c; }
      R[rd] = r;
      return;
    } else { // special data and branch exchange
      u32 rm = (i >> 3) & 15, rd = (i & 7) | ((i >> 4) & 8);
      switch ((i >> 8) & 3) {
      case 0: {
        u32 r = R[rd] + R[rm];
        if (rd == 15) t_branch(r);
        else R[rd] = r;
        return;
      }
      case 1: add_with_carry(R[rd], ~R[rm], 1, 1); return;
      case 2:
        if (rd == 15) t_branch(R[rm]);
        else R[rd] = R[rm];
        return;
      default: {
        u32 t = R[rm];
        if (i & 0x80) R[14] = (pc + 2) | 1;
        write_pc_interwork(t);
        return;
      }
      }
    }
  case 9: R[(i >> 8) & 7] = rd32(((pc + 4) & ~3u) + (i & 0xff) * 4); return; // LDR literal
  case 10: case 11: { // load/store register offset
    u32 rt = i & 7, addr = R[(i >> 3) & 7] + R[(i >> 6) & 7];
    switch ((i >> 9) & 7) {
    case 0: wr32(addr, R[rt]); return;
    case 1: wr16(addr, (u16)R[rt]); return;
    case 2: wr8(addr, (u8)R[rt]); return;
    case 3: R[rt] = (u32)(s32)(s8)rd8(addr); return;
    case 4: R[rt] = rd32(addr); return;
    case 5: R[rt] = rd16(addr); return;
    case 6: R[rt] = rd8(addr); return;
    default: R[rt] = (u32)(s32)(s16)rd16(addr); return;
    }
  }
  case 12: wr32(R[(i >> 3) & 7] + ((i >> 6) & 31) * 4, R[i & 7]); return;
  case 13: R[i & 7] = rd32(R[(i >> 3) & 7] + ((i >> 6) & 31) * 4); return;
  case 14: wr8(R[(i >> 3) & 7] + ((i >> 6) & 31), (u8)R[i & 7]); return;
  case 15: R[i & 7] = rd8(R[(i >> 3) & 7] + ((i >> 6) & 31)); return;
  case 16: wr16(R[(i >> 3) & 7] + ((i >> 6) & 31) * 2, (u16)R[i & 7]); return;
  case 17: R[i & 7] = rd16(R[(i >> 3) & 7] + ((i >> 6) & 31) * 2); return;
  case 18: wr32(R[13] + (i & 0xff) * 4, R[(i >> 8) & 7]); return;
  case 19: R[(i >> 8) & 7] = rd32(R[13] + (i & 0xff) * 4); return;
  case 20: R[(i >> 8) & 7] = ((pc + 4) & ~3u) + (i & 0xff) * 4; return; // ADR
  case 21: R[(i >> 8) & 7] = R[13] + (i & 0xff) * 4; return;            // ADD Rd, SP, #imm
  case 22: case 23: // miscellaneous
    switch ((i >> 8) & 15) {
    case 0:
      if (i & 0x80) R[13] -= (i & 0x7f) * 4;
      else R[13] += (i & 0x7f) * 4;
      return;
    case 1: case 3: case 9: case 11: { // CBZ / CBNZ
      u32 nz = (i >> 11) & 1;
      u32 off = (((i >> 9) & 1) << 6) | (((i >> 3) & 31) << 1);
      if ((R[i & 7] != 0) == nz) cpu_pc = pc + 4 + off;
      return;
    }
    case 2: {
      u32 m = R[(i >> 3) & 7], d = i & 7;
      switch ((i >> 6) & 3) {
      case 0: R[d] = (u32)(s32)(s16)m; return;
      case 1: R[d] = (u32)(s32)(s8)m; return;
      case 2: R[d] = m & 0xffff; return;
      default: R[d] = m & 0xff; return;
      }
    }
    case 4: case 5: t_push((i & 0xff) | ((i & 0x100) ? 0x4000 : 0)); return;
    case 6: return; // SETEND / CPS
    case 10: {
      u32 m = R[(i >> 3) & 7], d = i & 7;
      switch ((i >> 6) & 3) {
      case 0: R[d] = __builtin_bswap32(m); return;
      case 1: R[d] = ((m & 0x00ff00ff) << 8) | ((m >> 8) & 0x00ff00ff); return;
      case 3: R[d] = (u32)(s32)(s16)(((m & 0xff) << 8) | ((m >> 8) & 0xff)); return;
      default: break;
      }
      break;
    }
    case 12: case 13: t_pop((i & 0xff) | ((i & 0x100) ? 0x8000 : 0)); return;
    case 14: cpu_fail("bkpt", pc, i); return;
    case 15:
      if (i & 15) it_state = i & 0xff;
      return; // hints (NOP, YIELD, WFE, WFI, SEV)
    default: break;
    }
    cpu_fail("thumb misc", pc, i);
    return;
  case 24: { // STMIA Rn!
    u32 rn = (i >> 8) & 7, addr = R[rn];
    for (u32 k = 0; k < 8; k++)
      if (i & (1u << k)) { wr32(addr, R[k]); addr += 4; }
    R[rn] = addr;
    return;
  }
  case 25: { // LDMIA Rn(!)
    u32 rn = (i >> 8) & 7, addr = R[rn];
    if (!(i & (1u << rn))) R[rn] = addr + 4 * __builtin_popcount(i & 0xff);
    for (u32 k = 0; k < 8; k++)
      if (i & (1u << k)) { R[k] = rd32(addr); addr += 4; }
    return;
  }
  case 26: case 27: {
    u32 c = (i >> 8) & 15;
    if (c >= 14) { cpu_fail(c == 15 ? "svc" : "udf", pc, i); return; }
    if (cond_pass(c)) cpu_pc = pc + 4 + (u32)((s32)(s8)(i & 0xff) * 2);
    return;
  }
  case 28: cpu_pc = pc + 4 + (u32)(((s32)(i << 21)) >> 20); return; // B imm11
  default: cpu_fail("thumb 32-bit prefix", pc, i); return;
  }
}

// ---------------------------------------------------------------------------------------------
// 32-bit encodings

static inline __attribute__((always_inline)) u32 thumb_expand_imm(u32 imm12, u32 *carry) {
  u32 v = imm12 & 0xff;
  if (!(imm12 & 0xc00)) {
    *carry = fC;
    switch ((imm12 >> 8) & 3) {
    case 0: return v;
    case 1: return v | (v << 16);
    case 2: return (v << 8) | (v << 24);
    default: return v | (v << 8) | (v << 16) | (v << 24);
    }
  }
  u32 r = ror32(0x80 | (imm12 & 0x7f), (imm12 >> 7) & 31);
  *carry = r >> 31;
  return r;
}

// data processing with shifted register or modified immediate
static inline __attribute__((always_inline)) void t32_dp(u32 op, u32 s, u32 rn, u32 rd, u32 b, u32 sc, u32 pc, u32 insn) {
  u32 a = R[rn], r;
  switch (op) {
  case 0: r = a & b; if (rd == 15 && s) { set_nz(r); fC = sc; return; } goto logic; // AND / TST
  case 1: r = a & ~b; goto logic;
  case 2: r = rn == 15 ? b : a | b; goto logic;   // ORR / MOV
  case 3: r = rn == 15 ? ~b : a | ~b; goto logic; // ORN / MVN
  case 4: r = a ^ b; if (rd == 15 && s) { set_nz(r); fC = sc; return; } goto logic; // EOR / TEQ
  case 8: // ADD / CMN
    if (rd == 15 && s) { add_with_carry(a, b, 0, 1); return; }
    R[rd] = add_with_carry(a, b, 0, s);
    return;
  case 10: R[rd] = add_with_carry(a, b, fC, s); return;
  case 11: R[rd] = add_with_carry(a, ~b, fC, s); return;
  case 13: // SUB / CMP
    if (rd == 15 && s) { add_with_carry(a, ~b, 1, 1); return; }
    R[rd] = add_with_carry(a, ~b, 1, s);
    return;
  case 14: R[rd] = add_with_carry(b, ~a, 1, s); return;
  default: cpu_fail("thumb2 data processing", pc, insn); return;
  }
logic:
  if (s) { set_nz(r); fC = sc; }
  R[rd] = r;
}

static inline __attribute__((always_inline)) void t32_ldst_multiple(u32 hw1, u32 hw2, u32 pc) {
  u32 rn = hw1 & 15, list = hw2, l = (hw1 >> 4) & 1, w = (hw1 >> 5) & 1;
  u32 n = __builtin_popcount(list);
  u32 base = R[rn];
  u32 ia = ((hw1 >> 7) & 3) == 1;
  if (((hw1 >> 7) & 3) != 1 && ((hw1 >> 7) & 3) != 2) { cpu_fail("thumb2 rfe/srs", pc, (hw1 << 16) | hw2); return; }
  u32 addr = ia ? base : base - 4 * n;
  u32 newbase = ia ? base + 4 * n : base - 4 * n;
  if (l) {
    if (w) R[rn] = newbase;
    for (u32 k = 0; k < 15; k++)
      if (list & (1u << k)) { R[k] = rd32(addr); addr += 4; }
    if (list & 0x8000) write_pc_interwork(rd32(addr));
  } else {
    for (u32 k = 0; k < 15; k++)
      if (list & (1u << k)) { wr32(addr, R[k]); addr += 4; }
    if (w) R[rn] = newbase;
  }
}

static inline __attribute__((always_inline)) void t32_dual_excl(u32 hw1, u32 hw2, u32 pc) {
  u32 t1 = (hw1 >> 7) & 3, t2 = (hw1 >> 4) & 3, t3 = (hw2 >> 4) & 15;
  u32 rn = hw1 & 15, rt = hw2 >> 12, rt2 = (hw2 >> 8) & 15;
  if ((t1 & 2) || (t2 & 2)) { // LDRD / STRD
    u32 p = (hw1 >> 8) & 1, u = (hw1 >> 7) & 1, w = (hw1 >> 5) & 1, l = (hw1 >> 4) & 1;
    u32 imm = (hw2 & 0xff) * 4;
    u32 base = rn == 15 ? (R[15] & ~3u) : R[rn];
    u32 off = u ? base + imm : base - imm;
    u32 addr = p ? off : base;
    if (l) {
      u32 lo = rd32(addr), hi = rd32(addr + 4);
      if (w) R[rn] = off;
      R[rt] = lo;
      R[rt2] = hi;
    } else {
      wr32(addr, R[rt]);
      wr32(addr + 4, R[rt2]);
      if (w) R[rn] = off;
    }
    return;
  }
  if (t1 == 0 && t2 == 0) { // STREX
    u32 addr = R[rn] + (hw2 & 0xff) * 4;
    if (excl_addr == addr) { wr32(addr, R[rt]); R[rt2] = 0; }
    else R[rt2] = 1;
    excl_addr = ~0u;
    return;
  }
  if (t1 == 0 && t2 == 1) { // LDREX
    u32 addr = R[rn] + (hw2 & 0xff) * 4;
    excl_addr = addr;
    R[rt] = rd32(addr);
    return;
  }
  if (t1 == 1 && t2 == 0) { // STREXB/H/D
    u32 addr = R[rn], rd = hw2 & 15;
    if (excl_addr == addr) {
      if (t3 == 4) wr8(addr, (u8)R[rt]);
      else if (t3 == 5) wr16(addr, (u16)R[rt]);
      else { wr32(addr, R[rt]); wr32(addr + 4, R[rt2]); }
      R[rd] = 0;
    } else R[rd] = 1;
    excl_addr = ~0u;
    return;
  }
  // t1 == 1, t2 == 1: TBB/TBH, LDREXB/H/D
  u32 rm = hw2 & 15;
  if (t3 == 0) { cpu_pc = pc + 4 + 2 * rd8(R[rn] + R[rm]); return; }
  if (t3 == 1) { cpu_pc = pc + 4 + 2 * rd16(R[rn] + R[rm] * 2); return; }
  u32 addr = R[rn];
  excl_addr = addr;
  if (t3 == 4) R[rt] = rd8(addr);
  else if (t3 == 5) R[rt] = rd16(addr);
  else { R[rt] = rd32(addr); R[rt2] = rd32(addr + 4); }
}

static inline __attribute__((always_inline)) void t32_plain_imm(u32 hw1, u32 hw2, u32 pc) {
  u32 op = (hw1 >> 4) & 31, rn = hw1 & 15, rd = (hw2 >> 8) & 15;
  u32 imm12 = ((hw1 >> 10) & 1) << 11 | ((hw2 >> 12) & 7) << 8 | (hw2 & 0xff);
  u32 lsb = ((hw2 >> 12) & 7) << 2 | ((hw2 >> 6) & 3);
  u32 low5 = hw2 & 31;
  switch (op) {
  case 0: R[rd] = (rn == 15 ? (R[15] & ~3u) : R[rn]) + imm12; return; // ADDW / ADR
  case 10: R[rd] = (rn == 15 ? (R[15] & ~3u) : R[rn]) - imm12; return; // SUBW / ADR
  case 4: R[rd] = (rn << 12) | imm12; return;                         // MOVW
  case 12: R[rd] = (R[rd] & 0xffff) | (((rn << 12) | imm12) << 16); return; // MOVT
  case 16: case 18: { // SSAT
    u32 c, v = shift_imm(R[rn], ((hw1 >> 5) & 1) ? 2 : 0, lsb, &c);
    if (op == 18 && !lsb) { // SSAT16
      u32 n = low5 + 1;
      u32 lo = ssat((s16)v, n) & 0xffff, hi = ssat((s16)(v >> 16), n) & 0xffff;
      R[rd] = lo | (hi << 16);
      return;
    }
    R[rd] = ssat((s32)v, low5 + 1);
    return;
  }
  case 24: case 26: { // USAT
    u32 c, v = shift_imm(R[rn], ((hw1 >> 5) & 1) ? 2 : 0, lsb, &c);
    if (op == 26 && !lsb) {
      u32 lo = usat((s16)v, low5) & 0xffff, hi = usat((s16)(v >> 16), low5) & 0xffff;
      R[rd] = lo | (hi << 16);
      return;
    }
    R[rd] = usat((s32)v, low5);
    return;
  }
  case 20: case 28: { // SBFX / UBFX
    u32 width = low5 + 1;
    u32 v = R[rn] >> lsb;
    if (width < 32) {
      v &= (1u << width) - 1;
      if (op == 20 && ((v >> (width - 1)) & 1)) v |= ~0u << width;
    }
    R[rd] = v;
    return;
  }
  case 22: { // BFI / BFC
    u32 msb = low5;
    if (msb < lsb) return;
    u32 w = msb - lsb + 1;
    u32 mask = (w >= 32 ? ~0u : ((1u << w) - 1)) << lsb;
    u32 src = rn == 15 ? 0 : R[rn] << lsb;
    R[rd] = (R[rd] & ~mask) | (src & mask);
    return;
  }
  default: cpu_fail("thumb2 plain immediate", pc, (hw1 << 16) | hw2); return;
  }
}

static inline __attribute__((always_inline)) void t32_branch_misc(u32 hw1, u32 hw2, u32 pc) {
  u32 s = (hw1 >> 10) & 1, j1 = (hw2 >> 13) & 1, j2 = (hw2 >> 11) & 1;
  u32 k = ((hw2 >> 12) & 1) | (((hw2 >> 14) & 1) << 1);
  if (k == 0) {
    if (((hw1 >> 7) & 7) != 7) { // B<cond> T3
      u32 c = (hw1 >> 6) & 15;
      if (!cond_pass(c)) return;
      u32 imm = (s << 20) | (j2 << 19) | (j1 << 18) | ((hw1 & 63) << 12) | ((hw2 & 0x7ff) << 1);
      cpu_pc = pc + 4 + (u32)(((s32)(imm << 11)) >> 11);
      return;
    }
    u32 op = (hw1 >> 4) & 0x7f;
    if (op == 0x3a || op == 0x3b) { // hints, barriers, CLREX
      if (op == 0x3b && ((hw2 >> 4) & 15) == 2) excl_addr = ~0u;
      return;
    }
    if (op == 0x38 || op == 0x39) { // MSR
      if (hw2 & 0x800) set_nzcvq(R[hw1 & 15]);
      return;
    }
    if (op == 0x3e || op == 0x3f) { R[(hw2 >> 8) & 15] = cpsr_value(); return; } // MRS
    cpu_fail("thumb2 misc control", pc, (hw1 << 16) | hw2);
    return;
  }
  u32 i1 = !(j1 ^ s), i2 = !(j2 ^ s);
  u32 imm = (s << 24) | (i1 << 23) | (i2 << 22) | ((hw1 & 0x3ff) << 12) | ((hw2 & 0x7ff) << 1);
  s32 off = ((s32)(imm << 7)) >> 7;
  if (k == 1) { cpu_pc = pc + 4 + (u32)off; return; } // B T4
  R[14] = (pc + 4) | 1;
  if (k == 3) { cpu_pc = pc + 4 + (u32)off; return; } // BL
  fT = 0; // BLX imm: to ARM
  cpu_pc = (((pc + 4) & ~3u) + (u32)off) & ~3u;
}

static inline __attribute__((always_inline)) void t32_ldst_single(u32 hw1, u32 hw2, u32 pc) {
  u32 sgn = (hw1 >> 8) & 1, size = (hw1 >> 5) & 3, l = (hw1 >> 4) & 1, rn = hw1 & 15, rt = hw2 >> 12;
  u32 addr;
  if (rn == 15) {
    u32 base = R[15] & ~3u, imm = hw2 & 0xfff;
    addr = (hw1 & 0x80) ? base + imm : base - imm;
  } else if (hw1 & 0x80) {
    addr = R[rn] + (hw2 & 0xfff);
  } else if (hw2 & 0x800) {
    u32 imm = hw2 & 0xff, p = (hw2 >> 10) & 1, u = (hw2 >> 9) & 1, w = (hw2 >> 8) & 1;
    u32 base = R[rn];
    u32 off = u ? base + imm : base - imm;
    addr = p ? off : base;
    if (w) {
      if (l) {
        u32 v = t_load(addr, size, sgn);
        R[rn] = off;
        if (rt == 15) { if (size == 2) write_pc_interwork(v); }
        else R[rt] = v;
      } else {
        t_store(addr, size, R[rt]);
        R[rn] = off;
      }
      return;
    }
  } else if (!(hw2 & 0xfc0)) {
    addr = R[rn] + (R[hw2 & 15] << ((hw2 >> 4) & 3));
  } else {
    cpu_fail("thumb2 load/store", pc, (hw1 << 16) | hw2);
    return;
  }
  if (l) {
    if (rt == 15) {
      if (size == 2) write_pc_interwork(rd32(addr));
      return; // PLD / PLI
    }
    R[rt] = t_load(addr, size, sgn);
  } else {
    t_store(addr, size, R[rt]);
  }
}

static inline __attribute__((always_inline)) void t32_dp_reg(u32 hw1, u32 hw2, u32 pc) {
  u32 op1 = (hw1 >> 4) & 15, op2 = (hw2 >> 4) & 15;
  u32 rn = hw1 & 15, rd = (hw2 >> 8) & 15, rm = hw2 & 15;
  if (!(op1 & 8)) {
    if (op2 == 0) { // LSL/LSR/ASR/ROR register
      u32 c, r = shift_reg(R[rn], (op1 >> 1) & 3, R[rm], &c);
      if (op1 & 1) { set_nz(r); fC = c; }
      R[rd] = r;
      return;
    }
    if (op2 & 8) { // extend (and add)
      u32 v = ror32(R[rm], ((hw2 >> 4) & 3) * 8);
      u32 add = rn == 15 ? 0 : R[rn];
      switch (op1 & 7) {
      case 0: R[rd] = add + (u32)(s32)(s16)v; return;
      case 1: R[rd] = add + (v & 0xffff); return;
      case 2: R[rd] = (((add >> 16) + (u32)(s32)(s8)(v >> 16)) << 16) | ((add + (u32)(s32)(s8)v) & 0xffff); return;
      case 3: R[rd] = (((add >> 16) + ((v >> 16) & 0xff)) << 16) | ((add + (v & 0xff)) & 0xffff); return;
      case 4: R[rd] = add + (u32)(s32)(s8)v; return;
      case 5: R[rd] = add + (v & 0xff); return;
      default: break;
      }
    }
  } else if ((op1 & 0xc) == 8 && (op2 & 0xc) == 8) {
    u32 m = R[rm];
    switch (((op1 & 3) << 2) | (op2 & 3)) {
    case 0: R[rd] = ssat((s64)(s32)m + (s32)R[rn], 32); return;                        // QADD
    case 1: R[rd] = ssat((s64)(s32)m + (s32)ssat((s64)(s32)R[rn] * 2, 32), 32); return; // QDADD
    case 2: R[rd] = ssat((s64)(s32)m - (s32)R[rn], 32); return;                        // QSUB
    case 3: R[rd] = ssat((s64)(s32)m - (s32)ssat((s64)(s32)R[rn] * 2, 32), 32); return; // QDSUB
    case 4: R[rd] = __builtin_bswap32(m); return;
    case 5: R[rd] = ((m & 0x00ff00ff) << 8) | ((m >> 8) & 0x00ff00ff); return;
    case 6: R[rd] = rbit(m); return;
    case 7: R[rd] = (u32)(s32)(s16)(((m & 0xff) << 8) | ((m >> 8) & 0xff)); return;
    case 12: R[rd] = m ? __builtin_clz(m) : 32; return;
    default: break;
    }
  } else if ((op1 & 8) && (op2 & 0xc) == 0) { // parallel add/subtract (the forms compilers emit)
    u32 a = R[rn], b = R[rm], r = 0;
    u32 kind = op1 & 7, uns = (op2 >> 2) & 1; // op2[2] U, op2[1:0] = 00 plain, 01 Q, 10 H
    (void)uns;
    if ((op2 & 3) == 0 && (kind == 0 || kind == 4)) { // SADD8/UADD8 (kind 0 = ADD8 encoded with op1=1000)
      for (int k = 0; k < 32; k += 8) r |= (((a >> k) + (b >> k)) & 0xff) << k;
      R[rd] = r;
      return;
    }
  }
  cpu_fail("thumb2 register data processing", pc, (hw1 << 16) | hw2);
}

static inline __attribute__((always_inline)) void t32_multiply(u32 hw1, u32 hw2, u32 pc) {
  u32 op1 = (hw1 >> 4) & 7, op2 = (hw2 >> 4) & 3;
  u32 rn = hw1 & 15, ra = hw2 >> 12, rd = (hw2 >> 8) & 15, rm = hw2 & 15;
  u32 a = R[rn], b = R[rm];
  switch (op1) {
  case 0:
    if (op2 == 0) { R[rd] = a * b + (ra == 15 ? 0 : R[ra]); return; }
    if (op2 == 1) { R[rd] = R[ra] - a * b; return; }
    break;
  case 1: { // SMLAxy / SMULxy
    s32 x = (hw2 & 0x20) ? (s16)(a >> 16) : (s16)a;
    s32 y = (hw2 & 0x10) ? (s16)(b >> 16) : (s16)b;
    s64 r = (s64)x * y;
    if (ra != 15) { r += (s32)R[ra]; if (r != (s32)r) fQ = 1; }
    R[rd] = (u32)r;
    return;
  }
  case 2: case 4: { // SMLAD/SMUAD, SMLSD/SMUSD
    u32 bb = (hw2 & 0x10) ? ror32(b, 16) : b;
    s64 p1 = (s64)(s16)a * (s16)bb, p2 = (s64)(s16)(a >> 16) * (s16)(bb >> 16);
    s64 r = op1 == 2 ? p1 + p2 : p1 - p2;
    if (ra != 15) r += (s32)R[ra];
    if (r != (s32)r) fQ = 1;
    R[rd] = (u32)r;
    return;
  }
  case 3: { // SMLAWy / SMULWy
    s32 y = (hw2 & 0x10) ? (s16)(b >> 16) : (s16)b;
    s64 r = ((s64)(s32)a * y) >> 16;
    if (ra != 15) { r += (s32)R[ra]; if (r != (s32)r) fQ = 1; }
    R[rd] = (u32)r;
    return;
  }
  case 5: case 6: { // SMMLA/SMMUL, SMMLS
    s64 p = (s64)(s32)a * (s32)b;
    s64 acc = ra == 15 ? 0 : (s64)((u64)R[ra] << 32);
    s64 r = op1 == 5 ? acc + p : acc - p;
    if (hw2 & 0x10) r += 0x80000000LL;
    R[rd] = (u32)((u64)r >> 32);
    return;
  }
  case 7:
    if (op2 == 0) {
      u32 s = 0;
      for (int k = 0; k < 32; k += 8) {
        int x = (int)((a >> k) & 0xff) - (int)((b >> k) & 0xff);
        s += x < 0 ? -x : x;
      }
      R[rd] = s + (ra == 15 ? 0 : R[ra]);
      return;
    }
    break;
  }
  cpu_fail("thumb2 multiply", pc, (hw1 << 16) | hw2);
}

static inline __attribute__((always_inline)) void t32_long_multiply(u32 hw1, u32 hw2, u32 pc) {
  u32 op1 = (hw1 >> 4) & 7, op2 = (hw2 >> 4) & 15;
  u32 rn = hw1 & 15, lo = hw2 >> 12, hi = (hw2 >> 8) & 15, rm = hw2 & 15;
  u32 a = R[rn], b = R[rm];
  switch (op1) {
  case 0: { u64 r = (u64)((s64)(s32)a * (s32)b); R[lo] = (u32)r; R[hi] = (u32)(r >> 32); return; }
  case 1: R[hi] = b ? ((s32)a == (s32)0x80000000 && (s32)b == -1 ? a : (u32)((s32)a / (s32)b)) : 0; return; // SDIV
  case 2: { u64 r = (u64)a * b; R[lo] = (u32)r; R[hi] = (u32)(r >> 32); return; }
  case 3: R[hi] = b ? a / b : 0; return; // UDIV
  case 4:
    if (op2 == 0) {
      u64 r = (u64)((s64)(s32)a * (s32)b) + (((u64)R[hi] << 32) | R[lo]);
      R[lo] = (u32)r;
      R[hi] = (u32)(r >> 32);
      return;
    }
    if ((op2 & 0xc) == 8) { // SMLALxy
      s32 x = (op2 & 2) ? (s16)(a >> 16) : (s16)a;
      s32 y = (op2 & 1) ? (s16)(b >> 16) : (s16)b;
      u64 r = (u64)((s64)x * y) + (((u64)R[hi] << 32) | R[lo]);
      R[lo] = (u32)r;
      R[hi] = (u32)(r >> 32);
      return;
    }
    break;
  case 6:
    if (op2 == 0) {
      u64 r = (u64)a * b + (((u64)R[hi] << 32) | R[lo]);
      R[lo] = (u32)r;
      R[hi] = (u32)(r >> 32);
      return;
    }
    if (op2 == 6) {
      u64 r = (u64)a * b + R[lo] + R[hi];
      R[lo] = (u32)r;
      R[hi] = (u32)(r >> 32);
      return;
    }
    break;
  }
  cpu_fail("thumb2 long multiply", pc, (hw1 << 16) | hw2);
}

static inline __attribute__((always_inline)) void exec_t32(u32 hw1, u32 hw2, u32 pc) {
  u32 op1 = (hw1 >> 11) & 3, op2 = (hw1 >> 4) & 0x7f;
  if (op1 == 1) {
    if ((op2 & 0x64) == 0x00) { t32_ldst_multiple(hw1, hw2, pc); return; }
    if ((op2 & 0x64) == 0x04) { t32_dual_excl(hw1, hw2, pc); return; }
    if ((op2 & 0x60) == 0x20) {
      u32 c, b = shift_imm(R[hw2 & 15], (hw2 >> 4) & 3, ((hw2 >> 10) & 0x1c) | ((hw2 >> 6) & 3), &c);
      u32 op = (hw1 >> 5) & 15;
      if (op == 6) { // PKHBT / PKHTB
        u32 rd = (hw2 >> 8) & 15, a = R[hw1 & 15];
        R[rd] = (hw2 & 0x20) ? ((a & 0xffff0000) | (b & 0xffff)) : ((b & 0xffff0000) | (a & 0xffff));
        return;
      }
      t32_dp(op, (hw1 >> 4) & 1, hw1 & 15, (hw2 >> 8) & 15, b, c, pc, (hw1 << 16) | hw2);
      return;
    }
    exec_vfp((hw1 << 16) | hw2, pc);
    return;
  }
  if (op1 == 2) {
    if (hw2 & 0x8000) { t32_branch_misc(hw1, hw2, pc); return; }
    if (hw1 & 0x200) { t32_plain_imm(hw1, hw2, pc); return; }
    u32 imm12 = ((hw1 >> 10) & 1) << 11 | ((hw2 >> 12) & 7) << 8 | (hw2 & 0xff);
    u32 c, b = thumb_expand_imm(imm12, &c);
    t32_dp((hw1 >> 5) & 15, (hw1 >> 4) & 1, hw1 & 15, (hw2 >> 8) & 15, b, c, pc, (hw1 << 16) | hw2);
    return;
  }
  // op1 == 3
  if ((op2 & 0x60) == 0x00) { t32_ldst_single(hw1, hw2, pc); return; }
  if ((op2 & 0x70) == 0x20) { t32_dp_reg(hw1, hw2, pc); return; }
  if ((op2 & 0x78) == 0x30) { t32_multiply(hw1, hw2, pc); return; }
  if ((op2 & 0x78) == 0x38) { t32_long_multiply(hw1, hw2, pc); return; }
  exec_vfp((hw1 << 16) | hw2, pc);
}
