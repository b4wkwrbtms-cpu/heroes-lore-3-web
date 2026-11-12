import type { CheatApi } from "./backend";

/**
 * 영웅서기 제로 - 진홍의 사도 (Hands-On Mobile, KTF 2007), PID PD005576.
 *
 * Controls, from its own help screen and checked on every screen: it walks with the arrow keys (or 2/4/6/8) and in
 * eight directions when two arrows are held together; OK (or 5) talks, confirms and attacks; 1·3·7·9 are skills and
 * 0·# recovery items; * shows the map and CLR opens the menu. In the menus the number keys jump straight to an
 * entry (2 opens the inventory, 5 the spirits...), so the stick sends arrows, never 2/4/6/8.
 *
 * Its help names a quick-save key "우측상단키" that neither soft key, CALL nor HANGUP triggers here. Saving goes
 * through the game's own menu instead: CLR, 7 (시스템), OK on 세이브, OK on 예, then back out. It only starts on the
 * field, and every step checks that the game shows the expected window before the next key, so nothing sends 7 (a
 * skill) or OK into whatever else is on screen.
 *
 * v1.0.2's client.bin keeps the screen it shows in a state word of its data segment: 3 on the field (also while a
 * map loads), 4 in conversations and shops (their choices and item grids), 5 in the menu and its windows, 8 on the
 * map.
 */
export const ZERO_PID = "PD005576";

export const isZero = (appId: string): boolean => appId === ZERO_PID;

export const ZERO = {
  STATE: 0x001bb71c,
  FIELD: 3,
  TALK: 4,
  MENU: 5,
  MAP: 8,
} as const;

/** Code words of the supported client.bin (v1.0.2); another build may keep its state elsewhere. */
const BINARY: readonly (readonly [number, number])[] = [
  [0x00101000, 0x0009212c],
  [0x00140000, 0x99001c22],
  [0x00180000, 0x1c396818],
];

export const isZeroBinary = (api: Pick<CheatApi, "read">): boolean => {
  try {
    return BINARY.every(([address, word]) => api.read(address, 4, false) === word);
  } catch {
    return false;
  }
};

/** The game's state word, or undefined when this is not the supported binary or memory cannot be read. */
export const readZeroState = (api: Pick<CheatApi, "read"> | undefined): number | undefined => {
  if (!api || !isZeroBinary(api)) return undefined;
  try {
    return api.read(ZERO.STATE, 4, false);
  } catch {
    return undefined;
  }
};

/** Whether a cursor window (menu, shop, conversation choice, map) is up rather than the field. */
export const inZeroWindow = (api: Pick<CheatApi, "read"> | undefined): boolean => {
  const state = readZeroState(api);
  return state === ZERO.TALK || state === ZERO.MENU || state === ZERO.MAP;
};

/** Pad key of the save button; handled by the page, never sent to the game. */
export const ZERO_SAVE_KEY = "zero:save";

/** A fixed window of the game: RGB565 colors on a grid inside `box` (x0, y0, x1, y1), as indexes into `palette`. */
interface ScreenSignature {
  box: readonly [number, number, number, number];
  step: readonly [number, number];
  palette: readonly number[];
  pixels: string;
}

/** Windows of the save flow, sampled from the 240×320 screen; they are drawn at the same place over any map. */
export const ZERO_SCREENS = {
  // MENU title
  menu: {
    box: [60, 99, 180, 117],
    step: [4, 2],
    palette: [0xc5d2, 0x0, 0xd655, 0xce34, 0xce13, 0xce14, 0xc5f2],
    pixels:
      "111111111111111111111111111111023000230002300023000230002300500325003250032500325003250032" +
      "002040020400204002040020400204200202002020110110202002020020532045320453114112045320453204" +
      "000600006000060000600006000060020020200202002020020200202002501111111111111111111111111110",
  },
  // SYSTEM tab bar and the highlighted 세이브 row
  system: {
    box: [60, 99, 180, 131],
    step: [4, 2],
    palette: [0x3164, 0x6000, 0xc5d2, 0x8000, 0x0, 0xef5a, 0xd655, 0xce14, 0xce13, 0xce34, 0xddef, 0xffff],
    pixels:
      "444444444444444444444444444444000000000000000000000000000000060000000000000000000000000006" +
      "060000000000aa0000aa0000000006060000000000000000aa0000000006060000000000000000000000000006" +
      "000000000000000000000000000000555555555555555555555555555555722967229672296722967229672296" +
      "226282262822628226282262822628633333333333333333333333333332711111111111b11111111111111113" +
      "211111111111b1111111111111111321111111111111111111111111111371111111111111b111111111111113" +
      "211111111111111111111111111113",
  },
  // "저장하시겠습니까?" with 예 highlighted
  prompt: {
    box: [64, 150, 176, 176],
    step: [4, 2],
    palette: [0xc5d2, 0x6000, 0xce13, 0xce14, 0xce34, 0x3164, 0xc5f2, 0xd655, 0xc5f3, 0xffff, 0x0],
    pixels:
      "008005550000800058500585000872374553757257472354753547236000065055605006005065050600428744" +
      "557442875555744287442862340623406234062340623406230230002300023000230002300023111111111111" +
      "1406234062340623111111991111100023a00230a023111111991111144608a46084a608111111991111170673" +
      "a0673a0673111111191111100008000a8000081111111911111747237472374723111111111111100600006000" +
      "0600",
  },
  // "저장되었습니다."
  saved: {
    box: [64, 147, 176, 173],
    step: [4, 2],
    palette: [0xc5d2, 0xce34, 0xd655, 0xce13, 0x3164, 0xc5f3, 0xc5f2],
    pixels:
      "130011300113001130011300113000202002020020200202002020021000010000100001000010000100135021" +
      "350213502135021350213560010640444001040044600106001050110544104011054110501105630206302463" +
      "020630406302063000500045400050000540005000051300113004440414304113001130002020020200202002" +
      "020020200213001130011300113001130011300020200202002020020200202002100001000010000100001000" +
      "0100",
  },
} satisfies Record<string, ScreenSignature>;

