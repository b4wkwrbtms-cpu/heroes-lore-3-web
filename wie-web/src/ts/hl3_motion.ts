import type { CheatApi, GuestApi } from "./backend";
import { isHeroesLore3Binary } from "./hl3";
import { cameraOffset } from "./hl3_hits";
import type { MotionGame, MotionWrite } from "./motion";

/**
 * 영웅서기3 for the in-between frames, from the LGT 2009-03-10 binary. Its timer callback (0x166c) calls the current
 * mode's update and draw handlers (the pointers at 0x1503aa0 and 0x1503aa4) and then MC_grpFlushLcd. The field's
 * draw handler (0x3b840) first moves the camera: 0x16280 aims it at the sprite it follows and 0x162dc eases it
 * there, so the camera a frame was drawn with is the one in memory afterwards. It then draws the map's tiles at the
 * camera offset (state + 0x9e6c/0x9e70; 0x17080 clamps it to the map) and the sprites of the map's three lists
 * (map + 0x9c, 0x8c, 0xac, each linked through sprite + 0x40 or, when that is 0, + 0x3c) at their own map position
 * (s16 at sprite + 0x10/0x12; 0x1c868), the weather (0x16e18), the HUD (0x22a4) and, while state + 0x9e38 is set
 * and no dialog is open (state + 0x9c44), the quick slots (0x54d28). The hero, NPCs and monsters are all such
 * sprites. Besides the screen, drawing only changes a few counters in .bss (the HUD's blink, a screen flash) and
 * each sprite's on-screen byte.
 */
const STATE = 0x01503ab0;
const DRAW_HANDLER = 0x01503aa4;
const FIELD_DRAW = 0x3b841;
/** The field draw handler's drawing steps, without the two that move the camera. */
const DRAW_MAP = 0x17081;
const DRAW_WEATHER = 0x16e19;
const DRAW_HUD = 0x22a5;
const DRAW_QUICK_SLOTS = 0x54d29;
/** Returns the address of the screen's frame, as the game's own flush passes it. */
const SCREEN_FRAME = 0x2ad65;
/** The game's import veneer for MC_grpFlushLcd. */
const FLUSH_LCD = 0x01400484;
const BSS: readonly [number, number] = [0x01500000, 0x12958];
const LISTS = [0x9c, 0x8c, 0xac];
/** Byte in a sprite: 1 when its last drawing was on the screen (0x1c868 sets it; targeting at 0x16780 reads it). */
const ON_SCREEN = 0x22;
const MAX_SPRITES = 400;
/** Anything that moved further than this in one game frame jumped (a warp, a new map): it is not moved gradually. */
const NEAR = 48;

const heap = (p: number): boolean => p >= 0x40000000 && p < 0x50000000;
const signed16 = (n: number): number => (n << 16) >> 16;
/** Rounds the same way in both directions, so a camera and a sprite moving in step stay in step. */
const between = (from: number, to: number, frac: number): number => from + Math.sign(to - from) * Math.floor(Math.abs(to - from) * frac + 0.5);
const near = (a: number, b: number): boolean => Math.abs(a - b) <= NEAR;

export interface Hl3Motion {
  map: number;
  /** Camera offset as the renderer clamps it to the map: where the map's corner is on the screen. */
  camera: [number, number];
  /** Sprite address → its map position. */
  sprites: Map<number, [number, number]>;
}

export class Hl3MotionGame implements MotionGame<Hl3Motion> {
  readonly scratch = [BSS];
  private supported: boolean | undefined;

  read(api: CheatApi): Hl3Motion | undefined {
    const read = (address: number, width = 4) => api.read(address, width, false);
    this.supported ??= isHeroesLore3Binary(api);
    // Only the field itself: a dialog, the menu or a cutscene draws through other paths.
    if (!this.supported || read(STATE + 0x50) !== 4 || read(STATE + 0xa098, 1) !== 3 || read(DRAW_HANDLER) !== FIELD_DRAW) return undefined;
    const map = read(STATE + 0x9c68);
    if (!heap(map)) return undefined;
    const camera: [number, number] = [
      cameraOffset(read(STATE + 0x9e6c) | 0, read(STATE + 0x44), signed16(read(map + 0x50, 2))),
      cameraOffset(read(STATE + 0x9e70) | 0, read(STATE + 0x48), signed16(read(map + 0x52, 2))),
    ];
    const sprites = new Map<number, [number, number]>();
    for (const list of LISTS) {
      for (let sprite = read(map + list); heap(sprite) && !sprites.has(sprite) && sprites.size < MAX_SPRITES; sprite = read(sprite + 0x40) || read(sprite + 0x3c)) {
        sprites.set(sprite, [signed16(read(sprite + 0x10, 2)), signed16(read(sprite + 0x12, 2))]);
      }
    }
    return { map, camera, sprites };
  }

  place(prev: Hl3Motion, cur: Hl3Motion, frac: number): MotionWrite[] {
    const writes: MotionWrite[] = [];
    if (prev.map !== cur.map || !near(prev.camera[0], cur.camera[0]) || !near(prev.camera[1], cur.camera[1])) return writes;
    const put = (address: number, width: number, from: number, to: number) => {
      if (from !== to) writes.push({ address, width, value: between(from, to, frac) >>> 0 });
    };
    put(STATE + 0x9e6c, 4, prev.camera[0], cur.camera[0]);
    put(STATE + 0x9e70, 4, prev.camera[1], cur.camera[1]);
    for (const [sprite, [x, y]] of cur.sprites) {
      const before = prev.sprites.get(sprite);
      if (!before || !near(before[0], x) || !near(before[1], y)) continue;
      put(sprite + 0x10, 2, before[0], x);
      put(sprite + 0x12, 2, before[1], y);
    }
    return writes;
  }

  draw(guest: GuestApi, api: CheatApi, cur: Hl3Motion): void {
    const read = (address: number, width = 4) => api.read(address, width, false);
    // Drawing a sprite notes whether it was on the screen; the game's own logic reads that back.
    const sprites = [...cur.sprites.keys()];
    const onScreen = sprites.map(sprite => read(sprite + ON_SCREEN, 1));
    try {
      guest.call(DRAW_MAP, []);
      guest.call(DRAW_WEATHER, []);
      guest.call(DRAW_HUD, []);
      if (read(STATE + 0x9e38, 1) && !read(STATE + 0x9c44, 1)) guest.call(DRAW_QUICK_SLOTS, []);
      guest.call(FLUSH_LCD, [0, read(guest.call(SCREEN_FRAME, [])), 0, 0, read(STATE + 0x44), read(STATE + 0x48)]);
    } finally {
      sprites.forEach((sprite, index) => api.write(sprite + ON_SCREEN, 1, false, onScreen[index]));
    }
  }
}
