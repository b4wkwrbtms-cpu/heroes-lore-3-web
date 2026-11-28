// The PvP arena's server, played here in the core (Gamevil's own is long gone). The game builds and reads
// its packets as always, but CGsNetCore::Connect and CGsNetCore::Send (the transmit) never touch a socket:
// a request is answered by this file a frame later, through the game's own receive path (the packet put in
// the receive buffer, then the connection's OnRecvDone, as CGsNetCore::Recv does). The arena's requests
// (connect, the last match's result, the player's fighters, a random, searched or revenge opponent) get
// real answers; any other network menu gets the server's "failed" answer, as when it could not connect.
//
// Opponents are a roster of eight under names of their own, of all four classes: each fights with the
// player's own hero's stats and skill levels (so a match is even), in their class with the hero's
// equipment turned into their class's (as the game turns drops), at a level a little off the hero's. The
// player's wins, losses and points are counted the way the game shows them; whoever beat the player is
// on the revenge list until beaten back (kept while the page runs).
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
static u32 n_item_tid, n_to_base, n_to_class, n_layout;
static int n_on;
static u32 n_game, n_save, n_objs, n_items;

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
static u32 stat_of(u32 who, u32 stat) { u32 a[4] = {who, stat, 0, 0}; return call_guest(n_stat_total | 1, 4, a) & 0xffff; }

// a win is worth WIN_PTS and a loss costs LOSE_PTS of the player's points
#define WIN_PTS 20
#define LOSE_PTS 10
typedef struct { u32 id; char name[0x30]; u8 cls; s8 dlv; } Opp;
static Opp cur, revenge[4];
static u32 n_revenge, opp_serial = 1000, search_page;

// the roster: a name, a class (0 slayer, 1 blader, 2 ranger, 3 druid) and how many levels from the player's
typedef struct { const char *name; u8 cls; s8 dlv; } Rival;
static const Rival rivals[] = {
    {"\xea\xb7\xb8\xeb\xa6\xbc\xec\x9e\x90\xea\xb2\x80\xec\x82\xac", 0, 1},        // 그림자검사
    {"Noctis77", 1, 0},
    {"\xeb\x8b\xac\xeb\xb9\x9b\xeb\xa0\x88\xec\x9d\xb8\xec\xa0\x80", 2, 2},        // 달빛레인저
    {"\xec\x88\xb2\xec\x9d\x98\xec\x88\x98\xed\x98\xb8\xec\x9e\x90", 3, -1},       // 숲의수호자
    {"BladeQueen", 1, 3},
    {"\xeb\xb6\x89\xec\x9d\x80\xec\x82\xac\xeb\x83\xa5\xea\xbe\xbc", 2, -2},       // 붉은사냥꾼
    {"druid_rain", 3, 1},
    {"\xea\xb2\xb0\xed\x88\xac\xec\x9e\xa5\xec\x9d\x98\xec\xa0\x84\xec\x84\xa4", 0, 4}, // 결투장의전설
};

#define NAMES (sizeof rivals / sizeof rivals[0])

