// 영웅서기3: 대지의 성흔 (LGT WIPI, binary.mod 2009-03-10) — memory layout found by running the
// game headlessly and diffing memory. Addresses in the game image (.bss) are fixed; the bag lives
// in the heap and is reached through a pointer the game keeps in .bss.

import type { CheatApi } from "./backend";
import { HL3_ITEMS, type Hl3Item } from "./hl3_items";
import { HL3_SKILLS } from "./hl3_skills";

export const ORBS: Array<{ i: number; n: string; d: string }> = [
  { i: 0, n: "투신의", d: "HPMAX +%" },
  { i: 1, n: "공명의", d: "HP회복 +%" },
  { i: 2, n: "뇌제의", d: "물리공격 +%" },
  { i: 3, n: "금강의", d: "물리방어 +%" },
  { i: 4, n: "정령의", d: "특수방어 +%" },
  { i: 5, n: "사신의", d: "명중 +%" },
  { i: 6, n: "영제의", d: "오브 효과 6" },
  { i: 7, n: "철벽의", d: "오브 효과 7" },
  { i: 8, n: "속박의", d: "오브 효과 8" },
  { i: 9, n: "결의의", d: "오브 효과 9" },
  { i: 10, n: "현자의", d: "오브 효과 10" },
  { i: 11, n: "마도의", d: "오브 효과 11" },
  { i: 12, n: "흡혈의", d: "HP흡수 +%" },
  { i: 13, n: "폭풍의", d: "오브 효과 13" },
  { i: 14, n: "직격의", d: "오브 효과 14" },
];

export const gradeLabel = (name: string): string => {
  switch (name[0]) {
    case "|":
      return "레어";
    case "$":
      return "에픽";
    case "{":
      return "영웅";
    case "@":
      return "전설";
    case "}":
      return "네트워크/캐시";
    default:
      return "";
  }
};

export const displayName = (name: string): string => name.replace(/^[|${}@]/, "");

export const HL3 = {
  /** u32 소지금 */
  GOLD: 0x01503b54,
  /** u32 pointer to the game-state block; the bag array starts BAG_OFFSET bytes in. */
  BAG_PTR: 0x0150d8b0,
  BAG_OFFSET: 0x394,
  RECORD: 60,
  /** Each bag holds BAG_SLOTS records and occupies BAG_STRIDE bytes (16 × 60 + 4 bytes of padding). */
  BAG_SLOTS: 16,
  BAG_STRIDE: 0x3c4,
  /** s8 number of bags the player owns, right after the last bag. */
  BAG_COUNT_OFFSET: 0x1668,
  MAX_BAGS: 5,
  SLOTS: 80,
  /** 10 worn-equipment records (same 60-byte layout) */
  EQUIP: 0x01503e14,
  EQUIP_SLOTS: 10,
  /** u32 current HP, u16 max HP, u32 current SP (×10) */
  /** 현재 HP (u16). 상태창 왼쪽 숫자·HUD 게이지 기준. */
  HP: 0x01503b7a,
  /** 최대 HP (u32). */
  HP_MAX: 0x01503b74,
  SP: 0x01503b80,
  /** u16 level, u32 exp */
  LEVEL: 0x01503b6a,
  EXP: 0x01503b6c,
  /** u8 힘, 체력, 정신, 민첩 (two copies the game keeps in step) */
  STATS: 0x01503b5b,
  STATS2: 0x01503b60,
  /** u16 ATT1, ATT2, P.DEF, M.DEF, CRI, RES, ACC, DOD (final values shown on the status screen) */
  FINAL: 0x01503c18,
  /** second copy: ATT1 @+0, ATT2 @+2, ACC? @+4, CRI @+6, PDEF @+8, RES @+10, MDEF @+12, ... */
  FINAL2: 0x01503b86,
  /** 게임 모드 (u32): 4 = 필드에서 플레이 중, 5 = 메뉴(상태창·가방·스킬창) 열림, 2·3 = 타이틀/로딩. */
  MODE: 0x01503b00,
  /** 남은 스탯 포인트 (u16). 레벨업마다 +4, 게임 자체 상한 276. */
  STAT_POINTS: 0x01503c12,
  /** 남은 스킬 포인트 (u8). 레벨업마다 +1, 게임 자체 상한 44. */
  SKILL_POINTS: 0x01503c14,
  /** 스킬 배열: 주무기 9칸(액티브 6 + 패시브 3), 보조무기 9칸, 칸마다 8바이트, 첫 바이트가 레벨(0~5). */
  SKILLS_A: 0x01503c30,
  SKILLS_B: 0x01503c78,
  SKILL_STRIDE: 8,
  SKILLS_PER_WEAPON: 9,
  SKILL_MAX_LEVEL: 5,
  /** 무기 종류(아이템 카테고리 4~10)가 들어 있는 바이트: 주무기, 보조무기. */
  WEAPON_A: 0x01503b59,
  WEAPON_B: 0x01503b5a,
  HEAP_LO: 0x40000000,
  HEAP_HI: 0x50000000,
} as const;

