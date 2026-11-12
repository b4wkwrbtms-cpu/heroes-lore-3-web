import type { CheatApi } from "./backend";
import { type Tile, characterTile, heroTarget, isMonsterAlive, isOnField } from "./inotia";
import type { Direction } from "./pad_profile";

export interface HuntHooks {
  getCheats(): CheatApi | undefined;
  /** Holds a walk key for the approach, or lets it go. */
  steer(key?: string): void;
  /** One attack press, whether or not the player holds attack. */
  strike(): void;
  /** Whether the player walks with the stick themselves. */
  playerSteering(): boolean;
  directions: Record<Direction, string>;
}

const TICK_MS = 30;
/** Pause between attack presses while the player holds attack. */
const STRIKE_MS = 260;
/** Without a step for this long, the approach tries the other axis, then gives up. */
const STUCK_MS = 400;
/** A tap follows its target for at most this long. */
const TAP_MS = 4000;

/**
 * 이노티아 attacks only what stands next to the hero, and only on a fresh press of attack. With this, attack walks the
 * hero up to the monster the game targets on that press and strikes it; holding attack keeps striking and moves on to
 * the next target. The game clears its target as soon as the hero walks, so the hunt remembers it.
 */
export class InotiaHunt {
  private timer: number | undefined;
  private held = false;
  private target = -1;
  private started = 0;
  private lastStrike = 0;
  private walked = false;
  private steering: string | undefined;
  private lastTile = "";
  private lastStep = 0;
  private flipped = false;

  constructor(private readonly hooks: HuntHooks) {}

  /** The player pressed or let go of attack. The press itself reaches the game as usual. */
  setHeld(held: boolean) {
    if (held === this.held) return;
    this.held = held;
    if (!held) return;
    const now = performance.now();
    this.target = -1;
    this.started = now;
    this.lastStrike = now;
    this.walked = false;
    this.timer ??= window.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.held = false;
    this.steer(undefined);
  }

  private steer(key: string | undefined) {
    if (key === this.steering) return;
    this.steering = key;
    this.hooks.steer(key);
  }

  private tick() {
    const api = this.hooks.getCheats();
    if (!api) {
      this.stop();
      return;
    }
    const now = performance.now();
    try {
      if (!isOnField(api)) {
        this.stop();
        return;
      }
      if (this.hooks.playerSteering()) {
        this.steer(undefined);
        if (!this.held) this.stop();
        return;
      }
      if (!isMonsterAlive(api, this.target)) {
        const target = heroTarget(api);
        this.target = isMonsterAlive(api, target) ? target : -1;
        this.flipped = false;
      }
      if (this.target < 0) {
        this.steer(undefined);
        // Holding attack keeps pressing it, which also lets the game pick the next target.
        if (this.held) this.strikeEvery(now);
        else if (now - this.started > 300) this.stop();
        return;
      }

      const hero = characterTile(api, 0);
      const goal = characterTile(api, this.target);
      const dx = goal.x - hero.x;
      const dy = goal.y - hero.y;
      if (Math.abs(dx) + Math.abs(dy) <= 1) {
        this.steer(undefined);
        if (this.held) this.strikeEvery(now);
        else {
          // A tap that had to walk still lands its hit.
          if (this.walked) this.strike(now);
          this.stop();
        }
        return;
      }
      if (!this.held && now - this.started > TAP_MS) {
        this.stop();
        return;
      }
      this.approach(hero, dx, dy, now);
    } catch {
      this.stop();
    }
  }

  private strikeEvery(now: number) {
    if (now - this.lastStrike >= STRIKE_MS) this.strike(now);
  }

  private strike(now: number) {
    this.lastStrike = now;
    this.hooks.strike();
  }

  private approach(hero: Tile, dx: number, dy: number, now: number) {
    const tile = `${hero.x},${hero.y}`;
    if (dx === 0 || dy === 0) this.flipped = false;
    if (tile !== this.lastTile || !this.steering) {
      this.lastTile = tile;
      this.lastStep = now;
    } else if (now - this.lastStep > STUCK_MS) {
      // Blocked: walk along the other axis once, then give up on this target.
      if (this.flipped || dx === 0 || dy === 0) {
        this.target = -1;
        this.steer(undefined);
        if (!this.held) this.stop();
        return;
      }
      this.flipped = true;
      this.lastStep = now;
    }
    let alongX = Math.abs(dx) >= Math.abs(dy);
    if (this.flipped && dx !== 0 && dy !== 0) alongX = !alongX;
    const direction: Direction = alongX ? (dx > 0 ? "RIGHT" : "LEFT") : dy > 0 ? "DOWN" : "UP";
    this.walked = true;
    this.steer(this.hooks.directions[direction]);
  }
}
