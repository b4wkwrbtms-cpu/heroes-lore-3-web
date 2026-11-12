// ARMv5TE (ARM state only) interpreter. The game library contains no Thumb code.
#include "base.h"

u8 G[GUEST_SIZE + 64] __attribute__((aligned(16)));
u32 R[16];
u32 fN, fZ, fC, fV, fQ;
u32 cpu_pc;
u32 cpu_halt;
u64 cpu_insns;
u32 call_ret_hi;
#define TRACE_MAX 65536
static struct { u32 on, n, buf[TRACE_MAX]; } tr;
#define trace_calls tr.on
#define ntrace tr.n
#define trace_buf tr.buf
EXPORT(trace_info) u32 *trace_info(void) { return &tr.on; }

#define HALT_PC (TRAP_END - 8)
#ifdef PROFILE
static u32 prof[0x200000 >> 4];
EXPORT(prof_buf) u32 *prof_buf(void) { return prof; }
#endif

static void cpu_fail(const char *why, u32 pc, u32 insn) {
  logf("CPU halt: %s at %08x insn %08x lr=%08x sp=%08x", why, pc, insn, R[14], R[13]);
  cpu_halt = 1;
  cpu_pc = HALT_PC;
}

static inline int cond_pass(u32 c) {
  switch (c) {
  case 0: return fZ;
  case 1: return !fZ;
  case 2: return fC;
  case 3: return !fC;
  case 4: return fN;
  case 5: return !fN;
  case 6: return fV;
  case 7: return !fV;
  case 8: return fC && !fZ;
  case 9: return !fC || fZ;
  case 10: return fN == fV;
  case 11: return fN != fV;
  case 12: return !fZ && (fN == fV);
  case 13: return fZ || (fN != fV);
  default: return 1;
  }
}

static inline u32 cpsr_value(void) { return (fN << 31) | (fZ << 30) | (fC << 29) | (fV << 28) | (fQ << 27) | 0x10; }

static inline u32 op2_imm_shift(u32 insn, u32 *carry) {
  u32 rm = R[insn & 15];
  u32 amt = (insn >> 7) & 31;
  switch ((insn >> 5) & 3) {
  case 0:
    if (!amt) { *carry = fC; return rm; }
    *carry = (rm >> (32 - amt)) & 1;
    return rm << amt;
  case 1:
    if (!amt) { *carry = rm >> 31; return 0; }
    *carry = (rm >> (amt - 1)) & 1;
    return rm >> amt;
  case 2:
    if (!amt) { *carry = rm >> 31; return (u32)((s32)rm >> 31); }
    *carry = (rm >> (amt - 1)) & 1;
    return (u32)((s32)rm >> amt);
  default:
    if (!amt) { *carry = rm & 1; return (fC << 31) | (rm >> 1); }
    *carry = (rm >> (amt - 1)) & 1;
    return (rm >> amt) | (rm << (32 - amt));
  }
}

static inline u32 op2_reg_shift(u32 insn, u32 *carry) {
  u32 rm = R[insn & 15];
  if ((insn & 15) == 15) rm += 4;
  u32 s = R[(insn >> 8) & 15] & 0xff;
  if (!s) { *carry = fC; return rm; }
  switch ((insn >> 5) & 3) {
  case 0:
    if (s < 32) { *carry = (rm >> (32 - s)) & 1; return rm << s; }
    *carry = s == 32 ? rm & 1 : 0;
    return 0;
  case 1:
    if (s < 32) { *carry = (rm >> (s - 1)) & 1; return rm >> s; }
    *carry = s == 32 ? rm >> 31 : 0;
    return 0;
  case 2:
    if (s < 32) { *carry = (rm >> (s - 1)) & 1; return (u32)((s32)rm >> s); }
    *carry = rm >> 31;
    return (u32)((s32)rm >> 31);
  default: {
    u32 r = s & 31;
    if (!r) { *carry = rm >> 31; return rm; }
    *carry = (rm >> (r - 1)) & 1;
    return (rm >> r) | (rm << (32 - r));
  }
  }
}

