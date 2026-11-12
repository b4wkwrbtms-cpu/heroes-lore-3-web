import type { CheatApi, LibraryApp } from "./backend";
import { ZERO_SAVE_KEY, inZeroWindow, isZero as isZeroPid } from "./zero";

export type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";

/** How the on-screen controller talks to one game: which keys the joystick sends and what the pad buttons press. */
export interface PadProfile {
  /** Profile name, set on the player view as `data-pad-profile` (absent for the default pad). */
  name?: string;
  /** Key sent for each joystick direction. */
  directions: Record<Direction, string>;
  /** Keys pressed as another key (keyboard and pad), e.g. a game that confirms and attacks with 5 instead of OK. */
  keys?: Record<string, string>;
  /** Pad buttons, keyed by their default `data-key`: the key they press instead and their label. */
  buttons: Record<string, { key: string; title: string; caption: string }>;
  /** Full-keypad sheet buttons, keyed by their default `data-key`: the key they press instead and their label. */
  sheet?: Record<string, { key: string; label: string }>;
  /**
   * Pad arrangement, set on the player view as `data-pad-layout`. `keypad`: the phone's own d-pad (arrows and OK) on
   * top, and the keys around attack laid out like the phone's keypad (1 3 / 5 / 7 CLR 9 / * 0 #). `phone`: no stick;
   * call · C, the d-pad with OK and R on the left and the whole number pad on the right, below the screen in portrait
   * and on both sides of it in landscape.
   */
  layout?: "keypad" | "phone";
  /**
   * The game walks diagonally while two directions are held, so the stick has eight sectors and holds both keys of a
   * diagonal. Without it the stick has four sectors and holds one key at a time.
   */
  diagonals?: boolean;
  /**
   * With `diagonals`: whether the game shows a cursor window (menu, shop, a conversation's choices) instead of the
   * field. There the stick takes one straight direction at a time and repeats it while held, as such windows move
   * their cursor once per press.
   */
  windowed?: (api: CheatApi | undefined) => boolean;
}

const DEFAULT_PROFILE: PadProfile = {
  directions: { UP: "UP", DOWN: "DOWN", LEFT: "LEFT", RIGHT: "RIGHT" },
  buttons: {},
};

/**
 * 이노티아 연대기 (Com2uS, 2007): every screen (title menus, pop-ups, dialogs with 승낙/거절, the field and its menus)
 * moves with 2/4/6/8 and confirms, talks and attacks with 5; OK is ignored in quest windows. The phone's own arrow
 * keys scroll long descriptions and set up the party, and on the field they are shortcuts (↑ skills, ↓ map). Quick
 * slots are 1·7·*·3·9·#, CLR opens the menu and goes back.
 */
const INOTIA_PROFILE: PadProfile = {
  name: "inotia",
  layout: "keypad",
  directions: { UP: "2", DOWN: "8", LEFT: "4", RIGHT: "6" },
  keys: { OK: "5" },
  buttons: {
    "*": { key: "DOWN", title: "지도", caption: "" },
    CALL: { key: "UP", title: "스킬창", caption: "" },
    "1": { key: "1", title: "1", caption: "단축" },
    "3": { key: "3", title: "3", caption: "단축" },
    "7": { key: "7", title: "7", caption: "단축" },
    "9": { key: "9", title: "9", caption: "단축" },
    "0": { key: "0", title: "0", caption: "" },
    "#": { key: "#", title: "#", caption: "스킵" },
    OK: { key: "5", title: "공격", caption: "확인 · 대화 (5)" },
    CLR: { key: "CLR", title: "메뉴", caption: "CLR · 뒤로" },
  },
  // The game ignores the right soft key; its cancel/back key is CLR.
  sheet: { SOFT2: { key: "CLR", label: "취소 (CLR)" } },
};

/**
 * 영웅서기 제로 (Hands-On Mobile, 2007): the arrows move everywhere and walk diagonally when two are held, while in
 * its menus the number keys pick entries directly, so the stick sends arrows only. Skills are 1·3·7·9 (the four
 * keys nearest attack), recovery items 0 and # (# also skips scenes). The top bar's save key saves through the
 * game's own menu.
 */
