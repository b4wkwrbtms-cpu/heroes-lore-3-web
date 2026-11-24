// Native stand-ins for libgcc's ARM division routines, included by cpu.c. Each one does what the routine
// does with r0-r3 and returns to the caller (interworking through LR).
u32 find_symbol(const char *name);

static inline void helper_return(void) { write_pc_interwork(R[14]); }

static void nh_uidivmod(void) {
  u32 a = R[0], b = R[1];
  if (!b) { R[0] = 0; R[1] = 0; helper_return(); return; }
  R[0] = a / b;
  R[1] = a % b;
  helper_return();
}
static void nh_idivmod(void) {
  s32 a = (s32)R[0], b = (s32)R[1];
  if (!b) { R[0] = 0; R[1] = 0; helper_return(); return; }
  if (a == (s32)0x80000000 && b == -1) { R[0] = 0x80000000u; R[1] = 0; helper_return(); return; }
  R[0] = (u32)(a / b);
  R[1] = (u32)(a % b);
  helper_return();
}
static void nh_uldivmod(void) {
  u64 a = (u64)R[0] | ((u64)R[1] << 32), b = (u64)R[2] | ((u64)R[3] << 32);
  u64 q = b ? a / b : 0, r = b ? a % b : 0;
  R[0] = (u32)q; R[1] = (u32)(q >> 32); R[2] = (u32)r; R[3] = (u32)(r >> 32);
  helper_return();
}
static void nh_ldivmod(void) {
  s64 a = (s64)((u64)R[0] | ((u64)R[1] << 32)), b = (s64)((u64)R[2] | ((u64)R[3] << 32));
  s64 q, r;
  if (!b) { q = 0; r = 0; }
  else if (a == (s64)0x8000000000000000ULL && b == -1) { q = a; r = 0; }
  else { q = a / b; r = a % b; }
  R[0] = (u32)q; R[1] = (u32)((u64)q >> 32); R[2] = (u32)r; R[3] = (u32)((u64)r >> 32);
  helper_return();
}

static const char *const native_helper_names[] = {
    "__aeabi_uidiv", "__udivsi3", "__aeabi_uidivmod", "__aeabi_idiv", "__divsi3", "__aeabi_idivmod",
    "__aeabi_uldivmod", "__aeabi_ldivmod",
};
static void (*const native_helpers[])(void) = {
    nh_uidivmod, nh_uidivmod, nh_uidivmod, nh_idivmod, nh_idivmod, nh_idivmod, nh_uldivmod, nh_ldivmod,
};
#define NATIVE_HELPERS 8
static u32 native_helper_addr(int i) { return find_symbol(native_helper_names[i]) & ~1u; }

#include "blit_helpers.inc"