/** PID from the supported LGT archive's app_info. Names and filenames are not game identities. */
export const isHeroesLore3 = (appId: string): boolean => appId === "PD119037";

/** Check unchanged native routines before enabling this edition's memory tools. */
export const isHeroesLore3Binary = (api: Pick<CheatApi, "read">): boolean => {
  try {
    return api.read(0x38620, 4, false) === 0x307eb500 && api.read(0x17080, 4, false) === 0xb0a8b5f0;
  } catch {
    return false;
  }
};

export interface BagEntry {
  slot: number;
  address: number;
  name: string;
  category: number;
  index: number;
  count: number;
  equipped: boolean;
  /** Quick-slot the item is registered to (index into SLOT_ORDER), or -1. */
  quickSlot: number;
}

/** Quick-slot order used by the game's 등록 menu (1키등록 … #키등록); stored per bag record at +0x21, 0xff = none. */
export const SLOT_ORDER = ["1", "3", "9", "0", "#"] as const;
const QUICK_SLOT_OFFSET = 0x21;
/**
 * Quick-slot tables (u8 × 5 each, indexed by slot 0–4 = keys 1,3,9,0,#). The HUD and the key handler read these, not the bag.
 * KIND: 0 empty, 1 skill, 2 item · ITEMLOC: (bag << 5) | bag index · SKILLX: per-skill value the game stores for skills · IDX: skill index (0xff for items).
 */
export const SLOT_TABLES = { KIND: 0x01503cda, ITEMLOC: 0x01503cdf, SKILLX: 0x01503ce4, IDX: 0x01503cf4 } as const;
const SLOT_KIND = SLOT_TABLES.KIND;
const SLOT_AUX = SLOT_TABLES.IDX;

export interface SlotSnapshot {
  kind: number;
  itemLoc: number;
  skillX: number;
  idx: number;
}

export const readSlot = (api: CheatApi, slot: number): SlotSnapshot => ({
  kind: api.read(SLOT_TABLES.KIND + slot, 1, false),
  itemLoc: api.read(SLOT_TABLES.ITEMLOC + slot, 1, false),
  skillX: api.read(SLOT_TABLES.SKILLX + slot, 1, false),
  idx: api.read(SLOT_TABLES.IDX + slot, 1, false),
});

export const writeSlot = (api: CheatApi, slot: number, snapshot: SlotSnapshot): void => {
  api.write(SLOT_TABLES.KIND + slot, 1, false, snapshot.kind);
  api.write(SLOT_TABLES.ITEMLOC + slot, 1, false, snapshot.itemLoc);
  api.write(SLOT_TABLES.SKILLX + slot, 1, false, snapshot.skillX);
  api.write(SLOT_TABLES.IDX + slot, 1, false, snapshot.idx);
};

