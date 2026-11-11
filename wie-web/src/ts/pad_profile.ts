import type { LibraryApp } from "./backend";

/** How the on-screen controller talks to one game: which keys the joystick sends and what the pad buttons press. */
export interface PadProfile {
  /** Key sent for each joystick direction. */
  directions: Record<"UP" | "DOWN" | "LEFT" | "RIGHT", string>;
  /** Pad buttons, keyed by their default `data-key`: the key they press instead and their label. */
  buttons: Record<string, { key: string; title: string; caption: string }>;
}

const DEFAULT_PROFILE: PadProfile = {
  directions: { UP: "UP", DOWN: "DOWN", LEFT: "LEFT", RIGHT: "RIGHT" },
  buttons: {},
};

/**
 * 이노티아 연대기 (Com2uS, 2007): walks with 2/4/6/8 only; the arrow keys are shortcuts (↑ skills, ↓ map).
 * Quick slots are 1·7·*·3·9·# as drawn at the bottom of its screen, CLR opens the menu.
 */
const INOTIA_PROFILE: PadProfile = {
  directions: { UP: "2", DOWN: "8", LEFT: "4", RIGHT: "6" },
  buttons: {
    "*": { key: "DOWN", title: "지도", caption: "" },
    CALL: { key: "UP", title: "스킬창", caption: "" },
    "1": { key: "1", title: "1", caption: "단축" },
    "3": { key: "3", title: "3", caption: "단축" },
    "9": { key: "9", title: "9", caption: "단축" },
    "0": { key: "*", title: "*", caption: "단축" },
    "#": { key: "#", title: "#", caption: "단축·스킵" },
    "7": { key: "7", title: "7", caption: "단축" },
    OK: { key: "OK", title: "공격", caption: "확인 · 대화" },
    CLR: { key: "CLR", title: "메뉴", caption: "CLR · 뒤로" },
  },
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
