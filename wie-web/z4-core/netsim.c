// The PvP arena's server, played here in the core (Gamevil's own is long gone). The game builds and reads
// its packets as always, but CGsNetCore::Connect and CGsNetCore::Send (the transmit) never touch a socket:
// a request is answered by this file a frame later, through the game's own receive path (the packet put in
// the receive buffer, then the connection's OnRecvDone, as CGsNetCore::Recv does). The arena's requests
// (connect, the last match's result, the player's fighters, a random, searched or revenge opponent) get
// real answers; any other network menu gets the server's "failed" answer, as when it could not connect.
//
// Opponents are a ranked roster of a hundred under names of their own, of all four classes (see `rival`):
// each fights with the player's own hero's battle data, scaled by its rank, in its class with the hero's
// equipment turned into its class's (as the game turns drops). The player meets rivals near their points,
// so wins bring stronger ones; the top fifteen are well beyond the player. The player's wins, losses and
// points are counted the way the game shows them; whoever beat the player is on the revenge list until
// beaten back (kept while the page runs).
#include "base.h"
#ifdef NATIVE
char *getenv(const char *);
int atoi(const char *);
#endif

u32 find_symbol(const char *name);
int aot_hook(u32 addr, void (*fn)(void));
u32 call_guest(u32 addr, int nargs, const u32 *args);
u32 call_guest_unhooked(u32 addr, int nargs, const u32 *args);

static u32 n_connect, n_send, n_char_data, n_apply_stat, n_reg_result, n_stat_total, n_xor_byte, n_partner_cnt;
static u32 n_item_tid, n_to_base, n_to_class, n_layout, n_get_tbl, n_get_val, n_item_cls, n_hp_max, n_pvp_draw;
static u32 n_equip, n_xor_short;
static int n_on;
static u32 n_game, n_save, n_objs, n_items, n_xls;

typedef struct { const char *name; u32 size, sig; u32 *addr; } NetSym;
static const NetSym nsyms[] = {
    {"_ZN10CGsNetCore7ConnectEPKcsb", 98, 0x8686251au, &n_connect},
    {"_ZN10CGsNetCore4SendEv", 204, 0x843edcd4u, &n_send},
    {"_ZN14CMvNetworkMenu14SetPVPCharDataEP19tagCharaterBaseDataP9CMvPlayer", 268, 0x2d0b4438u, &n_char_data},
    {"_ZN12CMvStateMenu11OnApplyStatEb", 416, 0xd6de88bcu, &n_apply_stat},
    {"_ZN6CMvNet27API_ZN4_SC_REG_MATCH_RESULTEv", 188, 0x71356347u, &n_reg_result},
    {"_ZN12CMvCharacter12GetStatTotalE8EnumStatib", 108, 0xbc12011au, &n_stat_total},
    {"_Z13GsGetXorValueIhET_S0_", 24, 0x177182a6u, &n_xor_byte},
    {"_ZN9CMvPlayer18GetAllMyPartnerCntEv", 84, 0x8bcbacb2u, &n_partner_cnt},
    {"_ZN10CMvItemMgr14ConvertItemTIDE17EnumCharClassTypeibb", 244, 0x7940d5abu, &n_item_tid},
    {"_ZN10CMvItemMgr31ConvertClassItemToBaseClassItemEi", 104, 0x4b422414u, &n_to_base},
    {"_ZN10CMvItemMgr31ConvertBaseClassItemToClassItemE17EnumCharClassTypei", 104, 0x8e793081u, &n_to_class},
    {"_ZN9CMvXlsMgr6GetTblEi", 40, 0x2529598eu, &n_get_tbl},
    {"_ZN10GVXLLoader6GetValEii", 180, 0x576ba6beu, &n_get_val},
    {"_ZN7CMvItem16GetCharClassTypeEv", 52, 0xcb3fd8e3u, &n_item_cls},
    {"_ZN12CMvCharacter8GetHPMaxEv", 148, 0x49296bfeu, &n_hp_max},
    {"_ZN9CMvPlayer12GetEquipItemE21EnumItemEquipPosition", 84, 0x2a4ece71u, &n_equip},
    {"_Z13GsGetXorValueIsET_S0_", 26, 0x276f78ffu, &n_xor_short},
    {"_ZN10CZnPvpMenu6DoDrawEv", 68, 0xe03fa5c2u, &n_pvp_draw},
    {"_ZN10CMvItemMgr12GetPvpRewordEb", 348, 0xe65dd23du, &n_layout},
    // the replies are laid out the way these read them
    {"_ZN6CMvNet18API_ZN4_SC_CONNECTEv", 508, 0xc1ca12a7u, &n_layout},
    {"_ZN6CMvNet20SetCharacterDataInfoEbb", 410, 0xe86c2e87u, &n_layout},
    {"_ZN6CMvNet31API_ZN4_SC_GET_MATCH_RANDOM_OPPEv", 100, 0x8f4d0b3au, &n_layout},
    {"_ZN6CMvNet30API_ZN4_SC_PUT_MATCH_CHAR_DATAEv", 50, 0x50b24c71u, &n_layout},
    {"_ZN6CMvNet27API_ZN4_SC_GET_REVENGE_LISTEv", 308, 0x6f3c78c6u, &n_layout},
    {"_ZN6CMvNet27API_ZN4_SC_GET_REVENGE_DATAEv", 108, 0xb09cc59fu, &n_layout},
    {"_ZN6CMvNet36API_ZN4_SC_GET_MATCH_SEARCH_OPP_LISTEv", 280, 0xdc61f5f8u, &n_layout},
    {"_ZN6CMvNet36API_ZN4_SC_GET_MATCH_SEARCH_OPP_DATAEv", 100, 0x44ef01f1u, &n_layout},
    {"_ZN6CMvNet10OnRecvDoneEv", 788, 0xdda8c531u, &n_layout},
};

