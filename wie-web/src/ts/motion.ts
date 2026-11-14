import type { CheatApi, GuestApi, PlayerSession } from "./backend";
import { presentFrame } from "./display";
import { loadGamePreference, storeGamePreference } from "./game_preferences";

/** A guest memory write of 1, 2 or 4 little-endian bytes. */
export interface MotionWrite {
  address: number;
  width: number;
  value: number;
}

/** A screen rectangle: x, y, width, height. */
export type Box = readonly [number, number, number, number];

/** What a game tells the in-between frames about itself; S is what moves in it, as of one game frame. */
export interface MotionGame<S> {
  /** What moves, read after a game frame; undefined where in-between frames do not apply (menus, loading). */
  read(api: CheatApi): S | undefined;
  /** The writes that place everything `frac` of the way from `prev` to `cur`; none when nothing moves or it jumped. */
  place(prev: S, cur: S, frac: number): MotionWrite[];
  /**
   * Has the guest draw its screen from its present state and show it; `cur` is the game frame being moved toward.
   * Whatever the drawing changes in the guest outside `scratch` and that the game reads again, this puts back.
   */
  draw(guest: GuestApi, api: CheatApi, cur: S): void;
  /** Guest memory the drawing changes (animation counters) as [address, size]; put back after each drawing. */
  scratch: ReadonlyArray<readonly [number, number]>;
  /** Where the map's top-left corner is on the screen `frac` of the way from `prev` to `cur`, as `place` puts it. */
  view(prev: S, cur: S, frac: number): readonly [number, number];
  /** The part of the screen that shows the map; the rest (the HUD) does not move with it. */
  readonly field: Box;
  /** Screen boxes, `frac` of the way, around what moved from `prev` to `cur`: the picture is not blended there. */
  movers(prev: S, cur: S, frac: number): Box[];
  /** A game frame arrived and the guest is idle: the game may have the guest draw parts of it for `decorate`. */
  arrived?(guest: GuestApi, api: CheatApi, cur: S): void;
  /** Draws over a picture (RGBA pixels, `width` wide) shown `frac` of the way from `prev`'s frame to `cur`'s. */
  decorate?(pixels: Uint32Array, width: number, prev: S, cur: S, frac: number): void;
}

/** More of the map than this changing at once is a new scene, a flash or a shake: it is not blended. */
const MAX_BLEND_SHARE = 0.4;

/** Display frames are drawn no closer together than this: a 120 Hz screen does not get twice the drawings. */
const MIN_GAP_MS = 13;
/** A drawing slower than this gets one in-between frame per game frame; slower than GIVE_UP_MS, none for a while. */
const SLOW_MS = 9;
const GIVE_UP_MS = 15;

/**
 * In-between frames, the way the 영웅서기5 player has them. The game moves everything in whole steps some 15–20
 * times a second. Between two game frames the guest draws its screen again with what moves placed part of the way
 * between its last two positions, on every display frame; the guest's memory is put back after each drawing, so the
 * game never sees it. The picture runs one game frame behind so there is always a real position to move toward, and
 * each game frame's own picture is still shown, as the last of its in-between frames.
 *
 * What changes in place has no position to move: an attack's poses, a skill's flames, a monster flinching. Where the
 * two game frames differ with the map lined up and nothing moved, the in-between frame fades from the older picture
 * to the newer one. While nothing moves or changes the game's frames are shown at once, as without this.
 */
export class InBetweenFrames<S> {
  private readonly setting = document.getElementById("motion-setting");
  private readonly select = document.getElementById("motion") as HTMLSelectElement | null;
  private readonly abort = new AbortController();
  private readonly context: CanvasRenderingContext2D | null;
  /** The game's own pictures of the last two game frames: [the older one, the newer one]. */
  private held: [HTMLCanvasElement, HTMLCanvasElement] = [document.createElement("canvas"), document.createElement("canvas")];
  /** Their pixels (RGBA, as the canvas has them). */
  private pixels: [Uint32Array | undefined, Uint32Array | undefined] = [undefined, undefined];
  /** Whether something changed in place between the two: in-between frames then fade between them. */
  private fading = false;
  private prev: S | undefined;
  private cur: S | undefined;
  /** When `cur` arrived, and the running average of the time between game frames (0 until two have arrived). */
  private arrived = 0;
  private period = 0;
  /** In-between frames toward `cur` are being shown; its own picture is held back. */
  private pending = false;
  private lastDrawn = 0;
  private drawn = 0;
  /** Running average of what one drawing costs, in ms. */
  private cost = 0;
  private enabled: boolean;
  private failed = false;

