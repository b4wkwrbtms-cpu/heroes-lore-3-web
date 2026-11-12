import type { CheatApi } from "./backend";
import { loadGamePreference, storeGamePreference } from "./game_preferences";
import type { ZeroHit, ZeroView } from "./zero_hits";

const HIT_MS = 260;
const STRONG_HIT_MS = 300;
const KILL_MS = 420;
const HURT_MS = 260;
const MAX_HITS = 16;
/** A hit that takes this share of the monster's HP or more gets the larger burst. */
const STRONG = 0.25;

interface Burst {
  x: number;
  y: number;
  born: number;
  life: number;
  angle: number;
  size: number;
  killed: boolean;
}

/** One game's read-only view of its own field combat (영웅서기 제로, 영웅서기4). */
export interface FieldHitSource {
  /** Screen size and camera: screen = map + (x, y). */
  readonly view: ZeroView;
  /** Height of the status window at the bottom of the screen, kept clear of the accents. */
  readonly statusBar: number;
  /** From the map position a hit reports to the middle of the monster's body. */
  readonly aim: { readonly x: number; readonly y: number };
  /** Called after a new guest frame; false when the field is not showing. */
  sample(api: Pick<CheatApi, "read" | "dump">, hit: (hit: ZeroHit) => void, hurt: (share: number) => void): boolean;
  reset(): void;
}

/**
 * Short accents drawn over the game on hits the game already dealt — a flash, ring and sparks on a monster that
 * loses HP (bigger for heavy hits, a double ring when it falls) and a red edge when the hero is hurt. The game's own
 * image, animation frames, timing and damage are untouched; it can be turned off in the settings.
 */
export class FieldFeedback {
  private readonly canvas = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D | null;
  private readonly observer: ResizeObserver;
  private readonly abort = new AbortController();
  private readonly reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly setting = document.getElementById("hit-effects-setting");
  private readonly select = document.getElementById("hit-effects") as HTMLSelectElement | null;
  private readonly bursts: Burst[] = Array.from({ length: MAX_HITS }, () => ({ x: 0, y: 0, born: -Infinity, life: 1, angle: 0, size: 1, killed: false }));
  private next = 0;
  private hurtBorn = -Infinity;
  private hurtShare = 0;
  private enabled = true;
  private disposed = false;
  private frame: number | undefined;
  private cssWidth = 0;
  private cssHeight = 0;
  private scaleX = 1;
  private scaleY = 1;
  private left = 0;
  private top = 0;

