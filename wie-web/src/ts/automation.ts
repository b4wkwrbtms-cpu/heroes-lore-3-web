import type { CheatApi } from "./backend";
import {
  SLOT_ORDER, type SkillState, type SlotSnapshot, getLevel, isOnField, readSkills, readSlot, readVitals, registerSkill, topUpSlotItems, writeSlot,
} from "./hl3";

/** Quick-slot keys of 영웅서기3 (회복 아이템·스킬 등록 칸). */
export const SLOT_KEYS = ["1", "3", "9", "0", "#"] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];
/** 주무기 콤보(기본 공격) 키. */
export const ATTACK_KEY = "OK";

export interface SkillRef {
  weapon: "A" | "B";
  index: number;
}

export interface MacroConfig {
  /** Skills fired in order when the macro button is pressed. */
  skills: SkillRef[];
  /** Also fire these skills in the attack-key rotation. */
  auto: boolean;
}

export const MACRO_COUNT = 3;
export const MACRO_NAMES = ["A", "B", "C"] as const;

export interface AutoConfig {
  potionOn: boolean;
  hpKey: SlotKey;
  hpPercent: number;
  spKey: SlotKey;
  spPercent: number;
  /** Keep the potions registered to hpKey/spKey at 99 pieces. */
  infinitePotions: boolean;
  skillOn: boolean;
  /** 자동 스킬로 돌릴 단축키 칸. 쿨타임은 게임이 판단하므로 칸을 차례로 눌러 주기만 해요. */
  skillSlots: SlotKey[];
  /** 스킬 키를 연달아 누를 때 간격(ms). */
  skillGap: number;
  /** 스킬 묶음: 패드의 추가 버튼. 등록은 게임 메모리의 단축키 테이블을 잠시 바꿔치기해서 `macroSlot` 키로 발동. */
  macros: MacroConfig[];
  macroSlot: SlotKey;
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
  infinitePotions: true,
  skillOn: false,
  skillSlots: ["1", "3"],
  skillGap: 500,
  macros: Array.from({ length: MACRO_COUNT }, () => ({ skills: [], auto: false })),
  macroSlot: "#",
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
    config.infinitePotions = data.infinitePotions !== false;
    config.skillOn = data.skillOn === true;
    config.skillGap = clampNumber(data.skillGap, 150, 3000, config.skillGap);
    const slots: unknown = data.skillSlots;
    if (Array.isArray(slots)) config.skillSlots = SLOT_KEYS.filter(key => slots.includes(key));
    if (isSlotKey(data.macroSlot)) config.macroSlot = data.macroSlot;
    const macros: unknown = data.macros;
    if (Array.isArray(macros)) {
      macros.slice(0, MACRO_COUNT).forEach((macro: unknown, i) => {
        if (typeof macro !== "object" || macro === null) return;
        const entry = macro as Record<string, unknown>;
        const skills: unknown = entry.skills;
        config.macros[i] = {
          auto: entry.auto === true,
          skills: Array.isArray(skills)
            ? skills
                .filter((ref: unknown): ref is SkillRef => typeof ref === "object" && ref !== null && ((ref as SkillRef).weapon === "A" || (ref as SkillRef).weapon === "B") && Number.isInteger((ref as SkillRef).index))
                .map(ref => ({ weapon: ref.weapon, index: ref.index }))
            : [],
        };
      });
    }
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

/** Skills a macro may hold: learned actives of both weapons. */
export const macroCandidates = (skills: SkillState[]): SkillState[] => skills.filter(skill => skill.index >= 1 && skill.index <= 5);

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
/** Auto-skill keeps firing this long after a qualifying attack hold ends. */
const ATTACK_GRACE_MS = 1200;
/** A tap on attack talks to NPCs and confirms dialogs; only a real hold (a combo) arms the auto-skill. */
const ATTACK_HOLD_MS = 350;
const MAX_BACKOFF_MS = 12_000;

type Listener = (config: AutoConfig) => void;

class Automation {
  private context: AutoContext | undefined;
  private config: AutoConfig = defaultAutoConfig();
  private timer: number | undefined;
  private listeners = new Set<Listener>();

  private attackHeld = false;
  private attackDownAt = 0;
  private attackUntil = 0;
  private lastSkillAt = 0;
  private roundRobin = 0;

  private hp = newPotionState();
  private sp = newPotionState();
  private spPeak = 0;
  private level = 0;
  private lastTopUp = 0;

  /** Macro run in progress: remaining skills and the slot contents to restore afterwards. */
  private macroQueue: SkillRef[] = [];
  private macroRestore: { slot: number; snapshot: SlotSnapshot } | undefined;
  private macroNextAt = 0;

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

  /** Fire a macro: its skills are registered one by one into the borrowed slot and the slot key is pressed. */
  runMacro(index: number): boolean {
    const macro = this.config.macros[index];
    const context = this.context;
    if (!macro || macro.skills.length === 0 || !context || !context.getCheats()) return false;
    this.macroQueue.push(...macro.skills);
    this.macroNextAt = 0;
    return true;
  }

