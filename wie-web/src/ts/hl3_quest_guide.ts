import type { PlayerSession } from "./backend";
import { loadGamePreference, storeGamePreference } from "./game_preferences";
import { Hl3QuestResources, isCurrentQuestSnapshot, readHl3Quests, type QuestSnapshot } from "./hl3_quests";

/** A throttled, read-only HUD. No timers, key injection, save writes or guest-memory writes. */
export class Hl3QuestGuide {
  private readonly root = document.createElement("section");
  private readonly toggle = document.createElement("button");
  private readonly title = document.createElement("strong");
  private readonly objective = document.createElement("span");
  private readonly direction = document.createElement("span");
  private readonly details = document.createElement("div");
  private readonly description = document.createElement("p");
  private readonly marker = document.createElement("div");
  private readonly abort = new AbortController();
  private readonly observer: ResizeObserver;
  private resources?: Hl3QuestResources;
  private snapshot?: QuestSnapshot;
  private nextSample = 0;
  private lastValidSample = -Infinity;
  private disposed = false;
  private width = 0;
  private height = 0;

  constructor(private readonly game: HTMLCanvasElement, private readonly appId: string) {
    // Float inside the existing stick zone. Never take space from the native screen or pad.
    this.root.className = "hl3-quest-guide";
    this.root.setAttribute("aria-label", "영웅서기3 메인 퀘스트 안내");
    this.root.hidden = true;
    this.toggle.type = "button";
    this.toggle.className = "hl3-quest-toggle";
    this.toggle.textContent = "메인 퀘스트";
    this.toggle.setAttribute("aria-expanded", "false");
    this.title.className = "hl3-quest-title";
    this.objective.className = "hl3-quest-objective";
    this.direction.className = "hl3-quest-direction";
    this.details.className = "hl3-quest-details";
    this.details.hidden = true;
    this.details.append(this.objective, this.description);
    this.root.append(this.toggle, this.title, this.direction, this.details);
    this.marker.className = "hl3-quest-marker";
    this.marker.hidden = true;
    this.marker.setAttribute("aria-hidden", "true");
    game.parentElement!.append(this.marker);
    document.querySelector(".pad-left")!.append(this.root);
    this.root.dataset.compact = loadGamePreference(appId, "quest_compact", "false");
    const options = { signal: this.abort.signal };
    this.toggle.addEventListener("click", () => {
      this.details.hidden = !this.details.hidden;
      this.toggle.setAttribute("aria-expanded", String(!this.details.hidden));
      if (!this.details.hidden) this.root.dataset.compact = "false";
      else this.root.dataset.compact = "true";
      storeGamePreference(appId, "quest_compact", this.root.dataset.compact);
    }, options);
    for (const event of ["pointerdown", "pointerup", "touchstart", "touchend", "keydown", "keyup"]) {
      this.root.addEventListener(event, e => e.stopPropagation(), options);
    }
    document.addEventListener("visibilitychange", () => this.clear(), options);
    document.getElementById("screen-fit")?.addEventListener("change", () => this.positionMarker(), options);
    this.observer = new ResizeObserver(entries => {
      for (const entry of entries) { this.width = entry.contentRect.width; this.height = entry.contentRect.height; }
      this.positionMarker();
    });
    this.observer.observe(game.parentElement!);
  }

  attach(session: PlayerSession | undefined): void {
    if (this.disposed || !session?.readResources || this.resources) return;
    try {
      this.resources = new Hl3QuestResources(session.readResources(["res/dat/quest_", "res/event/"]));
    } catch (error) {
      // Unsupported archives keep playing normally; never interpret a different edition's data.
      console.warn("HL3 quest resources unavailable", error);
    }
  }

