import type { PlayerSession } from "./backend";
import { HL3, isHeroesLore3Binary } from "./hl3";

/**
 * 영웅서기3's combo, measured in game frames. A press of the attack key starts a hit; the hit sets a recovery count
 * (4 frames) and, when it runs out, the combo ends. Another press continues the combo only before that count is set
 * (about 3 frames after the previous press): presses while it runs are dropped, presses after it start a new combo.
 * At the game's speeds 8-10 a frame is 10-30 ms here, so that window is far shorter than a person's second tap.
 *
 * This keeps the window in real time instead: while a hit is younger than WINDOW_MS the recovery count is kept from
 * running out, and an attack press during it clears the count first so the game takes the press as the next hit.
 * Only the recovery count is written, never the combo's hit, and only while the game itself would still take the
 * next hit (the same check as the game's: weapon combo skill level ≥ current hit); when this does not happen in
 * time the game ends the combo as it always does. The game also refuses the skill keys while the count runs, so a
 * skill pressed while the count is only being kept clears it, and goes out as it would without this.
 */
const STEP = 0x01503cd7; // s8: hit of the running combo, -1 between combos
const RECOVERY = 0x01503cd9; // u8: frames until the combo ends; 0 or 255 between combos
const SWING = 0x0150eb58; // u8: frames left of the hero's attack motion, 255 when not attacking
const FIELD_STATE = 0x01503ab0 + 0xa098; // u8: 3 while walking the field
const FIELD_MODE = 4;
/** How long after a hit starts the next press still continues the combo (as at the game's speed 6). */
const WINDOW_MS = 300;
/** Recovery count kept while waiting: above the two game frames one display frame can hold at speed 10. */
const HOLD = 3;
/** The combo skill whose level allows the next hit: main weapon for attack (OK/5), sub weapon for 7. */
const WEAPON_OF: Readonly<Record<string, number>> = { OK: HL3.SKILLS_A, "5": HL3.SKILLS_A, "7": HL3.SKILLS_B };
/** The quick-slot keys: skills and items. */
const SKILL_KEYS: ReadonlySet<string> = new Set(["1", "3", "9", "0", "#"]);

const signed8 = (value: number): number => (value << 24) >> 24;

export class Hl3ComboTiming {
  private weapon: number = HL3.SKILLS_A;
  private swing = 255;
  private hitAt = -Infinity;
  /** Whether the running hit's recovery count is being kept past its own end. */
  private keeping = false;

  constructor(private readonly session: PlayerSession) {}

  /** The combo's hit and recovery count, when the hero is on the field in a combo the game would continue. */
  private continuable(): { step: number; recovery: number } | undefined {
    const api = this.session.cheats;
    // The game is loaded after the session starts, so its image is checked when it is used.
    if (!api || !isHeroesLore3Binary(api)) return undefined;
    const read = (address: number, width: number) => api.read(address, width, false);
    if (read(HL3.MODE, 4) !== FIELD_MODE || read(FIELD_STATE, 1) !== 3) return undefined;
    const step = signed8(read(STEP, 1)), recovery = read(RECOVERY, 1);
    if (step < 0 || recovery === 0 || recovery === 255 || signed8(read(this.weapon, 1)) < step) return undefined;
    return { step, recovery };
  }

  /** Before the game gets a key press. */
  press(key: string): void {
    const weapon = WEAPON_OF[key];
    if (weapon !== undefined) this.weapon = weapon;
    else if (!this.keeping || !SKILL_KEYS.has(key)) return;
    if (this.continuable()) this.session.cheats?.write(RECOVERY, 1, false, 0);
  }

  /** After the game's frames, once per frame shown. */
  sample(now: number): void {
    const api = this.session.cheats;
    if (!api || !isHeroesLore3Binary(api)) return;
    const swing = api.read(SWING, 1, false);
    if (swing !== 255 && (this.swing === 255 || swing > this.swing)) {
      this.hitAt = now;
      this.keeping = false;
    }
    this.swing = swing;
    const combo = this.continuable();
    if (combo && combo.recovery < HOLD && now - this.hitAt < WINDOW_MS) {
      api.write(RECOVERY, 1, false, HOLD);
      this.keeping = true;
    }
  }
}
