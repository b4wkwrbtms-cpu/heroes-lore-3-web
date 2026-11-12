import type { CheatApi } from "./backend";
import { ZERO, isZeroBinary } from "./zero";

/**
 * 영웅서기 제로 keeps two battle styles hidden, 검총사 (4) and 정령사 (5), until they are earned mid-game. The new-game
 * screen ("전투스타일 선택") already knows all six: its object keeps the selected style at +0x0c, how many styles its
 * arrows cycle through at +0x10 (4) and, at +0x38, a boolean[6] that decides whether a style's name and description
 * are shown. Raising the count to six and opening the two flags lets the player pick them from the start with the
 * game's own arrows; the game then creates the hero with that style as it does for the other four.
 *
 * Objects are handles of two words (data, class descriptor); at the title the game's handles sit in HANDLES.
 */
export const ZERO_STYLES = {
  /** State word while the title, slot and style screens are up. */
  TITLE: 2,
  SCREEN_CLASS: 0x001bd3b0,
  HANDLES: 0x48400000,
  HANDLES_SIZE: 0x100000,
  SELECTED: 0x0c,
  COUNT: 0x10,
  OPEN: 0x38,
  REGULAR: 4,
  ALL: 6,
} as const;

const heap = (p: number): boolean => p >= 0x40000000 && p < 0x50000000;

/** On the style screen, adds 검총사 and 정령사 to its choices. Returns whether the screen was found. */
export const openHiddenStyles = (api: Pick<CheatApi, "read" | "write" | "dump" | "writeBytes">): boolean => {
  const read = (address: number) => api.read(address, 4, false) >>> 0;
  if (!isZeroBinary(api) || read(ZERO.STATE) !== ZERO_STYLES.TITLE) return false;
  const handles = new Uint32Array(api.dump(ZERO_STYLES.HANDLES, ZERO_STYLES.HANDLES_SIZE).slice().buffer);
  let found = false;
  for (let i = 0; i + 1 < handles.length; i += 2) {
    if (handles[i + 1] !== ZERO_STYLES.SCREEN_CLASS || !heap(handles[i])) continue;
    const screen = handles[i];
    const count = read(screen + ZERO_STYLES.COUNT), selected = read(screen + ZERO_STYLES.SELECTED);
    const open = read(screen + ZERO_STYLES.OPEN);
    if ((count !== ZERO_STYLES.REGULAR && count !== ZERO_STYLES.ALL) || selected >= count || !heap(open)) continue;
    const flags = read(open);
    if (!heap(flags) || read(flags + 4) !== ZERO_STYLES.ALL) continue;
    // The four regular styles are always open on this screen; any other object of the class is left alone.
    // Booleans are single bytes: read and write exactly those, never the words around them.
    const opened = api.dump(flags + 8, ZERO_STYLES.ALL);
    if (!opened.subarray(0, ZERO_STYLES.REGULAR).every(flag => flag === 1)) continue;
    found = true;
    if (count !== ZERO_STYLES.ALL) api.write(screen + ZERO_STYLES.COUNT, 4, false, ZERO_STYLES.ALL);
    if (opened[4] !== 1 || opened[5] !== 1) api.writeBytes(flags + 8 + ZERO_STYLES.REGULAR, Uint8Array.of(1, 1));
  }
  return found;
};
