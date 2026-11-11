import type { LibraryApp } from "./backend";

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
}

const DEFAULT_PROFILE: PadProfile = {
  directions: { UP: "UP", DOWN: "DOWN", LEFT: "LEFT", RIGHT: "RIGHT" },
  buttons: {},
};

/**
 * 이노티아 연대기 (Com2uS, 2007): every screen (title menus, pop-ups, dialogs with 승낙/거절, the field and its menus)
 * moves with 2/4/6/8 and confirms, talks and attacks with 5; OK is ignored in quest windows, and on the field the
 * arrow keys are shortcuts (↑ skills, ↓ map). Quick slots are 1·7·*·3·9·#, CLR opens the menu and goes back.
 */
const INOTIA_PROFILE: PadProfile = {
  name: "inotia",
  directions: { UP: "2", DOWN: "8", LEFT: "4", RIGHT: "6" },
  keys: { OK: "5" },
  buttons: {
    "*": { key: "DOWN", title: "지도", caption: "" },
    CALL: { key: "UP", title: "스킬창", caption: "" },
    // The game's own quick-slot bar, row by row: 1 · 7 · * on the inner ring around attack, 3 · 9 · # on the outer.
    "7": { key: "1", title: "1", caption: "단축" },
    "1": { key: "7", title: "7", caption: "단축" },
    "3": { key: "*", title: "*", caption: "단축" },
    "9": { key: "3", title: "3", caption: "단축" },
    "0": { key: "9", title: "9", caption: "단축" },
    "#": { key: "#", title: "#", caption: "단축·스킵" },
    OK: { key: "5", title: "공격", caption: "확인 · 대화 (5)" },
    CLR: { key: "CLR", title: "메뉴", caption: "CLR · 뒤로" },
  },
  // The game ignores the right soft key; its cancel/back key is CLR.
  sheet: { SOFT2: { key: "CLR", label: "취소 (CLR)" } },
};

export const isInotia = (app: Pick<LibraryApp, "title" | "filename">): boolean =>
  /이노티아|inotia/i.test(`${app.title} ${app.filename}`);

export const padProfileFor = (app: Pick<LibraryApp, "title" | "filename">): PadProfile =>
  isInotia(app) ? INOTIA_PROFILE : DEFAULT_PROFILE;

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
    const title = button.querySelector("b") ?? button.querySelector("span");
    const caption = button.querySelector("b") ? button.querySelector("span") : null;
    button.dataset.defaultKey ??= button.dataset.key ?? "";
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