static int n_resolve(void) {
  static int resolved;
  if (resolved) return resolved > 0;
  resolved = -1;
  for (u32 i = 0; i < sizeof nsyms / sizeof nsyms[0]; i++) {
    u32 a = find_symbol(nsyms[i].name) & ~1u;
    if (!a) return 0;
    u32 h = 2166136261u;
    for (u32 k = 0; k < nsyms[i].size; k++) h = (h ^ rd8(a + k)) * 16777619u;
    if (h != nsyms[i].sig) { logf("netsim: %s differs (%08x)", nsyms[i].name, h); return 0; }
    *nsyms[i].addr = a;
  }
  // OnApplyStat: ldr r6, [pc, #0x17c]; add r6, pc; ldr r6, [r6] -> the variable holding the game (+8 the hero)
  n_game = rd32(n_apply_stat + 0xc + rd32(n_apply_stat + 0x184));
  // SC_REG_MATCH_RESULT: ldr r5, [pc, #0x90]; add r5, pc; ldr r5, [r5] -> the variable holding the save data
  n_save = rd32(n_reg_result + 0x2e + 4 + rd32(n_reg_result + 0xb8));
  // GetAllMyPartnerCnt: ldr r3, [pc, #0x34]; add r3, pc; ldr r3, [r3] -> the variable holding the object manager
  n_objs = rd32(n_partner_cnt + 0x1e + 4 + rd32(n_partner_cnt + 0x50));
  // ConvertItemTID: ldr r5, [pc, #0x80]; add r5, pc; ldr r5, [r5] -> the variable holding the item manager
  n_items = rd32(n_item_tid + 0x78 + 4 + rd32(n_item_tid + 0xf0));
  // CMvItem::GetCharClassType: ldr r3, [pc, #0x20]; add r3, pc; ldr r3, [r3] -> the variable holding the tables
  n_xls = rd32(n_item_cls + 0x12 + 4 + rd32(n_item_cls + 0x30));
  resolved = 1;
  return 1;
}

static void n_return(u32 r) {
  R[0] = r;
  u32 lr = R[14];
  fT = lr & 1;
  cpu_pc = lr & ~1u;
}

// ---- pending deliveries (one connection at a time is all the game uses)
enum { EV_NONE, EV_CONNECT, EV_REPLY };
static u32 ev_net;
static int ev_kind;
static u8 reply[0x2000];
static u32 reply_len;

static u32 vfunc(u32 obj, u32 slot) { return rd32(rd32(obj) + slot); }

// ---- the server
static u8 req[0x2000];
static u32 req_len, rp; // request body and read position
static u8 *op;          // reply writer
static void w1(u32 v) { *op++ = (u8)v; }
static void w2(u32 v) { w1(v); w1(v >> 8); }
static void w4(u32 v) { w2(v); w2(v >> 16); }
static void wn(const void *p, u32 n) { const u8 *s = p; while (n--) w1(s ? *s++ : 0); }
static u32 r1(void) { return rp < req_len ? req[rp++] : 0; }
static u32 r2(void) { u32 v = r1(); return v | r1() << 8; }
static u32 r4(void) { u32 v = r2(); return v | r2() << 16; }

// the save slot in play (CMvOptionSaveData + 0x18c, 0x1d48 a slot; the connection's +0xac is the slot)
static u32 slot_addr(u32 net) { return rd32(n_save) + 0x18c + 0x1d48 * rd32(net + 0xac); }
static u32 hero(void) { u32 g = rd32(n_game); return g ? rd32(g + 8) : 0; }

// the hero's partner, found the way CMvObjectMgr::SearchAllMyPartner does: a player object (type 1) of the
// hero's group in either of the manager's two lists
static u32 partner(u32 me) {
  u32 om = rd32(n_objs);
  if (!om || !me) return 0;
  for (u32 l = om; l < om + 0x20; l += 0x10) {
    u32 arr = rd32(l + 0x74), n = rd32(l + 0x78);
    for (u32 i = 0; i < n && i < 64; i++) {
      u32 o = rd32(arr + 4 * i);
      if (o && o != me && (s8)rd8(o + 4) == 1 && rd32(o + 0x6c) == rd32(me + 0x6c)) return o;
    }
  }
  return 0;
}
static u32 level_of(u32 who) { u32 a = rd8(who + 0x593); return call_guest(n_xor_byte | 1, 1, &a) & 0xff; }
static u32 stat_of(u32 who, u32 stat) { u32 a[4] = {who, stat, 0, 0}; return call_guest(n_stat_total | 1, 4, a); }

// The arena's ladder: eight tiers (bronze to challenger) of a hundred rivals each, ranks 0 to 799. A rival
// fights with the player's own hero's battle data, its four main stats (and HP, SP) scaled by the rank:
// from half the player's at rank 0, growing by the same step every rank, to 31.6 times at rank 799. Attack
// and staying power both grow that way, so a rival's fighting strength ("전투력", attack plus defence times
// most HP) goes from a quarter of the player's to a thousand times it, about 2.8 times a tier. Their level
// is a little under the player's at the bottom and far over it at the top. The player meets rivals near
// their points (a fifth of them, give or take two ranks; a tier is 500 points), so wins bring stronger
// ones; a win pays more the higher the tier, and gives a piece of equipment for the player's class near
// their level, better the higher the tier.
#define TIERS 8
#define PER_TIER 100
#define RANKS (TIERS * PER_TIER)
#define TOP 15
#define TIER_PTS 500
typedef struct { u32 id; char name[0x30]; u8 cls; s8 dlv; u16 rank, pct, win, lose; u8 boost, pad[3]; } Opp;
static Opp cur;
static u32 seed = 12345;

// What the arena keeps between visits (the page stores it, see arena_keep): the player's hero as it was
// when the arena first measured it (its battle data, attack, defence, most HP and the equipment bonus
// then), which every rival is built from from then on, so whatever the player gains afterwards counts;
// and the revenge list.
#define KEEP_MAGIC 0x34413a5au
// The ladder's standard, the player's choice: their blader at level 38 with attack 9,061,703 and defence
// 2,148,126 (the arena's screen, 2026-11-28). Whatever the hero is when measured (its equipment, skills
// and class are taken from it), the rivals' stats are scaled so that the measured hero would have this
// attack and defence; the player's own strength keeps changing as it does.
#define PIN_ATT 9061703.0
#define PIN_DEF 2148126.0
typedef struct {
  u32 magic, slot, att, def, hp, n_revenge, serial, best_tier, pity, promo, streak, pad;
  double scale; // the measured hero's stats times this give the ladder's standard (PIN_ATT, PIN_DEF)
  u8 blob[0x3e4];
  Opp revenge[4];
} Keep;
static Keep keep;
static u32 keep_rev;
#define revenge keep.revenge
#define n_revenge keep.n_revenge
#define opp_serial keep.serial