const decoder = (() => {
  try {
    return new TextDecoder("euc-kr");
  } catch {
    return undefined;
  }
})();

const decodeName = (bytes: Uint8Array): string => {
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0 && bytes[end] !== 0xff) end += 1;
  const slice = bytes.subarray(0, end);
  if (!decoder) return `(${end} bytes)`;
  try {
    return decoder.decode(slice);
  } catch {
    return "?";
  }
};

const u16 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);

export const bagBase = (api: CheatApi): number => {
  const pointer = api.read(HL3.BAG_PTR, 4, false) >>> 0;
  if (pointer < HL3.HEAP_LO || pointer >= HL3.HEAP_HI) {
    throw new Error("게임이 아직 시작되지 않았어요. 캐릭터로 필드에 나온 뒤 다시 시도하세요.");
  }
  return pointer + HL3.BAG_OFFSET;
};

/** Address of bag record `slot` (bag = slot / 16, position = slot % 16). */
const recordAddress = (base: number, slot: number): number =>
  base + Math.floor(slot / HL3.BAG_SLOTS) * HL3.BAG_STRIDE + (slot % HL3.BAG_SLOTS) * HL3.RECORD;

/** The game's location code for a bag record: bag in the high bits, position in the low five. */
const itemLocation = (slot: number): number => (Math.floor(slot / HL3.BAG_SLOTS) << 5) | slot % HL3.BAG_SLOTS;

export const readBag = (api: CheatApi): BagEntry[] => {
  const base = bagBase(api);
  const bags = Math.max(1, Math.min(HL3.MAX_BAGS, api.read(base - HL3.BAG_OFFSET + HL3.BAG_COUNT_OFFSET, 1, false)));
  const entries: BagEntry[] = [];
  for (let slot = 0; slot < bags * HL3.BAG_SLOTS; slot += 1) {
    const address = recordAddress(base, slot);
    const record = api.dump(address, HL3.RECORD);
    if (record.length < HL3.RECORD) break;
    const exists = record[0x1f] === 1;
    if (!exists) {
      entries.push({ slot, address, name: "", category: -1, index: -1, count: 0, equipped: false, quickSlot: -1 });
      continue;
    }
    entries.push({
      slot,
      address,
      name: decodeName(record.subarray(0, 30)),
      category: u16(record, 0x22),
      index: u16(record, 0x24),
      count: u16(record, 0x26),
      equipped: record[0x1e] === 1,
      quickSlot: record[QUICK_SLOT_OFFSET] === 0xff ? -1 : record[QUICK_SLOT_OFFSET],
    });
  }
  return entries;
};

/** Default socket count the game assigned to starter gear, by category. */
const SOCKETS: Record<number, number> = { 1: 3, 2: 5, 3: 5, 5: 4, 6: 3 };

const hexBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

export const buildRecord = (category: number, item: Hl3Item, count: number): Uint8Array => {
  const record = new Uint8Array(HL3.RECORD);
  record.fill(0xff, 0, 30);
  const name = hexBytes(item.b);
  record.set(name.subarray(0, 28), 0);
  record[Math.min(name.length, 28)] = 0;
  const kind = HL3_ITEMS[category]?.kind ?? "use";
  const view = new DataView(record.buffer);
  if (kind === "equip") {
    record.set([0x00, 0x01, 0x01, 0xff], 0x1e); // not equipped, exists, equipment type
    view.setUint16(0x22, category, true);
    view.setUint16(0x24, item.i, true);
    view.setUint16(0x26, 1, true);
    view.setUint32(0x28, 0xedae06d0, true);
    view.setUint32(0x2c, 287, true);
    // Bag piece, not worn: the game keeps +0x30/+0x33 at 0xff until it is put on.
    record[0x30] = 0xff;
    record[0x31] = 0x00;
    record[0x32] = SOCKETS[category] ?? 3;
    record[0x33] = 0xff;
    record.set([0xff, 0x00, 0xff, 0xff, 0x00, 0x00], 0x34);
    view.setUint16(0x3a, item.s ?? 0, true);
  } else {
    record.set([0xff, 0x01, 0x00, 0xff], 0x1e);
    view.setUint16(0x22, category, true);
    view.setUint16(0x24, item.i, true);
    view.setUint16(0x26, Math.max(1, Math.min(count, 65535)), true);
    view.setUint32(0x28, 0xedaf3f90, true);
    view.setUint32(0x2c, 287, true);
    record.fill(0xff, 0x30, 0x3c);
  }
  return record;
};

