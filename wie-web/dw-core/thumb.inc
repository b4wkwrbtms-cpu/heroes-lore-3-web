// Thumb (ARMv5T) instruction set, included by cpu.c. R[15] reads as the instruction address + 4.

static inline void set_nz(u32 r) { fN = r >> 31; fZ = !r; }
static inline u32 t_add(u32 a, u32 b) {
  u32 r = a + b;
  set_nz(r);
  fC = r < a;
  fV = (~(a ^ b) & (a ^ r)) >> 31;
  return r;
}
static inline u32 t_sub(u32 a, u32 b) {
  u32 r = a - b;
  set_nz(r);
  fC = a >= b;
  fV = ((a ^ b) & (a ^ r)) >> 31;
  return r;
}
static inline u32 t_adc(u32 a, u32 b) {
  u64 t = (u64)a + b + fC;
  u32 r = (u32)t;
  set_nz(r);
  fC = (u32)(t >> 32);
  fV = (~(a ^ b) & (a ^ r)) >> 31;
  return r;
}
static inline u32 t_sbc(u32 a, u32 b) {
  u32 borrow = !fC;
  u32 r = a - b - borrow;
  set_nz(r);
  fC = (u64)a >= (u64)b + borrow;
  fV = ((a ^ b) & (a ^ r)) >> 31;
  return r;
}
// shifts by a register amount (low byte), as the Thumb ALU LSL/LSR/ASR/ROR
static inline u32 t_shift(u32 type, u32 v, u32 s) {
  s &= 0xff;
  if (!s) { set_nz(v); return v; }
  u32 r;
  switch (type) {
  case 0:
    if (s < 32) { fC = (v >> (32 - s)) & 1; r = v << s; }
    else { fC = s == 32 ? v & 1 : 0; r = 0; }
    break;
  case 1:
    if (s < 32) { fC = (v >> (s - 1)) & 1; r = v >> s; }
    else { fC = s == 32 ? v >> 31 : 0; r = 0; }
    break;
  case 2:
    if (s < 32) { fC = (v >> (s - 1)) & 1; r = (u32)((s32)v >> s); }
    else { fC = v >> 31; r = (u32)((s32)v >> 31); }
    break;
  default: {
    u32 k = s & 31;
    if (!k) { fC = v >> 31; r = v; }
    else { fC = (v >> (k - 1)) & 1; r = (v >> k) | (v << (32 - k)); }
  }
  }
  set_nz(r);
  return r;
}

