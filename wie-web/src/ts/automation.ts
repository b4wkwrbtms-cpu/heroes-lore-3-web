import type { CheatApi } from "./backend";
import {
  HL3, SLOT_ORDER, type SkillState, type SlotSnapshot, getLevel, isOnField, readSkills, readSlot, readVitals, registerSkill, sanitizeInventory,
  topUpSlotItems, writeSlot,
} from "./hl3";
import { HL3_SKILLS } from "./hl3_skills";

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
  skillGap: 400,
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
const SKILL_HOLD_MS = 140;
/** Auto-skill keeps firing this long after the last attack press of a combo. */
const ATTACK_GRACE_MS = 1500;
/** How long after a replaced press we wait for SP to drop before calling the skill dropped, and how often to retry it. */
const SKILL_CONFIRM_MS = 350;
const SKILL_MAX_RETRIES = 2;
/** Attack presses needed within ATTACK_BURST_MS to count as fighting; single taps talk to NPCs and confirm dialogs. */
const ATTACK_BURST_COUNT = 3;
const SANITIZE_INTERVAL_MS = 1000;
const ATTACK_BURST_MS = 1500;
const MAX_BACKOFF_MS = 12_000;

type Listener = (config: AutoConfig) => void;

/** True while one of the app's own panels (settings, cheats, keypad sheet) covers the game. */
const appPanelOpen = (): boolean => typeof document !== "undefined" && document.querySelector("dialog[open]") !== null;

class Automation {
  private context: AutoContext | undefined;
  private config: AutoConfig = defaultAutoConfig();
  private timer: number | undefined;
  private listeners = new Set<Listener>();