export interface GiveResult {
  slot: number;
  stacked: boolean;
  count: number;
}

/** Put `count` of an item into the bag (stacking consumables onto an existing pile when possible). */
export const giveItem = (api: CheatApi, category: number, index: number, count: number): GiveResult => {
  const table = HL3_ITEMS[category];
  const item = table?.items[index];
  if (!table || !item) throw new Error("알 수 없는 아이템이에요.");
  const bag = readBag(api);
  if (table.kind === "use") {
    const existing = bag.find(entry => entry.category === category && entry.index === index && entry.count > 0);
    if (existing) {
      const total = Math.min(99, existing.count + count);
      api.write(existing.address + 0x26, 2, false, total);
      return { slot: existing.slot, stacked: true, count: total };
    }
  }
  const pieces = table.kind === "equip" ? Math.max(1, Math.min(count, 10)) : 1;
  let slot = -1;
  for (let n = 0; n < pieces; n += 1) {
    const empty = bag.find(entry => entry.count === 0 && entry.name === "" && entry.slot > (slot === -1 ? -1 : slot));
    if (!empty) {
      if (n === 0) throw new Error("가방이 가득 찼어요. 아이템을 버리거나 팔고 다시 시도하세요.");
      break;
    }
    api.writeBytes(empty.address, buildRecord(category, item, table.kind === "equip" ? 1 : Math.min(count, 99)));
    slot = empty.slot;
  }
  return { slot, stacked: false, count: table.kind === "equip" ? pieces : Math.min(count, 99) };
};

/** Register a bag item to a quick slot (unregistering whatever was there). */
export const registerItem = (api: CheatApi, entry: BagEntry, quickSlot: number): void => {
  for (const other of readBag(api)) {
    if (other.quickSlot === quickSlot && other.address !== entry.address) api.write(other.address + QUICK_SLOT_OFFSET, 1, false, 0xff);
  }
  api.write(entry.address + QUICK_SLOT_OFFSET, 1, false, quickSlot);
  api.write(SLOT_KIND + quickSlot, 1, false, 2);
  api.write(SLOT_TABLES.ITEMLOC + quickSlot, 1, false, itemLocation(entry.slot));
  api.write(SLOT_TABLES.SKILLX + quickSlot, 1, false, 0);
  api.write(SLOT_AUX + quickSlot, 1, false, 0xff);
};

/**
 * Value the game keeps in SKILLX for a registered skill. Observed in the emulator after registering through the game's own
 * N키등록 menu: weapon A idx 1,2,3 → 9, 11, 13 and weapon B idx 1,2 → 73, 75, i.e. 7 + 2·idx with bit 6 set for the second weapon.
 */
export const skillXValue = (skill: SkillState): number => (skill.weapon === "B" ? 0x40 : 0) + 7 + 2 * skill.index;

/** Register a learned skill to a quick slot exactly like the game's N키등록 does. */
export const registerSkill = (api: CheatApi, quickSlot: number, skill: SkillState): void => {
  for (const other of readBag(api)) {
    if (other.quickSlot === quickSlot) api.write(other.address + QUICK_SLOT_OFFSET, 1, false, 0xff);
  }
  writeSlot(api, quickSlot, { kind: 1, itemLoc: 0, skillX: skillXValue(skill), idx: skill.index });
};

export const slotItem = (api: CheatApi, quickSlot: number): BagEntry | undefined =>
  readBag(api).find(entry => entry.count > 0 && entry.quickSlot === quickSlot);

