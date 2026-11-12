import type { CheatApi } from "./backend";
import { ZERO, isZeroBinary } from "./zero";

/**
 * Read-only observer of 영웅서기 제로 (v1.0.2) combat, for presentation only.
 *
 * Java objects are handles of two words: the object's data and its class descriptor (in the data segment). Arrays
 * keep a type word and their length before the elements. The field the hero walks on is reached from a static:
 * MAP holds the map's handle; its data keeps the occupancy grid (an array of rows, each an array of entity handles,
 * one per tile) at +0x30 and the map size in pixels at +0x54/+0x58. A monster's data keeps its position in map
 * pixels at +0x04/+0x08 and its max and current HP at +0xa8/+0xac. The hero's handle is a static as well; its data
 * holds handles of int arrays of current and max [HP, SP, ...] at +0xa8/+0xac. The camera that draws the field is at
 * CAMERA_X/CAMERA_Y (screen = map + camera); the game keeps it unclamped there and the field renderer clamps it to
 * the map within the 240×288 field above the status window.
 *
 * Nothing here writes guest memory or decides anything about combat: it notices HP that the game already took.
 */
export const ZERO_FIELD = {
  MAP: 0x001bb57c,
  HERO: 0x001bb68c,
  CAMERA_X: 0x001bb5ac,
  CAMERA_Y: 0x001bb5bc,
  MONSTER_CLASS: 0x001bcca8,
  GRID: 0x30,
  MAP_WIDTH: 0x54,
  MAP_HEIGHT: 0x58,
  X: 0x04,
  Y: 0x08,
  MAX_HP: 0xa8,
  HP: 0xac,
  HERO_STATS: 0xa8,
  HERO_LIMITS: 0xac,
  /** Status window height at the bottom of the 240×320 screen; the field is drawn above it. */
  STATUS_BAR: 32,
  TILE: 16,
} as const;

const MAX_TILES = 256;
const SCREEN_WIDTH = 240;
const SCREEN_HEIGHT = 320;
const heap = (p: number): boolean => p >= 0x40000000 && p < 0x50000000;

/** The renderer's camera: kept on the map, and a map smaller than the field is centred. */
export const clampCamera = (offset: number, viewport: number, mapSize: number): number =>
  mapSize < viewport ? Math.floor((viewport - mapSize) / 2) : Math.max(viewport - mapSize, Math.min(0, offset));

export interface ZeroView {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ZeroHit {
  /** Map pixels of the monster's tile (its sprite stands on it). */
  x: number;
  y: number;
  damage: number;
  /** Damage as a share of the monster's max HP (0..1). */
  share: number;
  killed: boolean;
}

export class ZeroHitTracker {
  readonly view: ZeroView = { x: 0, y: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
  readonly statusBar = ZERO_FIELD.STATUS_BAR;
  /** The sprite stands on its tile; its body is over the tile's middle. */
  readonly aim = { x: ZERO_FIELD.TILE / 2, y: -6 };
  private supported: boolean | undefined;
  private map = 0;
  private monsters = new Map<number, number>();
  private seen = new Map<number, number>();
  private heroHp = -1;

  reset(): void {
    this.map = 0;
    this.monsters.clear();
    this.heroHp = -1;
  }

  /**
   * Called after a new guest frame. Reports monsters whose HP dropped since the last frame and damage the hero took
   * (as a share of its max HP). Returns false when the field is not showing; transient effects should be cleared.
   */
  sample(api: Pick<CheatApi, "read" | "dump">, hit: (hit: ZeroHit) => void, hurt: (share: number) => void): boolean {
    const read = (address: number) => api.read(address, 4, false) >>> 0;
    // Fail closed for another build instead of interpreting arbitrary guest memory as monsters.
    this.supported ??= isZeroBinary(api);
    if (!this.supported || read(ZERO.STATE) !== ZERO.FIELD) {
      this.reset();
      return false;
    }
    const mapHandle = read(ZERO_FIELD.MAP);
    const map = heap(mapHandle) ? read(mapHandle) : 0;
    const grid = heap(map) ? read(map + ZERO_FIELD.GRID) : 0;
    const rows = heap(grid) ? read(grid) : 0;
    if (!heap(rows)) {
      this.reset();
      return false;
    }
    const height = read(rows + 4);
    const mapWidth = read(map + ZERO_FIELD.MAP_WIDTH), mapHeight = read(map + ZERO_FIELD.MAP_HEIGHT);
    if (height < 1 || height > MAX_TILES || mapHeight !== height * ZERO_FIELD.TILE || mapWidth % ZERO_FIELD.TILE !== 0) {
      this.reset();
      return false;
    }
    const width = mapWidth / ZERO_FIELD.TILE;
    if (width < 1 || width > MAX_TILES) {
      this.reset();
      return false;
    }
    const baseline = map !== this.map;
    this.map = map;
    this.view.x = clampCamera(read(ZERO_FIELD.CAMERA_X) | 0, SCREEN_WIDTH, mapWidth);
    this.view.y = clampCamera(read(ZERO_FIELD.CAMERA_Y) | 0, SCREEN_HEIGHT - ZERO_FIELD.STATUS_BAR, mapHeight);

    const seen = this.seen;
    seen.clear();
    const rowHandles = new Uint32Array(api.dump(rows + 8, height * 4).slice().buffer);
    for (const rowHandle of rowHandles) {
      const row = heap(rowHandle) ? read(rowHandle) : 0;
      if (!heap(row) || read(row + 4) !== width) continue;
      const cells = new Uint32Array(api.dump(row + 8, width * 4).slice().buffer);
      for (const handle of cells) {
        if (!heap(handle) || read(handle + 4) !== ZERO_FIELD.MONSTER_CLASS) continue;
        const monster = read(handle);
        if (!heap(monster)) continue;
        const max = read(monster + ZERO_FIELD.MAX_HP) | 0, hp = read(monster + ZERO_FIELD.HP) | 0;
        if (max <= 0 || hp < 0 || hp > max) continue;
        seen.set(handle, hp);
        const before = this.monsters.get(handle);
        if (baseline || before === undefined || hp >= before) continue;
        const x = read(monster + ZERO_FIELD.X) | 0, y = read(monster + ZERO_FIELD.Y) | 0;
        hit({ x, y, damage: before - hp, share: Math.min(1, (before - hp) / max), killed: hp === 0 });
      }
    }
    // A monster that died this frame may already have left the grid; its last HP simply goes with it.
    [this.monsters, this.seen] = [seen, this.monsters];

    const hero = read(ZERO_FIELD.HERO);
    const heroData = heap(hero) ? read(hero) : 0;
    const current = heap(heroData) ? read(heroData + ZERO_FIELD.HERO_STATS) : 0;
    const maximum = heap(heroData) ? read(heroData + ZERO_FIELD.HERO_LIMITS) : 0;
    const stats = heap(current) ? read(current) : 0, limits = heap(maximum) ? read(maximum) : 0;
    if (heap(stats) && heap(limits)) {
      const hp = read(stats + 8) | 0, max = read(limits + 8) | 0;
      if (!baseline && this.heroHp >= 0 && hp < this.heroHp && max > 0) hurt(Math.min(1, (this.heroHp - hp) / max));
      this.heroHp = hp;
    } else {
      this.heroHp = -1;
    }
    return !baseline;
  }
}
