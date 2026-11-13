import type { CheatApi } from "./backend";
import { isHeroesLore3 } from "./hl3";

/** HL3's original rules plus its three requested native exceptions replace the old cheat system. */
export const allowsCheats = (appId: string): boolean => !isHeroesLore3(appId);

export const clearRetiredCheats = (appId: string, api?: CheatApi): void => {
  if (allowsCheats(appId)) return;
  try {
    window.localStorage.removeItem(`wie_cheats_${appId}`);
    window.localStorage.removeItem(`wie_auto_${appId}`);
  } catch {
    // Blocked storage cannot re-enable cheats: open/restore also enforce this policy.
  }
  api?.clearFreezes();
};
