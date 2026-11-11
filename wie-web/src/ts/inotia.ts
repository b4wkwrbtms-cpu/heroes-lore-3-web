import type { CheatApi } from "./backend";

/**
 * 이노티아 연대기 (Com2uS, 2007) memory: the rolled stats of the "스탯 결정" screen are six u32 in its data
 * segment, in on-screen order STR, DEX, CON, INT, MEN and the hidden LUK. Confirming the character takes them over.
 */
export const INOTIA = {
  ROLL: 0x00184880,
  STAT_NAMES: ["STR", "DEX", "CON", "INT", "MEN", "LUK"],
} as const;

export const readRolledStats = (api: CheatApi): number[] =>
  INOTIA.STAT_NAMES.map((_, i) => api.read(INOTIA.ROLL + i * 4, 4, false));

/** Overwrites the current roll; a REROLL afterwards rolls again. */
export const setRolledStats = (api: CheatApi, value: number) => {
  INOTIA.STAT_NAMES.forEach((_, i) => api.write(INOTIA.ROLL + i * 4, 4, false, value));
};