static void exec_thumb(u32 insn, u32 pc) {
  switch (insn >> 11) {
  case 0: case 1: case 2: { // LSL/LSR/ASR #imm5
    u32 rd = insn & 7, v = R[(insn >> 3) & 7], amt = (insn >> 6) & 31, op = insn >> 11, r;
    if (op == 0) {
      if (!amt) r = v;
      else { fC = (v >> (32 - amt)) & 1; r = v << amt; }
    } else if (op == 1) {
      if (!amt) { fC = v >> 31; r = 0; }
      else { fC = (v >> (amt - 1)) & 1; r = v >> amt; }
    } else {
      if (!amt) { fC = v >> 31; r = (u32)((s32)v >> 31); }
      else { fC = (v >> (amt - 1)) & 1; r = (u32)((s32)v >> amt); }
    }
    set_nz(r);
    R[rd] = r;
    return;
  }
  case 3: { // ADD/SUB register or imm3
    u32 rd = insn & 7, a = R[(insn >> 3) & 7];
    u32 b = (insn & 0x400) ? (insn >> 6) & 7 : R[(insn >> 6) & 7];
    R[rd] = (insn & 0x200) ? t_sub(a, b) : t_add(a, b);
    return;
  }
  case 4: { u32 r = insn & 0xff; R[(insn >> 8) & 7] = r; set_nz(r); return; } // MOV #imm8
  case 5: t_sub(R[(insn >> 8) & 7], insn & 0xff); return;                     // CMP #imm8
  case 6: { u32 rd = (insn >> 8) & 7; R[rd] = t_add(R[rd], insn & 0xff); return; }
  case 7: { u32 rd = (insn >> 8) & 7; R[rd] = t_sub(R[rd], insn & 0xff); return; }
  case 8:
    if (!(insn & 0x400)) { // ALU
      u32 rd = insn & 7, rm = (insn >> 3) & 7;
      u32 a = R[rd], b = R[rm];
      switch ((insn >> 6) & 15) {
      case 0: R[rd] = a & b; set_nz(R[rd]); return;
      case 1: R[rd] = a ^ b; set_nz(R[rd]); return;
      case 2: R[rd] = t_shift(0, a, b); return;
      case 3: R[rd] = t_shift(1, a, b); return;
      case 4: R[rd] = t_shift(2, a, b); return;
      case 5: R[rd] = t_adc(a, b); return;
      case 6: R[rd] = t_sbc(a, b); return;
      case 7: R[rd] = t_shift(3, a, b); return;
      case 8: set_nz(a & b); return;
      case 9: R[rd] = t_sub(0, b); return;
      case 10: t_sub(a, b); return;
      case 11: t_add(a, b); return;
      case 12: R[rd] = a | b; set_nz(R[rd]); return;
      case 13: R[rd] = a * b; set_nz(R[rd]); return;
      case 14: R[rd] = a & ~b; set_nz(R[rd]); return;
      default: R[rd] = ~b; set_nz(R[rd]); return;
      }
    } else { // high registers, BX/BLX
      u32 rd = (insn & 7) | ((insn >> 4) & 8), rm = (insn >> 3) & 15;
      u32 b = R[rm];
      switch ((insn >> 8) & 3) {
      case 0: {
        u32 r = R[rd] + b;
        if (rd == 15) cpu_pc = r & ~1u;
        else R[rd] = r;
        return;
      }
      case 1: t_sub(R[rd], b); return;
      case 2:
        if (rd == 15) cpu_pc = b & ~1u;
        else R[rd] = b;
        return;
      default:
        if (insn & 0x80) {
          R[14] = (pc + 2) | 1;
          if (trace_calls && ntrace < TRACE_MAX) trace_buf[ntrace++] = b;
        }
        write_pc_interwork(b, insn);
        return;
      }
    }
  case 9: R[(insn >> 8) & 7] = rd32((R[15] & ~3u) + (insn & 0xff) * 4); return; // LDR pc-relative
  case 10: case 11: { // load/store register offset
    u32 rd = insn & 7, addr = R[(insn >> 3) & 7] + R[(insn >> 6) & 7];
    switch ((insn >> 9) & 7) {
    case 0: wr32(addr, R[rd]); return;
    case 1: wr16(addr, (u16)R[rd]); return;
    case 2: wr8(addr, (u8)R[rd]); return;
    case 3: R[rd] = (u32)(s32)(s8)rd8(addr); return;
    case 4: R[rd] = rd32(addr); return;
    case 5: R[rd] = rd16(addr); return;
    case 6: R[rd] = rd8(addr); return;
    default: R[rd] = (u32)(s32)(s16)rd16(addr); return;
    }
  }
  case 12: wr32(R[(insn >> 3) & 7] + ((insn >> 6) & 31) * 4, R[insn & 7]); return;
  case 13: R[insn & 7] = rd32(R[(insn >> 3) & 7] + ((insn >> 6) & 31) * 4); return;
  case 14: wr8(R[(insn >> 3) & 7] + ((insn >> 6) & 31), (u8)R[insn & 7]); return;
  case 15: R[insn & 7] = rd8(R[(insn >> 3) & 7] + ((insn >> 6) & 31)); return;
  case 16: wr16(R[(insn >> 3) & 7] + ((insn >> 6) & 31) * 2, (u16)R[insn & 7]); return;
  case 17: R[insn & 7] = rd16(R[(insn >> 3) & 7] + ((insn >> 6) & 31) * 2); return;
  case 18: wr32(R[13] + (insn & 0xff) * 4, R[(insn >> 8) & 7]); return;
  case 19: R[(insn >> 8) & 7] = rd32(R[13] + (insn & 0xff) * 4); return;
  case 20: R[(insn >> 8) & 7] = (R[15] & ~3u) + (insn & 0xff) * 4; return;
  case 21: R[(insn >> 8) & 7] = R[13] + (insn & 0xff) * 4; return;
  case 22: case 23:
    switch ((insn >> 8) & 15) {
    case 0: // ADD/SUB SP, #imm7*4
      if (insn & 0x80) R[13] -= (insn & 0x7f) * 4;
      else R[13] += (insn & 0x7f) * 4;
      return;
    case 4: case 5: { // PUSH {list, lr}
      u32 list = insn & 0xff, n = __builtin_popcount(list) + ((insn >> 8) & 1);
      u32 addr = R[13] - 4 * n;
      R[13] = addr;
      for (u32 i = 0; i < 8; i++)
        if (list & (1u << i)) { wr32(addr, R[i]); addr += 4; }
      if (insn & 0x100) wr32(addr, R[14]);
      return;
    }
    case 12: case 13: { // POP {list, pc}
      u32 list = insn & 0xff, addr = R[13];
      for (u32 i = 0; i < 8; i++)
        if (list & (1u << i)) { R[i] = rd32(addr); addr += 4; }
      if (insn & 0x100) {
        u32 v = rd32(addr);
        addr += 4;
        R[13] = addr;
        write_pc_interwork(v, insn);
        return;
      }
      R[13] = addr;
      return;
    }
    case 14: cpu_fail("thumb bkpt", pc, insn); return;
    default: cpu_fail("undefined thumb", pc, insn); return;
    }
  case 24: { // STMIA
    u32 rb = (insn >> 8) & 7, list = insn & 0xff, addr = R[rb];
    for (u32 i = 0; i < 8; i++)
      if (list & (1u << i)) { wr32(addr, R[i]); addr += 4; }
    R[rb] = addr;
    return;
  }
  case 25: { // LDMIA
    u32 rb = (insn >> 8) & 7, list = insn & 0xff, addr = R[rb];
    for (u32 i = 0; i < 8; i++)
      if (list & (1u << i)) { R[i] = rd32(addr); addr += 4; }
    if (!(list & (1u << rb))) R[rb] = addr;
    return;
  }
  case 26: case 27: { // conditional branch, SWI
    u32 c = (insn >> 8) & 15;
    if (c == 14) { cpu_hook_thumb(insn & 0xff, pc); return; } // UDF: a native fast path (fast.c)
    if (c == 15) { cpu_fail("thumb swi", pc, insn); return; }
    if (cond_pass(c)) cpu_pc = R[15] + ((s32)(insn << 24) >> 23);
    return;
  }
  case 28: cpu_pc = R[15] + ((s32)(insn << 21) >> 20); return; // B
  case 29: { // BLX suffix: to ARM
    u32 t = (R[14] + ((insn & 0x7ff) << 1)) & ~3u;
    R[14] = (pc + 2) | 1;
    if (trace_calls && ntrace < TRACE_MAX) trace_buf[ntrace++] = t;
    fT = 0;
    cpu_pc = t;
    return;
  }
  case 30: R[14] = R[15] + ((s32)(insn << 21) >> 9); return; // BL/BLX prefix
  default: { // BL suffix
    u32 t = R[14] + ((insn & 0x7ff) << 1);
    R[14] = (pc + 2) | 1;
    if (trace_calls && ntrace < TRACE_MAX) trace_buf[ntrace++] = t;
    cpu_pc = t & ~1u;
    return;
  }
  }
}