static inline u32 op2_imm(u32 insn, u32 *carry) {
  u32 rot = ((insn >> 8) & 15) * 2;
  u32 v = insn & 0xff;
  if (!rot) { *carry = fC; return v; }
  v = (v >> rot) | (v << (32 - rot));
  *carry = v >> 31;
  return v;
}

static inline void write_pc_interwork(u32 v, u32 insn) {
  if (v & 1) {
    cpu_fail("thumb branch", R[15] - 8, insn);
    return;
  }
  cpu_pc = v & ~3u;
}

static inline void data_proc(u32 insn, u32 b, u32 sc) {
  u32 opc = (insn >> 21) & 15;
  u32 s = (insn >> 20) & 1;
  u32 rd = (insn >> 12) & 15;
  u32 a = R[(insn >> 16) & 15];
  u32 r;
  switch (opc) {
  case 0: r = a & b; goto logic;
  case 1: r = a ^ b; goto logic;
  case 2:
    r = a - b;
    if (s) { fC = a >= b; fV = ((a ^ b) & (a ^ r)) >> 31; }
    goto arith;
  case 3:
    r = b - a;
    if (s) { fC = b >= a; fV = ((b ^ a) & (b ^ r)) >> 31; }
    goto arith;
  case 4:
    r = a + b;
    if (s) { fC = r < a; fV = (~(a ^ b) & (a ^ r)) >> 31; }
    goto arith;
  case 5: {
    u64 t = (u64)a + b + fC;
    r = (u32)t;
    if (s) { fC = (u32)(t >> 32); fV = (~(a ^ b) & (a ^ r)) >> 31; }
    goto arith;
  }
  case 6: {
    u32 borrow = !fC;
    r = a - b - borrow;
    if (s) { fC = (u64)a >= (u64)b + borrow; fV = ((a ^ b) & (a ^ r)) >> 31; }
    goto arith;
  }
  case 7: {
    u32 borrow = !fC;
    r = b - a - borrow;
    if (s) { fC = (u64)b >= (u64)a + borrow; fV = ((b ^ a) & (b ^ r)) >> 31; }
    goto arith;
  }
  case 8: r = a & b; fN = r >> 31; fZ = !r; fC = sc; return;
  case 9: r = a ^ b; fN = r >> 31; fZ = !r; fC = sc; return;
  case 10: r = a - b; fN = r >> 31; fZ = !r; fC = a >= b; fV = ((a ^ b) & (a ^ r)) >> 31; return;
  case 11: r = a + b; fN = r >> 31; fZ = !r; fC = r < a; fV = (~(a ^ b) & (a ^ r)) >> 31; return;
  case 12: r = a | b; goto logic;
  case 13: r = b; goto logic;
  case 14: r = a & ~b; goto logic;
  default: r = ~b; goto logic;
  }
logic:
  if (s) { fN = r >> 31; fZ = !r; fC = sc; }
  goto write;
arith:
  if (s) { fN = r >> 31; fZ = !r; }
write:
  if (rd == 15) cpu_pc = r & ~3u;
  else R[rd] = r;
}