  constructor(private readonly game: HTMLCanvasElement, appId: string, private readonly tracker: FieldHitSource) {
    this.canvas.id = "hit-effects-canvas";
    this.canvas.hidden = true;
    this.canvas.setAttribute("aria-hidden", "true");
    game.parentElement!.append(this.canvas);
    this.context = this.canvas.getContext("2d");
    this.enabled = loadGamePreference(appId, "hit_effects", "on") !== "off";
    if (this.setting) this.setting.hidden = false;
    if (this.select) {
      this.select.value = this.enabled ? "on" : "off";
      this.select.addEventListener("change", () => {
        this.enabled = this.select!.value !== "off";
        storeGamePreference(appId, "hit_effects", this.enabled ? "on" : "off");
        this.clear();
      }, { signal: this.abort.signal });
    }
    this.observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        this.cssWidth = entry.contentRect.width;
        this.cssHeight = entry.contentRect.height;
      }
      this.fit();
    });
    this.observer.observe(game.parentElement!);
    document.getElementById("screen-fit")?.addEventListener("change", () => this.fit(), { signal: this.abort.signal });
    document.addEventListener("visibilitychange", () => this.clear(), { signal: this.abort.signal });
    this.reduced.addEventListener("change", () => this.clear(), { signal: this.abort.signal });
  }

  private fit(): void {
    // Cap backing resolution on phones; this layer is mostly transparent and has no expensive filters.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(this.cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(this.cssHeight * dpr));
    const sx = this.canvas.width / this.game.width, sy = this.canvas.height / this.game.height;
    const contain = document.documentElement.dataset.screenFit !== "fill";
    this.scaleX = contain ? Math.min(sx, sy) : sx;
    this.scaleY = contain ? Math.min(sx, sy) : sy;
    this.left = (this.canvas.width - this.game.width * this.scaleX) / 2;
    this.top = (this.canvas.height - this.game.height * this.scaleY) / 2;
  }

  sample(api: CheatApi | undefined): void {
    if (this.disposed) return;
    if (!api || !this.context || !this.enabled || this.reduced.matches || document.hidden || document.querySelector("dialog[open]")) {
      this.clear();
      return;
    }
    try {
      if (!this.tracker.sample(api, this.addHit, this.addHurt)) this.clearEffects();
    } catch {
      // A map load can invalidate pointers. A presentation enhancement must never interrupt the game.
      this.clear();
    }
  }

  private readonly addHit = (hit: ZeroHit): void => {
    const burst = this.bursts[this.next];
    // The sprite stands on its position and rises above it; aim at its body.
    burst.x = hit.x + this.tracker.aim.x;
    burst.y = hit.y + this.tracker.aim.y;
    burst.born = performance.now();
    burst.killed = hit.killed;
    burst.size = hit.killed ? 1.5 : hit.share >= STRONG ? 1.25 : 1;
    burst.life = hit.killed ? KILL_MS : hit.share >= STRONG ? STRONG_HIT_MS : HIT_MS;
    burst.angle = this.next * 2.399963;
    this.next = (this.next + 1) % MAX_HITS;
    this.start();
  };

  private readonly addHurt = (share: number): void => {
    this.hurtBorn = performance.now();
    this.hurtShare = share;
    this.start();
  };

  private start(): void {
    this.canvas.hidden = false;
    if (this.frame === undefined) this.frame = requestAnimationFrame(this.draw);
  }

  private readonly draw = (now: number): void => {
    this.frame = undefined;
    const ctx = this.context;
    if (!ctx || this.disposed) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.setTransform(this.scaleX, 0, 0, this.scaleY, this.left, this.top);
    const view = this.tracker.view;
    const field = view.height - this.tracker.statusBar;
    ctx.beginPath();
    ctx.rect(0, 0, view.width, field); // Keep the original slot bar and HP/SP gauges clear.
    ctx.clip();
    let active = false;

    const hurt = (now - this.hurtBorn) / HURT_MS;
    if (hurt >= 0 && hurt < 1) {
      active = true;
      // A red edge, stronger for a bigger bite out of the hero's HP; the middle of the field stays clear.
      const alpha = (0.28 + 0.5 * this.hurtShare) * (1 - hurt) ** 2;
      const glow = ctx.createRadialGradient(view.width / 2, field / 2, field * 0.28, view.width / 2, field / 2, field * 0.68);
      glow.addColorStop(0, "rgba(220, 30, 30, 0)");
      glow.addColorStop(1, `rgba(220, 30, 30, ${alpha.toFixed(3)})`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, view.width, field);
    }

    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (const burst of this.bursts) {
      const t = Math.max(0, (now - burst.born) / burst.life);
      if (t >= 1) continue;
      active = true;
      const x = burst.x + view.x, y = burst.y + view.y;
      const size = burst.size;
      const ease = 1 - (1 - t) ** 3;
      const alpha = (1 - t) ** 2;
      // The game draws its own slash over the monster; a short glow on the body marks the moment HP is taken.
      if (t < 0.4) {
        const glow = 1 - t / 0.4;
        const radius = 11 * size;
        const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
        light.addColorStop(0, `rgba(255, 244, 214, ${(0.55 * glow).toFixed(3)})`);
        light.addColorStop(1, "rgba(255, 190, 90, 0)");
        ctx.globalAlpha = 1;
        ctx.fillStyle = light;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      // Ring (two for a monster that falls).
      ctx.globalAlpha = alpha * 0.85;
      ctx.strokeStyle = burst.killed ? "#ffb36b" : "#ffd58b";
      ctx.lineWidth = burst.killed ? 1.6 : 1.2;
      ctx.beginPath();
      ctx.ellipse(x, y, (3 + ease * 15) * size, (2 + ease * 10) * size, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (burst.killed && t > 0.18) {
        const late = 1 - (1 - (t - 0.18) / 0.82) ** 3;
        ctx.globalAlpha = alpha * 0.6;
        ctx.beginPath();
        ctx.ellipse(x, y, (4 + late * 22) * size, (3 + late * 14) * size, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Sparks flying out and falling a little.
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = "#fff1cf";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const rays = burst.killed ? 10 : size > 1 ? 8 : 6;
      for (let i = 0; i < rays; i++) {
        const angle = burst.angle + (i * Math.PI * 2) / rays;
        const distance = (3 + ease * (14 + (i % 2) * 7)) * size;
        const tail = distance - 3 * (1 - t) * size;
        const drop = t * t * 4 * size;
        ctx.moveTo(x + Math.cos(angle) * tail, y + Math.sin(angle) * tail * 0.75 + drop);
        ctx.lineTo(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance * 0.75 + drop);
      }
      ctx.stroke();
      // The impact flash: a four-pointed star for the first frames.
      if (t < 0.32) {
        const flash = 1 - t / 0.32;
        const star = 6 * size * flash;
        ctx.globalAlpha = flash * 0.9;
        ctx.fillStyle = "#fff9e9";
        ctx.beginPath();
        ctx.moveTo(x, y - star);
        ctx.lineTo(x + star * 0.3, y - star * 0.3);
        ctx.lineTo(x + star, y);
        ctx.lineTo(x + star * 0.3, y + star * 0.3);
        ctx.lineTo(x, y + star);
        ctx.lineTo(x - star * 0.3, y + star * 0.3);
        ctx.lineTo(x - star, y);
        ctx.lineTo(x - star * 0.3, y - star * 0.3);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
    if (active) this.frame = requestAnimationFrame(this.draw);
    else this.canvas.hidden = true;
  };

  private clearEffects(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    for (const burst of this.bursts) burst.born = -Infinity;
    this.hurtBorn = -Infinity;
    if (!this.canvas.hidden && this.context) {
      this.context.setTransform(1, 0, 0, 1, 0, 0);
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.canvas.hidden = true;
  }

  clear(): void {
    this.tracker.reset();
    this.clearEffects();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.observer.disconnect();
    this.abort.abort();
    this.canvas.remove();
    if (this.setting) this.setting.hidden = true;
  }
}
