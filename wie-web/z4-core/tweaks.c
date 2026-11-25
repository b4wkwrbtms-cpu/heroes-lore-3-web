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
//
// Stats (CMvStateMenu, the status window): the main stat points never run out (the game's own setter fills
// them to the most they hold, 65535, whenever the game looks), and one press of a main stat's + puts in up
// to a chosen number of points at once, the way the game does it for one (CMvPlayer::UseMainStatPoint, and
// the window's record of what was put in this time, so cancelling takes them back).
//
// No overflowing damage: GetPercentValue(value, percent, round, base), which almost every damage, stat and
// price step goes through, multiplies in 32 bits, so a large enough attack wraps to a negative number and
// the blow does nothing. This computes it in 64 bits; where the game's own result was right it is the same,
// and where the game's would have wrapped it is the largest value (2^28 - 1, small enough that the sums
// after it cannot wrap either).
//
// Every skill at its highest level: CMvSkill::SetLevel with the skill table's maximum, for each of the
// hero's skills, then the game's own stat update (passive skills count at once).
#include "base.h"

u32 find_symbol(const char *name);
int aot_hook(u32 addr, void (*fn)(void));
u32 call_guest_unhooked(u32 addr, int nargs, const u32 *args);

static u32 get_zen, set_zen, get_gold, set_gold, do_refine, smith_ok, smith_fail;
static u32 get_points, set_points, use_points, apply_stat, stat_cursor, xor_int, xor_byte, percent;
static u32 skill_level, skill_max, game_var, enough_sp, sp_max, set_sp;

