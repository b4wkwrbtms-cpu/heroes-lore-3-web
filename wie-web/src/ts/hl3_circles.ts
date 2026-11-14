import type { CheatApi } from "./backend";
import { HL3, isHeroesLore3Binary } from "./hl3";

/**
 * 영웅서기3's 소울마스터 attacks from magic circles: one on the ground and copies of it rising above. They are parts
 * of the hero's picture (see hl3_motion.ts) on the weapon layer, and the game draws the rising copies see-through, at
 * opacity 180, 120 and 90 of 255, where they all but disappear into the ground behind them.
 *
 * This raises those three opacities in the record of the frame being shown, so the copies are drawn nearly as
 * clearly as the circle on the ground and still thin out as they rise. A record is animation data the game loaded
 * with the weapon; it stays raised until the game loads it again, and a raised value is not one of the three, so a
 * record is never raised twice. Nothing but the opacity of those parts is written.
 */
const STATE = 0x01503ab0;
const HERO_CLASS = STATE + 0xa8;
const HERO_SETS = STATE + 0x9c0c;
const HERO_ANIMATION = STATE + 0x9b8d;
const HERO_DIRECTION = STATE + 0x9b8c;
const HERO_FRAME = STATE + 0x9ba0;
const FIELD_MODE = 4;
/** Item categories of the 소울마스터's two weapons. */
const CIRCLE_WEAPONS: readonly number[] = [9, 10];
const WEAPON_LAYER = 5;
const MAX_PARTS = 32;
const CLEARER: Readonly<Record<number, number>> = { 180: 255, 120: 230, 90: 200 };

const heap = (p: number): boolean => p >= HL3.HEAP_LO && p < HL3.HEAP_HI;
const signed8 = (n: number): number => (n << 24) >> 24;

export class Hl3MagicCircles {
  private record = 0;

  /** After the game's frames, once per frame shown. */
  sample(api: CheatApi | undefined): void {
    // The game is loaded after the session starts, so its image is checked when it is used.
    if (!api || !isHeroesLore3Binary(api) || api.read(HL3.MODE, 4, false) !== FIELD_MODE) return;
    const read = (address: number, width: number) => api.read(address, width, false);
    if (!CIRCLE_WEAPONS.includes(read(HL3.WEAPON_A, 1))) return;
    const sets = read(HERO_SETS, 4);
    if (!heap(sets)) return;
    const set = sets + 0x28 * signed8(read(HERO_CLASS, 1));
    const animations = read(set + 0x18, 4), base = read(set + 0x20, 4);
    const direction = read(HERO_DIRECTION, 1) - 1, frame = (read(HERO_FRAME, 2) << 16) >> 16;
    const animation = signed8(read(HERO_ANIMATION, 1));
    if (!heap(animations) || !heap(base) || animation < 0 || direction < 0 || direction > 5 || frame < 0 || frame >= 50) return;
    const record = read(animations + 0x4b8 * animation + 8 + 4 * (50 * direction + frame), 4) + base;
    if (record === this.record || !heap(record)) return;
    this.record = record;
    const count = read(record, 1);
    if (count > MAX_PARTS) return;
    let part = record + 1;
    for (let index = 0; index < count; index++) {
      const head = read(part, 1);
      if (head === 0x7f || !(head & 0x80)) {
        part += 4;
        continue;
      }
      const clearer = (head & 0x1f) === WEAPON_LAYER ? CLEARER[read(part + 7, 1)] : undefined;
      if (clearer !== undefined) api.write(part + 7, 1, false, clearer);
      part += 9;
    }
  }
}
