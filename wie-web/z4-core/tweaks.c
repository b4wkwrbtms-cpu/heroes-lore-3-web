// Player-chosen changes to the game's rules (the page's settings turn them on). Each works through the
// game's own functions and is installed only when their bytes are the ones this was written against.
//
// Unlimited money: every time the game asks for the Zen (the cash shop's money,
// CMvOptionSaveData::GetZenMoney) or for the gold of the hero's bag (CMvItemInventory::GetGoldMoney), the
// game's own setter first fills it to the most the game allows (it clamps to the limit in its tables and
// keeps the checksum that guards the value right), then the game's own getter answers. Spending works as
// always and is filled again on the next look, so the shop, refining, skill points, revival and tickets
// never run short, and the save keeps the full amount.
//
// Easier refining (CMvRefineMenu, the blacksmith): the chance of success is never below 80 out of 100
// (a higher chance stays as it is), and the helper item put in the second slot is not used up. The item
// being refined is handled as the game always does.
#include "base.h"

u32 find_symbol(const char *name);
int aot_hook(u32 addr, void (*fn)(void));
u32 call_guest_unhooked(u32 addr, int nargs, const u32 *args);

static u32 get_zen, set_zen, get_gold, set_gold, do_refine, smith_ok, smith_fail;

typedef struct { const char *name; u32 size, sig; u32 *addr; } TweakSym;
static const TweakSym tsyms[] = {
    {"_ZN17CMvOptionSaveData11GetZenMoneyEv", 48, 0x78f15a51u, &get_zen},
    {"_ZN17CMvOptionSaveData11SetZenMoneyEi", 80, 0x8737c53fu, &set_zen},
    {"_ZN16CMvItemInventory12GetGoldMoneyEv", 52, 0xaca6444eu, &get_gold},
    {"_ZN16CMvItemInventory12SetGoldMoneyEib", 120, 0x01896861u, &set_gold},
    {"_ZN13CMvRefineMenu8DoRefineEv", 224, 0x4ee2cb9eu, &do_refine},
    {"_ZN13CMvRefineMenu19DoBlackSmithSuccessEv", 56, 0x5991b23bu, &smith_ok},
    {"_ZN13CMvRefineMenu16DoBlackSmithFailEv", 56, 0x6d537678u, &smith_fail},
};

static int t_resolve(void) {
  static int resolved;
  if (resolved) return resolved > 0;
  resolved = -1;
  for (u32 i = 0; i < sizeof tsyms / sizeof tsyms[0]; i++) {
    u32 a = find_symbol(tsyms[i].name) & ~1u;
    if (!a) return 0;
    u32 h = 2166136261u;
    for (u32 k = 0; k < tsyms[i].size; k++) h = (h ^ rd8(a + k)) * 16777619u;
    if (h != tsyms[i].sig) { logf("tweaks: %s differs (%08x)", tsyms[i].name, h); return 0; }
    *tsyms[i].addr = a;
  }
  resolved = 1;
  return 1;
}

static void t_return(u32 r) {
  R[0] = r;
  u32 lr = R[14];
  fT = lr & 1;
  cpu_pc = lr & ~1u;
}

static void t_get_zen(void) {
  u32 self = R[0];
  u32 a[2] = {self, 0x7fffffffu};
  call_guest_unhooked(set_zen | 1, 2, a);
  t_return(call_guest_unhooked(get_zen | 1, 1, &self));
}

static void t_get_gold(void) {
  u32 self = R[0];
  if (rd8(self + 0xa) == 1) { // the hero's bag (the one the game guards with a checksum)
    u32 a[3] = {self, 0x7fffffffu, 0};
    call_guest_unhooked(set_gold | 1, 3, a);
  }
  t_return(call_guest_unhooked(get_gold | 1, 1, &self));
}

EXPORT(money_unlimited) int money_unlimited(int on) {
  if (!t_resolve()) return -1;
  int r = aot_hook(get_zen, on ? t_get_zen : 0);
  return r ? r : aot_hook(get_gold, on ? t_get_gold : 0);
}

// DoRefine, right after Random(100): r0 is the roll, r7 the chance; the game goes on with
// `cmp r0, r7; blt success`. This stands in for those two instructions with the chance raised to 80.
static void t_refine_roll(void) {
  s32 roll = (s32)R[0], chance = (s32)R[7];
  if (chance < 80) chance = 80;
  fT = 1;
  cpu_pc = roll < chance ? do_refine + 0xba : do_refine + 0x78;
}
// DoBlackSmithSuccess / DoBlackSmithFail use up the helper item in slot 1 (index at +0x1e0, -1 for none):
// with the slot read as empty the game keeps it.
static void t_smith(u32 fn) {
  u32 self = R[0];
  wr32(self + 0x1e0, 0xffffffffu);
  t_return(call_guest_unhooked(fn | 1, 1, &self));
}
static void t_smith_ok(void) { t_smith(smith_ok); }
static void t_smith_fail(void) { t_smith(smith_fail); }

EXPORT(refine_easy) int refine_easy(int on) {
  if (!t_resolve()) return -1;
  int r = aot_hook(do_refine + 0x74, on ? t_refine_roll : 0);
  if (!r) r = aot_hook(smith_ok, on ? t_smith_ok : 0);
  if (!r) r = aot_hook(smith_fail, on ? t_smith_fail : 0);
  return r;
}
