import type { CheatApi } from "./backend";
import { HL3, isHeroesLore3Binary } from "./hl3";

/**
 * 영웅서기3's damage numbers over monsters. Every monster keeps one: the damage (s16), its age (s16, -1 when nothing
 * is shown) and its kind (0 damage, 1 miss). A hit sets the age to 0, each game frame adds one, and after age 4 the
 * number is gone: five game frames, under a fifth of a second at speed 6 and less at the faster speeds. The hero's
 * own number (hits taken) works the same way and is left at the game's pace.
 *
 * This holds the age back so each of the rising steps is shown for STEP_MS of real time. Only the age is written,
 * only ever lowered, and only while the number is up; the damage itself, the hit and everything the game decides
 * from it are untouched. A new hit restarts the age (seen as the age going below what was written, or new damage).
 */
const STATE = 0x01503ab0;
const MONSTERS = STATE + 0x9c94; // u32 pointer to the monster records
const MONSTER_COUNT = STATE + 0x9c98; // u16
const MONSTER_SIZE = 344;
const MONSTER_NUMBER = 0xaa; // damage, age, kind within a monster record
const FIELD_MODE = 4;
/** Real time each of the number's five steps stays on screen. */
const STEP_MS = 140;
/** Highest age held: the last steps (the number fading) go at the game's pace, which may add two frames at once. */
const LAST_HELD = 2;

export class Hl3DamageNumbers {
  /** Per number (address of its age): when it was hit and the age last written. */
  private readonly shown = new Map<number, { since: number; written: number; damage: number }>();

  /** After the game's frames, once per frame shown. */
  sample(api: CheatApi | undefined, now: number): void {
    // The game is loaded after the session starts, so its image is checked when it is used.
    if (!api || !isHeroesLore3Binary(api) || api.read(HL3.MODE, 4, false) !== FIELD_MODE) {
      this.shown.clear();
      return;
    }
    const seen = new Set<number>();
    const hold = (age: number) => {
      seen.add(age);
      this.hold(api, age, now);
    };
    const monsters = api.read(MONSTERS, 4, false);
    const count = api.read(MONSTER_COUNT, 2, false);
    for (let index = 0; index < count; index++) hold(monsters + index * MONSTER_SIZE + MONSTER_NUMBER + 2);
    for (const age of this.shown.keys()) if (!seen.has(age)) this.shown.delete(age);
  }

  private hold(api: CheatApi, address: number, now: number): void {
    const age = (api.read(address, 2, false) << 16) >> 16;
    if (age < 0) {
      this.shown.delete(address);
      return;
    }
    const damage = api.read(address - 2, 2, false);
    let number = this.shown.get(address);
    // A frame can be shown without a game frame, so an unchanged age is the same number.
    if (!number || age < number.written || damage !== number.damage) {
      number = { since: now, written: age, damage };
      this.shown.set(address, number);
    }
    const due = Math.floor((now - number.since) / STEP_MS);
    if (due <= LAST_HELD && due < age) {
      api.write(address, 2, false, due);
      number.written = due;
    } else number.written = age;
  }
}