static const char *const adj[25] = {
    "\xec\x9e\x91\xec\x9d\x80",
    "\xeb\xb0\x94\xeb\x9e\x8c",
    "\xec\x88\xb2\xec\x9d\x98",
    "\xed\x91\xb8\xeb\xa5\xb8",
    "\xec\x83\x88\xeb\xb2\xbd",
    "\xeb\xb6\x89\xec\x9d\x80",
    "\xec\xa1\xb0\xec\x9a\xa9\xed\x95\x9c",
    "\xeb\x8b\xac\xeb\xb9\x9b",
    "\xeb\xb9\xa0\xeb\xa5\xb8",
    "\xed\x95\x98\xec\x96\x80",
    "\xea\xb0\x95\xec\xb2\xa0",
    "\xec\x9a\xa9\xea\xb0\x90\xed\x95\x9c",
    "\xea\xb2\x80\xec\x9d\x80",
    "\xed\x99\xa9\xea\xb8\x88",
    "\xec\x9d\x80\xeb\xb9\x9b",
    "\xec\x84\x9c\xeb\xa6\xac",
    "\xeb\xb6\x88\xea\xbd\x83",
    "\xeb\xb2\x88\xea\xb0\x9c",
    "\xea\xb7\xb8\xeb\xa6\xbc\xec\x9e\x90",
    "\xeb\xb3\x84\xeb\xb9\x9b",
    "\xed\x8f\xad\xed\x92\x8d",
    "\xec\x8b\xac\xec\x97\xb0",
    "\xec\xb2\x9c\xeb\x91\xa5",
    "\xec\xb9\xa0\xed\x9d\x91",
    "\xed\x83\x9c\xec\x96\x91"
}; // 작은 바람 숲의 푸른 새벽 붉은 조용한 달빛 빠른 하얀 강철 용감한 검은 황금 은빛 서리 불꽃 번개 그림자 별빛 폭풍 심연 천둥 칠흑 태양
static const char *const noun[32] = {
    "\xeb\xb0\xa9\xeb\x9e\x91\xec\x9e\x90",
    "\xec\x82\xac\xeb\x83\xa5\xea\xbe\xbc",
    "\xea\xb6\x81\xec\x88\x98",
    "\xec\xa0\x84\xec\x82\xac",
    "\xeb\x8a\x91\xeb\x8c\x80",
    "\xea\xb8\xb0\xec\x82\xac",
    "\xea\xb2\x80\xec\x82\xac",
    "\xeb\xa7\x88\xeb\xb2\x95\xec\x82\xac",
    "\xec\x88\x98\xed\x98\xb8\xec\x9e\x90",
    "\xec\xb9\xbc\xeb\x82\xa0",
    "\xeb\xa7\xa4",
    "\xea\xb3\xb0",
    "\xec\x97\xac\xec\x9a\xb0",
    "\xec\x9a\xa9\xeb\xb3\x91",
    "\xea\xb8\xb0\xec\x88\x98",
    "\xeb\x8f\x84\xec\xa0\x81",
    "\xec\x82\xac\xeb\x8f\x84",
    "\xed\x88\xac\xec\x82\xac",
    "\xed\x8c\x8c\xec\x88\x98\xea\xbe\xbc",
    "\xec\x88\x9c\xeb\xa1\x80\xec\x9e\x90",
    "\xea\xb2\x80\xea\xb0\x9d",
    "\xec\xb0\xbd\xec\x88\xa0\xec\x82\xac",
    "\xed\x95\x99\xec\x9e\x90",
    "\xec\x88\x98\xeb\x8f\x84\xec\x8a\xb9",
    "\xec\xa0\x95\xec\xb0\xb0\xeb\xb3\x91",
    "\xed\x8f\xac\xec\x88\x98",
    "\xea\xb1\xb0\xec\x9d\xb8",
    "\xea\xb5\xb0\xec\xa3\xbc",
    "\xec\x98\x81\xec\x9b\x85",
    "\xeb\xa7\xb9\xec\x88\x98",
    "\xed\x95\xb4\xec\xa0\x81",
    "\xec\x84\xb1\xea\xb8\xb0\xec\x82\xac"
}; // 방랑자 사냥꾼 궁수 전사 늑대 기사 검사 마법사 수호자 칼날 매 곰 여우 용병 기수 도적 사도 투사 파수꾼 순례자 검객 창술사 학자 수도승 정찰병 포수 거인 군주 영웅 맹수 해적 성기사
static const char *const top[15] = {
    "\xeb\xb0\x94\xeb\x9e\x8c\xec\x9d\x98\xea\xb2\x80\xed\x9d\x94",
    "\xec\x9d\x80\xed\x95\x98\xec\x9d\x98\xea\xb6\x81\xec\x88\x98",
    "\xea\xb0\x95\xec\xb2\xa0\xec\x9d\x98\xeb\xb0\x94\xec\x9c\x84",
    "\xeb\xb6\x88\xeb\xa9\xb8\xec\x9d\x98\xec\xb0\xbd",
    "\xec\x8b\xac\xec\x97\xb0\xec\x9d\x98\xea\xb8\xb0\xec\x82\xac",
    "\xed\x8f\xad\xed\x92\x8d\xec\x9d\x98\xec\x82\xac\xec\x88\x98",
    "\xeb\xb6\x89\xec\x9d\x80\xeb\x8b\xac\xea\xb5\xb0\xec\xa3\xbc",
    "\xec\x98\x81\xec\x9b\x90\xec\x9d\x98\xec\x88\x98\xed\x98\xb8\xec\x9e\x90",
    "\xed\x9d\x91\xec\x97\xbc\xec\x9d\x98\xea\xb5\xb0\xec\xa3\xbc",
    "\xed\x94\xbc\xec\x9d\x98\xeb\x8c\x80\xea\xb3\xb5",
    "\xec\xb2\x9c\xeb\xb2\x8c\xec\x9d\x98\xec\x82\xac\xeb\x8f\x84",
    "\xed\x98\xbc\xeb\x8f\x88\xec\x9d\x98\xeb\xa7\x88\xec\x99\x95",
    "\xeb\xac\xb4\xed\x8c\xa8\xec\x9d\x98\xea\xb2\x80\xec\x84\xb1",
    "\xec\x8b\xa0\xec\x82\xb4\xec\x9e\x90",
    "\xea\xb2\xb0\xed\x88\xac\xec\x9e\xa5\xec\x9d\x98\xec\xa0\x84\xec\x84\xa4"
}; // 바람의검흔 은하의궁수 강철의바위 불멸의창 심연의기사 폭풍의사수 붉은달군주 영원의수호자 흑염의군주 피의대공 천벌의사도 혼돈의마왕 무패의검성 신살자 결투장의전설