const ZERO_PROFILE: PadProfile = {
  name: "zero",
  diagonals: true,
  windowed: inZeroWindow,
  directions: { UP: "UP", DOWN: "DOWN", LEFT: "LEFT", RIGHT: "RIGHT" },
  buttons: {
    "7": { key: "7", title: "7", caption: "스킬" },
    "1": { key: "1", title: "1", caption: "스킬" },
    "3": { key: "3", title: "3", caption: "스킬" },
    "9": { key: "9", title: "9", caption: "스킬" },
    "0": { key: "0", title: "0", caption: "회복" },
    "#": { key: "#", title: "#", caption: "회복" },
    OK: { key: "OK", title: "공격", caption: "확인 · 대화" },
    CALL: { key: ZERO_SAVE_KEY, title: "저장", caption: "" },
  },
};

/**
 * 영웅서기4 - 환영의 가면 (EA Mobile Korea, 2010, LGT): the touch keypad of its Android release, kept as it was. The
 * game walks with the arrows or 2/4/6/8 (tapping one twice rolls or teleports), talks with OK or 5, uses 1·3·7·9·0
 * as quick slots, # swaps the slot belt, * shows the minimap, C opens the menu and the call key quick-saves.
 */
const HEROES_LORE_4_PROFILE: PadProfile = {
  name: "hl4",
  layout: "phone",
  directions: { UP: "UP", DOWN: "DOWN", LEFT: "LEFT", RIGHT: "RIGHT" },
  buttons: {},
};

/** PID from the KTF __adf__ or LGT app_info; a renamed archive must not select another game's controls. */
export const isInotia = (app: Pick<LibraryApp, "id">): boolean => app.id === "PD005362";
export const isZero = (app: Pick<LibraryApp, "id">): boolean => isZeroPid(app.id);
export const isHeroesLore4 = (app: Pick<LibraryApp, "id">): boolean => app.id === "PD140249";

export const padProfileFor = (app: Pick<LibraryApp, "id">): PadProfile =>
  isInotia(app) ? INOTIA_PROFILE : isZero(app) ? ZERO_PROFILE : isHeroesLore4(app) ? HEROES_LORE_4_PROFILE : DEFAULT_PROFILE;

/**
 * Points the pad buttons at the profile's keys and labels. The markup's own key and labels are kept in data
 * attributes so switching back to another game restores them.
 */
export const applyPadProfile = (buttons: Iterable<HTMLButtonElement>, profile: PadProfile) => {
  for (const button of buttons) {
    if (button.closest(".keypad-sheet")) {
      button.dataset.defaultKey ??= button.dataset.key ?? "";
      button.dataset.defaultText ??= button.textContent ?? "";
      const override = profile.sheet?.[button.dataset.defaultKey];
      button.dataset.key = override?.key ?? button.dataset.defaultKey;
      button.textContent = override?.label ?? button.dataset.defaultText;
      continue;
    }
    if (!button.closest(".pad")) continue;
    button.dataset.defaultKey ??= button.dataset.key ?? "";
    // Raw keys (the d-pad, the keypad layout's own * and CLR, the phone layout's keys) always press what they show.
    if (button.dataset.raw !== undefined) continue;
    const title = button.querySelector("b") ?? button.querySelector("span");
    const caption = button.querySelector("b") ? button.querySelector("span") : null;
    if (title) title.dataset.defaultText ??= title.textContent ?? "";
    if (caption) caption.dataset.defaultText ??= caption.textContent ?? "";
    const override = profile.buttons[button.dataset.defaultKey];
    button.dataset.key = override?.key ?? button.dataset.defaultKey;
    if (title) title.textContent = override?.title ?? title.dataset.defaultText ?? "";
    if (caption) caption.textContent = override ? override.caption : (caption.dataset.defaultText ?? "");
  }
};

/** Key a keyboard key mapped to `key` presses in this game. */
export const remapKey = (profile: PadProfile, key: string): string => profile.keys?.[key] ?? key;
