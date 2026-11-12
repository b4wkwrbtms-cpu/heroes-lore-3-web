import type { CheatApi } from "./backend";
import { loadGamePreference, storeGamePreference } from "./game_preferences";
import { HL4_FIELD, type Hl4Hit, Hl4HitTracker } from "./hl4_hits";

/**
 * A heavy blow (a critical hit, a strong skill) does this much more than the hero's recent blows, or takes half of the
 * monster's HP. Early monsters lose a quarter of their HP to every plain hit, so a fixed share alone flashes always.
 */
const HEAVY_RATIO = 1.35;
const HEAVY_SHARE = 0.5;
/** Hit-stop: the game is held still for a moment so a blow lands with weight. */
const HOLD_HIT_MS = 24;
const HOLD_HEAVY_MS = 50;
const HOLD_KILL_MS = 60;
const MAX_SPARKS = 180;
/** A sprite stands at its feet; its body is about this far above. */
const BODY = 14;

interface Spark { x: number; y: number; vx: number; vy: number; life: number; decay: number; width: number; hue: number }
interface Glow { x: number; y: number; radius: number; life: number; decay: number; hue: number }
interface Slash { x: number; y: number; angle: number; length: number; life: number; decay: number }
interface Ring { x: number; y: number; radius: number; speed: number; life: number; decay: number; hue: number }

/**
 * 영웅서기4: accents drawn over the game on blows the game already dealt. A monster losing HP gets sparks, a glow and
 * a slash streak; a heavy blow adds a warm flash; the last blow bursts into rings and debris. Blows hold the game
 * still for a moment and shake the screen a little, and the hero being hit reddens the screen's edge. The game's own
 * image, animation frames and damage are untouched; the 타격 효과 setting turns all of it off, and the device's
 * reduced-motion setting removes the shake and hit-stop.
 */
export class Hl4Feedback {
  private readonly tracker = new Hl4HitTracker();
  private readonly canvas = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D | null;
  private readonly wrapper: HTMLElement;
  private readonly observer: ResizeObserver;
  private readonly abort = new AbortController();
  private readonly reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly setting = document.getElementById("hit-effects-setting");
  private readonly select = document.getElementById("hit-effects") as HTMLSelectElement | null;
  private sparks: Spark[] = [];
  private glows: Glow[] = [];
  private slashes: Slash[] = [];
  private rings: Ring[] = [];
  private flash = 0;
  private hurt = 0;
  private shake = 0;
  private seed = 1;
  /** Running average of recent damage and how many blows it has seen. */
  private average = 0;
  private blows = 0;
  private enabled = true;
  private disposed = false;
  private frame: number | undefined;
  private last = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  private scaleX = 1;
  private scaleY = 1;
  private left = 0;
  private top = 0;

  constructor(private readonly game: HTMLCanvasElement, appId: string, private readonly hold: (ms: number) => void) {
    this.wrapper = game.parentElement!;
    this.canvas.id = "hit-effects-canvas";
    this.canvas.hidden = true;
    this.canvas.setAttribute("aria-hidden", "true");
    this.wrapper.append(this.canvas);
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
    this.observer.observe(this.wrapper);
    document.getElementById("screen-fit")?.addEventListener("change", () => this.fit(), { signal: this.abort.signal });
    document.addEventListener("visibilitychange", () => this.clear(), { signal: this.abort.signal });
    this.reduced.addEventListener("change", () => this.clear(), { signal: this.abort.signal });
  }