static void copy_str(char *d, const char *a, const char *b) {
  int n = 0;
  while (*a && n < 0x2f) d[n++] = *a++;
  while (b && *b && n < 0x2f) d[n++] = *b++;
  while (n < 0x30) d[n++] = 0;
}
// the stat scale of rank r in percent: 50 x 1.0052039^r (63.25 times over the 799 steps)
static u32 rank_pct(u32 r) {
  double v = 50.0;
  for (u32 i = 0; i < r; i++) v *= 1.0052039;
  return (u32)(v + 0.5);
}
// rank r's rival (its number is left to the caller)
static void rival(u32 r, Opp *o) {
  if (r >= RANKS) r = RANKS - 1;
  u32 tier = r / PER_TIER;
  o->rank = (u16)r;
  o->cls = (u8)((r * 3 + 1) % 4);
  if (r >= RANKS - TOP) copy_str(o->name, top[r - (RANKS - TOP)], 0);
  else copy_str(o->name, adj[(r % 25) * 7 % 25], noun[r / 25]);
  o->pct = (u16)rank_pct(r);
  o->dlv = (s8)(-6 + (s32)(36 * r / (RANKS - 1)));
  o->win = (u16)(20 + 5 * tier);
  o->lose = (u16)(10 + 3 * tier);
}
static u32 rank_of_name(const char *name) {
  Opp o;
  for (u32 r = 0; r < RANKS; r++) {
    rival(r, &o);
    int k = 0;
    while (k < 0x30 && o.name[k] == name[k] && name[k]) k++;
    if (k < 0x30 && !o.name[k] && !name[k]) return r;
  }
  return 0;
}
static s32 points_now(void) {
  u32 save = rd32(n_save);
  s32 pts = save ? (s32)rd32(save + 0x18c + 0x1d48 * rd32(save + 0x7f40) + 0x58) : 0;
#ifdef NATIVE
  if (getenv("NETPTS")) pts = atoi(getenv("NETPTS"));
#endif
  return pts;
}
// the rank the player's points reach: a fifth of them
static u32 player_rank(void) {
  s32 r = points_now() / (TIER_PTS / PER_TIER);
  return r < 0 ? 0 : r >= RANKS ? RANKS - 1 : (u32)r;
}
static void new_opp(u32 r) {
  rival(r, &cur);
  if (opp_serial < 1000) opp_serial = 1000;
  cur.id = ++opp_serial;
  keep_rev++;
}
static void revenge_drop(u32 id) {
  keep_rev++;
  for (u32 i = 0; i < n_revenge; i++)
    if (revenge[i].id == id) { for (u32 k = i + 1; k < n_revenge; k++) revenge[k - 1] = revenge[k]; n_revenge--; return; }
}
static void revenge_add(const Opp *o) {
  keep_rev++;
  revenge_drop(o->id);
  if (n_revenge == 4) revenge_drop(revenge[0].id);
  revenge[n_revenge++] = *o;
}

// tagCharaterBaseData (0x3e4 bytes) of a character, made by the game's own CMvNetworkMenu::SetPVPCharData
// in free stack space well below the game's
static u32 char_data(u32 who) {
  u32 tmp = (R[13] - 0x40000u) & ~15u;
  for (u32 i = 0; i < 0x3e4; i++) wr8(tmp + i, 0);
  u32 a[3] = {0, tmp, who};
  call_guest(n_char_data | 1, 3, a);
  return tmp;
}
static u32 u16max(u32 v) { return v > 0xffff ? 0xffff : v; } // the lists carry 16 bits
static u32 lv_shift(u32 lv, s32 d) { s32 v = (s32)lv + d; return v < 1 ? 1 : v > 99 ? 99 : (u32)v; }
// the same, turned into a rival's: their strength, their class (the equipment made the class's own, as
// the game's CMvItemMgr does for drops) and their level
static u32 scaled(u32 v, u32 pct) { u64 x = (u64)v * pct / 100; return x < 1 ? 1 : x > 0x7fffffff ? 0x7fffffff : (u32)x; }
static void put_rival_data(u32 who, const u8 *src, s32 cls, s32 dlv, u32 pct) {
  u32 d = char_data(who);
  if (src) for (u32 i = 0; i < 0x3e4; i++) wr8(d + i, src[i]);
  // tagSavePlayerData: +0xc the four main stats, +0x6c HP, +0x70 SP
  for (u32 k = 0; k < 4; k++) wr32(d + 0xc + 4 * k, scaled(rd32(d + 0xc + 4 * k), pct));
  wr32(d + 0x6c, scaled(rd32(d + 0x6c), pct));
  wr32(d + 0x70, scaled(rd32(d + 0x70), pct));
  if (cls >= 0 && (u32)cls != rd8(d + 1)) {
    u32 mgr = rd32(n_items);
    wr8(d + 1, (u8)cls);
    for (u32 k = 0; k < 10 && mgr; k++) {
      u32 it = d + 0x134 + 0x2c * k;
      s32 tid = (s16)rd16(it);
      if (tid < 0 || tid >= 0x7d0 || (tid >= 0x3da && tid <= 0x3dd)) continue;
      u32 a[3] = {mgr, (u32)tid, 0};
      u32 base = call_guest(n_to_base | 1, 2, a);
      a[1] = (u32)cls; a[2] = base;
      wr16(it, (u16)call_guest(n_to_class | 1, 3, a));
    }
  }
  wr8(d, (u8)lv_shift(rd8(d), dlv));
  for (u32 i = 0; i < 0x3e4; i++) w1(rd8(d + i));
}

static u32 class_of(u32 who) { // tagSavePlayerData: +1 the class
  u32 d = char_data(who);
  return rd8(d + 1);
}

