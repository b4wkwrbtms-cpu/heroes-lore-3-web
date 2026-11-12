// Rule changes the player asked for in 영웅서기5. Each one is checked against the exact instruction
// words of the library build it was read from and left out otherwise.
//  - level up: twice the stat points (+8) and three times the skill points (+3 every other level)
//  - twice the experience from monsters and quests
//  - field bosses (type 1) also drop three pieces (weapon, accessory, armour) and story bosses (type 3)
//    five (weapon, accessory, three armour pieces) of the best equipment the hero can use at the hero's
//    level: the highest grade available, with options rolled at the top of the game's range (at least 3)
//  - every equipped accessory adds critical +25 on top of its own options
//  - the hero's buffs (buff skills, stance and spirit buffs) do not run out
#include "base.h"

typedef void (*Hle)(void);
u32 find_symbol(const char *name);
void hook_at(u32 addr, Hle fn, const char *name);
void exec_displaced(u32 insn, u32 addr);

#define GMAIN (LOAD_BASE + 0x16fcf0u)
#define HERO_PTR (GMAIN + 0x1474u)
#define ITEM_TABLE (GMAIN + 0x1444u)
#define MAP_ITEMS (GMAIN + 0x1448u)
#define ITEM_SIZE 376u
#define OPT_CRITICAL 38

static u32 rng;
static u32 rnd(u32 n) {
  rng ^= rng << 13;
  rng ^= rng >> 17;
  rng ^= rng << 5;
  return n ? rng % n : 0;
}

