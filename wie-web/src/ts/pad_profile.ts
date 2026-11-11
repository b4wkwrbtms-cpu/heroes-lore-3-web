import type { LibraryApp } from "./backend";

export type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";

/** How the on-screen controller talks to one game: which keys the joystick sends and what the pad buttons press. */
export interface PadProfile {
  /** Profile name, set on the player view as `data-pad-profile` (absent for the default pad). */
  name?: string;
  /** Key sent for each joystick direction. */
  directions: Record<Direction, string>;
  /** Directions used instead while the game shows its field (games whose title menus only follow the arrows). */
  field?: { detect: (screen: HTMLCanvasElement) => boolean; directions: Record<Direction, string> };
  /** Pad buttons, keyed by their default `data-key`: the key they press instead and their label. */
  buttons: Record<string, { key: string; title: string; caption: string }>;
}

const DEFAULT_PROFILE: PadProfile = {
  directions: { UP: "UP", DOWN: "DOWN", LEFT: "LEFT", RIGHT: "RIGHT" },
  buttons: {},
};

/** Left edges of 이노티아's quick-slot frames (1·7·*·3·9·#) on its 176×220 screen; the 4th is drawn differently. */
const INOTIA_SLOT_EDGES = [19, 42, 65, 114, 137];

/**
 * 이노티아's field always shows its quick-slot bar at the bottom (also under the in-field menus): each slot has a
 * black left edge and a white number tag beside it. Title, pop-up and story screens don't.
 */
const inotiaShowsField = (screen: HTMLCanvasElement): boolean => {
  if (screen.width !== 176 || screen.height !== 220) return false;
  const context = screen.getContext("2d");
  if (!context) return false;
  const rows = context.getImageData(0, 201, 176, 10).data;
  const brightness = (x: number, y: number) => {
    const i = ((y - 201) * 176 + x) * 4;
    return rows[i] + rows[i + 1] + rows[i + 2];
  };
  const slots = INOTIA_SLOT_EDGES.filter(x => brightness(x, 210) < 150 && brightness(x + 1, 201) > 700).length;
  return slots >= 4;
};

/**
 * 이노티아 연대기 (Com2uS, 2007): walks with 2/4/6/8 only, and on the field the arrow keys are shortcuts
 * (↑ skills, ↓ map); its title and pop-up menus only follow the arrows. So the joystick sends the arrows until the
 * field's quick-slot bar is on screen. Quick slots are 1·7·*·3·9·#, CLR opens the menu.
 */
const INOTIA_PROFILE: PadProfile = {
  name: "inotia",
  directions: DEFAULT_PROFILE.directions,
  field: { detect: inotiaShowsField, directions: { UP: "2", DOWN: "8", LEFT: "4", RIGHT: "6" } },
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

/** Key the joystick (or a keyboard arrow) sends for `direction` with `screen` showing what it shows now. */
export const directionKey = (profile: PadProfile, direction: Direction, screen: HTMLCanvasElement): string =>
  profile.field?.detect(screen) ? profile.field.directions[direction] : profile.directions[direction];