  private attackHeld = false;
  private attackPresses: number[] = [];
  private attackUntil = 0;
  /** Last replaced attack press, until SP shows the skill went out. */
  private pendingSkill: { key: string; spBefore: number; at: number; retries: number } | undefined;
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
    this.attackHeld = pressed;
  }

  /**
   * Called for every attack press from the player's thumb. While the player is mashing attack
   * (ATTACK_BURST_COUNT presses within ATTACK_BURST_MS) every `skillGap` one of those presses is
   * turned into a skill key instead: the game accepts input at exactly those moments, whereas extra
   * key presses in the middle of a combo tend to be dropped. Returns the key to press instead of attack.
   */
  interceptAttack(): string | undefined {
    const context = this.context;
    if (!context || !this.config.skillOn) return undefined;
    const api = context.getCheats();
    if (!api) return undefined;
    const now = performance.now();
    let onField = false;
    try {
      onField = !appPanelOpen() && isOnField(api);
    } catch {
      onField = false;
    }
    if (!onField) {
      this.attackPresses = [];
      this.attackUntil = 0;
      this.pendingSkill = undefined;
      return undefined;
    }
    this.attackPresses = this.attackPresses.filter(time => now - time <= ATTACK_BURST_MS);
    this.attackPresses.push(now);
    if (this.attackPresses.length >= ATTACK_BURST_COUNT || now < this.attackUntil) this.attackUntil = now + ATTACK_GRACE_MS;
    if (!this.attacking(now)) return undefined;
    if (this.macroQueue.length > 0) return undefined;

    let sp = 0;
    try {
      sp = readVitals(api).sp;
    } catch {
      return undefined;
    }

    // Did the previous replacement actually fire? Casting costs SP; if it did not go out (the game was
    // still in a combo animation) repeat the same key instead of moving on.
    const pending = this.pendingSkill;
    if (pending) {
      if (sp < pending.spBefore) this.pendingSkill = undefined;
      else if (now - pending.at < SKILL_CONFIRM_MS) return undefined;
      else if (pending.retries < SKILL_MAX_RETRIES) {
        pending.retries += 1;
        pending.at = now;
        pending.spBefore = sp;
        this.lastSkillAt = now;
        return pending.key;
      } else this.pendingSkill = undefined;
    }
    if (now - this.lastSkillAt < this.config.skillGap) return undefined;

    const candidates: Array<{ key: string; ref?: SkillRef; cost: number }> = [];
    for (const key of skillSlotKeys(this.config)) {
      if (!this.config.skillSlots.includes(key) || key === this.config.macroSlot) continue;
      candidates.push({ key, cost: this.slotSkillCost(api, SLOT_ORDER.indexOf(key)) });
    }
    for (const macro of this.config.macros) {
      if (!macro.auto) continue;
      for (const ref of macro.skills) candidates.push({ key: this.config.macroSlot, ref, cost: this.skillCost(ref) });
    }
    if (candidates.length === 0) return undefined;
    // Round-robin, skipping skills the player cannot afford right now.
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const position = (this.roundRobin + offset) % candidates.length;
      const candidate = candidates[position];
      if (candidate.cost * 10 > sp) continue;
      if (candidate.ref) {
        try {
          if (!this.prepareMacroSkill(api, candidate.ref)) continue;
        } catch {
          continue;
        }
      }
      this.roundRobin = (position + 1) % candidates.length;
      this.lastSkillAt = now;
      // A free skill cannot be confirmed through SP; fire it once and move on.
      this.pendingSkill = candidate.cost > 0 ? { key: candidate.key, spBefore: sp, at: now, retries: 0 } : undefined;
      return candidate.key;
    }
    return undefined;
  }

  /** SP cost (display units) of the skill registered in a quick slot, 0 when unknown. */
  private slotSkillCost(api: CheatApi, slot: number): number {
    try {
      const snapshot = readSlot(api, slot);
      if (snapshot.kind !== 1) return 0;
      return this.skillCost({ weapon: snapshot.skillX & 0x40 ? "B" : "A", index: snapshot.idx });
    } catch {
      return 0;
    }
  }

  private skillCost(ref: SkillRef): number {
    const api = this.context?.getCheats();
    if (!api) return 0;
    try {
      const category = api.read(ref.weapon === "A" ? HL3.WEAPON_A : HL3.WEAPON_B, 1, false);
      const record = HL3_SKILLS[category]?.skills[ref.index === 0 ? 0 : ref.index + 6];
      return record?.sp ?? 0;
    } catch {
      return 0;
    }
  }

  /** True while the player is mashing attack (or shortly after the last press). */
  private attacking(now: number): boolean {
    return now < this.attackUntil;
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
    this.attackPresses = [];
    this.attackUntil = 0;
    this.pendingSkill = undefined;
  }

  private lastSanitize = -Infinity;

  private tick() {
    const context = this.context;
    if (!context) return;
    const api = context.getCheats();
    if (!api) return;
    const now = performance.now();
    // Records pointing at items the game has no data for crash it; clear them once a save has finished loading.
    if (now - this.lastSanitize >= SANITIZE_INTERVAL_MS) {
      this.lastSanitize = now;
      try {
        const mode = api.read(HL3.MODE, 4, false) >>> 0;
        if (mode === 4 || mode === 5) {
          const cleared = sanitizeInventory(api);
          if (cleared > 0) console.warn(`[hl3] cleared ${cleared} broken inventory record(s)`);
        }
      } catch {
        // game state not loaded yet
      }
    }
    // In menus the quick-slot keys page through screens (◀1 STATUS 3▶, 7/9 tabs), so never press them there.
    let onField = false;
    try {
      onField = !appPanelOpen() && isOnField(api);
    } catch {
      onField = false;
    }
    if (!onField) {
      this.macroQueue = [];
      this.attackHeld = false;
      this.attackPresses = [];
      this.attackUntil = 0;
      this.pendingSkill = undefined;
    }
    if (this.config.potionOn) {
      try {
        this.tickPotion(api, context, now, onField);
      } catch {
        // player not in game yet
      }
    }
    this.tickMacro(api, context, now);
  }

  private borrowedSlot(): number {
    return SLOT_ORDER.indexOf(this.config.macroSlot);
  }

  /** Register a macro skill into the borrowed slot (remembering what was there) so pressing that key fires it. */
  private prepareMacroSkill(api: CheatApi, ref: SkillRef): boolean {
    const skill = readSkills(api).find(candidate => candidate.weapon === ref.weapon && candidate.index === ref.index);
    if (!skill || skill.level <= 0) return false;
    const slot = this.borrowedSlot();
    if (!this.macroRestore) this.macroRestore = { slot, snapshot: readSlot(api, slot) };
    registerSkill(api, slot, skill);
    return true;
  }

  private fireSkill(api: CheatApi, context: AutoContext, ref: SkillRef): boolean {
    if (!this.prepareMacroSkill(api, ref)) return false;
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
}

export const automation = new Automation();