static int patch(u32 off, u32 expect, u32 insn) {
  if (rd32(LOAD_BASE + off) != expect) return 0;
  wr32(LOAD_BASE + off, insn);
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Boss drops
static u32 fn_new_drop;

static int usable(u32 e, int cat, int cls) {
  int t = rd8(e + 0x155);
  if (cat <= 4 || cat == 9) return t == cls; // weapons and shields belong to one class
  return (cls == 1 || cls == 2) ? t == 5 : (t == 5 || t == 6); // armour and accessories by weight
}

// strongest item of a category the hero can use at the hero's level: highest grade (up to 4; plain
// items count as the rare items they drop as), and among those the newest; an item one grade lower
// wins only when it is at least 9 levels newer. Ties at random.
static int pick(int cat, int cls, int lvl) {
  u32 it = rd32(ITEM_TABLE);
  int n = (s16)rd16(it + cat * 2);
  u32 base = rd32(it + 0x28 + cat * 4);
  int best = -1, bs = -1, ties = 0;
  for (int i = 0; i < n && i < 128; i++) {
    u32 e = base + ITEM_SIZE * i;
    int g = (s8)rd8(e + 0x15c), l = rd8(e + 0x15d);
    if (g < 0 || g > 4 || l > lvl || !usable(e, cat, cls)) continue;
    int score = l + 8 * (g < 2 ? 2 : g);
    if (score > bs) { best = i; bs = score; ties = 1; }
    else if (score == bs && rnd(++ties) == 0) best = i;
  }
  return best;
}

// one option for slot k the way the game rolls them (its option table), at the top of the value range
static void roll_option(u32 e, int k, int lvl, s8 *type, s8 *val, const s8 *have) {
  u32 ot = rd32(rd32(ITEM_TABLE) + 0x74);
  for (int tries = 0; tries < 20; tries++) {
    int r = (int)rnd(1000), i = 0;
    for (; i < 48; i++) if (r < (s16)rd16(ot + i * 8 + 2 + k * 2)) break;
    if (i == 48) continue;
    int id = rd8(ot + i * 8), scale = (s8)rd8(ot + i * 8 + 1);
    if (id == 0 || id == 108 || id == 109) continue; // none, level-limit relief, spirit power
    if (id == have[0] || id == have[1] || id == have[2]) continue;
    int v = scale * lvl / 100 * 120 / 100; // the game rolls 80..120% of scale x level / 100
    *type = (s8)id;
    *val = (s8)(v < 3 ? 3 : v > 100 ? 100 : v);
    return;
  }
  (void)e;
}

static void drop_item(int cat, int idx, int lvl, s32 x, s32 y) {
  u32 it = rd32(ITEM_TABLE);
  u32 e = rd32(it + 0x28 + cat * 4) + ITEM_SIZE * idx;
  int g = (s8)rd8(e + 0x15c);
  s8 type[3], val[3], grade = -1;
  for (int k = 0; k < 3; k++) { type[k] = -1; val[k] = -1; }
  s8 have[3] = {(s8)rd8(e + 0x15f), (s8)rd8(e + 0x160), (s8)rd8(e + 0x161)};
  int slots = 3;
  if (g < 2) { grade = 2; slots = 2; have[0] = have[1] = have[2] = -1; } // plain items come as rare
  int ilv = rd8(e + 0x15d);
  if (ilv < lvl) ilv = lvl;
  for (int k = 0; k < slots; k++) {
    if (have[k] >= 0 && grade < 0) continue; // the item's own fixed option
    roll_option(e, k, ilv, &type[k], &val[k], have);
    have[k] = type[k];
  }
  u32 a[12] = {rd32(MAP_ITEMS), (u32)x, (u32)y, (u32)cat, (u32)idx, (u32)(s32)grade,
               (u32)(s32)type[0], (u32)(s32)val[0], (u32)(s32)type[1], (u32)(s32)val[1], (u32)(s32)type[2], (u32)(s32)val[2]};
  call_guest(fn_new_drop, 12, a);
}

static void boss_drops(u32 mon, int story) {
  u32 hero = rd32(HERO_PTR);
  if (!hero || !rd32(MAP_ITEMS) || !rd32(ITEM_TABLE)) return;
  int cls = (s8)rd8(hero + 0x22c), lvl = rd8(hero + 0x22d);
  if (cls < 0 || cls > 3) return;
  int cats[8], n = 0;
  cats[n++] = cls; // weapon
  cats[n++] = 10;  // accessory
  int armour[5] = {5, 6, 7, 8, 9}, na = cls == 3 ? 5 : 4;
  for (int i = na - 1; i > 0; i--) { int j = (int)rnd((u32)i + 1), t = armour[i]; armour[i] = armour[j]; armour[j] = t; }
  for (int i = 0; i < (story ? 3 : 1); i++) cats[n++] = armour[i];
  static const s8 spread[8][2] = {{-20, 0}, {20, 0}, {0, -14}, {0, 14}, {-14, -10}, {14, 10}, {-14, 10}, {14, -10}};
  s32 x = (s32)rd32(mon + 4), y = (s32)rd32(mon + 8);
  for (int i = 0; i < n; i++) {
    int idx = pick(cats[i], cls, lvl);
    if (idx >= 0) drop_item(cats[i], idx, lvl, x + spread[i][0], y + spread[i][1]);
  }
}

#define DROP_ENTRY 0xbc910u
static u32 drop_insn;
static void hle_set_drop_item(void) {
  u32 mon = R[0];
  int t = rd8(mon + 0x22c);
  if (t == 1 || t == 3) boss_drops(mon, t == 3);
  exec_displaced(drop_insn, LOAD_BASE + DROP_ENTRY);
}

// ---------------------------------------------------------------------------------------------
// Buffs: BATTLER::DecreaseCount(short *timer) counts every buff down; the hero's buff-skill, stance
// and spirit-buff timers are left alone
#define DECREASE_COUNT 0x49f68u
static void hle_decrease_count(void) {
  u32 self = R[0], p = R[1];
  u32 hero = rd32(HERO_PTR);
  u32 off = p - hero;
  int keep = hero && self == hero && (off == 292 || off == 294 || off == 296 || off == 648 || off == 656);
  if (!keep) {
    s32 v = (s16)rd16(p) - 1;
    wr16(p, (u16)(v < 0 ? 0 : v));
  }
  cpu_pc = R[14] & ~1u;
}

// ---------------------------------------------------------------------------------------------
// Accessories: right after HERO::CalcStatusComputation has applied the options of all eight equipment
// slots, apply one more "critical +25" option for each accessory, the same way the game applies one
#define AFTER_EQUIP_OPTIONS 0x96998u
static u32 crit_insn, fn_calc, fn_apply, fn_equip_ptr, fn_get_equip, formula_var;
static void apply_option(u32 hero, int type, int value) {
  u32 g = GMAIN, formula = rd32(formula_var);
  wr8(g + 0x57e, (u8)type);
  wr16(g + 0x580, (u16)value);
  for (int k = 0; k < 3; k++) {
    wr16(hero + 422, rd16(g + 34 * type + 2 * k + 1438));
    u32 ca[6] = {formula, (u32)(s32)(s8)rd8(g + 34 * type + k + 1435), hero, 0, 0, 0};
    u32 v = call_guest(fn_calc, 6, ca);
    u32 aa[3] = {hero, (u32)(s32)(s8)rd8(g + 34 * type + k + 1432), v};
    call_guest(fn_apply, 3, aa);
  }
}
static void hle_accessory_crit(void) {
  u32 hero = rd32(HERO_PTR);
  if (hero && R[6] == hero && formula_var) {
    u32 equip = call_guest(fn_equip_ptr, 1, &hero);
    for (u32 slot = 6; equip && slot < 8; slot++) {
      u32 ga[2] = {equip, slot};
      u32 item = call_guest(fn_get_equip, 2, ga);
      if (item && rd8(item + 0x14) == 10) apply_option(hero, OPT_CRITICAL, 25);
    }
  }
  exec_displaced(crit_insn, LOAD_BASE + AFTER_EQUIP_OPTIONS);
}

// ---------------------------------------------------------------------------------------------
EXPORT(apply_tweaks) int apply_tweaks(u32 seed) {
  rng = seed | 1;
  // the build these offsets come from
  if (find_symbol("_ZN7Monster11SetDropItemEv") != LOAD_BASE + DROP_ENTRY) return -1;
  int n = 0;
  n += patch(0x97f60, 0xe28c2004u, 0xe28c2008u); // stat points: add r2, r12, #4 -> #8
  n += patch(0x97f74, 0x02822001u, 0x02822003u); // skill points: addeq r2, r2, #1 -> #3
  n += patch(0xc06f0, 0xe1a0a000u, 0xe1a0a080u); // monster exp: mov r10, r0 -> r0, lsl #1
  n += patch(0xd49a8, 0xe0812002u, 0xe0812082u); // quest exp: add r2, r1, r2 -> r2, lsl #1
  fn_new_drop = find_symbol("_ZN7MapItem11NewDropItemEiiaaaaaaaaa");
  if (fn_new_drop && rd32(LOAD_BASE + DROP_ENTRY) == 0xe92d4ff0u) {
    drop_insn = rd32(LOAD_BASE + DROP_ENTRY);
    hook_at(LOAD_BASE + DROP_ENTRY, hle_set_drop_item, "boss_drops");
    n++;
  }
  if (rd32(LOAD_BASE + DECREASE_COUNT) == 0xe1d130b0u && rd32(LOAD_BASE + DECREASE_COUNT + 4) == 0xe2433001u) {
    hook_at(LOAD_BASE + DECREASE_COUNT, hle_decrease_count, "buff_timers");
    n++;
  }
  fn_calc = find_symbol("_ZN7Formula4calcEiP4CHARS1_P13HeroSkillInfoP8ItemBase");
  fn_apply = find_symbol("_ZN4HERO18ApplyBuildupEffectEai");
  fn_equip_ptr = find_symbol("_ZN4HERO15GetEquipItemPtrEv");
  fn_get_equip = find_symbol("_ZN9EquipItem12GetEquipItemEa");
  // the Formula instance, through the GOT slot Monster::SetDieMotion loads it from
  if (rd32(LOAD_BASE + 0xc069c) == 0xe08f4004u && rd32(LOAD_BASE + 0xc06b4) == 0xe59f3270u)
    formula_var = rd32(LOAD_BASE + 0xc06a4 + rd32(LOAD_BASE + 0xc0924) + rd32(LOAD_BASE + 0xc092c));
  if (fn_calc && fn_apply && fn_equip_ptr && fn_get_equip && formula_var && rd32(LOAD_BASE + AFTER_EQUIP_OPTIONS) == 0xe59f347cu) {
    crit_insn = rd32(LOAD_BASE + AFTER_EQUIP_OPTIONS);
    hook_at(LOAD_BASE + AFTER_EQUIP_OPTIONS, hle_accessory_crit, "accessory_crit");
    n++;
  }
  return n;
}