  sample(session: PlayerSession | undefined, now = performance.now()): void {
    if (this.disposed) return;
    if (document.hidden || document.querySelector("dialog[open]")) { this.clear(); return; }
    if (!session?.cheats || !this.resources) { this.clear(); return; }
    // Check cheap native context on every frame, even between the heavier 250ms reads.
    // Never retain a waypoint across a dialog, map change, character change or quest turn-in.
    if (this.snapshot && !isCurrentQuestSnapshot(this.appId, session.cheats, this.snapshot)) this.clear();
    if (now < this.nextSample) return;
    this.nextSample = now + 250;
    try {
      const snapshot = readHl3Quests(this.appId, session.cheats, this.resources);
      if (!snapshot) { this.retrySample(session, now); return; }
      this.lastValidSample = now;
      this.snapshot = snapshot;
      const selected = snapshot.selected;
      if (!selected) { this.root.hidden = this.marker.hidden = true; return; }
      this.root.hidden = false;
      const text = (node: HTMLElement, value: string) => { if (node.textContent !== value) node.textContent = value; };
      text(this.toggle, "메인 퀘스트");
      this.toggle.setAttribute("aria-label", `메인 퀘스트 ${snapshot.quests.length}개 · ${this.details.hidden ? "보기" : "접기"}`);
      text(this.title, selected.title);
      const progress = selected?.progress.map(p => `${Math.min(p.current, p.required)}/${p.required}`).join(" · ");
      text(this.objective, selected ? `${selected.location.replace(/;/g, " · ")}${progress ? `  ${progress}` : ""}` : "");
      text(this.direction, snapshot.guidance);
      text(this.description, selected.description);
      this.positionMarker();
    } catch { this.retrySample(session, now); }
  }

  private retrySample(session: PlayerSession, now: number): void {
    if (!this.snapshot || now - this.lastValidSample > 750 || !session.cheats ||
      !isCurrentQuestSnapshot(this.appId, session.cheats, this.snapshot)) this.clear();
    // A single incomplete field read no longer blanks the HUD for a full sampling interval.
    this.nextSample = now + 50;
  }

  private positionMarker(): void {
    const snapshot = this.snapshot, point = snapshot?.point;
    this.marker.hidden = this.root.hidden || !point || !this.width || !this.height;
    if (!point || !snapshot || !this.width || !this.height) return;
    const fill = document.documentElement.dataset.screenFit === "fill";
    const sx = this.width / 240, sy = this.height / 320;
    const xScale = fill ? sx : Math.min(sx, sy), yScale = fill ? sy : Math.min(sx, sy);
    const x = point.x + snapshot.camera.x, y = point.y + snapshot.camera.y - 12;
    // Keep every marker below the native player/mini-boss HUD and above its bottom hotkeys.
    // Include the glyph's screen-pixel radius so its edges cannot cover either HUD.
    const left = Math.max(12, 16 / xScale), right = 240 - left;
    const top = 64 + 16 / yScale, bottom = 264 - 16 / yScale;
    const onScreen = x >= left && x <= right && y >= top && y <= bottom;
    const px = (this.width - 240 * xScale) / 2 + Math.max(left, Math.min(right, x)) * xScale;
    const py = (this.height - 320 * yScale) / 2 + Math.max(top, Math.min(bottom, y)) * yScale;
    this.marker.style.left = `${px}px`;
    this.marker.style.top = `${py}px`;
    const angle = Math.atan2((point.y - snapshot.player.y) * yScale, (point.x - snapshot.player.x) * xScale) * 180 / Math.PI;
    this.marker.textContent = onScreen ? point.kind === "exit" ? "◇" : "◎" : "➤";
    this.marker.style.transform = `translate(-50%, -50%) rotate(${onScreen ? 0 : angle}deg)`;
  }

  clear(): void {
    this.root.hidden = this.marker.hidden = true;
    this.snapshot = undefined;
    this.nextSample = 0;
    this.lastValidSample = -Infinity;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    this.resources = undefined;
    this.observer.disconnect();
    this.abort.abort();
    this.root.remove();
    this.marker.remove();
  }
}