  constructor(private readonly session: PlayerSession, private readonly canvas: HTMLCanvasElement, private readonly game: MotionGame<S>, appId: string) {
    this.context = canvas.getContext("2d");
    this.enabled = loadGamePreference(appId, "motion", "smooth") !== "original";
    if (this.setting) this.setting.hidden = false;
    if (this.select) {
      this.select.value = this.enabled ? "smooth" : "original";
      this.select.addEventListener("change", () => {
        this.enabled = this.select!.value !== "original";
        storeGamePreference(appId, "motion", this.enabled ? "smooth" : "original");
      }, { signal: this.abort.signal });
    }
    session.display = (painted, time) => this.display(painted, time);
  }

  /** `now` is the display frame's time: display frames are evenly apart, the guest's work within them is not. */
  private display(painted: boolean, now: number): boolean {
    const { guest, cheats: api } = this.session;
    if (!guest || !api || !this.context || !this.enabled || this.failed) {
      this.prev = this.cur = undefined;
      this.pending = false;
      return false;
    }
    try {
      return painted ? this.gameFrame(now, guest, api) : this.pending && this.inBetween(now, guest, api);
    } catch (error) {
      // The game goes on without in-between frames; its own next frame repaints the screen.
      console.warn("In-between frames stopped:", error);
      this.failed = true;
      this.pending = false;
      return false;
    }
  }

  /** The guest painted a game frame: keep its picture and, if something moved, start toward it from the last one. */
  private gameFrame(now: number, guest: GuestApi, api: CheatApi): boolean {
    const interval = now - this.arrived;
    if (this.arrived && interval < 250) this.period = this.period ? this.period + (interval - this.period) * 0.2 : interval;
    this.arrived = now;
    this.cost *= 0.995; // a device that was too slow for a while gets another try later
    this.held.reverse();
    this.pixels.reverse();
    this.keep(this.held[1]);
    this.pixels[1] = this.picture().pixels.slice();
    this.prev = this.cur;
    this.cur = guest.idle() ? this.game.read(api) : undefined;
    if (this.cur !== undefined) this.game.arrived?.(guest, api, this.cur);
    this.lastDrawn = now;
    this.drawn = 0;
    const ready = this.prev !== undefined && this.cur !== undefined && interval < this.period * 3 && this.cost < GIVE_UP_MS
      && this.held[0].width === this.canvas.width && this.pixels[0]?.length === this.pixels[1].length;
    this.fading = ready && this.fade(undefined, 0.5) > 0;
    this.pending = ready && (this.fading || this.game.place(this.prev!, this.cur!, 0.5).length > 0);
    if (!this.pending) return false;
    this.show(0, 0); // the frame before this one: the movement toward this one starts there
    return true;
  }

  /** A display frame between game frames. Always true: the picture on screen is this class's. */
  private inBetween(now: number, guest: GuestApi, api: CheatApi): boolean {
    const frac = (now - this.arrived) / this.period;
    // The last stretch belongs to the game's own picture; so does all of it once the guest is busy with its next frame.
    if (frac >= 0.85) {
      this.pending = false;
      this.show(1, 1);
      return true;
    }
    if (now - this.lastDrawn < MIN_GAP_MS || (this.cost > SLOW_MS && (this.drawn > 0 || frac < 0.4))) return true;
    const writes = this.game.place(this.prev!, this.cur!, frac);
    if (writes.length ? !guest.idle() : !this.fading) return true;

    const started = performance.now();
    if (writes.length) {
      const scratch = this.game.scratch.map(([address, size]) => api.dump(address, size));
      const before = writes.map(({ address, width }) => api.read(address, width, false));
      try {
        for (const { address, width, value } of writes) api.write(address, width, false, value);
        this.game.draw(guest, api, this.cur!);
      } finally {
        this.game.scratch.forEach(([address], index) => api.writeBytes(address, scratch[index]));
        writes.forEach(({ address, width }, index) => api.write(address, width, false, before[index]));
      }
    }
    if (this.fading || this.game.decorate) {
      // The guest's drawing at the in-between positions, or with nothing moved the newer picture, faded in place.
      const picture = writes.length ? this.picture() : this.picture(this.pixels[1]!);
      if (this.fading) this.fade(picture.pixels, frac);
      this.game.decorate?.(picture.pixels, this.canvas.width, this.prev!, this.cur!, frac);
      this.context!.putImageData(picture.image, 0, 0);
    }
    this.cost += (performance.now() - started - this.cost) * 0.1;
    this.lastDrawn = now;
    this.drawn++;
    presentFrame();
    return true;
  }