/** HP / SP potions used by 물약 준비: 엘릭서 (HP 3000), 요정수 (SP 완전 회복). */
export const AUTO_POTIONS = { hp: [18, 3] as const, sp: [18, 6] as const };

/** Put 99 HP potions in `hpSlot` and 99 SP potions in `spSlot`, giving them when the bag has none. */
export const prepareAutoPotions = (api: CheatApi, hpSlot: number, spSlot: number): { hp: string; sp: string } => {
  const names = { hp: "", sp: "" };
  for (const kind of ["hp", "sp"] as const) {
    const [category, index] = AUTO_POTIONS[kind];
    const item = HL3_ITEMS[category]?.items[index];
    if (!item) continue;
    let entry = readBag(api).find(candidate => candidate.category === category && candidate.index === index && candidate.count > 0);
    if (!entry) {
      giveItem(api, category, index, 99);
      entry = readBag(api).find(candidate => candidate.category === category && candidate.index === index && candidate.count > 0);
    }
    if (!entry) throw new Error("가방이 가득 차서 물약을 넣지 못했어요.");
    if (entry.count < 99) api.write(entry.address + 0x26, 2, false, 99);
    registerItem(api, entry, kind === "hp" ? hpSlot : spSlot);
    names[kind] = displayName(item.n);
  }
  return names;
};

/** Keep the items registered to the given quick slots at `count` pieces. Returns true when something was topped up. */
export const topUpSlotItems = (api: CheatApi, quickSlots: number[], count = 99): boolean => {
  let changed = false;
  for (const entry of readBag(api)) {
    if (entry.quickSlot < 0 || !quickSlots.includes(entry.quickSlot) || entry.count <= 0 || entry.count >= count) continue;
    const table = HL3_ITEMS[entry.category];
    if (!table || table.kind !== "use") continue;
    api.write(entry.address + 0x26, 2, false, count);
    changed = true;
  }
  return changed;
};

export const getGold = (api: CheatApi): number => api.read(HL3.GOLD, 4, false) >>> 0;
export const setGold = (api: CheatApi, value: number): void => api.write(HL3.GOLD, 4, false, Math.max(0, Math.min(value, 99_999_999)));
export const freezeGold = (api: CheatApi, value: number): void => api.freeze(HL3.GOLD, 4, false, Math.max(0, Math.min(value, 99_999_999)));

/** Items most people want in bulk: [category, index, label]. */
export const QUICK_ITEMS: Array<[number, number, string]> = [
  [18, 7, "오브원석"],
  [14, 3, "제련석"],
  [18, 3, "엘릭서"],
  [18, 6, "요정수"],
  [18, 2, "미라클포션"],
  [18, 8, "귀환서"],
];

/** 캐시 상점 전용 아이템 (게임 안에서는 네트워크 결제로만 살 수 있던 것들): [category, index, label, description]. */
export const CASH_ITEMS: Array<[number, number, string, string]> = [
  [18, 12, "컵라면", "HP·SP 완전 회복"],
  [18, 13, "오토루팅", "아이템 자동 루팅 (게임 종료 전까지)"],
  [18, 14, "여행가방", "인벤토리 1가방 확장 (최대 5가방)"],
  [18, 11, "부활의서", "게임오버 때 자동 부활"],
  [18, 15, "스탯리셋", "육성한 스탯 포인트 초기화"],
  [18, 16, "스킬리셋", "육성한 스킬 포인트 초기화"],
  [18, 26, "소켓확장", "장비 소켓 증가 (최대 5)"],
  [18, 25, "오브상자", "랜덤 오브 상자"],
  [18, 9, "그리폰의피리", "원하는 마을로 이동"],
];

export const findItem = (category: number, name: string): Hl3Item | undefined =>
  HL3_ITEMS[category]?.items.find(item => item.n.replace(/^[^가-힣A-Za-z0-9]+/, "") === name);

