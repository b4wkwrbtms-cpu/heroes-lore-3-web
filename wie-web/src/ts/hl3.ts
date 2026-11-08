// 영웅서기3: 대지의 성흔 (LGT WIPI, binary.mod 2009-03-10) — memory layout found by running the
// game headlessly and diffing memory. Addresses in the game image (.bss) are fixed; the bag lives
// in the heap and is reached through a pointer the game keeps in .bss.

import type { CheatApi } from "./backend";
import { HL3_ITEMS, type Hl3Item } from "./hl3_items";

export const HL3 = {
  /** u32 소지금 */
  GOLD: 0x01503b54,
  /** u32 pointer to the game-state block; the bag array starts BAG_OFFSET bytes in. */
  BAG_PTR: 0x0150d8b0,
  BAG_OFFSET: 0x394,
  RECORD: 60,
  SLOTS: 90,
  /** 10 worn-equipment records (same 60-byte layout) */
  EQUIP: 0x01503e14,
  EQUIP_SLOTS: 10,
  /** u16 level, u32 exp */
  LEVEL: 0x01503b6a,
  EXP: 0x01503b6c,
  /** u8 힘, 체력, 정신, 민첩 */
  STATS: 0x01503b5b,
  HEAP_LO: 0x40000000,
  HEAP_HI: 0x50000000,
} as const;

export const isHeroesLore3 = (title: string, filename = ""): boolean =>
  /영웅서기\s*3|heroes[\s_-]*lore[\s_-]*3/i.test(`${title} ${filename}`);

export interface BagEntry {
  slot: number;
  address: number;
  name: string;
  category: number;
  index: number;
  count: number;
  equipped: boolean;
}

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

export const readBag = (api: CheatApi): BagEntry[] => {
  const base = bagBase(api);
  const entries: BagEntry[] = [];
  for (let slot = 0; slot < HL3.SLOTS; slot += 1) {
    const address = base + slot * HL3.RECORD;
    const record = api.dump(address, HL3.RECORD);
    if (record.length < HL3.RECORD) break;
    const exists = record[0x1f] === 1;
    if (!exists) {
      entries.push({ slot, address, name: "", category: -1, index: -1, count: 0, equipped: false });
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
    });
  }
  return entries;
};

/** Default socket count / equipment slot the game assigned to starter gear, by category. */
const SOCKETS: Record<number, number> = { 1: 3, 2: 5, 3: 5, 5: 4, 6: 3 };
const EQUIP_SLOT: Record<number, number> = { 0: 1, 1: 4, 2: 3, 3: 7, 4: 0, 5: 6, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 5, 12: 8 };

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
    view.setUint16(0x30, 1, true);
    record[0x32] = SOCKETS[category] ?? 3;
    record[0x33] = EQUIP_SLOT[category] ?? 0;
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

export const getGold = (api: CheatApi): number => api.read(HL3.GOLD, 4, false) >>> 0;
export const setGold = (api: CheatApi, value: number): void => api.write(HL3.GOLD, 4, false, Math.max(0, Math.min(value, 99_999_999)));
export const freezeGold = (api: CheatApi, value: number): void => api.freeze(HL3.GOLD, 4, false, Math.max(0, Math.min(value, 99_999_999)));

/** Items most people want in bulk: [category, index, label]. */
export const QUICK_ITEMS: Array<[number, number, string]> = [
  [18, 7, "오브원석"],
  [14, 3, "제련석"],
  [18, 0, "포션"],
  [18, 3, "엘릭서"],
  [18, 5, "포도주"],
  [18, 8, "귀환서"],
];

export const findItem = (category: number, name: string): Hl3Item | undefined =>
  HL3_ITEMS[category]?.items.find(item => item.n.replace(/^[^가-힣A-Za-z0-9]+/, "") === name);
