// ARMv7-A interpreter: ARM and Thumb-2 instruction sets with VFPv3-D16. The game library is Thumb-2 code
// (with IT blocks, VFP arithmetic and hardware-float conversions) that calls ARM PLT stubs and a few ARM
// runtime helpers from libgcc, so both states, interworking and the VFP coprocessor are needed.
#pragma once
#include "base.h"

extern u32 t_in_it;
extern u32 excl_addr;
void aot_call(u32 ret);
#define HALT_PC (TRAP_END - 8)

static inline void cpu_fail(const char *why, u32 pc, u32 insn) {
  logf("CPU halt: %s at %08x (lib+%x) insn %08x lr=%08x sp=%08x", why, pc, pc - LOAD_BASE, insn, R[14], R[13]);
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

static inline u32 cpsr_value(void) {
  return (fN << 31) | (fZ << 30) | (fC << 29) | (fV << 28) | (fQ << 27) | (fT << 5) | 0x10;
}
static inline void set_nzcvq(u32 v) {
  fN = v >> 31;
  fZ = (v >> 30) & 1;
  fC = (v >> 29) & 1;
  fV = (v >> 28) & 1;
  fQ = (v >> 27) & 1;
}

static inline u32 ror32(u32 v, u32 r) {
  r &= 31;
  return r ? (v >> r) | (v << (32 - r)) : v;
}

// shift by an immediate amount (type: 0 LSL, 1 LSR, 2 ASR, 3 ROR/RRX), carry out in *carry
static inline u32 shift_imm(u32 v, u32 type, u32 amt, u32 *carry) {
  switch (type) {
  case 0:
    if (!amt) { *carry = fC; return v; }
    *carry = (v >> (32 - amt)) & 1;
    return v << amt;
  case 1:
    if (!amt) { *carry = v >> 31; return 0; }
    *carry = (v >> (amt - 1)) & 1;
    return v >> amt;
  case 2:
    if (!amt) { *carry = v >> 31; return (u32)((s32)v >> 31); }
    *carry = (v >> (amt - 1)) & 1;
    return (u32)((s32)v >> amt);
  default:
    if (!amt) { *carry = v & 1; return (fC << 31) | (v >> 1); }
    *carry = (v >> (amt - 1)) & 1;
    return (v >> amt) | (v << (32 - amt));
  }
}

// shift by a register amount (low byte)
static inline u32 shift_reg(u32 v, u32 type, u32 s, u32 *carry) {
  s &= 0xff;
  if (!s) { *carry = fC; return v; }
  switch (type) {
  case 0:
    if (s < 32) { *carry = (v >> (32 - s)) & 1; return v << s; }
    *carry = s == 32 ? v & 1 : 0;
    return 0;
  case 1:
    if (s < 32) { *carry = (v >> (s - 1)) & 1; return v >> s; }
    *carry = s == 32 ? v >> 31 : 0;
    return 0;
  case 2:
    if (s < 32) { *carry = (v >> (s - 1)) & 1; return (u32)((s32)v >> s); }
    *carry = v >> 31;
    return (u32)((s32)v >> 31);
  default: {
    u32 r = s & 31;
    if (!r) { *carry = v >> 31; return v; }
    *carry = (v >> (r - 1)) & 1;
    return (v >> r) | (v << (32 - r));
  }
  }
}

static inline void write_pc_interwork(u32 v) {
  fT = v & 1;
  cpu_pc = fT ? v & ~1u : v & ~3u;
}

static inline void trace_call(u32 target) { (void)target; }

// ---------------------------------------------------------------------------------------------
// Shared helpers used by both instruction sets

static inline u32 add_with_carry(u32 a, u32 b, u32 cin, int s) {
  u64 t = (u64)a + b + cin;
  u32 r = (u32)t;
  if (s) {
    fN = r >> 31;
    fZ = !r;
    fC = (u32)(t >> 32);
    fV = (~(a ^ b) & (a ^ r)) >> 31;
  }
  return r;
}

// saturation helpers
static inline u32 ssat(s64 v, u32 n) { // signed saturate to n bits (1..32)
  s64 max = ((s64)1 << (n - 1)) - 1, min = -((s64)1 << (n - 1));
  if (v > max) { fQ = 1; return (u32)max; }
  if (v < min) { fQ = 1; return (u32)min; }
  return (u32)v;
}
static inline u32 usat(s64 v, u32 n) { // unsigned saturate to n bits (0..31)
  s64 max = ((s64)1 << n) - 1;
  if (v > max) { fQ = 1; return (u32)max; }
  if (v < 0) { fQ = 1; return 0; }
  return (u32)v;
}

static inline u32 rbit(u32 v) {
  u32 r = 0;
  for (int i = 0; i < 32; i++) r |= ((v >> i) & 1) << (31 - i);
  return r;
}

// exclusive monitor: single core, the store always succeeds when a matching load came first

#include "vfp.inc"

#include "thumb2.inc"
