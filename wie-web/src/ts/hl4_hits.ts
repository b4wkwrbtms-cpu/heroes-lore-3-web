import type { CheatApi } from "./backend";

/**
 * Read-only observer of 영웅서기4 - 환영의 가면 (LGT v1.0.1) combat, for presentation only.
 *
 * Everything on the field — the hero, monsters, NPCs, scenery, portals — is a record in one doubly linked list kept
 * in drawing order (by y). A record keeps the previous and next records at +0x00/+0x04, its position in map pixels
 * (where it stands) at +0x08/+0x0c, its own address at +0x10, its kind in the low byte of +0x14 (2 the hero, 3 a
 * monster) and its current and max HP at +0xa4/+0xa8. The hero's record is a static and stays on the list while the
 * field is up. The camera's top-left corner in map pixels is kept in the game state (screen = map - camera), next to
 * the map's size.
 *
 * Nothing here writes guest memory or decides anything about combat: it notices HP that the game already took.
 */
export const HL4_FIELD = {
  HERO: 0x0151b7d8,
  MAP_WIDTH: 0x0151b46c,
  MAP_HEIGHT: 0x0151b470,
  CAMERA_X: 0x0151b484,
  CAMERA_Y: 0x0151b488,
  PREVIOUS: 0x00,
  NEXT: 0x04,
  X: 0x08,
  Y: 0x0c,
  SELF: 0x10,
  KIND: 0x14,
  HP: 0xa4,
  MAX_HP: 0xa8,
  HERO_KIND: 2,
  MONSTER_KIND: 3,
  /** Slot bar and HP/SP gauges at the bottom of the 240×320 screen. */
  STATUS_BAR: 32,
} as const;

const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 320;
/** Field records live in the binary's data and bss segments. */
const record = (p: number): boolean => p >= 0x01400000 && p < 0x01570000;
const MAX_RECORDS = 1024;

/** The supported build: code that loads the hero's record and the game state from these literals. */
export const isHeroesLore4Binary = (api: Pick<CheatApi, "read">): boolean => {
  try {
    return api.read(0x4e328, 4, false) >>> 0 === HL4_FIELD.HERO && api.read(0x4c34, 4, false) >>> 0 === 0x0151b3e8;
  } catch {
    return false;
  }
};

/** Screen size and camera: screen = map + (x, y). */
export interface Hl4View {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Hl4Hit {
  /** Map pixels where the monster stands (its feet). */
  x: number;
  y: number;
  damage: number;
  /** Damage as a share of the monster's max HP (0..1). */
  share: number;
  killed: boolean;
}

export class Hl4HitTracker {
  readonly view: Hl4View = { x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
  private supported: boolean | undefined;
  private mapWidth = 0;
  private mapHeight = 0;
  /** Record → max HP × 0x10000 + HP, as of the last frame. */
  private monsters = new Map<number, number>();
  private seen = new Map<number, number>();
  private heroHp = -1;

  reset(): void {
    this.mapWidth = this.mapHeight = 0;
    this.monsters.clear();
    this.heroHp = -1;
  }

  /**
   * Called after a new guest frame. Reports monsters whose HP dropped since the last frame and damage the hero took
   * (as a share of its max HP). Returns false when the field is not showing; transient effects should be cleared.
   */
  sample(api: Pick<CheatApi, "read">, hit: (hit: Hl4Hit) => void, hurt: (share: number) => void): boolean {
    const read = (address: number) => api.read(address, 4, false) >>> 0;
    // Fail closed for another build instead of interpreting arbitrary guest memory as monsters.
    this.supported ??= isHeroesLore4Binary(api);
    const hero = HL4_FIELD.HERO;
    const mapWidth = read(HL4_FIELD.MAP_WIDTH) | 0, mapHeight = read(HL4_FIELD.MAP_HEIGHT) | 0;
    if (!this.supported || read(hero + HL4_FIELD.SELF) !== hero || (read(hero + HL4_FIELD.KIND) & 0xff) !== HL4_FIELD.HERO_KIND
      || mapWidth <= 0 || mapHeight <= 0) {
      this.reset();
      return false;
    }
    const baseline = mapWidth !== this.mapWidth || mapHeight !== this.mapHeight;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.view.x = -(read(HL4_FIELD.CAMERA_X) | 0);
    this.view.y = -(read(HL4_FIELD.CAMERA_Y) | 0);

    const seen = this.seen;
    seen.clear();
    // The list is walked from the hero both ways; a record that is not its own self is not on the list.
    for (const link of [HL4_FIELD.PREVIOUS, HL4_FIELD.NEXT]) {
      let node = read(hero + link);
      for (let steps = 0; steps < MAX_RECORDS && record(node) && node !== hero && read(node + HL4_FIELD.SELF) === node; steps++) {
        if ((read(node + HL4_FIELD.KIND) & 0xff) === HL4_FIELD.MONSTER_KIND) {
          const max = read(node + HL4_FIELD.MAX_HP) | 0, hp = read(node + HL4_FIELD.HP) | 0;
          if (max > 0 && max <= 0xffff && hp >= 0 && hp <= max) {
            // Keyed with the max HP as well: a record reused for another monster is not a hit.
            seen.set(node, max * 0x10000 + hp);
            const previous = this.monsters.get(node);
            const before = previous !== undefined && Math.floor(previous / 0x10000) === max ? previous % 0x10000 : undefined;
            if (!baseline && before !== undefined && hp < before) {
              const x = read(node + HL4_FIELD.X) | 0, y = read(node + HL4_FIELD.Y) | 0;
              const sx = x + this.view.x, sy = y + this.view.y;
              if (sx >= 0 && sx < SCREEN_WIDTH && sy >= 0 && sy < SCREEN_HEIGHT) {
                hit({ x, y, damage: before - hp, share: Math.min(1, (before - hp) / max), killed: hp === 0 });
              }
            }
          }
        }
        node = read(node + link);
      }
    }
    // A monster that left the list this frame takes its last HP with it.
    [this.monsters, this.seen] = [seen, this.monsters];

    const hp = read(hero + HL4_FIELD.HP) | 0, max = read(hero + HL4_FIELD.MAX_HP) | 0;
    if (!baseline && this.heroHp >= 0 && hp < this.heroHp && max > 0) hurt(Math.min(1, (this.heroHp - hp) / max));
    this.heroHp = max > 0 && hp >= 0 ? hp : -1;
    return !baseline;
  }
}