export type ZeroScreen = keyof typeof ZERO_SCREENS;

/** Share of a window's sampled pixels that must match; the other windows of the game stay far below it. */
const MATCH = 0.9;

export interface Frame {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export const showsScreen = (frame: Frame, screen: ZeroScreen): boolean => {
  const { box, step, palette, pixels } = ZERO_SCREENS[screen];
  const [x0, y0, x1, y1] = box;
  if (frame.width < x1 || frame.height < y1) return false;
  let index = 0;
  let matched = 0;
  for (let y = y0; y < y1; y += step[1]) {
    for (let x = x0; x < x1; x += step[0]) {
      const offset = (y * frame.width + x) * 4;
      const rgb565 = ((frame.data[offset] >> 3) << 11) | ((frame.data[offset + 1] >> 2) << 5) | (frame.data[offset + 2] >> 3);
      if (rgb565 === palette[parseInt(pixels[index], 16)]) matched++;
      index++;
    }
  }
  return matched >= index * MATCH;
};

export interface SaveHost {
  /** Presses and releases a key. */
  press(key: string): Promise<void>;
  /** The game's current screen, or undefined when it cannot be read. */
  frame(): Frame | undefined;
  /** Resolves after `ms`. */
  sleep(ms: number): Promise<void>;
  /** False once the session ends; the save stops without pressing anything more. */
  alive(): boolean;
  /** The game's state word when it can be read (see ZERO). */
  state(): number | undefined;
}

export type SaveResult = "saved" | "not-field" | "unreadable" | "stopped" | "failed";

const POLL_MS = 40;

/** Waits until the screen satisfies `test`, for at most `timeout` ms. */
const waitFor = async (host: SaveHost, test: (frame: Frame) => boolean, timeout: number): Promise<boolean> => {
  for (let waited = 0; ; waited += POLL_MS) {
    if (!host.alive()) return false;
    const frame = host.frame();
    if (frame && test(frame)) return true;
    if (waited >= timeout) return false;
    await host.sleep(POLL_MS);
  }
};

/** Saves to the slot the game was loaded from, through its own menu. Call it from the field. */
export const saveZero = async (host: SaveHost): Promise<SaveResult> => {
  const frame = host.frame();
  if (!frame) return "unreadable";
  // An open menu would close on CLR and 7 would then fire a skill: only start from the field.
  const state = host.state();
  if ((state !== undefined && state !== ZERO.FIELD) || showsScreen(frame, "menu") || showsScreen(frame, "system")) {
    return "not-field";
  }
  await host.press("CLR");
  if (!await waitFor(host, f => showsScreen(f, "menu"), 1500)) return host.alive() ? "not-field" : "stopped";
  await host.press("7");
  if (!await waitFor(host, f => showsScreen(f, "system") && !showsScreen(f, "prompt"), 1500)) {
    if (host.alive()) await host.press("CLR");
    return host.alive() ? "failed" : "stopped";
  }
  await host.press("OK");
  if (!await waitFor(host, f => showsScreen(f, "prompt"), 1500)) return host.alive() ? "failed" : "stopped";
  await host.press("OK");
  if (!await waitFor(host, f => showsScreen(f, "saved"), 5000)) return host.alive() ? "failed" : "stopped";
  // Back out to the field: dismiss the notice, leave 시스템, close the menu.
  await host.press("OK");
  if (!await waitFor(host, f => showsScreen(f, "system") && !showsScreen(f, "saved"), 1500)) return host.alive() ? "saved" : "stopped";
  await host.press("CLR");
  if (!await waitFor(host, f => showsScreen(f, "menu"), 1500)) return host.alive() ? "saved" : "stopped";
  await host.press("CLR");
  return "saved";
};
