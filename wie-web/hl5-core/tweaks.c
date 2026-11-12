// Rule changes the player asked for in 영웅서기5. Each one is checked against the exact instruction
// words of the library build it was read from and left out otherwise.
//  - level up: twice the stat points (+8) and three times the skill points (+3 every other level)
//  - twice the experience from monsters and quests
//  - field bosses (type 1) also drop three pieces (weapon, accessory, armour) and story bosses (type 3)
//    five (weapon, accessory, three armour pieces) of the best equipment the hero can use at the hero's
//    level: the highest grade available, always with attack %, critical and critical damage
//  - every equipped accessory adds critical +25 on top of its own options
//  - the hero's buffs (buff skills, stance and spirit buffs) do not run out
//  - on the game-over screen the hero can always revive: the game asks to use a revival charm as if one
//    were in the bag, and reviving does not take one (buying one needs EA's servers, which are gone)
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
// and rare items count as the unique items they drop as), and among those the newest; an item one
// grade lower wins only when it is at least 9 levels newer. Ties at random.
static int pick(int cat, int cls, int lvl) {
  u32 it = rd32(ITEM_TABLE);
  int n = (s16)rd16(it + cat * 2);
  u32 base = rd32(it + 0x28 + cat * 4);
  int best = -1, bs = -1, ties = 0;
  for (int i = 0; i < n && i < 128; i++) {
    u32 e = base + ITEM_SIZE * i;
    int g = (s8)rd8(e + 0x15c), l = rd8(e + 0x15d);
    if (g < 0 || g > 4 || l > lvl || !usable(e, cat, cls)) continue;
    int score = l + 8 * (g < 3 ? 3 : g);
    if (score > bs) { best = i; bs = score; ties = 1; }
    else if (score == bs && rnd(++ties) == 0) best = i;
  }
  return best;
}

// Every boss drop carries attack %, critical and critical damage (the player's choice), replacing
// whatever options the item had. Values follow the game's own scale x level / 100 at the top of its
// 80..120% roll, at least 5; an item's own option of the same kind keeps its value when that is higher.
#define OPT_MELEE 28
#define OPT_RANGED 29
#define OPT_CRIT_DAMAGE 45
static void drop_item(int cat, int idx, int cls, int lvl, s32 x, s32 y) {
  u32 it = rd32(ITEM_TABLE);
  u32 e = rd32(it + 0x28 + cat * 4) + ITEM_SIZE * idx;
  int g = (s8)rd8(e + 0x15c);
  int lv = rd8(e + 0x15d);
  if (lv < lvl) lv = lvl;
  const int type[3] = {cls == 2 ? OPT_RANGED : OPT_MELEE, OPT_CRITICAL, OPT_CRIT_DAMAGE};
  const int scale[3] = {10, 10, 25};
  s32 val[3];
  for (int k = 0; k < 3; k++) {
    int v = scale[k] * lv / 100 * 120 / 100;
    if (v < 5) v = 5;
    for (int j = 0; j < 3; j++)
      if (rd8(e + 0x15f + j) == type[k] && (s8)rd8(e + 0x162 + j) > v) v = (s8)rd8(e + 0x162 + j);
    val[k] = v > 100 ? 100 : v;
  }
  // plain and rare items come as unique (grade 3), the lowest grade that shows three options
  s32 grade = g < 3 ? 3 : -1;
  u32 a[12] = {rd32(MAP_ITEMS), (u32)x, (u32)y, (u32)cat, (u32)idx, (u32)grade,
               (u32)type[0], (u32)val[0], (u32)type[1], (u32)val[1], (u32)type[2], (u32)val[2]};
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
    if (idx >= 0) drop_item(cats[i], idx, cls, lvl, x + spread[i][0], y + spread[i][1]);
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
  // revival: the talisman count (bag category 18, index 23) reads as 1 on the game-over screen
  n += patch(0xdffe0, 0xebfefde5u, 0xe3a00001u); // StateGame::DrawGameOver: bl GetBagItemTotalBunchCount -> mov r0, #1
  n += patch(0xdeba0, 0xebff02f5u, 0xe3a00001u); // StateGame::TouchGameOver: same
  n += patch(0xe036c, 0xebfefd02u, 0xe3a00001u); // StateGame::KeyGameOver: same
  n += patch(0xe03b8, 0xebff0657u, 0xe1a00000u); // StateGame::KeyGameOver: bl DeleteBagItemCategoryIndex -> nop
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
