// 영웅서기3: 대지의 성흔 (LGT WIPI, binary.mod 2009-03-10) — memory layout found by running the
// game headlessly and diffing memory. Addresses in the game image (.bss) are fixed; the bag lives
// in the heap and is reached through a pointer the game keeps in .bss.

import type { CheatApi } from "./backend";
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
  /** Quick-slot the item is registered to (index 0–4 for 1, 3, 9, 0, #), or -1. */
  quickSlot: number;
}

const QUICK_SLOT_OFFSET = 0x21;

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