static void exec_misc(u32 insn) {
  // opcode 10xx with S clear: MRS, MSR, BX, BLX, CLZ, saturating and DSP multiplies
  u32 low = insn & 0xf0;
  if ((insn & 0x0fbf0fff) == 0x010f0000) { R[(insn >> 12) & 15] = cpsr_value(); return; }
  if ((insn & 0x0fb0fff0) == 0x0120f000) {
    if (insn & (1 << 19)) { u32 v = R[insn & 15]; fN = v >> 31; fZ = (v >> 30) & 1; fC = (v >> 29) & 1; fV = (v >> 28) & 1; fQ = (v >> 27) & 1; }
    return;
  }
  if ((insn & 0x0ffffff0) == 0x012fff10) { write_pc_interwork(R[insn & 15], insn); return; }
  if ((insn & 0x0ffffff0) == 0x012fff30) {
    u32 t = R[insn & 15];
    R[14] = R[15] - 4;
    if (trace_calls && ntrace < TRACE_MAX) trace_buf[ntrace++] = t;
    write_pc_interwork(t, insn);
    return;
  }
  if ((insn & 0x0fff0ff0) == 0x016f0f10) {
    u32 v = R[insn & 15];
    R[(insn >> 12) & 15] = v ? __builtin_clz(v) : 32;
    return;
  }
  if (low == 0x50) {
    s64 a = (s32)R[insn & 15], b = (s32)R[(insn >> 16) & 15];
    u32 op = (insn >> 21) & 3;
    if (op >= 2) {
      b *= 2;
      if (b > 0x7fffffffLL) { b = 0x7fffffff; fQ = 1; }
      if (b < -0x80000000LL) { b = -0x80000000LL; fQ = 1; }
    }
    s64 r = (op & 1) ? a - b : a + b;
    if (r > 0x7fffffffLL) { r = 0x7fffffff; fQ = 1; }
    if (r < -0x80000000LL) { r = -0x80000000LL; fQ = 1; }
    R[(insn >> 12) & 15] = (u32)r;
    return;
  }
  if ((insn & 0x90) == 0x80) {
    u32 op = (insn >> 21) & 3;
    u32 rd = (insn >> 16) & 15, rn = (insn >> 12) & 15, rs = (insn >> 8) & 15, rm = insn & 15;
    s32 xm = (insn & 0x20) ? (s16)(R[rm] >> 16) : (s16)R[rm];
    s32 ys = (insn & 0x40) ? (s16)(R[rs] >> 16) : (s16)R[rs];
    if (op == 0) { // SMLAxy
      s64 r = (s64)xm * ys + (s32)R[rn];
      if (r != (s32)r) fQ = 1;
      R[rd] = (u32)r;
    } else if (op == 1) { // SMLAWy / SMULWy
      s64 p = ((s64)(s32)R[rm] * ys) >> 16;
      if (insn & 0x20) R[rd] = (u32)p;
      else {
        s64 r = p + (s32)R[rn];
        if (r != (s32)r) fQ = 1;
        R[rd] = (u32)r;
      }
    } else if (op == 2) { // SMLALxy
      s64 acc = (s64)(((u64)R[rd] << 32) | R[rn]);
      acc += (s64)xm * ys;
      R[rn] = (u32)acc;
      R[rd] = (u32)((u64)acc >> 32);
    } else {
      R[rd] = (u32)(xm * ys);
    }
    return;
  }
  if ((insn & 0x0ff000f0) == 0x01200070) { cpu_fail("bkpt", R[15] - 8, insn); return; }
  cpu_fail("undefined misc", R[15] - 8, insn);
}

static void exec_mul_swp(u32 insn) {
  u32 rd = (insn >> 16) & 15, rn = (insn >> 12) & 15, rs = (insn >> 8) & 15, rm = insn & 15;
  if ((insn & 0x0fc000f0) == 0x00000090) {
    u32 r = R[rm] * R[rs];
    if (insn & (1 << 21)) r += R[rn];
    R[rd] = r;
    if (insn & (1 << 20)) { fN = r >> 31; fZ = !r; }
    return;
  }
  if ((insn & 0x0f8000f0) == 0x00800090) {
    u64 r;
    if (insn & (1 << 22)) r = (u64)((s64)(s32)R[rm] * (s32)R[rs]);
    else r = (u64)R[rm] * R[rs];
    if (insn & (1 << 21)) r += ((u64)R[rd] << 32) | R[rn];
    R[rn] = (u32)r;
    R[rd] = (u32)(r >> 32);
    if (insn & (1 << 20)) { fN = (u32)(r >> 63); fZ = !r; }
    return;
  }
  if ((insn & 0x0fb00ff0) == 0x01000090) {
    u32 addr = R[rd];
    if (insn & (1 << 22)) { u32 t = rd8(addr); wr8(addr, (u8)R[rm]); R[rn] = t; }
    else { u32 t = rd32(addr); wr32(addr, R[rm]); R[rn] = t; }
    return;
  }
  cpu_fail("undefined multiply", R[15] - 8, insn);
}