static double dsqrt(double x) {
  if (x <= 0) return 0;
  double r = x > 1 ? x : 1;
  for (int i = 0; i < 64; i++) r = 0.5 * (r + x / r);
  return r;
}
static double dpow(double a, u32 n) { double r = 1; while (n--) r *= a; return r; }
// The arena's equipment power. Each piece worn has a grade, its quality in the game (0 D, 1 C, 2 B, 3 A,
// 4 S: the arena's prizes come in these, with the options the game rolls for that quality), and an option
// score of 0-99 read from its own options (a hash of the piece's data, so a piece keeps its score). A piece
// counts PIECE[grade] times 0.95-1.05 by its score; wearing several pieces of one grade or better is a
// set (2/4/6/8/10 pieces), whose bonus is SET; the best set counts. Refining does not count. Ten S
// pieces with average options come to about 1000 times (better options, more), enough for the
// challenger at the top (1000 times the measured hero); ten A about 100 (the top of master), ten B
// about 7 (platinum), ten C about 2.4 (gold). From ten A each S piece in their place adds about 1.19
// times (the A set still counts them), and the tenth S brings the S set: about 1000.
static const double PIECE[5] = {1.0, 1.04, 1.09, 1.18, 1.4};
static const double SET[5][5] = {
    {1, 1, 1, 1, 1},
    {1.1, 1.2, 1.3, 1.45, 1.6},
    {1.2, 1.45, 1.8, 2.3, 3},
    {1.5, 2.5, 5, 10, 19},
    {1.5, 2.5, 5, 12, 35},
};
typedef struct { double power, set_mult; s32 set_grade; u32 set_pieces, count[5], rolls, pieces; } Gear;
static u32 piece_grade(u32 it) {
  u32 q = rd16(it + 8);
  s32 g = (s16)call_guest(n_xor_short | 1, 1, &q);
  return g < 0 || g > 4 ? 0 : (u32)g;
}
static u32 piece_roll(u32 it) {
  u32 h = 2166136261u;
  for (u32 k = 0; k < 0x2a; k++) {
    if (k == 2 || k == 3 || k == 7) continue; // durability, refining
    h = (h ^ rd8(it + k)) * 16777619u;
  }
  return (h >> 8) % 100;
}
static void gear_of(u32 me, Gear *g) {
  double m = 1;
  u32 *n = g->count;
  for (u32 k = 0; k < 5; k++) n[k] = 0;
  g->rolls = g->pieces = 0;
  for (u32 pos = 0; pos < 10 && me; pos++) {
    u32 a[2] = {me, pos};
    u32 it = call_guest(n_equip | 1, 2, a);
    if (!it || (s16)rd16(it) < 0) continue;
    u32 grade = piece_grade(it), roll = piece_roll(it);
    m *= PIECE[grade] * (0.95 + 0.1 * roll / 99.0);
    n[grade]++;
    g->rolls += roll;
    g->pieces++;
  }
  g->set_mult = 1;
  g->set_grade = -1;
  g->set_pieces = 0;
  for (s32 grade = 1; grade <= 4; grade++) {
    u32 have = 0;
    for (s32 k = grade; k <= 4; k++) have += n[k];
    if (have < 2) continue;
    u32 step = (have >= 10 ? 10 : have) / 2 - 1;
    if (SET[grade][step] > g->set_mult) { g->set_mult = SET[grade][step]; g->set_grade = grade; g->set_pieces = (step + 1) * 2; }
  }
  g->power = m * g->set_mult;
}
static double gear_mult(u32 me) { Gear g; gear_of(me, &g); return g.power; }
static u32 cur_slot(void) { u32 save = rd32(n_save); return save ? rd32(save + 0x7f40) : 0; }
static u32 hp_of(u32 who) { return call_guest(n_hp_max | 1, 1, &who); }
// the hero measured once (again after arena_rebase, or for another save slot)
static void measure(u32 me) {
  if (keep.magic == KEEP_MAGIC && keep.slot == cur_slot()) return;
  u32 d = char_data(me);
  for (u32 i = 0; i < 0x3e4; i++) keep.blob[i] = rd8(d + i);
  double att = stat_of(me, 4), def = stat_of(me, 5);
  if (att < 1) att = 1;
  if (def < 1) def = 1;
  keep.scale = dsqrt(PIN_ATT / att * (PIN_DEF / def));
  keep.att = (u32)PIN_ATT;
  keep.def = (u32)PIN_DEF;
  keep.hp = (u32)(hp_of(me) * keep.scale);
  keep.pity = keep.promo = keep.streak = 0;
  keep.best_tier = player_rank() / PER_TIER;
  keep.slot = cur_slot();
  keep.magic = KEEP_MAGIC;
  keep_rev++;
}
// a rank's stat scale against the measured hero, less by the root of the player's equipment power (attack
// and HP both shrink by it, so the fighting strength by all of it)
static double gain_of(u32 me) { double g = gear_mult(me); return g < 1 ? 1 : g; }
static u32 eff_pct(u32 pct, u32 me) {
  double gain = gain_of(me);
  double p = pct * (keep.scale > 0 ? keep.scale : 1) / dsqrt(gain);
  return p < 1 ? 1 : (u32)(p + 0.5);
}

// a line of the search or revenge list: the opponent's name and what the list shows of the two fighters
static void list_entry(const Opp *o, int is_revenge) {
  u32 me = hero(), mate = partner(me);
  if (is_revenge) { w4(o->id); wn(o->name, 0x30); w1(0); wn(0, 6); } // -, the date of the match
  else { w1(0); wn(o->name, 0x30); }
  if (me) measure(me);
  u32 pct = me ? eff_pct(o->pct, me) : o->pct;
  w1(o->cls); w1(lv_shift(keep.blob[0] ? keep.blob[0] : 1, o->dlv));
  w2(u16max(scaled(keep.att, pct))); w2(u16max(scaled(keep.def, pct)));
  w1(mate ? class_of(mate) : 0); w1(mate ? lv_shift(level_of(mate), o->dlv) : 0);
  w2(mate ? u16max(scaled(stat_of(mate, 4), pct)) : 0); w2(mate ? u16max(scaled(stat_of(mate, 5), pct)) : 0);
}

