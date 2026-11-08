import type { CheatApi } from "./backend";
import { getLevel, readVitals } from "./hl3";

/** Quick-slot keys of 영웅서기3 (회복 아이템·스킬 등록 칸). */
export const SLOT_KEYS = ["1", "3", "9", "0", "#"] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];
/** 주무기 콤보(기본 공격) 키. */
export const ATTACK_KEY = "OK";

export interface AutoConfig {
  potionOn: boolean;
  hpKey: SlotKey;
  hpPercent: number;
  spKey: SlotKey;
  spPercent: number;
  skillOn: boolean;
  /** 자동 스킬로 돌릴 단축키 칸. 쿨타임은 게임이 판단하므로 칸을 차례로 눌러 주기만 해요. */
  skillSlots: SlotKey[];
  /** 스킬 키를 연달아 누를 때 간격(ms). */
  skillGap: number;
}

export interface AutoContext {
  appId: string;
  getCheats(): CheatApi | undefined;
  /** Press a key and release it after `holdMs`. */
  pressKey(key: string, holdMs?: number): void;
}

export const defaultAutoConfig = (): AutoConfig => ({
  potionOn: false,
  hpKey: "9",
  hpPercent: 40,
  spKey: "0",
  spPercent: 30,
  skillOn: false,
  skillSlots: ["1", "3"],
  skillGap: 500,
});

const storageKey = (appId: string) => `wie_auto_${appId}`;

const isSlotKey = (value: unknown): value is SlotKey => typeof value === "string" && (SLOT_KEYS as readonly string[]).includes(value);

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

export const loadAutoConfig = (appId: string): AutoConfig => {
  const config = defaultAutoConfig();
  try {
    const raw = window.localStorage.getItem(storageKey(appId));
    if (!raw) return config;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return config;
    const data = parsed as Record<string, unknown>;
    config.potionOn = data.potionOn === true;
    if (isSlotKey(data.hpKey)) config.hpKey = data.hpKey;
    if (isSlotKey(data.spKey)) config.spKey = data.spKey;
    config.hpPercent = clampNumber(data.hpPercent, 5, 95, config.hpPercent);
    config.spPercent = clampNumber(data.spPercent, 5, 95, config.spPercent);
    config.skillOn = data.skillOn === true;
    config.skillGap = clampNumber(data.skillGap, 150, 3000, config.skillGap);
    if (Array.isArray(data.skillSlots)) config.skillSlots = SLOT_KEYS.filter(key => data.skillSlots.includes(key));
  } catch {
    // ignore corrupt settings
  }
  return config;
};

export const storeAutoConfig = (appId: string, config: AutoConfig) => {
  try {
    window.localStorage.setItem(storageKey(appId), JSON.stringify(config));
  } catch {
    // storage unavailable
  }
};

/** Slot keys that the auto-skill may use (potion keys are excluded while auto-potion is on). */
export const skillSlotKeys = (config: AutoConfig): SlotKey[] =>
  SLOT_KEYS.filter(key => !(config.potionOn && (key === config.hpKey || key === config.spKey)));

interface PotionState {
  lastPress: number;
  backoff: number;
  valueAtPress: number;
  rose: boolean;
}

const newPotionState = (): PotionState => ({ lastPress: 0, backoff: 1500, valueAtPress: 0, rose: false });

const TICK_MS = 100;
const POTION_HOLD_MS = 90;
const SKILL_HOLD_MS = 90;
/** Auto-skill keeps firing this long after the attack key is released, so tapping attack repeatedly still counts. */
const ATTACK_GRACE_MS = 1500;
const MAX_BACKOFF_MS = 12_000;

type Listener = (config: AutoConfig) => void;

class Automation {
  private context: AutoContext | undefined;
  private config: AutoConfig = defaultAutoConfig();
  private timer: number | undefined;
  private listeners = new Set<Listener>();

  private attackHeld = false;
  private attackUntil = 0;
  private lastSkillAt = 0;
  private roundRobin = 0;

  private hp = newPotionState();
  private sp = newPotionState();
  private spPeak = 0;
  private level = 0;

  attach(context: AutoContext) {
    this.detach();
    this.context = context;
    this.config = loadAutoConfig(context.appId);
    this.resetState();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.emit();
  }

  detach() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.context = undefined;
    this.attackHeld = false;
  }

  get current(): AutoConfig {
    return this.config;
  }

  get appId(): string | undefined {
    return this.context?.appId;
  }

  update(config: AutoConfig) {
    this.config = config;
    if (this.context) storeAutoConfig(this.context.appId, config);
    this.emit();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called with every key transition that reaches the game. */
  notifyKey(key: string, pressed: boolean) {
    if (key !== ATTACK_KEY) return;
    this.attackHeld = pressed;
    if (!pressed) this.attackUntil = performance.now() + ATTACK_GRACE_MS;
  }

  private emit() {
    for (const listener of this.listeners) listener(this.config);
  }

  private resetState() {
    this.hp = newPotionState();
    this.sp = newPotionState();
    this.spPeak = 0;
    this.level = 0;
    this.roundRobin = 0;
    this.lastSkillAt = 0;
    this.attackHeld = false;
    this.attackUntil = 0;
  }

  private tick() {
    const context = this.context;
    if (!context) return;
    const api = context.getCheats();
    if (!api) return;
    const now = performance.now();
    if (this.config.potionOn) {
      try {
        this.tickPotion(api, context, now);
      } catch {
        // player not in game yet
      }
    }
    if (this.config.skillOn && (this.attackHeld || now < this.attackUntil)) this.tickSkill(context, now);
  }

  private tickPotion(api: CheatApi, context: AutoContext, now: number) {
    const vitals = readVitals(api);
    if (vitals.hpMax <= 0 || vitals.hpMax > 100_000 || vitals.hp <= 0) return;

    // A new/lower level means another character: forget what we learned about SP.
    const level = getLevel(api);
    if (level < this.level) this.spPeak = 0;
    this.level = level;
    if (vitals.sp < 1_000_000 && vitals.sp > this.spPeak) this.spPeak = vitals.sp;

    this.drink(context, now, this.hp, vitals.hp, vitals.hpMax, this.config.hpPercent, this.config.hpKey);
    if (this.spPeak > 0) this.drink(context, now, this.sp, vitals.sp, this.spPeak, this.config.spPercent, this.config.spKey);
  }

  private drink(context: AutoContext, now: number, state: PotionState, value: number, max: number, percent: number, key: string) {
    if (state.lastPress > 0 && value > state.valueAtPress) state.rose = true;
    if (value >= (max * percent) / 100) {
      state.backoff = 1500;
      return;
    }
    if (now - state.lastPress < state.backoff) return;
    if (state.lastPress > 0) {
      // The previous press did not help (menu open, no potions left…): slow down.
      state.backoff = state.rose ? 1500 : Math.min(MAX_BACKOFF_MS, state.backoff * 2);
    }
    state.lastPress = now;
    state.valueAtPress = value;
    state.rose = false;
    context.pressKey(key, POTION_HOLD_MS);
  }

  /** Presses the checked slots in turn; the game itself ignores a slot whose skill is still cooling down. */
  private tickSkill(context: AutoContext, now: number) {
    if (now - this.lastSkillAt < this.config.skillGap) return;
    const keys = skillSlotKeys(this.config).filter(key => this.config.skillSlots.includes(key));
    if (keys.length === 0) return;
    const key = keys[this.roundRobin % keys.length];
    this.roundRobin = (this.roundRobin + 1) % keys.length;
    this.lastSkillAt = now;
    context.pressKey(key, SKILL_HOLD_MS);
  }
}

export const automation = new Automation();