  private fit(): void {
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
    if (!api || !this.context || !this.enabled || document.hidden || document.querySelector("dialog[open]")) {
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

  /** Deterministic jitter so effects never depend on Math.random's state. */
  private random(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  private readonly addHit = (hit: Hl4Hit): void => {
    const heavy = hit.share >= HEAVY_SHARE || (this.blows >= 3 && hit.damage >= this.average * HEAVY_RATIO);
    this.average = this.blows === 0 ? hit.damage : this.average * 0.8 + hit.damage * 0.2;
    this.blows++;
    const x = hit.x, y = hit.y - BODY;
    const count = hit.killed ? 22 : heavy ? 18 : 11;
    for (let i = 0; i < count && this.sparks.length < MAX_SPARKS; i++) {
      const angle = this.random() * Math.PI * 2, speed = (heavy || hit.killed ? 2.7 : 2.1) * (0.5 + this.random());
      this.sparks.push({
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.7,
        life: 1, decay: 0.045 + this.random() * 0.04, width: heavy ? 1.6 : 1.2, hue: hit.killed ? 15 + this.random() * 30 : 30 + this.random() * 20,
      });
    }
    this.glows.push({ x, y, radius: heavy || hit.killed ? 24 : 17, life: 1, decay: heavy ? 0.07 : 0.1, hue: heavy ? 48 : 36 });
    const angle = -0.6 + this.random() * 1.2 + (this.random() < 0.5 ? 0 : Math.PI / 2);
    this.slashes.push({ x, y, angle, length: heavy ? 30 : 22, life: 1, decay: heavy ? 0.11 : 0.14 });
    if (heavy) this.flash = Math.max(this.flash, 0.2);
    if (hit.killed) {
      this.rings.push({ x, y, radius: 4, speed: 2.6, life: 1, decay: 0.05, hue: 22 });
      this.rings.push({ x, y, radius: 2, speed: 1.7, life: 1, decay: 0.045, hue: 42 });
    }
    this.kick(hit.killed ? 2.4 : heavy ? 2.6 : 1.1, hit.killed ? HOLD_KILL_MS : heavy ? HOLD_HEAVY_MS : HOLD_HIT_MS);
    this.start();
  };

  private readonly addHurt = (share: number): void => {
    this.hurt = Math.min(1, 0.45 + share * 1.5 + this.hurt * 0.5);
    this.kick(1.4 + share * 4, 0);
    this.start();
  };

  /** Screen shake (CSS pixels) and hit-stop, both left out when the device asks for less motion. */
  private kick(pixels: number, holdMs: number): void {
    if (this.reduced.matches) return;
    this.shake = Math.max(this.shake, pixels);
    if (holdMs > 0) this.hold(holdMs);
  }

  private start(): void {
    this.canvas.hidden = false;
    if (this.frame === undefined) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.draw);
    }
  }

  private readonly draw = (now: number): void => {
    this.frame = undefined;
    const ctx = this.context;
    if (!ctx || this.disposed) return;
    const step = Math.min((now - this.last) / 16.7, 3);
    this.last = now;
    this.update(step);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.setTransform(this.scaleX, 0, 0, this.scaleY, this.left, this.top);
    const view = this.tracker.view;
    const field = view.height - HL4_FIELD.STATUS_BAR;
    ctx.beginPath();
    ctx.rect(0, 0, view.width, field); // Keep the game's slot bar and HP/SP gauges clear.
    ctx.clip();

    if (this.hurt > 0) {
      const glow = ctx.createRadialGradient(view.width / 2, field / 2, field * 0.3, view.width / 2, field / 2, field * 0.7);
      glow.addColorStop(0, "rgba(200, 10, 0, 0)");
      glow.addColorStop(1, `rgba(200, 10, 0, ${(0.6 * this.hurt).toFixed(3)})`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, view.width, field);
    }
    ctx.globalCompositeOperation = "lighter";
    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255, 216, 128, ${this.flash.toFixed(3)})`;
      ctx.fillRect(0, 0, view.width, field);
    }
    for (const glow of this.glows) {
      const x = glow.x + view.x, y = glow.y + view.y, radius = glow.radius * (1.2 - glow.life * 0.4);
      const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
      light.addColorStop(0, `hsla(${glow.hue}, 100%, 85%, ${(0.85 * glow.life).toFixed(3)})`);
      light.addColorStop(0.35, `hsla(${glow.hue}, 100%, 60%, ${(0.45 * glow.life).toFixed(3)})`);
      light.addColorStop(1, `hsla(${glow.hue}, 100%, 50%, 0)`);
      ctx.fillStyle = light;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.lineCap = "round";
    for (const slash of this.slashes) {
      const x = slash.x + view.x, y = slash.y + view.y;
      const reach = slash.length * (0.55 + (1 - slash.life) * 0.6);
      const dx = Math.cos(slash.angle) * reach, dy = Math.sin(slash.angle) * reach;
      ctx.strokeStyle = `rgba(255, 246, 220, ${slash.life.toFixed(3)})`;
      ctx.lineWidth = 2.2 * slash.life + 0.4;
      ctx.beginPath();
      ctx.moveTo(x - dx, y - dy);
      ctx.lineTo(x + dx, y + dy);
      ctx.stroke();
    }
    for (const ring of this.rings) {
      ctx.strokeStyle = `hsla(${ring.hue}, 100%, 70%, ${(0.9 * ring.life).toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(ring.x + view.x, ring.y + view.y, ring.radius, ring.radius * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const spark of this.sparks) {
      const x = spark.x + view.x, y = spark.y + view.y;
      ctx.strokeStyle = `hsla(${spark.hue}, 100%, ${(60 + 30 * spark.life).toFixed(0)}%, ${spark.life.toFixed(3)})`;
      ctx.lineWidth = spark.width;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - spark.vx * 1.8, y - spark.vy * 1.8);
      ctx.stroke();
    }
    ctx.restore();

    const shake = this.shake;
    this.wrapper.style.translate = shake ? `${((this.random() * 2 - 1) * shake).toFixed(1)}px ${((this.random() * 2 - 1) * shake).toFixed(1)}px` : "";
    if (this.active()) this.frame = requestAnimationFrame(this.draw);
    else this.canvas.hidden = true;
  };

  private update(step: number): void {
    for (const spark of this.sparks) {
      spark.x += spark.vx * step;
      spark.y += spark.vy * step;
      spark.vy += 0.08 * step;
      spark.vx *= 0.96;
      spark.life -= spark.decay * step;
    }
    for (const ring of this.rings) {
      ring.radius += ring.speed * step;
      ring.speed *= 0.93;
      ring.life -= ring.decay * step;
    }
    for (const glow of this.glows) glow.life -= glow.decay * step;
    for (const slash of this.slashes) slash.life -= slash.decay * step;
    this.sparks = this.sparks.filter(spark => spark.life > 0);
    this.rings = this.rings.filter(ring => ring.life > 0);
    this.glows = this.glows.filter(glow => glow.life > 0);
    this.slashes = this.slashes.filter(slash => slash.life > 0);
    this.flash = Math.max(0, this.flash - 0.03 * step);
    this.hurt = Math.max(0, this.hurt - 0.035 * step);
    this.shake = this.shake < 0.2 ? 0 : this.shake * 0.82 ** step;
  }

  private active(): boolean {
    return this.sparks.length + this.rings.length + this.glows.length + this.slashes.length > 0
      || this.flash > 0 || this.hurt > 0 || this.shake > 0;
  }

  private clearEffects(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.sparks = [];
    this.glows = [];
    this.slashes = [];
    this.rings = [];
    this.flash = this.hurt = this.shake = 0;
    this.wrapper.style.translate = "";
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