// The prize for beating `cur`: a piece of equipment of the player's class near their level, its grade
// (the game's quality, 0 D to 4 S) drawn from the rival's tier's table (DROP, in percent), so the game
// rolls options to match. A promotion's first win gives the tier's best grade; otherwise every fifth win
// is a grade better. The piece goes to a place where the player wears something of a lower grade, if
// there is one, so a set fills up. From platinum it needs five levels less, from diamond one of its
// numbers is raised (the game's own reward flags). The item table (5): column 7 the type (0 weapon,
// 1 armour, 4 accessory), 8 where it is worn, 9 the class (0: made the class's own by the game's own
// conversion), 12 the level needed. Only items below 0x7d0 are items of the table.
static const u8 DROP[TIERS][5] = {
    {60, 35, 5, 0, 0}, {35, 45, 18, 2, 0}, {15, 40, 35, 10, 0}, {5, 25, 45, 25, 0},
    {0, 15, 42, 40, 3}, {0, 5, 35, 52, 8}, {0, 0, 25, 60, 15}, {0, 0, 10, 65, 25},
};
static u16 cand_tid[0x7d0];
static u8 cand_lv[0x7d0], cand_pos[0x7d0];
static u32 n_cand;
static u32 tbl_val(u32 tbl, u32 col, u32 row) { u32 a[3] = {tbl, col, row}; return call_guest(n_get_val | 1, 3, a); }
static u32 rnd(u32 n) { seed = seed * 1103515245u + 12345u; return (seed >> 16) % n; }
static void prize(u32 *tid, u32 *quality, u32 *less_level, u32 *boost) {
  u32 tier = cur.rank / PER_TIER, me = hero();
  u32 roll = rnd(100), grade = 0, acc = 0;
  for (u32 g = 0; g < 5; g++) { acc += DROP[tier][g]; if (roll < acc) { grade = g; break; } }
  u32 top = 0;
  for (u32 g = 0; g < 5; g++) if (DROP[tier][g]) top = g;
  if (top < 2) top = 2;
  cur.boost = 0;
  if (keep.promo) { grade = top; cur.boost = 1; }
  else if (keep.pity >= 4 && grade < 4) { grade++; cur.boost = 2; }
  *tid = 0xffff; *quality = grade; *less_level = tier >= 3; *boost = tier >= 4;
  u32 xls = rd32(n_xls), mgr = rd32(n_items);
  if (!me || !xls || !mgr) return;
  u32 a[2] = {xls, 5};
  u32 tbl = call_guest(n_get_tbl | 1, 2, a);
  if (!tbl) return;
  if (!n_cand) {
    u32 rows = rd16(tbl + 0xa);
    if (rows > 0x7d0) rows = 0x7d0;
    for (u32 t = 0; t < rows; t++) {
      u32 type = tbl_val(tbl, 7, t), lv = tbl_val(tbl, 12, t), pos = tbl_val(tbl, 8, t);
      if ((type <= 1 || type == 4) && tbl_val(tbl, 9, t) == 0 && lv > 0 && lv < 200 && pos < 10) {
        cand_tid[n_cand] = (u16)t; cand_lv[n_cand] = (u8)lv; cand_pos[n_cand++] = (u8)pos;
      }
    }
  }
  if (!n_cand) return;
  // places worn below this grade (or empty)
  u32 want = 0;
  for (u32 pos = 0; pos < 10; pos++) {
    u32 b[2] = {me, pos};
    u32 it = call_guest(n_equip | 1, 2, b);
    if (!it || (s16)rd16(it) < 0 || piece_grade(it) < grade) want |= 1u << pos;
  }
  // the best a player of this level may use (five more with the flag), then one of the dozen closest below
  u32 lv0 = level_of(me) + (*less_level ? 5 : 0), best[12], nb = 0;
  for (u32 pass = 0; pass < 4 && !nb; pass++) {
    u32 limit = pass & 1 ? 255 : lv0, mask = pass < 2 && want ? want : 0x3ff;
    for (s32 lv = (s32)limit; lv > 0 && nb < 12; lv--)
      for (u32 i = 0; i < n_cand && nb < 12; i++)
        if (cand_lv[i] == (u32)lv && (mask >> cand_pos[i] & 1)) best[nb++] = cand_tid[i];
  }
  if (!nb) return;
  u32 c[3] = {mgr, class_of(me), best[rnd(nb)]};
  *tid = call_guest(n_to_class | 1, 3, c) & 0xffff;
}

// the offer of `cur`: CMvNet::SetCharacterDataInfo's data, with or without each fighter's small header
static int opp_reply(u32 team, int headers, int with_id) {
  u32 me = hero();
  if (!me) return 0;
  u32 mate = partner(me);
  measure(me);
  u32 pct = eff_pct(cur.pct, me);
  w1(0);
  if (with_id) w4(cur.id); // (a revenge match keeps the number from the list)
  u32 tid, quality, less, boost;
  prize(&tid, &quality, &less, &boost);
  w2(cur.win); w2(cur.lose); w2(0); w2(tid); // points won, points lost, -, the prize
  w1(quality); w1(less); w1(boost);
  // the gold a win pays (CMvItemMgr::GetPvpReword reads the connection's +0xc12, which no reply sets)
  wr32(ev_net + 0xc12, 2000u * (cur.rank / PER_TIER + 1) * (cur.rank % PER_TIER + 10));
  wn(cur.name, 0x30);
  w4(0); w4(0); w4(0); w4(0);
  w1(0);
  w1(2); // the opponent and a partner
  for (int k = 0; k < 2; k++) {
    if (headers) { w1(0); w1(0); w2(0); w2(0); }
    if (k && mate) put_rival_data(mate, 0, -1, cur.dlv, pct);
    else put_rival_data(me, keep.blob, cur.cls, cur.dlv, pct);
    w2(0); w2(0);
  }
  return 1;
}