static void exec_halfword(u32 insn) {
  u32 rn = (insn >> 16) & 15, rd = (insn >> 12) & 15;
  u32 off = (insn & (1 << 22)) ? (((insn >> 4) & 0xf0) | (insn & 15)) : R[insn & 15];
  u32 base = R[rn];
  u32 up = insn & (1 << 23);
  u32 pre = insn & (1 << 24);
  u32 addr = pre ? (up ? base + off : base - off) : base;
  u32 wb = !pre || (insn & (1 << 21));
  u32 sh = (insn >> 5) & 3;
  if (insn & (1 << 20)) {
    u32 v;
    if (sh == 1) v = rd16(addr);
    else if (sh == 2) v = (u32)(s32)(s8)rd8(addr);
    else v = (u32)(s32)(s16)rd16(addr);
    if (wb) R[rn] = up ? base + off : base - off;
    if (rd == 15) write_pc_interwork(v, insn);
    else R[rd] = v;
  } else {
    if (sh == 1) {
      wr16(addr, (u16)(rd == 15 ? R[15] + 4 : R[rd]));
    } else if (sh == 2) { // LDRD
      u32 lo = rd32(addr), hi = rd32(addr + 4);
      if (wb) R[rn] = up ? base + off : base - off;
      R[rd] = lo;
      R[(rd + 1) & 15] = hi;
      return;
    } else { // STRD
      wr32(addr, R[rd]);
      wr32(addr + 4, R[(rd + 1) & 15]);
    }
    if (wb) R[rn] = up ? base + off : base - off;
  }
}

static void exec_single(u32 insn) {
  u32 rn = (insn >> 16) & 15, rd = (insn >> 12) & 15;
  u32 off;
  if (insn & (1 << 25)) {
    if (insn & 0x10) { cpu_fail("media instruction", R[15] - 8, insn); return; }
    u32 c;
    off = op2_imm_shift(insn, &c);
  } else {
    off = insn & 0xfff;
  }
  u32 base = R[rn];
  u32 up = insn & (1 << 23);
  u32 pre = insn & (1 << 24);
  u32 addr = pre ? (up ? base + off : base - off) : base;
  u32 wb = !pre || (insn & (1 << 21));
  if (insn & (1 << 20)) {
    u32 v = (insn & (1 << 22)) ? rd8(addr) : rd32(addr);
    if (wb) R[rn] = up ? base + off : base - off;
    if (rd == 15) write_pc_interwork(v, insn);
    else R[rd] = v;
  } else {
    u32 v = rd == 15 ? R[15] + 4 : R[rd];
    if (insn & (1 << 22)) wr8(addr, (u8)v);
    else wr32(addr, v);
    if (wb) R[rn] = up ? base + off : base - off;
  }
}

static void exec_block(u32 insn) {
  u32 rn = (insn >> 16) & 15;
  u32 list = insn & 0xffff;
  u32 n = __builtin_popcount(list);
  u32 base = R[rn];
  u32 up = insn & (1 << 23), pre = insn & (1 << 24);
  u32 addr;
  if (up) addr = pre ? base + 4 : base;
  else addr = pre ? base - 4 * n : base - 4 * n + 4;
  u32 newbase = up ? base + 4 * n : base - 4 * n;
  if (insn & (1 << 20)) {
    if (insn & (1 << 21)) R[rn] = newbase;
    for (u32 i = 0; i < 15; i++) {
      if (list & (1u << i)) { R[i] = rd32(addr); addr += 4; }
    }
    if (list & 0x8000) write_pc_interwork(rd32(addr), insn);
  } else {
    for (u32 i = 0; i < 16; i++) {
      if (list & (1u << i)) {
        wr32(addr, i == 15 ? R[15] + 4 : (i == rn ? base : R[i]));
        addr += 4;
      }
    }
    if (insn & (1 << 21)) R[rn] = newbase;
  }
}

