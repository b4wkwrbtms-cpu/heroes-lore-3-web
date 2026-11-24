// ARMv7-A interpreter: run loop, ARM state and the table of translated functions.
#include "cpu_core.h"

u8 G[GUEST_SIZE + 64] __attribute__((aligned(16)));
u32 R[16];
u32 fN, fZ, fC, fV, fQ, fT;
u32 cpu_pc;
u32 cpu_halt;
u64 cpu_insns;
u32 call_ret_hi;
u32 it_state;
VfpRegs V;
u32 fpscr;
u32 t_in_it;
u32 excl_addr = 0xffffffff; // exclusive monitor: single core, a store succeeds after a matching load
#ifdef PROFILE
#define PROF_RANGE 0x200000
static u32 prof[PROF_RANGE >> 2];
EXPORT(prof_buf) u32 *prof_buf(void) { return prof; }
#endif

// ---------------------------------------------------------------------------------------------
// ARM state

static inline void data_proc(u32 insn, u32 b, u32 sc) {
  u32 opc = (insn >> 21) & 15;
  u32 s = (insn >> 20) & 1;
  u32 rd = (insn >> 12) & 15;
  u32 a = R[(insn >> 16) & 15];
  u32 r;
  switch (opc) {
  case 0: r = a & b; goto logic;
  case 1: r = a ^ b; goto logic;
  case 2: r = add_with_carry(a, ~b, 1, s); goto write;
  case 3: r = add_with_carry(b, ~a, 1, s); goto write;
  case 4: r = add_with_carry(a, b, 0, s); goto write;
  case 5: r = add_with_carry(a, b, fC, s); goto write;
  case 6: r = add_with_carry(a, ~b, fC, s); goto write;
  case 7: r = add_with_carry(b, ~a, fC, s); goto write;
  case 8: r = a & b; fN = r >> 31; fZ = !r; fC = sc; return;
  case 9: r = a ^ b; fN = r >> 31; fZ = !r; fC = sc; return;
  case 10: add_with_carry(a, ~b, 1, 1); return;
  case 11: add_with_carry(a, b, 0, 1); return;
  case 12: r = a | b; goto logic;
  case 13: r = b; goto logic;
  case 14: r = a & ~b; goto logic;
  default: r = ~b; goto logic;
  }
logic:
  if (s) { fN = r >> 31; fZ = !r; fC = sc; }
write:
  if (rd == 15) write_pc_interwork(r); // ARMv7: ALU writes to PC interwork in ARM state
  else R[rd] = r;
}