static const Rival *rival_named(const char *name) {
  for (u32 i = 0; i < NAMES; i++) {
    const char *a = rivals[i].name;
    int k = 0;
    while (a[k] && a[k] == name[k]) k++;
    if (!a[k] && !name[k]) return &rivals[i];
  }
  return &rivals[0];
}
static void new_opp(const Rival *r) {
  cur.id = ++opp_serial;
  for (int i = 0; i < 0x30; i++) cur.name[i] = 0;
  for (int i = 0; r->name[i] && i < 0x2f; i++) cur.name[i] = r->name[i];
  cur.cls = r->cls;
  cur.dlv = r->dlv;
}
static void revenge_drop(u32 id) {
  for (u32 i = 0; i < n_revenge; i++)
    if (revenge[i].id == id) { for (u32 k = i + 1; k < n_revenge; k++) revenge[k - 1] = revenge[k]; n_revenge--; return; }
}
static void revenge_add(const Opp *o) {
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
static u32 lv_shift(u32 lv, s32 d) { s32 v = (s32)lv + d; return v < 1 ? 1 : v > 99 ? 99 : (u32)v; }
// the same, turned into a rival's: their class (the equipment made the class's own, as the game's
// CMvItemMgr does for drops) and their level
static void put_rival_data(u32 who, s32 cls, s32 dlv) {
  u32 d = char_data(who);
  if (cls >= 0 && (u32)cls != rd8(d + 1)) {
    u32 mgr = rd32(rd32(n_items));
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

// a line of the search or revenge list: the opponent's name and what the list shows of the two fighters
static void list_entry(const Opp *o, int is_revenge) {
  u32 me = hero(), mate = partner(me);
  if (is_revenge) { w4(o->id); wn(o->name, 0x30); w1(0); wn(0, 6); } // -, the date of the match
  else { w1(0); wn(o->name, 0x30); }
  w1(o->cls); w1(lv_shift(me ? level_of(me) : 1, o->dlv));
  w2(me ? stat_of(me, 4) : 0); w2(me ? stat_of(me, 5) : 0);
  w1(mate ? class_of(mate) : 0); w1(mate ? lv_shift(level_of(mate), o->dlv) : 0);
  w2(mate ? stat_of(mate, 4) : 0); w2(mate ? stat_of(mate, 5) : 0);
}

// the offer of `cur`: CMvNet::SetCharacterDataInfo's data, with or without each fighter's small header
static int opp_reply(u32 team, int headers, int with_id) {
  u32 me = hero();
  if (!me) return 0;
  u32 mate = partner(me);
  w1(0);
  if (with_id) w4(cur.id); // (a revenge match keeps the number from the list)
  w2(WIN_PTS); w2(LOSE_PTS); w2(0); w2(0xffff); // points won, points lost, -, reward item (none)
  w1(0); w1(0); w1(0);
  wn(cur.name, 0x30);
  w4(0); w4(0); w4(0); w4(0);
  w1(0);
  w1(2); // the opponent and a partner
  for (int k = 0; k < 2; k++) {
    if (headers) { w1(0); w1(0); w2(0); w2(0); }
    if (k && mate) put_rival_data(mate, -1, cur.dlv);
    else put_rival_data(me, cur.cls, cur.dlv);
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
      if (kind == 1 || kind == 3) { win++; pts += WIN_PTS; }
      if (kind == 2 || kind == 4) { lose++; pts -= LOSE_PTS; }
      if (kind == 2) revenge_add(&cur);
      if (kind == 3) revenge_drop(cur.id);
      cur.id = 0;
    }
    if (pts < 0) pts = 0;
    w1(0);
    w4(win); w4(lose); w4(pts);
    break;
  }
  case 0x818: { // CS_GET_MATCH_RANDOM_OPP -> someone from the arena's roster
    u32 team = r1() == 2;
    static u32 turn;
#ifdef NATIVE
    if (getenv("NETRIVAL") && !turn) turn = atoi(getenv("NETRIVAL"));
#endif
    new_opp(&rivals[turn++ % NAMES]);
    if (!opp_reply(team, 1, 1)) { op = reply + 4; w1(0xff); }
    break;
  }
  case 0x81e: // CS_GET_MATCH_SEARCH_OPP_LIST -> the whole roster, whatever was typed
    w1(0);
    w1(NAMES < 4 ? NAMES : 4);
    for (u32 i = 0; i < NAMES && i < 4; i++) {
      Opp o = {0};
      const Rival *r = &rivals[(search_page + i) % NAMES];
      for (int k = 0; r->name[k] && k < 0x2f; k++) o.name[k] = r->name[k];
      o.cls = r->cls; o.dlv = r->dlv;
      list_entry(&o, 0);
    }
    search_page = (search_page + 4) % NAMES;
    break;
  case 0x820: { // CS_GET_MATCH_SEARCH_OPP_DATA (mode, name) -> that one
    u32 team = r1() == 2;
    char name[0x30];
    for (int i = 0; i < 0x30; i++) name[i] = (char)r1();
    name[0x2f] = 0;
    new_opp(rival_named(name));
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
    new_opp(&rivals[0]);
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

// once a frame, before the game's frame: what the server has for the game
EXPORT(net_poll) void net_poll(void) {
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
  if (aot_hook(n_connect, on ? n_t_connect : 0) || aot_hook(n_send, on ? n_t_send : 0)) return -1;
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