typedef struct { const char *name; u32 size, sig; u32 *addr; } TweakSym;
static const TweakSym tsyms[] = {
    {"_ZN17CMvOptionSaveData11GetZenMoneyEv", 48, 0x78f15a51u, &get_zen},
    {"_ZN17CMvOptionSaveData11SetZenMoneyEi", 80, 0x8737c53fu, &set_zen},
    {"_ZN16CMvItemInventory12GetGoldMoneyEv", 52, 0xaca6444eu, &get_gold},
    {"_ZN16CMvItemInventory12SetGoldMoneyEib", 120, 0x01896861u, &set_gold},
    {"_ZN13CMvRefineMenu8DoRefineEv", 224, 0x4ee2cb9eu, &do_refine},
    {"_ZN13CMvRefineMenu19DoBlackSmithSuccessEv", 56, 0x5991b23bu, &smith_ok},
    {"_ZN13CMvRefineMenu16DoBlackSmithFailEv", 56, 0x6d537678u, &smith_fail},
    {"_ZN9CMvPlayer16GetMainStatPointEv", 10, 0x01cae9fcu, &get_points},
    {"_ZN9CMvPlayer16SetMainStatPointEi", 22, 0x0f415ab1u, &set_points},
    {"_ZN9CMvPlayer16UseMainStatPointE8EnumStati", 58, 0x4ec1ff99u, &use_points},
    {"_ZN12CMvStateMenu11OnApplyStatEb", 416, 0xd6de88bcu, &apply_stat},
    {"_ZN12CMvStateMenu25GetSelectedMainStatCursorEv", 60, 0x5c21363au, &stat_cursor},
    {"_Z13GsGetXorValueIiET_S0_", 22, 0xa5d330ccu, &xor_int},
    {"_Z13GsGetXorValueIhET_S0_", 24, 0x177182a6u, &xor_byte},
    {"_Z15GetPercentValueiibi", 54, 0xe6714865u, &percent},
    {"_ZN8CMvSkill8SetLevelEi", 32, 0x90413da0u, &skill_level},
    {"_ZN8CMvSkill12LoadMaxLevelEi", 48, 0x7084551au, &skill_max},
    {"_ZN12CMvCharacter10IsEnoughSPEi", 44, 0x0ed5041eu, &enough_sp},
    {"_ZN12CMvCharacter8GetSPMaxEv", 10, 0x38ddb20du, &sp_max},
    {"_ZN9CMvPlayer5SetSPEib", 74, 0x0ee2515au, &set_sp},
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
  // OnApplyStat: ldr r6, [pc, #0x17c]; add r6, pc; ldr r6, [r6] -> the variable holding the game, whose
  // +8 is the hero (CMvPlayer)
  game_var = rd32(apply_stat + 0xc + rd32(apply_stat + 0x184));
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

// ---- stats
static int stat_unlimited, stat_step = 1;
static u32 hero(void) { u32 g = rd32(game_var); return g ? rd32(g + 8) : 0; }
static u32 guest1(u32 fn, u32 a) { return call_guest_unhooked(fn | 1, 1, &a); }

static u32 refilled_points(u32 player) {
  u32 a[2] = {player, 65535};
  call_guest_unhooked(set_points | 1, 2, a);
  return guest1(get_points, player);
}
static void t_get_points(void) { t_return(refilled_points(R[0])); }

// CMvStateMenu::OnApplyStat(main): the + of the main stat under the cursor
static void t_apply_stat(void) {
  u32 menu = R[0], main = R[1] & 0xff, player = hero();
  if (main && player) {
    s32 points = (s32)(stat_unlimited ? refilled_points(player) : guest1(get_points, player));
    s32 cursor = (s32)guest1(stat_cursor, menu);
    if (points > 0 && cursor >= 0 && cursor < 4) {
      s32 n = stat_step < points ? stat_step : points;
      u32 up = menu + 0x19c + 8 * (u32)cursor;
      wr32(up, guest1(xor_int, guest1(xor_int, rd32(up)) + (u32)n));
      u32 a[3] = {player, (u32)cursor, (u32)-n};
      call_guest_unhooked(use_points | 1, 3, a);
      t_return(0);
      return;
    }
  }
  u32 a[2] = {menu, R[1]};
  t_return(call_guest_unhooked(apply_stat | 1, 2, a));
}

// unlimited: the main stat points never run out; step: points one press of + puts in (1 = as the game)
EXPORT(stat_rules) int stat_rules(int unlimited, int step) {
  if (!t_resolve()) return -1;
  stat_unlimited = unlimited;
  stat_step = step > 1 ? step : 1;
  int r = aot_hook(get_points, unlimited ? t_get_points : 0);
  return r ? r : aot_hook(apply_stat, unlimited || stat_step > 1 ? t_apply_stat : 0);
}

// ---- damage
#define PERCENT_CAP 0x0fffffff
static void t_percent(void) {
  s32 v = (s32)R[0], pct = (s32)R[1], base = (s32)R[3];
  u32 round = R[2];
  if (!base) { // the game's division by zero, as it is
    u32 a[4] = {R[0], R[1], R[2], R[3]};
    t_return(call_guest_unhooked(percent | 1, 4, a));
    return;
  }
  if (!v || !pct) { t_return(0); return; }
  s64 prod = (s64)v * pct;
  s64 q = prod / base;
  if (prod != (s32)prod) // the game's 32-bit product would have wrapped
    t_return(q > PERCENT_CAP ? PERCENT_CAP : q < -PERCENT_CAP ? (u32)-PERCENT_CAP : (u32)(s32)q);
  else // the game's own result: the quotient, or with rounding on at least 1 (or -1)
    t_return(q ? (u32)(s32)q : round ? (prod < 0 ? 0xffffffffu : 1u) : 0);
}

EXPORT(damage_uncapped) int damage_uncapped(int on) {
  if (!t_resolve()) return -1;
  return aot_hook(percent, on ? t_percent : 0);
}

// ---- skills
// Raises every skill of the hero below its highest level to it; the number raised, -1 if not in a game.
EXPORT(skills_max) int skills_max(void) {
  if (!t_resolve()) return -1;
  u32 player = hero();
  if (!player) return -1;
  int raised = 0;
  for (u32 sk = player + 0xe74; sk < player + 0x118c; sk += 0x24) { // CMvPlayer's 22 CMvSkill
    if ((s16)rd16(sk + 4) < 0) continue;                            // no skill in this place
    u32 a[2] = {sk, 0xffffffffu};
    s32 max = (s32)call_guest_unhooked(skill_max | 1, 2, a);
    s32 level = (s32)(guest1(xor_byte, rd8(sk + 6)) & 0xff);
    if (max <= 0 || level >= max) continue;
    a[1] = (u32)max;
    call_guest_unhooked(skill_level | 1, 2, a);
    raised++;
  }
  if (raised) { // the game's stat update, as after learning a skill: UpdateStat(0, 0, 0, 1)
    u32 a[5] = {player, 0, 0, 0, 1};
    call_guest_unhooked(rd32(rd32(player) + 0x228), 5, a);
  }
  return raised;
}

// ---- SP
// CMvCharacter::IsEnoughSP(cost), which every skill, special attack and dash of the hero asks first: for
// the hero it fills SP to the most it holds (CMvPlayer::SetSP) and says yes, so maxed skills, whose cost is
// a share of SP, always go off; for anyone else it answers as the game does.
static void t_enough_sp(void) {
  u32 ch = R[0], player = hero();
  if (ch && ch == player) {
    u32 a[3] = {player, guest1(sp_max, player), 1};
    call_guest_unhooked(set_sp | 1, 3, a);
    t_return(1);
    return;
  }
  u32 a[2] = {R[0], R[1]};
  t_return(call_guest_unhooked(enough_sp | 1, 2, a));
}
EXPORT(sp_unlimited) int sp_unlimited(int on) {
  if (!t_resolve()) return -1;
  return aot_hook(enough_sp, on ? t_enough_sp : 0);
}