  /** Called with every key transition that reaches the game. */
  notifyKey(key: string, pressed: boolean) {
    if (key !== ATTACK_KEY) return;
    const now = performance.now();
    if (pressed) {
      this.attackHeld = true;
      this.attackDownAt = now;
      return;
    }
    if (this.attackHeld && now - this.attackDownAt >= ATTACK_HOLD_MS) this.attackUntil = now + ATTACK_GRACE_MS;
    this.attackHeld = false;
  }

  /** True while attack has been held long enough to count as fighting (or shortly after). */
  private attacking(now: number): boolean {
    return (this.attackHeld && now - this.attackDownAt >= ATTACK_HOLD_MS) || now < this.attackUntil;
  }

  private emit() {
    for (const listener of this.listeners) listener(this.config);
  }

  private resetState() {
    this.hp = newPotionState();
    this.sp = newPotionState();
    this.spPeak = 0;
    this.level = 0;
    this.lastTopUp = 0;
    this.roundRobin = 0;
    this.macroQueue = [];
    this.macroRestore = undefined;
    this.macroNextAt = 0;
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
    // In menus the quick-slot keys page through screens (◀1 STATUS 3▶, 7/9 tabs), so never press them there.
    let onField = false;
    try {
      onField = isOnField(api);
    } catch {
      onField = false;
    }
    if (!onField) {
      this.macroQueue = [];
      this.attackHeld = false;
      this.attackUntil = 0;
    }
    if (this.config.potionOn) {
      try {
        this.tickPotion(api, context, now, onField);
      } catch {
        // player not in game yet
      }
    }
    this.tickMacro(api, context, now);
    if (onField && this.config.skillOn && this.attacking(now)) this.tickSkill(api, context, now);
  }

  private borrowedSlot(): number {
    return SLOT_ORDER.indexOf(this.config.macroSlot);
  }

  private fireSkill(api: CheatApi, context: AutoContext, ref: SkillRef): boolean {
    const skill = readSkills(api).find(candidate => candidate.weapon === ref.weapon && candidate.index === ref.index);
    if (!skill || skill.level <= 0) return false;
    const slot = this.borrowedSlot();
    if (!this.macroRestore) this.macroRestore = { slot, snapshot: readSlot(api, slot) };
    registerSkill(api, slot, skill);
    context.pressKey(this.config.macroSlot, SKILL_HOLD_MS);
    return true;
  }

  private tickMacro(api: CheatApi, context: AutoContext, now: number) {
    if (now < this.macroNextAt) return;
    const next = this.macroQueue.shift();
    if (next) {
      try {
        this.fireSkill(api, context, next);
      } catch {
        // game not ready
      }
      this.macroNextAt = now + this.config.skillGap;
      return;
    }
    if (this.macroRestore && !(this.config.skillOn && this.attacking(now))) {
      try {
        writeSlot(api, this.macroRestore.slot, this.macroRestore.snapshot);
      } catch {
        // ignore
      }
      this.macroRestore = undefined;
    }
  }

  private tickPotion(api: CheatApi, context: AutoContext, now: number, onField: boolean) {
    const vitals = readVitals(api);
    if (vitals.hpMax <= 0 || vitals.hpMax > 100_000 || vitals.hp <= 0) return;

    // A new/lower level means another character: forget what we learned about SP.
    const level = getLevel(api);
    if (level < this.level) this.spPeak = 0;
    this.level = level;
    if (vitals.sp < 1_000_000 && vitals.sp > this.spPeak) this.spPeak = vitals.sp;

    if (onField) {
      this.drink(context, now, this.hp, vitals.hp, vitals.hpMax, this.config.hpPercent, this.config.hpKey);
      if (this.spPeak > 0) this.drink(context, now, this.sp, vitals.sp, this.spPeak, this.config.spPercent, this.config.spKey);
    }

    if (this.config.infinitePotions && now - this.lastTopUp > 2000) {
      this.lastTopUp = now;
      topUpSlotItems(api, [SLOT_ORDER.indexOf(this.config.hpKey), SLOT_ORDER.indexOf(this.config.spKey)]);
    }
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

  /** Presses the checked slots (and auto macros' skills) in turn; the game itself ignores a skill still cooling down. */
  private tickSkill(api: CheatApi, context: AutoContext, now: number) {
    if (now - this.lastSkillAt < this.config.skillGap || this.macroQueue.length > 0) return;
    const keys = skillSlotKeys(this.config).filter(key => this.config.skillSlots.includes(key) && key !== this.config.macroSlot);
    const macroSkills = this.config.macros.filter(macro => macro.auto).flatMap(macro => macro.skills);
    const total = keys.length + macroSkills.length;
    if (total === 0) return;
    const position = this.roundRobin % total;
    this.roundRobin = (this.roundRobin + 1) % total;
    this.lastSkillAt = now;
    if (position < keys.length) {
      context.pressKey(keys[position], SKILL_HOLD_MS);
      return;
    }
    try {
      this.fireSkill(api, context, macroSkills[position - keys.length]);
    } catch {
      // game not ready
    }
  }
}

export const automation = new Automation();