export interface EquipEntry {
  slot: number;
  address: number;
  name: string;
  category: number;
  index: number;
  orb: number;
  orbValue: number;
  stat: number;
  bagAddress?: number;
}

/** Worn equipment (.bss copies) joined with the matching bag records. */
export const readEquipment = (api: CheatApi): EquipEntry[] => {
  let bag: BagEntry[] = [];
  try {
    bag = readBag(api);
  } catch {
    bag = [];
  }
  const entries: EquipEntry[] = [];
  for (let slot = 0; slot < HL3.EQUIP_SLOTS; slot += 1) {
    const address = HL3.EQUIP + slot * HL3.RECORD;
    const record = api.dump(address, HL3.RECORD);
    if (record.length < HL3.RECORD || record[0x1f] !== 1) continue;
    const category = u16(record, 0x22);
    const index = u16(record, 0x24);
    const match = bag.find(entry => entry.equipped && entry.category === category && entry.index === index);
    entries.push({
      slot,
      address,
      name: decodeName(record.subarray(0, 30)),
      category,
      index,
      orb: record[0x34],
      orbValue: u16(record, 0x38),
      stat: u16(record, 0x3a),
      bagAddress: match?.address,
    });
  }
  return entries;
};

const recordsFor = (entry: EquipEntry): number[] => (entry.bagAddress !== undefined ? [entry.address, entry.bagAddress] : [entry.address]);

/** Socket an orb (by table index) with the given percent value into a worn item (and its bag record). */
export const setOrb = (api: CheatApi, entry: EquipEntry, orb: number, percent: number): void => {
  const value = Math.max(0, Math.min(percent, 9999));
  for (const address of recordsFor(entry)) {
    if (orb < 0) {
      api.writeBytes(address + 0x34, new Uint8Array([0xff, 0x00, 0xff, 0xff, 0x00, 0x00]));
    } else {
      api.writeBytes(address + 0x34, new Uint8Array([orb & 0xff, 0x00, 0xff, 0xff, value & 0xff, (value >> 8) & 0xff]));
    }
  }
};

/** Set the item's own attack/defense number. Takes effect in battle after re-equipping. */
export const setItemStat = (api: CheatApi, entry: EquipEntry, stat: number): void => {
  const value = Math.max(0, Math.min(stat, 9999));
  for (const address of recordsFor(entry)) api.write(address + 0x3a, 2, false, value);
};

export const getLevel = (api: CheatApi): number => api.read(HL3.LEVEL, 2, false);
/** 게임의 레벨 상한은 70 (레벨업 루틴이 0x46에서 멈춤). */
export const setLevel = (api: CheatApi, level: number): void => api.write(HL3.LEVEL, 2, false, Math.max(1, Math.min(level, 70)));

export const MODE_FIELD = 4;
/** True while the player is actually on the field (not in a menu), where quick-slot keys mean skills/items. */
export const isOnField = (api: CheatApi): boolean => (api.read(HL3.MODE, 4, false) >>> 0) === MODE_FIELD;

export const getStatPoints = (api: CheatApi): number => api.read(HL3.STAT_POINTS, 2, false);
export const setStatPoints = (api: CheatApi, value: number): void => api.write(HL3.STAT_POINTS, 2, false, Math.max(0, Math.min(value, 9999)));
export const getSkillPoints = (api: CheatApi): number => api.read(HL3.SKILL_POINTS, 1, false);
export const setSkillPoints = (api: CheatApi, value: number): void => api.write(HL3.SKILL_POINTS, 1, false, Math.max(0, Math.min(value, 99)));

/** Weapon category → label used in the skill screen tabs. */
export const HL3_SKILL_LABELS: Record<number, string> = { 4: "스피어", 5: "스워드", 6: "나이프", 7: "건", 8: "라이플", 9: "다크", 10: "홀리" };

export interface SkillState {
  weapon: "A" | "B";
  category: number;
  index: number;
  name: string;
  level: number;
  address: number;
}