static void exec_arm(u32 insn) {
  switch ((insn >> 25) & 7) {
  case 0:
    if ((insn & 0x90) == 0x90) {
      if ((insn & 0x60) == 0) exec_mul_swp(insn);
      else exec_halfword(insn);
    } else if ((insn & 0x01900000) == 0x01000000) {
      exec_misc(insn);
    } else {
      u32 c, b = (insn & 0x10) ? op2_reg_shift(insn, &c) : op2_imm_shift(insn, &c);
      data_proc(insn, b, c);
    }
    return;
  case 1:
    if ((insn & 0x01900000) == 0x01000000) {
      if ((insn & 0x0fb0f000) == 0x0320f000) {
        if (insn & (1 << 19)) {
          u32 c, v = op2_imm(insn, &c);
          fN = v >> 31; fZ = (v >> 30) & 1; fC = (v >> 29) & 1; fV = (v >> 28) & 1; fQ = (v >> 27) & 1;
        }
        return;
      }
      cpu_fail("undefined", R[15] - 8, insn);
      return;
    } else {
      u32 c, b = op2_imm(insn, &c);
      data_proc(insn, b, c);
    }
    return;
  case 2:
  case 3:
    exec_single(insn);
    return;
  case 4:
    exec_block(insn);
    return;
  case 5: {
    s32 off = ((s32)(insn << 8)) >> 6;
    if (insn & (1 << 24)) {
      R[14] = R[15] - 4;
      if (trace_calls && ntrace < TRACE_MAX) trace_buf[ntrace++] = R[15] + off;
    }
    cpu_pc = R[15] + off;
    return;
  }
  default:
    cpu_fail("coprocessor/swi", R[15] - 8, insn);
    return;
  }
}

// Execute one instruction as if it were located at `addr` (used by watch points), then continue
// with the instruction after it unless it branched.
void exec_displaced(u32 insn, u32 addr) {
  R[15] = addr + 8;
  cpu_pc = addr + 4;
  u32 c = insn >> 28;
  if (c == 14 || cond_pass(c)) exec_arm(insn);
}

void cpu_run_until_return(void) {
  for (;;) {
    u32 pc = cpu_pc;
    if (__builtin_expect(pc - TRAP_BASE < TRAP_COUNT * 4, 0)) {
      if (pc == RETURN_MAGIC || pc == HALT_PC) return;
      hle_dispatch((pc - TRAP_BASE) >> 2);
      if (cpu_halt) { cpu_pc = HALT_PC; return; }
      if (cpu_pc == pc) cpu_pc = R[14] & ~1u;
      continue;
    }
    u32 insn = rd32(pc);
    R[15] = pc + 8;
    cpu_pc = pc + 4;
#ifdef STATS
    cpu_insns++;
#endif
#ifdef PROFILE
    if (pc - LOAD_BASE < 0x200000) prof[(pc - LOAD_BASE) >> 4]++;
#endif
    u32 c = insn >> 28;
    if (c == 14 || cond_pass(c)) {
      exec_arm(insn);
    } else if (c == 15) {
      if ((insn & 0x0d70f000) == 0x0550f000) continue; // PLD
      cpu_fail("unconditional instruction", pc, insn);
    }
  }
}

u32 call_guest(u32 addr, int nargs, const u32 *args) {
  u32 saved[16];
  memcpy(saved, R, sizeof saved);
  u32 sf[5] = {fN, fZ, fC, fV, fQ};
  u32 spc = cpu_pc;
  u32 sp = R[13];
  int nstack = nargs > 4 ? nargs - 4 : 0;
  sp = (sp - 64 - nstack * 4) & ~7u;
  for (int i = 0; i < nargs; i++) {
    if (i < 4) R[i] = args[i];
    else wr32(sp + (i - 4) * 4, args[i]);
  }
  R[13] = sp;
  R[14] = RETURN_MAGIC;
  cpu_pc = addr;
  if (addr & 1) {
    logf("call_guest: thumb target %08x", addr);
    cpu_halt = 1;
  } else {
    cpu_run_until_return();
  }
  u32 ret = R[0];
  call_ret_hi = R[1];
  memcpy(R, saved, sizeof saved);
  fN = sf[0]; fZ = sf[1]; fC = sf[2]; fV = sf[3]; fQ = sf[4];
  cpu_pc = cpu_halt ? HALT_PC : spc;
  return ret;
}
