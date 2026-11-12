import type { CheatApi } from "./backend";
import { Hl3HitTracker } from "./hl3_hits";

const PREF = "wie_hl3_hit_effects";
const LIFETIME = 220;
const MAX_HITS = 12;

/** Local, short-lived accents on actual hits. The original game image and combat timing are untouched. */
export class Hl3Feedback {
  private readonly tracker = new Hl3HitTracker();
  private readonly canvas = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D | null;
  private readonly observer: ResizeObserver;
  private readonly abort = new AbortController();
  private readonly reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly setting = document.getElementById("hit-effects-setting");
  private readonly select = document.getElementById("hit-effects") as HTMLSelectElement | null;
  private readonly hits = Array.from({ length: MAX_HITS }, () => ({ x: 0, y: 0, born: -Infinity, angle: 0 }));
  private next = 0;
  private enabled = true;
  private disposed = false;
  private frame: number | undefined;
  private cssWidth = 0;
  private cssHeight = 0;
  private scaleX = 1;
  private scaleY = 1;
  private left = 0;
  private top = 0;

  constructor(private readonly game: HTMLCanvasElement) {
    this.canvas.id = "hit-effects-canvas";
    this.canvas.hidden = true;
    this.canvas.setAttribute("aria-hidden", "true");
    game.parentElement!.append(this.canvas);
    this.context = this.canvas.getContext("2d");
    try { this.enabled = localStorage.getItem(PREF) !== "off"; } catch { /* Use the default. */ }
    if (this.setting) this.setting.hidden = false;
    if (this.select) {
      this.select.value = this.enabled ? "on" : "off";
      this.select.addEventListener("change", () => {
        this.enabled = this.select!.value !== "off";
        try { localStorage.setItem(PREF, this.enabled ? "on" : "off"); } catch { /* Session preference still works. */ }
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
      if (!this.tracker.sample(api, this.addHit)) this.clearEffects();
    } catch {
      // A map/load can invalidate pointers. A presentation enhancement must never interrupt the game.
      this.clear();
    }
  }

  private readonly addHit = (x: number, y: number): void => {
    const hit = this.hits[this.next];
    hit.x = x;
    hit.y = y;
    hit.born = performance.now();
    hit.angle = this.next * 2.399963;
    this.next = (this.next + 1) % MAX_HITS;
    this.canvas.hidden = false;
    if (this.frame === undefined) this.frame = requestAnimationFrame(this.draw);
  };

  private readonly draw = (now: number): void => {
    this.frame = undefined;
    const ctx = this.context;
    if (!ctx || this.disposed) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.setTransform(this.scaleX, 0, 0, this.scaleY, this.left, this.top);
    const view = this.tracker.view;
    ctx.beginPath();
    ctx.rect(0, 0, view.width, view.height - 28); // Keep the original quick slots and HP/SP bars clear.
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    let active = false;
    for (const hit of this.hits) {
      const t = Math.max(0, (now - hit.born) / LIFETIME);
      if (t >= 1) continue;
      active = true;
      const x = hit.x + view.x, y = hit.y + view.y;
      const ease = 1 - (1 - t) ** 3;
      const alpha = (1 - t) ** 2;
      ctx.globalAlpha = alpha * 0.85;
      ctx.strokeStyle = "#ffd58b";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.ellipse(x, y, 3 + ease * 12, 2 + ease * 8, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#fff1cf";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = hit.angle + i * Math.PI / 3;
        const distance = 3 + ease * (12 + (i % 2) * 6);
        const tail = distance - 3 * (1 - t);
        ctx.moveTo(x + Math.cos(angle) * tail, y + Math.sin(angle) * tail * 0.75 + t * t * 4);
        ctx.lineTo(x + Math.cos(angle) * distance, y + Math.sin(angle) * distance * 0.75 + t * t * 4);
      }
      ctx.stroke();
      if (t < 0.32) {
        const size = 6 * (1 - t / 0.32);
        ctx.globalAlpha = (1 - t / 0.32) * 0.9;
        ctx.fillStyle = "#fff9e9";
        ctx.beginPath();
        ctx.moveTo(x, y - size);
        ctx.lineTo(x + size * 0.3, y - size * 0.3);
        ctx.lineTo(x + size, y);
        ctx.lineTo(x + size * 0.3, y + size * 0.3);
        ctx.lineTo(x, y + size);
        ctx.lineTo(x - size * 0.3, y + size * 0.3);
        ctx.lineTo(x - size, y);
        ctx.lineTo(x - size * 0.3, y - size * 0.3);
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
    for (const hit of this.hits) hit.born = -Infinity;
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