static void serve(u32 id) {
  op = reply + 4;
  logf("netsim: request %04x (%u bytes)", id, req_len);
  switch (id) {
  case 0x10c: // CS_CONNECT -> SC_CONNECT
    w1(0);                   // result
    w1(1);                   // accepted
    w1(1); w1(0); w1(1);     // flags (0x767..0x769)
    w1(0);                   // no file to fetch
    w1(0);                   // 0x766
    w4(1);                   // user number
    w4(0);                   // 0x1710
    w2(0); w1(0); w1(0);     // version / options
    w4(0);                   // four bytes
    { // the player's game ID (the arena's name for them): the one saved, or a first one
      u32 saved = rd32(n_save) + 0x7d60;
      static const char first[] = "\xec\xa0\x9c\xeb\x85\xb8\xeb\x8b\x88\xec\x95\x84\xec\x9a\xa9\xec\x82\xac"; // 제노니아용사
      u8 id[0x30] = {0};
      if (rd8(saved)) for (int i = 0; i < 0x2f; i++) id[i] = rd8(saved + i);
      else for (int i = 0; first[i]; i++) id[i] = (u8)first[i];
      wn(id, 0x30);
    }
    w1(0); w4(0); w4(0);
    w1(0xff);                // no slot flag
    break;
  case 0x80a: { // CS_REG_MATCH_RESULT: the last match -> the player's wins, losses and points
    u32 slot = slot_addr(ev_net);
    r1();
    u32 opp = r4(), kind = r1();
    s32 win = (s32)rd32(slot + 0x50), lose = (s32)rd32(slot + 0x54), pts = (s32)rd32(slot + 0x58);
    if (opp && opp == cur.id) {
      if (kind == 1 || kind == 3) {
        win++; pts += cur.win;
        keep.streak = 0;
        if (cur.boost == 1) keep.promo = 0;
        if (cur.boost == 2) keep.pity = 0;
        else keep.pity++;
        u32 t = (u32)(pts / (TIER_PTS / PER_TIER)) / PER_TIER;
        if (t >= TIERS) t = TIERS - 1;
        if (t > keep.best_tier) { keep.best_tier = t; keep.promo = 1; }
      }
      if (kind == 2 || kind == 4) { lose++; pts -= cur.lose; keep.streak++; }
      keep_rev++;
      if (kind == 2) revenge_add(&cur);
      if (kind == 3) revenge_drop(cur.id);
      cur.id = 0;
    }
    if (pts < 0) pts = 0;
    w1(0);
    w4(win); w4(lose); w4(pts);
    break;
  }
  case 0x818: { // CS_GET_MATCH_RANDOM_OPP -> a rival near the player's rank
    u32 team = r1() == 2;
    seed = seed * 1103515245u + 12345u + opp_serial;
    // from three ranks under the player to one over; after two losses in a row, five ranks lower
    s32 r = (s32)player_rank() + (s32)((seed >> 16) % 5) - 3 - (keep.streak >= 2 ? 5 : 0);
    new_opp(r < 0 ? 0 : r >= RANKS ? RANKS - 1 : (u32)r);
    if (!opp_reply(team, 1, 1)) { op = reply + 4; w1(0xff); }
    break;
  }
  case 0x81e: { // CS_GET_MATCH_SEARCH_OPP_LIST -> four rivals around the player's rank, whatever was typed
    s32 from = (s32)player_rank() - 1;
    if (from < 0) from = 0;
    if (from > RANKS - 4) from = RANKS - 4;
    w1(0);
    w1(4);
    for (u32 i = 0; i < 4; i++) { Opp o; rival((u32)from + i, &o); list_entry(&o, 0); }
    break;
  }
  case 0x820: { // CS_GET_MATCH_SEARCH_OPP_DATA (mode, name) -> that one
    u32 team = r1() == 2;
    char name[0x30];
    for (int i = 0; i < 0x30; i++) name[i] = (char)r1();
    name[0x2f] = 0;
    new_opp(rank_of_name(name));
    if (!opp_reply(team, 0, 1)) { op = reply + 4; w1(0xff); }
    break;
  }
  case 0x81a: // CS_GET_REVENGE_LIST -> those who beat the player
    w1(0);
    w1(n_revenge);
    for (u32 i = 0; i < n_revenge; i++) list_entry(&revenge[i], 1);
    break;
  case 0x81c: { // CS_GET_REVENGE_DATA (mode, id) -> that one again
    u32 team = r1() == 2, id = r4();
    new_opp(0);
    for (u32 i = 0; i < n_revenge; i++) if (revenge[i].id == id) cur = revenge[i];
    cur.id = id;
    if (!opp_reply(team, 1, 0)) { op = reply + 4; w1(0xff); }
    break;
  }
  case 0x800: // CS_PUT_MATCH_CHAR_DATA: the player's hero (then partner) for others to fight; kept as sent
    w1(0);
    break;
  default:
    w1(0xff); // failure
    break;
  }
  reply_len = (u32)(op - reply);
  reply[0] = (u8)reply_len; reply[1] = (u8)(reply_len >> 8);
  reply[2] = (u8)(id + 1); reply[3] = (u8)((id + 1) >> 8);
}

// CGsNetCore::Connect(host, port, flag): connected at once, the game told so a frame later
static void n_t_connect(void) {
  u32 net = R[0];
  wr32(net + 0x8, 2);
  wr32(net + 0xc, 0);
  ev_net = net;
  ev_kind = EV_CONNECT;
  n_return(1);
}

// CGsNetCore::Send(): the packet the game put together in its send buffer is taken as sent
static void n_t_send(void) {
  u32 net = R[0];
  u32 buf = rd32(net + 0x70), base = rd32(buf), len = rd16(buf + 0xc);
  if (len < 4 || len > sizeof req + 4) { n_return(1); return; }
  u32 id = rd16(base + 2);
  req_len = len - 4;
  for (u32 i = 0; i < req_len; i++) req[i] = rd8(base + 4 + i);
  rp = 0;
  if (rd8(net + 0x11)) logf("netsim: request body is base64");
  // the buffer emptied as CGsNetBuffer::Clear does
  for (u32 i = 0; i < rd16(buf + 4); i++) wr8(base + i, 0);
  wr32(buf + 8, base);
  wr16(buf + 0xc, 0);
  wr32(net + 0x8, 2);
  ev_net = net;
  serve(id);
  ev_kind = EV_REPLY;
  u32 a = net;
  call_guest(vfunc(net, 0x8), 1, &a); // OnSendDone
  n_return(0);
}

// the arena screen (CZnPvpMenu) drawn: when, by the frames counted here
static u32 n_frame, arena_seen;
static void n_t_pvp_draw(void) {
  arena_seen = n_frame;
  u32 a = R[0];
  n_return(call_guest_unhooked(n_pvp_draw | 1, 1, &a));
}