static void exec_misc(u32 insn) {
  // opcode 10xx with S clear: MRS, MSR, BX, BLX, CLZ, saturating and DSP multiplies
  u32 low = insn & 0xf0;
  if ((insn & 0x0fbf0fff) == 0x010f0000) { R[(insn >> 12) & 15] = cpsr_value(); return; }
  if ((insn & 0x0fb0fff0) == 0x0120f000) {
    if (insn & (1 << 19)) set_nzcvq(R[insn & 15]);
    return;
  }
  if ((insn & 0x0ffffff0) == 0x012fff10) { write_pc_interwork(R[insn & 15]); return; }
  if ((insn & 0x0ffffff0) == 0x012fff30) {
    u32 t = R[insn & 15];
    R[14] = R[15] - 4;
    write_pc_interwork(t);
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
    if (op >= 2) b = (s32)ssat(b * 2, 32);
    R[(insn >> 12) & 15] = ssat((op & 1) ? a - b : a + b, 32);
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
  if ((insn & 0x0ff000f0) == 0x00600090) { R[rd] = R[rn] - R[rm] * R[rs]; return; } // MLS
  if ((insn & 0x0ff000f0) == 0x00400090) { // UMAAL
    u64 r = (u64)R[rm] * R[rs] + R[rn] + R[rd];
    R[rn] = (u32)r;
    R[rd] = (u32)(r >> 32);
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
  // LDREX/STREX family: 0001 1 op Rn Rd 1111 1001 Rt
  if ((insn & 0x0f8000f0) == 0x01800090) {
    u32 op = (insn >> 21) & 3, l = (insn >> 20) & 1;
    u32 addr = R[rd]; // Rn in bits 19:16
    u32 t = rn;       // Rt/Rd in bits 15:12
    if (l) {
      excl_addr = addr;
      switch (op) {
      case 0: R[t] = rd32(addr); break;
      case 1: R[t] = rd32(addr); R[t + 1] = rd32(addr + 4); break;
      case 2: R[t] = rd8(addr); break;
      default: R[t] = rd16(addr); break;
      }
    } else {
      u32 src = rm;
      if (excl_addr == addr) {
        switch (op) {
        case 0: wr32(addr, R[src]); break;
        case 1: wr32(addr, R[src]); wr32(addr + 4, R[src + 1]); break;
        case 2: wr8(addr, (u8)R[src]); break;
        default: wr16(addr, (u16)R[src]); break;
        }
        R[t] = 0;
      } else R[t] = 1;
      excl_addr = 0xffffffff;
    }
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
    if (rd == 15) write_pc_interwork(v);
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

static void exec_media(u32 insn) {
  // ARM media instructions used by compiled code: extends, reverses, bit fields, saturation
  u32 rd = (insn >> 12) & 15, rn = (insn >> 16) & 15, rm = insn & 15;
  if ((insn & 0x0f8003f0) == 0x06800070 && ((insn >> 20) & 3) != 1) {
    u32 op = (insn >> 20) & 7; // 010 SXTB 011 SXTH 110 UXTB 111 UXTH 000 SXTB16 100 UXTB16
    u32 v = ror32(R[rm], ((insn >> 10) & 3) * 8);
    u32 add = rn == 15 ? 0 : R[rn];
    u32 r;
    switch (op) {
    case 2: r = add + (u32)(s32)(s8)v; break;
    case 3: r = add + (u32)(s32)(s16)v; break;
    case 6: r = add + (v & 0xff); break;
    case 7: r = add + (v & 0xffff); break;
    case 4: r = (((add >> 16) + ((v >> 16) & 0xff)) << 16) | ((add + (v & 0xff)) & 0xffff); break;
    default: r = (((add >> 16) + (u32)(s32)(s8)(v >> 16)) << 16) | ((add + (u32)(s32)(s8)v) & 0xffff); break;
    }
    R[rd] = r;
    return;
  }
  if ((insn & 0x0fff0ff0) == 0x06bf0f30) { R[rd] = __builtin_bswap32(R[rm]); return; } // REV
  if ((insn & 0x0fff0ff0) == 0x06bf0fb0) { // REV16
    u32 v = R[rm];
    R[rd] = ((v & 0x00ff00ff) << 8) | ((v >> 8) & 0x00ff00ff);
    return;
  }
  if ((insn & 0x0fff0ff0) == 0x06ff0fb0) { R[rd] = (u32)(s32)(s16)(((R[rm] & 0xff) << 8) | ((R[rm] >> 8) & 0xff)); return; }
  if ((insn & 0x0fff0ff0) == 0x06ff0f30) { R[rd] = rbit(R[rm]); return; }
  if ((insn & 0x0fe00070) == 0x07a00050 || (insn & 0x0fe00070) == 0x07e00050) { // SBFX / UBFX
    u32 lsb = (insn >> 7) & 31, w = ((insn >> 16) & 31) + 1;
    u32 v = R[rm] >> lsb;
    if (w < 32) v &= (1u << w) - 1;
    if (!(insn & (1 << 22)) && w < 32 && (v >> (w - 1)) & 1) v |= ~0u << w;
    R[rd] = v;
    return;
  }
  if ((insn & 0x0fe0007f) == 0x07c0001f || (insn & 0x0fe00070) == 0x07c00010) { // BFC / BFI
    u32 lsb = (insn >> 7) & 31, msb = (insn >> 16) & 31;
    if (msb < lsb) return;
    u32 w = msb - lsb + 1;
    u32 mask = (w >= 32 ? ~0u : ((1u << w) - 1)) << lsb;
    u32 src = rm == 15 ? 0 : R[rm] << lsb;
    R[rd] = (R[rd] & ~mask) | (src & mask);
    return;
  }
  if ((insn & 0x0fa00030) == 0x06a00010) { // SSAT / USAT
    u32 sh = (insn >> 6) & 1, amt = (insn >> 7) & 31, c;
    u32 v = shift_imm(R[rm], sh ? 2 : 0, amt, &c);
    u32 sat = (insn >> 16) & 31;
    if (insn & (1 << 22)) R[rd] = usat((s32)v, sat);
    else R[rd] = ssat((s32)v, sat + 1);
    return;
  }
  if ((insn & 0x0ff000f0) == 0x07800010 && ((insn >> 12) & 15) == 15) { // USAD8
    u32 a = R[rm], b = R[(insn >> 8) & 15], s = 0;
    for (int i = 0; i < 32; i += 8) {
      int x = (int)((a >> i) & 0xff) - (int)((b >> i) & 0xff);
      s += x < 0 ? -x : x;
    }
    R[rn] = s;
    return;
  }
  cpu_fail("media instruction", R[15] - 8, insn);
}

static void exec_single(u32 insn) {
  u32 rn = (insn >> 16) & 15, rd = (insn >> 12) & 15;
  u32 off;
  if (insn & (1 << 25)) {
    if (insn & 0x10) { exec_media(insn); return; }
    u32 c;
    off = shift_imm(R[insn & 15], (insn >> 5) & 3, (insn >> 7) & 31, &c);
  } else {
    off = insn & 0xfff;
  }
  u32 base = R[rn];
  if (rn == 15) base &= ~3u;
  u32 up = insn & (1 << 23);
  u32 pre = insn & (1 << 24);
  u32 addr = pre ? (up ? base + off : base - off) : base;
  u32 wb = !pre || (insn & (1 << 21));
  if (insn & (1 << 20)) {
    u32 v = (insn & (1 << 22)) ? rd8(addr) : rd32(addr);
    if (wb) R[rn] = up ? base + off : base - off;
    if (rd == 15) write_pc_interwork(v);
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
    if (list & 0x8000) write_pc_interwork(rd32(addr));
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
      u32 c, b;
      if (insn & 0x10) b = shift_reg(R[insn & 15] + ((insn & 15) == 15 ? 4 : 0), (insn >> 5) & 3, R[(insn >> 8) & 15], &c);
      else b = shift_imm(R[insn & 15], (insn >> 5) & 3, (insn >> 7) & 31, &c);
      data_proc(insn, b, c);
    }
    return;
  case 1:
    if ((insn & 0x01900000) == 0x01000000) {
      if ((insn & 0x0fb0f000) == 0x0320f000) { // MSR imm / hints
        if (insn & (1 << 19)) set_nzcvq(ror32(insn & 0xff, ((insn >> 8) & 15) * 2));
        return;
      }
      if ((insn & 0x0ff00000) == 0x03000000) { R[(insn >> 12) & 15] = ((insn >> 4) & 0xf000) | (insn & 0xfff); return; } // MOVW
      if ((insn & 0x0ff00000) == 0x03400000) { // MOVT
        u32 rd = (insn >> 12) & 15;
        R[rd] = (R[rd] & 0xffff) | ((((insn >> 4) & 0xf000) | (insn & 0xfff)) << 16);
        return;
      }
      cpu_fail("undefined", R[15] - 8, insn);
      return;
    } else {
      u32 rot = ((insn >> 8) & 15) * 2;
      u32 b = ror32(insn & 0xff, rot);
      u32 c = rot ? b >> 31 : fC;
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
    if (insn & (1 << 24)) R[14] = R[15] - 4;
    cpu_pc = R[15] + off;
    return;
  }
  case 6:
  case 7:
    if (((insn >> 9) & 7) == 5) { exec_vfp(insn, R[15] - 8); return; } // coprocessors 10 and 11
    cpu_fail("coprocessor/swi", R[15] - 8, insn);
    return;
  }
}



// ---------------------------------------------------------------------------------------------
// Run loop. Translated functions (aot_gen.c) are entered from here at their first instruction and
// return when control leaves them; native helpers stand in for some runtime routines.
static void run_loop(u32 stop_pc, u32 stop_sp);
void aot_call(u32 ret) {
  // a call from translated code: run the callee until it comes back to `ret` with the same stack
  run_loop(ret, R[13]);
}
#include "native_helpers.inc"
typedef struct { u32 addr; void (*fn)(void); } AotEntry;
#ifdef AOT
extern const AotEntry aot_entries[];
extern const int aot_count;
extern const u32 aot_text_lo, aot_text_hi, aot_text_hash;
#define AOT_COUNT aot_count
#define AOT_MAX 4096
#else
static const AotEntry aot_entries[] = {{0, 0}};
#define AOT_COUNT 0
#define AOT_MAX 0
#endif
#define AOT_LO (LOAD_BASE + 0x00090000u)
#define AOT_SPAN 0x000f0000u
static u16 aot_index[AOT_SPAN >> 1];
typedef void (*AotFn)(void);
static AotFn aot_fns[AOT_MAX + NATIVE_HELPERS + 2];
static int aot_ready;
static int aot_text_matches(void) {
#ifdef AOT
  u32 h = 2166136261u;
  for (u32 a = aot_text_lo; a < aot_text_hi; a++) h = (h ^ rd8(a)) * 16777619u;
  if (h != aot_text_hash) logf("library differs from the translated build (%08x): interpreting only", h);
  return h == aot_text_hash;
#else
  return 0;
#endif
}
// 0 for the interpreter-only core, otherwise the checksum of the library the translations were made from
EXPORT(aot_build) u32 aot_build(void) {
#ifdef AOT
  return aot_text_hash;
#else
  return 0;
#endif
}
EXPORT(aot_active) int aot_active(void) { return aot_ready == 2; }
EXPORT(aot_enable) void aot_enable(int on) {
  memset(aot_index, 0, sizeof aot_index);
  if ((on & 1) && !aot_text_matches()) on &= ~1;
  int n = 1;
  if (on & 1) for (int i = 0; i < AOT_COUNT; i++) {
    u32 off = aot_entries[i].addr - AOT_LO;
    if (off < AOT_SPAN) { aot_fns[n] = aot_entries[i].fn; aot_index[off >> 1] = (u16)n++; }
  }
  if (on & 2) for (int i = 0; i < NATIVE_HELPERS; i++) {
    u32 a = native_helper_addr(i);
    u32 off = a - AOT_LO;
    if (a && off < AOT_SPAN) { aot_fns[n] = native_helpers[i]; aot_index[off >> 1] = (u16)n++; }
  }
  aot_ready = (on & 1) && AOT_COUNT ? 2 : 1;
}

static void run_loop(u32 stop_pc, u32 stop_sp) {
  for (;;) {
    u32 pc = cpu_pc;
    if (__builtin_expect(pc == stop_pc, 0) && R[13] == stop_sp) return;
    {
      u32 off = pc - AOT_LO;
      if (off < AOT_SPAN && aot_index[off >> 1]) {
        aot_fns[aot_index[off >> 1]]();
        if (cpu_halt) { cpu_pc = HALT_PC; return; }
        continue;
      }
    }
    if (__builtin_expect(pc - TRAP_BASE < TRAP_COUNT * 4, 0)) {
      if (pc == RETURN_MAGIC || pc == HALT_PC) return;
      hle_dispatch((pc - TRAP_BASE) >> 2);
      if (cpu_halt) { cpu_pc = HALT_PC; return; }
      if (cpu_pc == pc) { fT = R[14] & 1; cpu_pc = R[14] & ~1u; }
      continue;
    }
#ifdef STATS
    cpu_insns++;
#endif
#ifdef PROFILE
    if (pc - LOAD_BASE < PROF_RANGE) prof[(pc - LOAD_BASE) >> 2]++;
#endif
    if (fT) {
      u32 hw = rd16(pc);
      R[15] = pc + 4;
      if (__builtin_expect(it_state != 0, 0)) {
        u32 c = it_state >> 4;
        it_state = (it_state & 7) ? (it_state & 0xe0) | ((it_state << 1) & 0x1f) : 0;
        u32 len = hw >= 0xe800 ? 4 : 2;
        cpu_pc = pc + len;
        if (!cond_pass(c)) continue;
        t_in_it = 1;
        if (len == 4) exec_t32(hw, rd16(pc + 2), pc);
        else exec_t16(hw, pc);
        t_in_it = 0;
        continue;
      }
      if (hw >= 0xe800) {
        cpu_pc = pc + 4;
        exec_t32(hw, rd16(pc + 2), pc);
      } else {
        cpu_pc = pc + 2;
        exec_t16(hw, pc);
      }
      continue;
    }
    u32 insn = rd32(pc);
    R[15] = pc + 8;
    cpu_pc = pc + 4;
    u32 c = insn >> 28;
    if (c == 14 || cond_pass(c)) {
      exec_arm(insn);
    } else if (c == 15) {
      if ((insn & 0x0e000000) == 0x0a000000) { // BLX imm: switch to Thumb
        s32 off = ((s32)(insn << 8)) >> 6;
        R[14] = pc + 4;
        fT = 1;
        cpu_pc = R[15] + off + ((insn >> 23) & 2);
        continue;
      }
      if ((insn & 0x0d70f000) == 0x0550f000) continue;            // PLD
      if ((insn & 0x0ffffff0) == 0x057ff050) continue;            // DMB
      if ((insn & 0x0ffffff0) == 0x057ff040) continue;            // DSB
      if ((insn & 0x0ffffff0) == 0x057ff060) continue;            // ISB
      if ((insn & 0x0fffffff) == 0x057ff01f) { excl_addr = ~0u; continue; } // CLREX
      cpu_fail("unconditional instruction", pc, insn);
    }
  }
}

void cpu_run_until_return(void) { run_loop(RETURN_MAGIC, 0xffffffffu); }

u32 call_guest(u32 addr, int nargs, const u32 *args) {
  u32 saved[16];
  memcpy(saved, R, sizeof saved);
  u32 sf[7] = {fN, fZ, fC, fV, fQ, fT, it_state};
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
  fT = addr & 1;
  it_state = 0;
  cpu_pc = addr & ~1u;
  cpu_run_until_return();
  u32 ret = R[0];
  call_ret_hi = R[1];
  memcpy(R, saved, sizeof saved);
  fN = sf[0]; fZ = sf[1]; fC = sf[2]; fV = sf[3]; fQ = sf[4]; fT = sf[5]; it_state = sf[6];
  cpu_pc = cpu_halt ? HALT_PC : spc;
  return ret;
}
