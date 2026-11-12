import type { CheatApi } from "./backend";

/**
 * 이노티아 연대기 (Com2uS, 2007) memory, all in its data segment.
 *
 * - The rolled stats of the "스탯 결정" screen are six u32 in on-screen order STR, DEX, CON, INT, MEN and the hidden
 *   LUK. Confirming the character takes them over.
 * - Items live in a table of 20-byte records: word0 holds the item id (top 12 bits) and the count, word1 the item's
 *   own values, then three socket words. An empty record is 0x7fc00000. Gold is an item too, the pouch: its word1
 *   is the amount. Records move whenever the bag changes, so no item (gold included) has a fixed address.
 * - Every real item's word1 has a non-zero kind in its top 6 bits (7 for plain items, more for magic gear); only the
 *   pouch uses the whole word as a number. An item whose kind reads 0 was overwritten — typically by a gold freeze
 *   left on a slot the pouch has since moved out of — and makes DMG/DEF explode once the game recomputes them.
 * - Characters are records PARTY_STRIDE apart: the party first (the hero, then the mercenaries), then the monsters of
 *   the current map. Each has its tile position, and the hero the index of its current target, which the game sets on
 *   an attack press and clears as soon as the hero walks.
 * - A state word reads ON_FIELD while the player walks the field; menus, the map and dialogs use other values.
 */
export const INOTIA = {
  ROLL: 0x00184880,
  STAT_NAMES: ["STR", "DEX", "CON", "INT", "MEN", "LUK"],
  ITEMS: 0x00182ee0,
  ITEM_SIZE: 20,
  ITEM_COUNT: 185,
  EMPTY_ITEM: 0x7fc00000,
  GOLD_POUCH_ID: 0x490,
  /** word1 of a plain item, and of the starting dagger (id 0) in a fresh game. */
  PLAIN_ITEM: 0x1c000000,
  STARTER_DAGGER: 0x1c000008,
  PARTY: 0x00171050,
  PARTY_STRIDE: 0x424,
  PARTY_SIZE: 6,
  LEVEL: 0x18,
  MAX_HP: 0x3c,
  MAX_MP: 0x40,
  HP: 0x54,
  MP: 0x58,
  TILE_X: 0x22c,
  TILE_Y: 0x230,
  TARGET: 0x240,
  MONSTER_FIRST: 6,
  MONSTER_LAST: 52,
  STATE: 0x0016f600,
  ON_FIELD: 2,
} as const;

export const GOLD_MAX = 9_999_999;

export const readRolledStats = (api: CheatApi): number[] =>
  INOTIA.STAT_NAMES.map((_, i) => api.read(INOTIA.ROLL + i * 4, 4, false));

/** Overwrites the current roll; a REROLL afterwards rolls again. */
export const setRolledStats = (api: CheatApi, value: number) => {
  INOTIA.STAT_NAMES.forEach((_, i) => api.write(INOTIA.ROLL + i * 4, 4, false, value));
};

/** Whether an address falls inside the item table, where values move with the bag. */
export const isInItemTable = (address: number): boolean =>
  address >= INOTIA.ITEMS && address < INOTIA.ITEMS + INOTIA.ITEM_COUNT * INOTIA.ITEM_SIZE;

interface ItemRecord {
  address: number;
  id: number;
  value: number;
}

const readItems = (api: CheatApi): ItemRecord[] => {
  const bytes = api.dump(INOTIA.ITEMS, INOTIA.ITEM_COUNT * INOTIA.ITEM_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const items: ItemRecord[] = [];
  for (let i = 0; i < INOTIA.ITEM_COUNT; i++) {
    const head = view.getUint32(i * INOTIA.ITEM_SIZE, true);
    if (head === INOTIA.EMPTY_ITEM) continue;
    items.push({ address: INOTIA.ITEMS + i * INOTIA.ITEM_SIZE, id: head >>> 20, value: view.getUint32(i * INOTIA.ITEM_SIZE + 4, true) });
  }
  return items;
};

const goldPouch = (api: CheatApi): ItemRecord => {
  const pouch = readItems(api).find(item => item.id === INOTIA.GOLD_POUCH_ID);
  if (!pouch) throw new Error("소지금 자리를 못 찾았어요. 캐릭터로 필드에 나온 뒤 다시 눌러 주세요.");
  return pouch;
};

export const getGold = (api: CheatApi): number => goldPouch(api).value;

export const setGold = (api: CheatApi, value: number) => {
  api.write(goldPouch(api).address + 4, 4, false, value);
};

/** Tops the pouch up wherever it currently is; for the "always full" toggle. */
export const keepGold = (api: CheatApi, value: number) => {
  const pouch = goldPouch(api);
  if (pouch.value < value) api.write(pouch.address + 4, 4, false, value);
};

const isDamaged = (item: ItemRecord) => item.id !== INOTIA.GOLD_POUCH_ID && item.value >>> 26 === 0;

export const countDamagedItems = (api: CheatApi): number => readItems(api).filter(isDamaged).length;

/**
 * Gives damaged items back a plain word1 (the starting dagger its fresh-game value). DMG/DEF follow once the game
 * reloads the save: 저장 → 나가기 → 이어하기.
 */
export const repairItems = (api: CheatApi): number => {
  const damaged = readItems(api).filter(isDamaged);
  for (const item of damaged) {
    api.write(item.address + 4, 4, false, item.id === 0 ? INOTIA.STARTER_DAGGER : INOTIA.PLAIN_ITEM);
  }
  return damaged.length;
};

/**
 * Refills HP/MP of living party members once they drop under the ratio; fallen ones are left to the game's own
 * revival.
 */
export const healParty = (api: CheatApi, ratio = 0.35) => {
  for (let i = 0; i < INOTIA.PARTY_SIZE; i++) {
    const member = INOTIA.PARTY + i * INOTIA.PARTY_STRIDE;
    if (api.read(member + INOTIA.LEVEL, 4, false) === 0) continue;
    const hp = api.read(member + INOTIA.HP, 4, false);
    if (hp === 0) continue;
    const maxHp = api.read(member + INOTIA.MAX_HP, 4, false);
    const maxMp = api.read(member + INOTIA.MAX_MP, 4, false);
    if (hp < maxHp * ratio) api.write(member + INOTIA.HP, 4, false, maxHp);
    if (api.read(member + INOTIA.MP, 4, false) < maxMp * ratio) api.write(member + INOTIA.MP, 4, false, maxMp);
  }
};

export interface Tile {
  x: number;
  y: number;
}

const character = (index: number) => INOTIA.PARTY + index * INOTIA.PARTY_STRIDE;

export const isOnField = (api: CheatApi): boolean => api.read(INOTIA.STATE, 4, false) === INOTIA.ON_FIELD;

export const characterTile = (api: CheatApi, index: number): Tile => ({
  x: api.read(character(index) + INOTIA.TILE_X, 4, false) | 0,
  y: api.read(character(index) + INOTIA.TILE_Y, 4, false) | 0,
});

/** The character the hero targets, or -1; it may have fallen since. */
export const heroTarget = (api: CheatApi): number => api.read(character(0) + INOTIA.TARGET, 4, false) | 0;

export const isMonsterAlive = (api: CheatApi, index: number): boolean =>
  index >= INOTIA.MONSTER_FIRST && index <= INOTIA.MONSTER_LAST && (api.read(character(index) + INOTIA.HP, 4, false) | 0) > 0;
