import type { CheatApi, GuestApi, PlayerSession } from "./backend";
import { presentFrame } from "./display";
import { loadGamePreference, storeGamePreference } from "./game_preferences";

/** A guest memory write of 1, 2 or 4 little-endian bytes. */
export interface MotionWrite {
  address: number;
  width: number;
  value: number;
}

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
}

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
 * each game frame's own picture is still shown, as the last of its in-between frames. While nothing moves the game's
 * frames are shown at once, as without this.
 */
export class InBetweenFrames<S> {
  private readonly setting = document.getElementById("motion-setting");
  private readonly select = document.getElementById("motion") as HTMLSelectElement | null;
  private readonly abort = new AbortController();
  private readonly context: CanvasRenderingContext2D | null;
  /** The game's own pictures of the last two game frames: [the older one, the newer one]. */
  private held: [HTMLCanvasElement, HTMLCanvasElement] = [document.createElement("canvas"), document.createElement("canvas")];
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
    this.keep(this.held[1]);
    this.prev = this.cur;
    this.cur = guest.idle() ? this.game.read(api) : undefined;
    this.lastDrawn = now;
    this.drawn = 0;
    this.pending = this.prev !== undefined && this.cur !== undefined && interval < this.period * 3 && this.cost < GIVE_UP_MS
      && this.held[0].width === this.canvas.width && this.game.place(this.prev, this.cur, 0.5).length > 0;
    if (!this.pending) return false;
    this.show(this.held[0]); // the frame before this one: the movement toward this one starts there
    return true;
  }

  /** A display frame between game frames. Always true: the picture on screen is this class's. */
  private inBetween(now: number, guest: GuestApi, api: CheatApi): boolean {
    const frac = (now - this.arrived) / this.period;
    // The last stretch belongs to the game's own picture; so does all of it once the guest is busy with its next frame.
    if (frac >= 0.85) {
      this.pending = false;
      this.show(this.held[1]);
      return true;
    }
    if (now - this.lastDrawn < MIN_GAP_MS || (this.cost > SLOW_MS && (this.drawn > 0 || frac < 0.4)) || !guest.idle()) return true;
    const writes = this.game.place(this.prev!, this.cur!, frac);
    if (!writes.length) return true;

    const started = performance.now();
    const scratch = this.game.scratch.map(([address, size]) => api.dump(address, size));
    const before = writes.map(({ address, width }) => api.read(address, width, false));
    try {
      for (const { address, width, value } of writes) api.write(address, width, false, value);
      this.game.draw(guest, api, this.cur!);
    } finally {
      this.game.scratch.forEach(([address], index) => api.writeBytes(address, scratch[index]));
      writes.forEach(({ address, width }, index) => api.write(address, width, false, before[index]));
    }
    this.cost += (performance.now() - started - this.cost) * 0.1;
    this.lastDrawn = now;
    this.drawn++;
    presentFrame();
    return true;
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

  private show(picture: HTMLCanvasElement): void {
    const context = this.context!;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalCompositeOperation = "copy";
    context.drawImage(picture, 0, 0);
    context.restore();
    presentFrame();
  }

  dispose(): void {
    this.session.display = undefined;
    this.abort.abort();
    if (this.setting) this.setting.hidden = true;
  }
}