// For the page's badge on the arena screen (doubles): [0] whether it shows, [1] the player's points,
// [2] wins, [3] losses, [4] the player's rank (0-799, a hundred a tier), [5] the offered rival's rank or
// -1, [6] the player's fighting strength (attack plus defence, times most HP, over 10000) with the
// equipment power, [7] the rival's, [8] the equipment power, [9] losses in a row, [10] whether a
// promotion prize waits, [11] wins towards the better prize, [12] the best set's grade (-1 none),
// [13] its pieces, [14] its bonus, [15] the average option score, [16-20] pieces worn of grade D-S.
EXPORT(arena_info) int arena_info(double *out) {
  if (!n_on || !n_resolve()) return -1;
  for (u32 i = 0; i < 21; i++) out[i] = 0;
  out[0] = arena_seen && n_frame - arena_seen < 8;
  u32 save = rd32(n_save), slot = save ? save + 0x18c + 0x1d48 * rd32(save + 0x7f40) : 0;
  out[1] = points_now();
  out[2] = slot ? (s32)rd32(slot + 0x50) : 0;
  out[3] = slot ? (s32)rd32(slot + 0x54) : 0;
  out[4] = player_rank();
  out[5] = cur.id ? cur.rank : -1;
  out[8] = 1;
  out[9] = keep.streak;
  out[10] = keep.promo;
  out[11] = keep.pity;
  out[12] = -1;
  u32 me = hero();
  if (me && out[0]) {
    measure(me);
    Gear g;
    gear_of(me, &g);
    double power = g.power < 1 ? 1 : g.power;
    out[8] = power;
    out[12] = g.set_grade;
    out[13] = g.set_pieces;
    out[14] = g.set_mult;
    out[15] = g.pieces ? (double)g.rolls / g.pieces : 0;
    for (u32 k = 0; k < 5; k++) out[16 + k] = g.count[k];
    out[6] = ((double)stat_of(me, 4) + stat_of(me, 5)) * hp_of(me) / 10000.0 * power;
    if (cur.id) {
      double p = eff_pct(cur.pct, me) / 100.0;
      out[7] = ((double)keep.att + keep.def) * keep.hp / 10000.0 * p * p;
    }
  }
  return 0;
}

// What the page stores between visits: where, how big, and a number that changes whenever it should be
// stored again; after the page puts stored bytes back, arena_keep_check drops them if they are not a keep.
EXPORT(arena_keep) u8 *arena_keep(void) { return (u8 *)&keep; }
EXPORT(arena_keep_size) u32 arena_keep_size(void) { return sizeof keep; }
EXPORT(arena_keep_rev) u32 arena_keep_rev(void) { return keep_rev; }
EXPORT(arena_keep_check) int arena_keep_check(void) {
  if (keep.magic != KEEP_MAGIC || n_revenge > 4) {
    u8 *p = (u8 *)&keep;
    for (u32 i = 0; i < sizeof keep; i++) p[i] = 0;
    return 0;
  }
  return 1;
}
// measure the hero again at the next match (the page's "measure again" button)
EXPORT(arena_rebase) void arena_rebase(void) { keep.magic = 0; keep_rev++; }

// once a frame, before the game's frame: what the server has for the game
EXPORT(net_poll) void net_poll(void) {
  n_frame++;
  if (!n_on || !ev_kind) return;
  int kind = ev_kind;
  u32 net = ev_net;
  ev_kind = EV_NONE;
  if (rd32(net + 0x8) < 2) return; // disconnected meanwhile
  u32 a = net;
  if (kind == EV_CONNECT) { call_guest(vfunc(net, 0x4), 1, &a); return; }
  u32 buf = rd32(net + 0x74);
  if (!buf) buf = rd32(net + 0x70);
  u32 base = rd32(buf), cap = rd16(buf + 4);
  if (reply_len > cap) { logf("netsim: reply too long"); return; }
  for (u32 i = 0; i < reply_len; i++) wr8(base + i, reply[i]);
  wr32(buf + 8, base);
  wr16(buf + 0xc, 0);
  call_guest(vfunc(net, 0xc), 1, &a); // OnRecvDone
  buf = rd32(net + 0x74);
  if (!buf) buf = rd32(net + 0x70);
  base = rd32(buf);
  for (u32 i = 0; i < rd16(buf + 4); i++) wr8(base + i, 0);
  wr32(buf + 8, base);
  wr16(buf + 0xc, 0);
}

EXPORT(net_enable) int net_enable(int on) {
  if (!n_resolve()) return -1;
  n_on = on;
  ev_kind = EV_NONE;
  if (aot_hook(n_connect, on ? n_t_connect : 0) || aot_hook(n_send, on ? n_t_send : 0) ||
      aot_hook(n_pvp_draw, on ? n_t_pvp_draw : 0)) return -1;
  return 0;
}

#ifdef NATIVE
// test builds: TRACEFN=sym1,sym2 logs every call of those functions (r0-r3, return address, result)
static u32 tr_addr[8];
static int tr_n;
static void tr_hook(void) {
  u32 pc = cpu_pc & ~1u, a[4] = {R[0], R[1], R[2], R[3]}, lr = R[14];
  u32 st[4] = {rd32(R[13]), rd32(R[13] + 4), rd32(R[13] + 8), rd32(R[13] + 12)};
  int k = 0;
  while (k < tr_n && tr_addr[k] != pc) k++;
  u32 args[8] = {a[0], a[1], a[2], a[3], st[0], st[1], st[2], st[3]};
  u32 r = call_guest_unhooked(pc | 1, 8, args);
  u32 lb = (find_symbol("JNI_OnLoad") & ~1u) - 0x94764;
  logf("trace %x(%x, %x, %x, %x | %x %x) from %x -> %x  [r1: %02x %02x %02x %02x %02x %02x]", pc - lb, a[0], a[1], a[2], a[3], st[0], st[1], (lr & ~1u) - lb, r,
       rd8(a[1]), rd8(a[1] + 1), rd8(a[1] + 2), rd8(a[1] + 3), rd8(a[1] + 4), rd8(a[1] + 5));
  n_return(r);
}
void net_trace_setup(void) {
  char *s = getenv("TRACEFN");
  static char buf[1024];
  if (!s) return;
  int i = 0;
  while (s[i] && i < 1023) { buf[i] = s[i]; i++; }
  buf[i] = 0;
  char *p = buf;
  while (*p && tr_n < 8) {
    char *e = p;
    while (*e && *e != ',') e++;
    char c = *e;
    *e = 0;
    u32 a = find_symbol(p) & ~1u;
    logf("trace %s", p);
    if (a) { tr_addr[tr_n++] = a; aot_hook(a, tr_hook); }
    if (!c) break;
    p = e + 1;
  }
}
#endif