/** Current skill levels of both weapons, joined with the skill tables (주무기 category at WEAPON_A, 보조 at WEAPON_B). */
export const readSkills = (api: CheatApi): SkillState[] => {
  const out: SkillState[] = [];
  for (const weapon of ["A", "B"] as const) {
    const category = api.read(weapon === "A" ? HL3.WEAPON_A : HL3.WEAPON_B, 1, false);
    const table = HL3_SKILLS[category];
    const base = weapon === "A" ? HL3.SKILLS_A : HL3.SKILLS_B;
    for (let index = 0; index < HL3.SKILLS_PER_WEAPON; index += 1) {
      const address = base + index * HL3.SKILL_STRIDE;
      // table records: 0..6 basic combo levels, 7..11 actives, 12..14 passives → slot 0 = basic, 1..5 actives, 6..8 passives
      const record = table?.skills[index === 0 ? 0 : index + 6];
      out.push({ weapon, category, index, name: record?.n ?? `스킬 ${index + 1}`, level: api.read(address, 1, false), address });
    }
  }
  return out;
};

/** Set every skill of both weapons to `level` (게임 상한 5). */
export const setAllSkillLevels = (api: CheatApi, level: number): void => {
  const value = Math.max(0, Math.min(level, HL3.SKILL_MAX_LEVEL));
  for (const skill of readSkills(api)) api.write(skill.address, 1, false, value);
};

export const setBaseStats = (api: CheatApi, value: number): void => {
  const v = Math.max(1, Math.min(value, 255));
  api.writeBytes(HL3.STATS, new Uint8Array([v, v, v, v]));
  api.writeBytes(HL3.STATS2, new Uint8Array([v, v, v, v]));
};

/** Freeze the derived battle stats (both copies the game keeps). CRI/RES are capped at 255 by the game. */
export const freezeBattleStats = (api: CheatApi, on: boolean): void => {
  const first = [9999, 9999, 9999, 9999, 255, 255, 255, 255]; // ATT1 ATT2 PDEF MDEF CRI RES ACC DOD
  const second: Array<[number, number]> = [[0, 9999], [2, 9999], [4, 255], [6, 255], [8, 9999], [10, 255], [12, 9999], [16, 255], [18, 255]];
  for (let i = 0; i < first.length; i += 1) {
    const address = HL3.FINAL + i * 2;
    if (on) api.freeze(address, 2, false, first[i]);
    else api.unfreeze(address);
  }
  for (const [offset, value] of second) {
    const address = HL3.FINAL2 + offset;
    if (on) api.freeze(address, 2, false, value);
    else api.unfreeze(address);
  }
};

export interface Vitals {
  hp: number;
  hpMax: number;
  sp: number;
}

export const readVitals = (api: CheatApi): Vitals => ({
  hp: api.read(HL3.HP, 2, false),
  hpMax: api.read(HL3.HP_MAX, 4, false) >>> 0,
  /** SP는 내부적으로 10배 값으로 저장돼요 (표시 100 = 1000). */
  sp: api.read(HL3.SP, 4, false) >>> 0,
});

/** Auto-heal tick: refill HP when it drops under `ratio` of max; SP is restored to the highest value seen. */
export const autoHealTick = (api: CheatApi, state: { spPeak: number }, ratio = 0.35): boolean => {
  const vitals = readVitals(api);
  let healed = false;
  if (vitals.hpMax > 0 && vitals.hpMax < 60_000 && vitals.hp > 0 && vitals.hp < vitals.hpMax * ratio) {
    api.write(HL3.HP, 2, false, vitals.hpMax);
    healed = true;
  }
  if (vitals.sp < 1_000_000 && vitals.sp > state.spPeak) state.spPeak = vitals.sp;
  if (state.spPeak > 0 && vitals.sp < state.spPeak * ratio) {
    api.write(HL3.SP, 4, false, state.spPeak);
    healed = true;
  }
  return healed;
};