  /** The canvas's pixels, or a copy of `from` to work on, as an image to put back. */
  private picture(from?: Uint32Array): { image: ImageData; pixels: Uint32Array } {
    const { width, height } = this.canvas;
    const image = from ? new ImageData(width, height) : this.context!.getImageData(0, 0, width, height);
    const pixels = new Uint32Array(image.data.buffer);
    if (from) pixels.set(from);
    return { image, pixels };
  }

  /**
   * Fades what changed in place between the two game frames into `base` (the picture at `frac`), `frac` of the way
   * from the older picture; returns how many pixels that is. Without `base` it only counts. The pictures are lined
   * up on the map; around what moved, and outside the map, `base` is kept as it is.
   */
  private fade(base: Uint32Array | undefined, frac: number): number {
    const older = this.pixels[0]!, newer = this.pixels[1]!;
    const width = this.canvas.width;
    const [fx, fy, fw, fh] = this.game.field;
    const [px, py] = this.game.view(this.prev!, this.cur!, 0);
    const [cx, cy] = this.game.view(this.prev!, this.cur!, 1);
    const [vx, vy] = this.game.view(this.prev!, this.cur!, frac);
    const skip = new Uint8Array(fw * fh);
    for (const [bx, by, bw, bh] of this.game.movers(this.prev!, this.cur!, frac)) {
      for (let y = Math.max(by, fy); y < Math.min(by + bh, fy + fh); y++) {
        skip.fill(1, (y - fy) * fw + Math.max(bx, fx) - fx, (y - fy) * fw + Math.min(bx + bw, fx + fw) - fx);
      }
    }
    const weight = Math.round(frac * 256);
    let changed = 0;
    for (let y = fy; y < fy + fh; y++) {
      // The same spot of the map in each picture.
      const oy = y - vy + py, ny = y - vy + cy;
      if (oy < fy || oy >= fy + fh || ny < fy || ny >= fy + fh) continue;
      for (let x = fx; x < fx + fw; x++) {
        const ox = x - vx + px, nx = x - vx + cx;
        if (ox < fx || ox >= fx + fw || nx < fx || nx >= fx + fw || skip[(y - fy) * fw + x - fx]) continue;
        const from = older[oy * width + ox];
        if (from === newer[ny * width + nx]) continue;
        changed++;
        if (!base) continue;
        const to = base[y * width + x];
        let mixed = 0xff000000;
        for (let shift = 0; shift < 24; shift += 8) {
          const a = (from >>> shift) & 0xff, b = (to >>> shift) & 0xff;
          mixed |= ((a * (256 - weight) + b * weight) >> 8) << shift;
        }
        base[y * width + x] = mixed >>> 0;
      }
    }
    return changed > 0 && changed <= fw * fh * MAX_BLEND_SHARE ? changed : 0;
  }

  private keep(copy: HTMLCanvasElement): void {
    if (copy.width !== this.canvas.width || copy.height !== this.canvas.height) {
      copy.width = this.canvas.width;
      copy.height = this.canvas.height;
    }
    const context = copy.getContext("2d")!;
    context.globalCompositeOperation = "copy";
    context.drawImage(this.canvas, 0, 0);
  }

  /** Shows the older (0) or newer (1) game frame's own picture, `frac` along the way for what is drawn over it. */
  private show(which: 0 | 1, frac: number): void {
    const context = this.context!;
    const pixels = this.pixels[which];
    if (this.game.decorate && pixels && this.prev !== undefined && this.cur !== undefined) {
      const picture = this.picture(pixels);
      this.game.decorate(picture.pixels, this.canvas.width, this.prev, this.cur, frac);
      context.putImageData(picture.image, 0, 0);
    } else {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = "copy";
      context.drawImage(this.held[which], 0, 0);
      context.restore();
    }
    presentFrame();
  }

  dispose(): void {
    this.session.display = undefined;
    this.abort.abort();
    if (this.setting) this.setting.hidden = true;
  }
}