/**
 * 자동 조준: 공격·말 걸기 직전에 가장 가까운 몬스터(또는 NPC) 쪽으로 몸을 돌려요.
 * 필드의 캐릭터들은 128바이트 충돌 객체로, 서로 연결 리스트(+0x34/+0x38/+0x3c/+0x40)로 이어져 있어요.
 */
export const AIM = {
  /** u32 pointer to the player's collision object. */
  PLAYER: 0x0150d654,
  /** u8 facing: 1 up, 2 down, 3 left, 4 right. Writing it turns the hero in place; the next attack follows it. */
  FACING: 0x0150d63c,
  /** u32: 3 while the player has control, 4 while an NPC dialog is open. */
  FIELD_STATE: 0x0150db48,
  KIND: 0x04,
  X: 0x10,
  Y: 0x12,
  W: 0x1a,
  H: 0x1c,
  LINKS: [0x34, 0x38, 0x3c, 0x40],
  KIND_MONSTER: 5,
  KIND_NPC: 6,
  /** Gap between bounding boxes (px) within which a target counts as "nearby". */
  MONSTER_RANGE: 48,
  NPC_RANGE: 24,
} as const;

const FIELD_CONTROL = 3;
const AIM_MAX_OBJECTS = 600;

const isObjectPointer = (pointer: number): boolean => pointer >= 0x48000000 && pointer < 0x50000000;

/**
 * Turns the hero toward the closest monster nearby (or NPC when `npcs`), so the following attack or talk lands
 * on it. Returns true when the facing was changed.
 */
export const aimAtNearest = (api: CheatApi, npcs: boolean): boolean => {
  if (!isOnField(api) || (api.read(AIM.FIELD_STATE, 4, false) >>> 0) !== FIELD_CONTROL) return false;
  const player = api.read(AIM.PLAYER, 4, false) >>> 0;
  if (!isObjectPointer(player)) return false;
  const px = api.read(player + AIM.X, 2, false) << 16 >> 16;
  const py = api.read(player + AIM.Y, 2, false) << 16 >> 16;
  const pw = api.read(player + AIM.W, 2, false);
  const ph = api.read(player + AIM.H, 2, false);

  let best: { dx: number; dy: number; score: number } | undefined;
  const seen = new Set<number>([player]);
  const queue = [player];
  while (queue.length > 0 && seen.size < AIM_MAX_OBJECTS) {
    const object = queue.pop() as number;
    for (const link of AIM.LINKS) {
      const next = api.read(object + link, 4, false) >>> 0;
      if (isObjectPointer(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
    if (object === player) continue;
    const kind = api.read(object + AIM.KIND, 2, false) & 0xff;
    const range = kind === AIM.KIND_MONSTER ? AIM.MONSTER_RANGE : npcs && kind === AIM.KIND_NPC ? AIM.NPC_RANGE : -1;
    if (range < 0) continue;
    const dx = (api.read(object + AIM.X, 2, false) << 16 >> 16) - px;
    const dy = (api.read(object + AIM.Y, 2, false) << 16 >> 16) - py;
    const gapX = Math.abs(dx) - (pw + api.read(object + AIM.W, 2, false)) / 2;
    const gapY = Math.abs(dy) - (ph + api.read(object + AIM.H, 2, false)) / 2;
    if (Math.max(gapX, gapY) > range) continue;
    // Monsters first; among the same kind, the closest one.
    const score = Math.hypot(dx, dy) + (kind === AIM.KIND_MONSTER ? 0 : 10000);
    if (!best || score < best.score) best = { dx, dy, score };
  }
  if (!best) return false;
  const facing = Math.abs(best.dx) > Math.abs(best.dy) ? (best.dx > 0 ? 4 : 3) : best.dy > 0 ? 2 : 1;
  if ((api.read(AIM.FACING, 2, false) & 0xff) === facing) return false;
  api.writeBytes(AIM.FACING, Uint8Array.of(facing));
  return true;
};
