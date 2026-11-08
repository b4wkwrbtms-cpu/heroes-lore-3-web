import { X, createIcons } from "lucide";

import { type AutoConfig, MACRO_NAMES, SLOT_KEYS, type SkillRef, type SlotKey, automation, loadAutoConfig, macroCandidates, skillSlotKeys, storeAutoConfig } from "./automation";
import type { CheatApi } from "./backend";
import {
  CASH_ITEMS, HL3, HL3_SKILL_LABELS, ORBS, QUICK_ITEMS, SLOT_ORDER, autoHealTick, displayName, freezeBattleStats, freezeGold, getGold, getLevel,
  getSkillPoints, getStatPoints, giveItem, gradeLabel, isHeroesLore3, prepareAutoPotions, readBag, removeDuplicateEquipment, unequipAll, readEquipment, readSkills, readVitals,
  setAllSkillLevels, setGold, setItemStat, setLevel, setOrb, setSkillPoints, setStatPoints,
} from "./hl3";
import { HL3_ITEMS } from "./hl3_items";

export interface CheatContext {
  appId: string;
  appTitle: string;
  getCheats(): CheatApi | undefined;
}

interface SavedCheat {
  name: string;
  address: number;
  width: number;
  bigEndian: boolean;
  value: number;
  freeze: boolean;
}

export interface CheatPanel {
  open(context: CheatContext): void;
  /** Re-apply saved "freeze" cheats for the app; call once the session is ready. */
  restore(context: CheatContext): void;
}

interface Target {
  key: "gold" | "cash" | "custom";
  label: string;
  particle: string; // 이/가
  defaultValue: number;
  hint: string;
}

/** Bag record index → "N번 가방 M번째 칸" as the game shows it (16 slots per bag). */
const bagPlace = (slot: number): string => `${Math.floor(slot / 16) + 1}번 가방 ${(slot % 16) + 1}번째 칸`;

const TARGETS: Target[] = [
  { key: "gold", label: "소지금(돈)", particle: "이", defaultValue: 10000000, hint: "상태창·상점에서 보이는 골드 숫자" },
  { key: "cash", label: "캐시", particle: "가", defaultValue: 10000000, hint: "캐시 상점에서 보이는 캐시 숫자" },
  { key: "custom", label: "값", particle: "이", defaultValue: 10000000, hint: "HP, 아이템 개수 등 화면에 보이는 숫자" },
];

type Step =
  | { kind: "home" }
  | { kind: "enter"; target: Target; round: number; candidates: Uint32Array; width: number; bigEndian: boolean }
  | {
      kind: "apply";
      target: Target;
      candidates: number[];
      index: number;
      width: number;
      bigEndian: boolean;
      value: number;
      freeze: boolean;
      awaiting: boolean;
      previousValue?: number;
    }
  | { kind: "done"; target: Target; name: string };

const storageKey = (appId: string) => `wie_cheats_${appId}`;
const BATTLE_KEY = "전투 능력치 최대 고정";
const AUTO_HEAL_KEY = "자동 회복";

let autoHealTimer: number | undefined;
let autoHealContextId: string | undefined;

const stopAutoHeal = () => {
  if (autoHealTimer !== undefined) window.clearInterval(autoHealTimer);
  autoHealTimer = undefined;
  autoHealContextId = undefined;
};

const startAutoHeal = (context: CheatContext) => {
  stopAutoHeal();
  autoHealContextId = context.appId;
  const state = { spPeak: 0 };
  autoHealTimer = window.setInterval(() => {
    const api = context.getCheats();
    if (!api) {
      stopAutoHeal();
      return;
    }
    try {
      autoHealTick(api, state);
    } catch {
      // game not in a playable state yet
    }
  }, 150);
};

const loadSaved = (appId: string): SavedCheat[] => {
  try {
    const raw = window.localStorage.getItem(storageKey(appId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SavedCheat =>
        typeof item === "object" && item !== null
        && typeof (item as SavedCheat).address === "number"
        && typeof (item as SavedCheat).value === "number")
      .map(item => ({
        name: String(item.name ?? ""),
        address: item.address >>> 0,
        width: item.width === 2 ? 2 : 4,
        bigEndian: Boolean(item.bigEndian),
        value: item.value >>> 0,
        freeze: Boolean(item.freeze),
      }));
  } catch {
    return [];
  }
};

const storeSaved = (appId: string, cheats: SavedCheat[]) => {
  try {
    window.localStorage.setItem(storageKey(appId), JSON.stringify(cheats));
  } catch {
    // storage unavailable; cheats will only last for this session
  }
};

const formatNumber = (value: number) => value.toLocaleString("ko-KR");
const parseNumber = (text: string): number | undefined => {
  const digits = text.replace(/[^0-9]/g, "");
  if (digits === "") return undefined;
  const value = Number(digits);
  if (!Number.isFinite(value) || value > 0xffffffff) return undefined;
  return value;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const button = (label: string, className: string, onClick: () => void): HTMLButtonElement => {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
};

const readStore = (dbName: string, storeName: string): Promise<Array<{ key: unknown; data: string; size: number }>> =>
  new Promise(resolve => {
    const entries: Array<{ key: unknown; data: string; size: number }> = [];
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(dbName);
    } catch {
      resolve(entries);
      return;
    }
    request.onupgradeneeded = () => {
      // The database did not exist; abort so we don't create an empty one.
      request.transaction?.abort();
    };
    request.onerror = () => resolve(entries);
    request.onblocked = () => resolve(entries);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve(entries);
        return;
      }
      const cursorRequest = db.transaction(storeName, "readonly").objectStore(storeName).openCursor();
      cursorRequest.onerror = () => {
        db.close();
        resolve(entries);
      };
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          db.close();
          resolve(entries);
          return;
        }
        const value = cursor.value;
        const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : undefined;
        entries.push({
          key: cursor.key,
          data: bytes ? toBase64(bytes) : JSON.stringify(value),
          size: bytes ? bytes.length : -1,
        });
        cursor.continue();
      };
    };
  });

const yieldToUi = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));

/** Collect memory + save data so the layout can be analysed offline. Returns the file to share. */
const buildDiagnostics = async (live: CheatApi, context: CheatContext, saved: SavedCheat[], note: string, onProgress: (text: string) => void): Promise<File> => {
  onProgress("메모리 읽는 중…");
  await yieldToUi();
  const ranges = live.memoryRanges();
  const regions: Array<{ address: number; size: number; data: string }> = [];
  const HEAP_BASE = 0x40000000;
  const HEAP_HALF = 0x08000000;
  const HEAP_TAKE = 8 * 1024 * 1024;
  const CHUNK = 1024 * 1024;
  const take = async (address: number, size: number) => {
    for (let offset = 0; offset < size; offset += CHUNK) {
      const len = Math.min(CHUNK, size - offset);
      const bytes = live.dump(address + offset, len);
      if (bytes.length === 0) break;
      regions.push({ address: address + offset, size: bytes.length, data: toBase64(bytes) });
      onProgress(`메모리 읽는 중… ${regions.length}MB`);
      await yieldToUi();
    }
  };
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    const start = ranges[i];
    const size = ranges[i + 1];
    if (start >= HEAP_BASE && start < HEAP_BASE + 2 * HEAP_HALF) {
      // Heap: first 8 MiB of each allocator half.
      await take(HEAP_BASE, Math.min(HEAP_TAKE, size));
      if (size > HEAP_HALF) await take(HEAP_BASE + HEAP_HALF, Math.min(HEAP_TAKE, size - HEAP_HALF));
    } else if (size <= 4 * 1024 * 1024) {
      await take(start, size);
    }
  }
  // Extra context around every saved cheat address.
  for (const cheat of saved) {
    const start = Math.max(0, cheat.address - 0x8000) >>> 0;
    await take(start, 0x10000);
  }

  onProgress("세이브 파일 읽는 중…");
  const files = await readStore("wie_filesystem", "files");
  const dbName = `wie_${context.appId}`;
  const records = await readStore(dbName, dbName);

  onProgress("파일 압축 중…");
  await yieldToUi();
  const payload = {
    format: "wie-cheat-diagnostics/1",
    exportedAt: new Date().toISOString(),
    app: { id: context.appId, title: context.appTitle },
    note,
    savedCheats: saved,
    memoryRanges: Array.from(ranges),
    regions,
    files,
    records,
  };
  const json = JSON.stringify(payload);
  let blob = new Blob([json], { type: "application/json" });
  let filename = `hl3-diagnostics-${Date.now()}.json`;
  if (typeof CompressionStream === "function") {
    const compressed = blob.stream().pipeThrough(new CompressionStream("gzip"));
    blob = await new Response(compressed).blob();
    filename += ".gz";
  }
  return new File([blob], filename, { type: "application/octet-stream" });
};

/** Must be called directly from a tap: the share sheet needs a fresh user gesture. */
const shareDiagnostics = (file: File): Promise<string> => {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  const fallback = () => {
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return `파일로 저장했어요 (${Math.round(file.size / 1024)}KB). 파일 앱 → 다운로드에서 찾아 보내 주세요.`;
  };
  if (typeof navigator.share === "function" && (!nav.canShare || nav.canShare({ files: [file] }))) {
    return navigator.share({ files: [file], title: "영웅서기3 진단 파일" })
      .then(() => `보냈어요 (${Math.round(file.size / 1024)}KB).`)
      .catch((error: Error) => (error.name === "AbortError" ? "공유를 취소했어요." : fallback()));
  }
  return Promise.resolve(fallback());
};

let panel: CheatPanel | undefined;

export const getCheatPanel = (): CheatPanel => {
  if (panel) return panel;

  const dialog = document.getElementById("cheat-dialog") as HTMLDialogElement;
  const title = document.getElementById("cheat-title") as HTMLElement;
  const body = document.getElementById("cheat-body") as HTMLElement;
  createIcons({ icons: { X }, root: dialog });

  // Enter inside a text field must not submit the form (which would close the dialog).
  dialog.addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
      event.preventDefault();
      const next = body.querySelector<HTMLButtonElement>("button[data-default]");
      next?.click();
    }
  });

  let context: CheatContext | undefined;
  let saved: SavedCheat[] = [];
  let step: Step = { kind: "home" };
  let statusText = "";
  let statusError = false;
  let exporting = false;
  let diagnosticsFile: File | undefined;

  const setStatus = (text: string, error = false) => {
    statusText = text;
    statusError = error;
    render();
  };

  const api = () => context?.getCheats();

  const persist = () => {
    if (context) storeSaved(context.appId, saved);
  };

  const render = () => {
    body.replaceChildren();
    const live = api();
    if (!live) {
      title.textContent = "치트";
      body.append(el("p", "cheat-lead", "게임이 실행 중일 때만 사용할 수 있어요."));
      return;
    }

    switch (step.kind) {
      case "home":
        renderHome(live);
        break;
      case "enter":
        renderEnter(step, live);
        break;
      case "apply":
        renderApply(step, live);
        break;
      case "done":
        renderDone(step);
        break;
    }

    if (statusText) {
      const status = el("p", `cheat-status${statusError ? " error" : ""}`, statusText);
      body.append(status);
    }
  };

  let hl3Category = 18;
  let hl3Index = 7;
  let hl3Count = 99;
  let hl3ShowBag = false;

  const renderHl3 = (live: CheatApi) => {
    body.append(el("p", "cheat-lead", "⚔️ 영웅서기3 전용 치트"));
    body.append(el("p", "cheat-muted", "게임 메모리 구조를 분석해서 만든 전용 기능이에요. 캐릭터로 필드에 나온 상태에서 쓰세요."));

    // 소지금
    let goldText = "";
    try {
      goldText = ` (지금 ${formatNumber(getGold(live))})`;
    } catch {
      goldText = "";
    }
    const goldRow = el("div", "cheat-item-actions");
    goldRow.append(
      button(`💰 소지금 1천만${goldText}`, "primary-command", () => {
        try {
          setGold(live, 10_000_000);
          setStatus("소지금을 10,000,000으로 바꿨어요. 메뉴를 열면 바로 보여요.");
        } catch (error) {
          setStatus(String(error), true);
        }
      }),
      button("무제한(항상 1천만 유지)", "secondary-command", () => {
        try {
          freezeGold(live, 10_000_000);
          saved = saved.filter(cheat => cheat.address !== HL3.GOLD);
          saved.push({ name: "소지금", address: HL3.GOLD, width: 4, bigEndian: false, value: 10_000_000, freeze: true });
          persist();
          setStatus("소지금을 항상 1천만으로 유지해요. 게임을 다시 켜도 자동 적용됩니다.");
        } catch (error) {
          setStatus(String(error), true);
        }
      }),
    );
    body.append(goldRow);

    // 빠른 지급
    body.append(el("p", "cheat-lead", "🎒 아이템 바로 넣기 (99개)"));
    const quick = el("div", "cheat-item-actions");
    for (const [category, index, label] of QUICK_ITEMS) {
      quick.append(button(label, "secondary-command", () => {
        try {
          const result = giveItem(live, category, index, 99);
          setStatus(`${label} ${formatNumber(result.count)}개 — ${bagPlace(result.slot)}${result.stacked ? "에 합쳤어요" : "에 넣었어요"}. 가방을 열어 확인하세요.`);
        } catch (error) {
          setStatus(String(error), true);
        }
      }));
    }
    body.append(quick);

    // 캐시 아이템
    body.append(el("p", "cheat-lead", "💎 캐시 아이템 넣기 (캐시 상점 전용이던 것들)"));
    body.append(el("p", "cheat-muted", "원래는 네트워크 결제로만 살 수 있던 아이템이에요. 가방에 바로 넣어 드려요 (싱글 플레이에서 안 먹히는 것도 있을 수 있어요)."));
    const cash = el("div", "cheat-item-actions");
    for (const [category, index, label, description] of CASH_ITEMS) {
      const cashButton = button(label, "secondary-command", () => {
        try {
          const result = giveItem(live, category, index, 10);
          setStatus(`${label} ${formatNumber(result.count)}개 — ${bagPlace(result.slot)}. ${description}.`);
        } catch (error) {
          setStatus(String(error), true);
        }
      });
      cashButton.title = description;
      cash.append(cashButton);
    }
    body.append(cash);

    // 아이템 선택 지급
    body.append(el("p", "cheat-lead", "🗡️ 아이템 골라서 넣기 (무기·방어구·장신구·오브·재료 전부)"));
    const pickRow = el("div", "cheat-row");
    const categorySelect = el("select") as HTMLSelectElement;
    for (const key of Object.keys(HL3_ITEMS).map(Number).sort((a, b) => a - b)) {
      const option = el("option", undefined, HL3_ITEMS[key].label);
      option.value = String(key);
      categorySelect.append(option);
    }
    categorySelect.value = String(hl3Category);
    const itemSelect = el("select") as HTMLSelectElement;
    const fillItems = () => {
      itemSelect.replaceChildren();
      const table = HL3_ITEMS[hl3Category];
      for (const item of table.items) {
        if (item.n.includes("아래부터")) continue;
        const extra = item.s !== undefined && item.s > 0 ? ` · ${table.kind === "equip" ? (hl3Category <= 3 || hl3Category === 11 ? "방" : "공") + item.s : ""}` : "";
        const level = item.l !== undefined && item.l > 0 && item.l < 200 ? ` · Lv${item.l}` : "";
        const grade = gradeLabel(item.n);
        const option = el("option", undefined, `${displayName(item.n)}${grade ? ` [${grade}]` : ""}${level}${extra}`);
        option.value = String(item.i);
        itemSelect.append(option);
      }
      if (!table.items[hl3Index]) hl3Index = 0;
      itemSelect.value = String(hl3Index);
    };
    fillItems();
    categorySelect.addEventListener("change", () => {
      hl3Category = Number(categorySelect.value);
      hl3Index = 0;
      fillItems();
    });
    itemSelect.addEventListener("change", () => {
      hl3Index = Number(itemSelect.value);
    });
    pickRow.append(categorySelect);
    body.append(pickRow);
    const pickRow2 = el("div", "cheat-row");
    pickRow2.append(itemSelect);
    body.append(pickRow2);
    const countRow = el("div", "cheat-row");
    const countInput = el("input") as HTMLInputElement;
    countInput.type = "text";
    countInput.inputMode = "numeric";
    countInput.value = String(hl3Count);
    countInput.addEventListener("change", () => {
      hl3Count = parseNumber(countInput.value) ?? 1;
    });
    countRow.append(el("span", undefined, "개수"), countInput, button("넣기", "primary-command", () => {
      const count = parseNumber(countInput.value) ?? 1;
      hl3Count = count;
      try {
        const table = HL3_ITEMS[hl3Category];
        const item = table.items[hl3Index];
        const result = giveItem(live, hl3Category, hl3Index, count);
        setStatus(`${item.n} ${formatNumber(result.count)}개 — ${bagPlace(result.slot)}${result.stacked ? "에 합쳤어요" : "에 넣었어요"}.${table.kind === "equip" ? " 장비는 한 번에 1개씩만 넣어요. 가방에서 선택해 장착하세요 (요구 레벨 미달이면 장착 불가)." : ""}`);
      } catch (error) {
        setStatus(String(error), true);
      }
    }));
    body.append(countRow);

    // 캐릭터
    body.append(el("p", "cheat-lead", "⬆️ 캐릭터"));
    let levelText = "";
    try {
      levelText = ` (지금 Lv${getLevel(live)})`;
    } catch {
      levelText = "";
    }
    const battleOn = saved.some(cheat => cheat.name === BATTLE_KEY);
    const charRow = el("div", "cheat-item-actions");
    charRow.append(
      button(`레벨 70 (게임 최대)${levelText}`, "secondary-command", () => {
        try {
          setLevel(live, 70);
          setStatus("레벨을 70(게임 최대치)으로 바꿨어요. 높은 레벨 장비를 바로 장착할 수 있어요. 포인트는 아래 '포인트 주기'로 따로 받으세요.");
        } catch (error) {
          setStatus(String(error), true);
        }
      }),
      button(battleOn ? "전투 능력치 최대 고정 끄기" : "전투 능력치 최대 고정 (공·방 9999)", battleOn ? "primary-command" : "secondary-command", () => {
        try {
          freezeBattleStats(live, !battleOn);
          saved = saved.filter(cheat => cheat.name !== BATTLE_KEY);
          if (!battleOn) saved.push({ name: BATTLE_KEY, address: HL3.FINAL, width: 2, bigEndian: false, value: 9999, freeze: true });
          persist();
          setStatus(!battleOn ? "ATT/DEF 9999, 명중·회피·기절·저항 255로 고정했어요. 게임을 켤 때마다 자동 적용." : "능력치 고정을 껐어요.");
        } catch (error) {
          setStatus(String(error), true);
        }
      }),
    );
    body.append(charRow);

    // 스탯·스킬 포인트
    let pointsText = "";
    try {
      pointsText = `지금 스탯 포인트 ${formatNumber(getStatPoints(live))} · 스킬 포인트 ${formatNumber(getSkillPoints(live))}`;
    } catch {
      pointsText = "";
    }
    body.append(el("p", "cheat-lead", "🎯 포인트 주기"));
    body.append(el("p", "cheat-muted", `스탯은 상태창에서, 스킬은 스킬창(포인트투자)에서 직접 찍어요. 게임이 주는 상한은 스탯 276 · 스킬 44인데 더 줘도 돼요.${pointsText ? ` ${pointsText}` : ""}`));
    const pointsRow = el("div", "cheat-item-actions");
    pointsRow.append(
      button("스탯 포인트 276", "secondary-command", () => {
        try {
          setStatPoints(live, 276);
          setStatus("스탯 포인트를 276으로 맞췄어요. 메뉴 → STATUS에서 힘·체력·정신·민첩에 찍으세요.");
        } catch (error) {
          setStatus(String(error), true);
        }
      }),
      button("스탯 포인트 999", "secondary-command", () => {
        try {
          setStatPoints(live, 999);
          setStatus("스탯 포인트를 999로 맞췄어요. 상태창에서 찍으세요 (100 넘는 스탯은 2포인트씩 들어요).");
        } catch (error) {
          setStatus(String(error), true);
        }
      }),
      button("스킬 포인트 99", "secondary-command", () => {
        try {
          setSkillPoints(live, 99);
          setStatus("스킬 포인트를 99로 맞췄어요. 메뉴 → SKILL → 스킬 선택 → 포인트투자로 찍으세요 (스킬당 최대 5).");
        } catch (error) {
          setStatus(String(error), true);
        }
      }),
      button("모든 스킬 Lv5", "secondary-command", () => {
        try {
          setAllSkillLevels(live, 5);
          const names = readSkills(live).filter(skill => skill.index > 0).map(skill => skill.name).join(", ");
          setStatus(`주무기·보조무기 스킬을 전부 Lv5로 올렸어요: ${names}. 스킬창을 열어 확인하고 단축키에 등록하세요.`);
        } catch (error) {
          setStatus(String(error), true);
        }
      }),
    );
    body.append(pointsRow);

    // 자동화 (자동 물약 · 자동 스킬 · 치트 회복)
    body.append(el("p", "cheat-lead", "🤖 자동화"));
    const auto = context && automation.appId === context.appId ? automation.current : loadAutoConfig(context?.appId ?? "");
    const saveAuto = (next: AutoConfig) => {
      if (context && automation.appId === context.appId) automation.update(next);
      else if (context) storeAutoConfig(context.appId, next);
      render();
    };
    let vitalsText = "";
    try {
      const vitals = readVitals(live);
      if (vitals.hpMax > 0) vitalsText = `지금 HP ${formatNumber(vitals.hp)}/${formatNumber(vitals.hpMax)} · SP ${formatNumber(Math.floor(vitals.sp / 10))}`;
    } catch {
      vitalsText = "";
    }

    // 자동 물약
    const potionRow = el("div", "cheat-item-actions");
    potionRow.append(button(auto.potionOn ? "🧪 자동 물약 끄기" : "🧪 자동 물약 켜기", auto.potionOn ? "primary-command" : "secondary-command", () => {
      saveAuto({ ...auto, potionOn: !auto.potionOn });
      setStatus(!auto.potionOn
        ? `HP ${auto.hpPercent}% 아래면 ${auto.hpKey}번, SP ${auto.spPercent}% 아래면 ${auto.spKey}번 칸을 자동으로 눌러요. 게임에서 그 칸에 물약을 등록해 두세요.`
        : "자동 물약을 껐어요.");
    }));
    body.append(potionRow);
    body.append(el("p", "cheat-muted", `게임 단축키 칸에 등록한 물약을 대신 눌러 주는 방식이에요 (물약은 실제로 줄어요).${vitalsText ? ` ${vitalsText}` : ""}`));
    const slotSelect = (value: SlotKey, onChange: (key: SlotKey) => void): HTMLSelectElement => {
      const select = el("select") as HTMLSelectElement;
      for (const key of SLOT_KEYS) {
        const option = el("option", undefined, `${key}번 칸`);
        option.value = key;
        select.append(option);
      }
      select.value = value;
      select.addEventListener("change", () => {
        const key = select.value;
        if (key === "1" || key === "3" || key === "9" || key === "0" || key === "#") onChange(key);
      });
      return select;
    };
    const percentInput = (value: number, onChange: (percent: number) => void): HTMLInputElement => {
      const input = el("input", "cheat-short") as HTMLInputElement;
      input.type = "text";
      input.inputMode = "numeric";
      input.value = String(value);
      input.addEventListener("change", () => {
        const percent = parseNumber(input.value);
        if (percent === undefined || percent < 5 || percent > 95) {
          setStatus("5~95 사이 숫자로 입력해 주세요.", true);
          return;
        }
        onChange(percent);
      });
      return input;
    };
    const hpRow = el("div", "cheat-row");
    hpRow.append(el("span", undefined, "HP 물약"), slotSelect(auto.hpKey, key => saveAuto({ ...auto, hpKey: key })), percentInput(auto.hpPercent, percent => saveAuto({ ...auto, hpPercent: percent })), el("span", undefined, "% 아래면"));
    body.append(hpRow);
    const spRow = el("div", "cheat-row");
    spRow.append(el("span", undefined, "SP 물약"), slotSelect(auto.spKey, key => saveAuto({ ...auto, spKey: key })), percentInput(auto.spPercent, percent => saveAuto({ ...auto, spPercent: percent })), el("span", undefined, "% 아래면"));
    body.append(spRow);
    const prepRow = el("div", "cheat-item-actions");
    prepRow.append(button(`🧴 물약 준비 (${auto.hpKey}번 엘릭서 · ${auto.spKey}번 요정수 99개 등록)`, "secondary-command", () => {
      try {
        const names = prepareAutoPotions(live, SLOT_ORDER.indexOf(auto.hpKey), SLOT_ORDER.indexOf(auto.spKey));
        setStatus(`${auto.hpKey}번 칸에 ${names.hp}, ${auto.spKey}번 칸에 ${names.sp}를 99개씩 넣고 등록했어요. 화면 아래 단축키 칸에 아이콘이 떠요.`);
      } catch (error) {
        setStatus(String(error), true);
      }
    }));
    body.append(prepRow);
    const infiniteCheck = el("label", "cheat-check");
    const infiniteBox = el("input") as HTMLInputElement;
    infiniteBox.type = "checkbox";
    infiniteBox.checked = auto.infinitePotions;
    infiniteBox.addEventListener("change", () => saveAuto({ ...auto, infinitePotions: infiniteBox.checked }));
    infiniteCheck.append(infiniteBox, el("span", undefined, "등록한 물약 안 줄어들게 (개수 99 유지)"));
    body.append(infiniteCheck);
    const buffCheck = el("label", "cheat-check");
    const buffBox = el("input") as HTMLInputElement;
    buffBox.type = "checkbox";
    buffBox.checked = auto.keepBuffs;
    buffBox.addEventListener("change", () => saveAuto({ ...auto, keepBuffs: buffBox.checked }));
    buffCheck.append(buffBox, el("span", undefined, "✨ 버프 계속 유지 (한 번 쓰면 안 꺼져요 · 게임 규칙상 버프는 하나만, 다른 버프를 쓰면 바뀌어요)"));
    body.append(buffCheck);

    // 자동 스킬
    const skillRow = el("div", "cheat-item-actions");
    skillRow.append(button(auto.skillOn ? "✨ 자동 스킬 끄기" : "✨ 자동 스킬 켜기", auto.skillOn ? "primary-command" : "secondary-command", () => {
      saveAuto({ ...auto, skillOn: !auto.skillOn });
      setStatus(!auto.skillOn
        ? "공격을 3번 이상 연타하면, 그다음 공격 입력 중 일부가 체크한 칸의 스킬 키로 바뀌어 나가요(눌린 칸이 노랗게 반짝여요). 연타를 멈추면 1.5초 뒤 꺼져요."
        : "자동 스킬을 껐어요.");
    }));
    body.append(skillRow);
    body.append(el("p", "cheat-muted", "게임에서 스킬을 등록해 둔 칸을 체크하세요. 공격 3연타부터 켜지고, 연타하는 공격 입력 중 0.4초마다 하나가 스킬 키로 바뀌어 나가요(콤보 중간에 끼워 넣으면 게임이 무시해서 이 방식이에요). 메뉴에선 멈추고, 쿨타임 중인 스킬은 게임이 넘겨요."));
    const slotRow = el("div", "cheat-row cheat-wrap");
    for (const key of skillSlotKeys(auto)) {
      const check = el("label", "cheat-check");
      const box = el("input") as HTMLInputElement;
      box.type = "checkbox";
      box.checked = auto.skillSlots.includes(key);
      box.addEventListener("change", () => saveAuto({ ...auto, skillSlots: SLOT_KEYS.filter(slot => (slot === key ? box.checked : auto.skillSlots.includes(slot))) }));
      check.append(box, el("span", undefined, `${key}번`));
      slotRow.append(check);
    }
    body.append(slotRow);

    // 스킬 묶음
    body.append(el("p", "cheat-lead", "🧩 스킬 묶음 (패드에 버튼 추가)"));
    body.append(el("p", "cheat-muted", "게임 단축키는 5개뿐이라, 묶음 버튼에 스킬을 여러 개 넣어 두면 누를 때 차례로 다 나가요. 배운 스킬(Lv1 이상)만 돼요 — 위 '모든 스킬 Lv5'를 먼저 누르면 전부 쓸 수 있어요."));
    let skillList: ReturnType<typeof readSkills> = [];
    try {
      skillList = macroCandidates(readSkills(live));
    } catch {
      skillList = [];
    }
    const macroSlotRow = el("div", "cheat-row");
    macroSlotRow.append(el("span", undefined, "묶음이 빌려 쓰는 칸"), slotSelect(auto.macroSlot, key => saveAuto({ ...auto, macroSlot: key })), el("span", undefined, "(끝나면 원래대로 돌려놔요)"));
    body.append(macroSlotRow);
    if (auto.potionOn && (auto.macroSlot === auto.hpKey || auto.macroSlot === auto.spKey)) {
      body.append(el("p", "cheat-status error", "물약 키와 같은 칸이에요. 묶음이 빌려 쓰는 칸을 다른 키로 바꿔 주세요."));
    }
    auto.macros.forEach((macro, i) => {
      const item = el("div", "cheat-item");
      const head = el("div", "cheat-item-info");
      head.append(el("strong", undefined, `묶음 ${MACRO_NAMES[i]}`), el("span", undefined, macro.skills.length ? `${macro.skills.length}개 등록됨` : "비어 있음 (패드에 안 보여요)"));
      item.append(head);
      const row = el("div", "cheat-row cheat-wrap");
      for (const skill of skillList) {
        const check = el("label", "cheat-check");
        const box = el("input") as HTMLInputElement;
        box.type = "checkbox";
        box.checked = macro.skills.some(ref => ref.weapon === skill.weapon && ref.index === skill.index);
        box.disabled = skill.level <= 0;
        box.addEventListener("change", () => {
          const ref: SkillRef = { weapon: skill.weapon, index: skill.index };
          const skills = box.checked
            ? [...macro.skills, ref]
            : macro.skills.filter(other => !(other.weapon === ref.weapon && other.index === ref.index));
          const macros = auto.macros.map((other, j) => (j === i ? { ...other, skills } : other));
          saveAuto({ ...auto, macros });
        });
        check.append(box, el("span", undefined, `${skill.name}${skill.level > 0 ? ` Lv${skill.level}` : " (안 배움)"} · ${HL3_SKILL_LABELS[skill.category] ?? skill.weapon}`));
        row.append(check);
      }
      if (skillList.length === 0) row.append(el("span", undefined, "캐릭터로 필드에 나오면 스킬 목록이 보여요."));
      item.append(row);
      const autoCheck = el("label", "cheat-check");
      const autoBox = el("input") as HTMLInputElement;
      autoBox.type = "checkbox";
      autoBox.checked = macro.auto;
      autoBox.addEventListener("change", () => {
        const macros = auto.macros.map((other, j) => (j === i ? { ...other, auto: autoBox.checked } : other));
        saveAuto({ ...auto, macros });
      });
      autoCheck.append(autoBox, el("span", undefined, "공격 버튼 누르는 동안 이 묶음도 자동으로 돌리기"));
      item.append(autoCheck);
      body.append(item);
    });

    // 치트 회복 (메모리 방식)
    const autoOn = saved.some(cheat => cheat.name === AUTO_HEAL_KEY) && autoHealTimer !== undefined;
    const healRow = el("div", "cheat-item-actions");
    healRow.append(button(autoOn ? "💊 치트 회복 끄기" : "💊 치트 회복 켜기 (물약 없이 HP/SP 채움)", autoOn ? "primary-command" : "secondary-command", () => {
      saved = saved.filter(cheat => cheat.name !== AUTO_HEAL_KEY);
      if (autoOn) {
        stopAutoHeal();
        setStatus("치트 회복을 껐어요.");
      } else {
        if (context) startAutoHeal(context);
        saved.push({ name: AUTO_HEAL_KEY, address: HL3.HP, width: 2, bigEndian: false, value: 0, freeze: false });
        setStatus("HP가 35% 아래로 떨어지면 메모리로 바로 가득 채워요 (SP도). 물약은 안 줄어요. 게임을 켤 때마다 자동 적용.");
      }
      persist();
    }));
    body.append(healRow);

    // 장착 장비 강화
    body.append(el("p", "cheat-lead", "🔨 장착 장비 강화 (오브 결합 · 공/방 수치)"));
    body.append(el("p", "cheat-muted", "오브 효과는 바로 표시돼요. 공/방 수치는 장비를 한 번 해제했다가 다시 장착해야 전투에 반영됩니다."));
    try {
      const gear = readEquipment(live);
      if (gear.length === 0) body.append(el("p", "cheat-muted", "장착 중인 장비가 없어요."));
      const seen = new Set<string>();
      for (const entry of gear) {
        const key = `${entry.category}:${entry.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const item = el("div", "cheat-item");
        const info = el("div", "cheat-item-info");
        const orb = ORBS.find(o => o.i === entry.orb);
        const isWeapon = entry.category >= 4 && entry.category <= 10;
        info.append(
          el("strong", undefined, `${orb ? `${orb.n} ` : ""}${displayName(entry.name)}`),
          el("span", undefined, `${HL3_ITEMS[entry.category]?.label ?? ""} · ${isWeapon ? "공" : "방"} ${entry.stat}${orb ? ` · ${orb.d.replace("%", `${entry.orbValue}%`)}` : ""}`),
        );
        item.append(info);
        const row1 = el("div", "cheat-row");
        const statInput = el("input") as HTMLInputElement;
        statInput.type = "text";
        statInput.inputMode = "numeric";
        statInput.value = String(Math.min(9999, Math.max(entry.stat * 5, 500)));
        row1.append(el("span", undefined, isWeapon ? "공격" : "방어"), statInput, button("적용", "secondary-command", () => {
          const value = parseNumber(statInput.value);
          if (value === undefined) {
            setStatus("숫자를 입력해 주세요.", true);
            return;
          }
          try {
            setItemStat(live, entry, value);
            setStatus(`${displayName(entry.name)} ${isWeapon ? "공격" : "방어"} ${formatNumber(value)} 적용. 장비 해제 후 다시 장착하면 전투에 반영돼요.`);
          } catch (error) {
            setStatus(String(error), true);
          }
        }));
        item.append(row1);
        const row2 = el("div", "cheat-row");
        const orbSelect = el("select") as HTMLSelectElement;
        const none = el("option", undefined, "오브 없음");
        none.value = "-1";
        orbSelect.append(none);
        for (const o of ORBS) {
          const option = el("option", undefined, `${o.n} 오브 (${o.d})`);
          option.value = String(o.i);
          orbSelect.append(option);
        }
        orbSelect.value = String(orb ? orb.i : isWeapon ? 2 : 3);
        const pctInput = el("input") as HTMLInputElement;
        pctInput.type = "text";
        pctInput.inputMode = "numeric";
        pctInput.value = String(entry.orbValue || 50);
        row2.append(orbSelect, pctInput, el("span", undefined, "%"), button("결합", "secondary-command", () => {
          const pct = parseNumber(pctInput.value) ?? 50;
          try {
            setOrb(live, entry, Number(orbSelect.value), pct);
            setStatus(`${displayName(entry.name)}에 오브를 결합했어요. 가방에서 아이템 설명을 열면 효과가 보여요.`);
          } catch (error) {
            setStatus(String(error), true);
          }
        }));
        item.append(row2);
        body.append(item);
      }
      if (gear.length > 0) {
        body.append(button("⚡ 장착 장비 전부 한 번에: 공/방 ×5 + 무기 뇌제의 50% · 방어구 금강의 50%", "primary-command cheat-big", () => {
          try {
            const done = new Set<string>();
            for (const entry of readEquipment(live)) {
              const key = `${entry.category}:${entry.index}`;
              if (done.has(key)) continue;
              done.add(key);
              const isWeaponItem = entry.category >= 4 && entry.category <= 10;
              setItemStat(live, entry, Math.min(9999, Math.max(entry.stat * 5, 500)));
              setOrb(live, entry, isWeaponItem ? 2 : 3, 50);
            }
            setStatus("장착 장비를 전부 강화했어요. 장비를 해제 후 다시 장착하면 공/방이 전투에 반영돼요.");
          } catch (error) {
            setStatus(String(error), true);
          }
        }));
      }
    } catch (error) {
      body.append(el("p", "cheat-status error", String(error)));
    }

    // 가방 보기
    const bagRow = el("div", "cheat-item-actions");
    bagRow.append(button(hl3ShowBag ? "가방 내용 숨기기" : "가방 내용 보기", "secondary-command", () => {
      hl3ShowBag = !hl3ShowBag;
      render();
    }));
    bagRow.append(button("🧥 장비 전부 해제", "secondary-command", () => {
      try {
        const removed = removeDuplicateEquipment(live);
        const off = unequipAll(live);
        setStatus(`장비 ${off}칸을 해제했어요${removed > 0 ? ` (같은 장비 ${removed}개 정리)` : ""}. 메뉴 → EQUIPMENT에서 다시 하나씩 장착하세요. 장착해야 능력치가 다시 계산돼요. 이상하면 저장하지 말고 껐다 켜세요.`);
      } catch (error) {
        setStatus(String(error), true);
      }
    }));
    bagRow.append(button("🧹 같은 장비 중복 정리", "secondary-command", () => {
      try {
        const removed = removeDuplicateEquipment(live);
        setStatus(removed > 0 ? `같은 장비 ${removed}개를 정리했어요. 장착 중인 것 하나만 남겼어요.` : "중복된 장비가 없어요.");
      } catch (error) {
        setStatus(String(error), true);
      }
    }));
    body.append(bagRow);
    if (hl3ShowBag) {
      try {
        const allEntries = readBag(live);
        const bag = allEntries.filter(entry => entry.count > 0 || entry.name);
        const list = el("ul", "cheat-saved");
        for (const entry of bag) {
          const item = el("li", "cheat-item");
          const info = el("div", "cheat-item-info");
          info.append(
            el("strong", undefined, `${entry.slot + 1}. ${entry.name}${entry.equipped ? " (장착 중)" : ""}`),
            el("span", undefined, `${HL3_ITEMS[entry.category]?.label ?? `분류 ${entry.category}`} · ${formatNumber(entry.count)}개`),
          );
          item.append(info);
          list.append(item);
        }
        body.append(el("p", "cheat-muted", `가방 ${bag.length}/${allEntries.length}칸 사용 중`), list);
      } catch (error) {
        body.append(el("p", "cheat-status error", String(error)));
      }
    }
    body.append(el("div", "cheat-divider"));
  };

  const renderHome = (live: CheatApi) => {
    title.textContent = "치트";
    if (context && isHeroesLore3(context.appTitle)) {
      renderHl3(live);
    }

    const generic = saved.filter(cheat => cheat.name !== BATTLE_KEY && cheat.name !== AUTO_HEAL_KEY);
    if (generic.length > 0) {
      body.append(el("p", "cheat-lead", "저장된 치트"));
      const list = el("ul", "cheat-saved");
      generic.forEach(cheat => {
        const index = saved.indexOf(cheat);
        const item = el("li", "cheat-item");
        const info = el("div", "cheat-item-info");
        let current = "";
        try {
          current = ` · 지금 값 ${formatNumber(live.read(cheat.address, cheat.width, cheat.bigEndian))}`;
        } catch {
          current = "";
        }
        info.append(
          el("strong", undefined, cheat.name),
          el("span", undefined, `${formatNumber(cheat.value)}으로 설정${current}${cheat.freeze ? " · 자동 유지 켜짐" : ""}`),
        );
        const actions = el("div", "cheat-item-actions");
        actions.append(
          button("지금 적용", "primary-command", () => {
            try {
              live.write(cheat.address, cheat.width, cheat.bigEndian, cheat.value);
              setStatus(`${cheat.name}: ${formatNumber(cheat.value)} 적용했어요.`);
            } catch (error) {
              setStatus(String(error), true);
            }
          }),
          button(cheat.freeze ? "자동 유지 끄기" : "자동 유지 켜기", "secondary-command", () => {
            cheat.freeze = !cheat.freeze;
            try {
              if (cheat.freeze) live.freeze(cheat.address, cheat.width, cheat.bigEndian, cheat.value);
              else live.unfreeze(cheat.address);
            } catch (error) {
              setStatus(String(error), true);
              return;
            }
            persist();
            setStatus(cheat.freeze ? "게임을 켤 때마다 자동으로 유지돼요." : "자동 유지를 껐어요.");
          }),
          button("삭제", "danger-command", () => {
            try {
              live.unfreeze(cheat.address);
            } catch {
              // ignore
            }
            saved.splice(index, 1);
            persist();
            setStatus("삭제했어요.");
          }),
        );
        item.append(info, actions);
        list.append(item);
      });
      body.append(list, el("div", "cheat-divider"));
    }

    body.append(el("p", "cheat-lead", "새 치트 만들기"));
    body.append(el("p", "cheat-muted", "물어보는 숫자만 입력하면 나머지는 자동으로 찾아서 바꿔 드려요. 게임을 켜 둔 채로 진행하세요."));
    for (const target of TARGETS) {
      const label = target.key === "gold" ? "💰 소지금 1천만으로" : target.key === "cash" ? "💎 캐시 무제한으로" : "🔧 다른 숫자 바꾸기";
      body.append(button(label, "primary-command cheat-big", () => {
        statusText = "";
        step = { kind: "enter", target, round: 1, candidates: new Uint32Array(), width: 4, bigEndian: false };
        render();
      }));
    }

    body.append(el("div", "cheat-divider"), el("p", "cheat-lead", "아이템·무기 강화·오브 치트 준비"));
    body.append(el("p", "cheat-muted", "아이템 목록 치트를 만들려면 게임 데이터 구조를 분석해야 해요. 게임을 켜 둔 채(가능하면 소지금 치트를 먼저 찾은 뒤) 아래 버튼으로 진단 파일을 만들어 대화창에 보내 주세요. 게임 파일 자체는 포함되지 않아요."));
    const noteRow = el("div", "cheat-row");
    const note = el("input") as HTMLInputElement;
    note.type = "text";
    note.placeholder = "메모 (예: 소지금 1250, 포션 3개, 오브원석 2개)";
    note.autocomplete = "off";
    noteRow.append(note);
    body.append(noteRow);
    const exportButton = button(exporting ? "만드는 중…" : "1) 진단 파일 만들기", "secondary-command cheat-big", () => {
      if (!context || exporting) return;
      exporting = true;
      diagnosticsFile = undefined;
      const current = context;
      void buildDiagnostics(live, current, saved, note.value, text => setStatus(text))
        .then(file => {
          diagnosticsFile = file;
          setStatus(`준비됐어요 (${Math.round(file.size / 1024)}KB). 아래 “보내기”를 누르세요.`);
        })
        .catch(error => setStatus(String(error), true))
        .finally(() => {
          exporting = false;
          render();
        });
    });
    exportButton.disabled = exporting;
    body.append(exportButton);
    if (diagnosticsFile) {
      const file = diagnosticsFile;
      body.append(button("2) 📤 보내기 (공유 → Claude 또는 파일에 저장)", "primary-command cheat-big", () => {
        void shareDiagnostics(file).then(text => setStatus(text));
      }));
    }
  };

  const renderEnter = (current: Extract<Step, { kind: "enter" }>, live: CheatApi) => {
    const { target, round } = current;
    title.textContent = `${target.label} 치트 · ${round}단계`;

    if (round === 1) {
      body.append(
        el("p", "cheat-lead", `게임 화면에 보이는 지금 ${target.label} 숫자를 그대로 입력하세요.`),
        el("p", "cheat-muted", `${target.hint}. 쉼표는 빼고 숫자만 (예: 1,250 → 1250). 화면에 안 보이면 먼저 게임에서 ${target.label}${target.particle} 보이는 메뉴를 열어 두고 오세요.`),
      );
    } else {
      body.append(
        el("p", "cheat-lead", `후보가 ${formatNumber(current.candidates.length)}개예요. 게임으로 돌아가 ${target.label}${target.particle} 바뀌게 한 뒤, 바뀐 숫자를 입력하세요.`),
        el("p", "cheat-muted", "예: 상점에서 아무거나 사거나 팔기, 적을 잡아 돈 얻기. 바뀐 뒤 ✨ 버튼을 다시 누르면 이 화면으로 돌아와요."),
      );
    }

    const row = el("div", "cheat-row");
    const input = el("input") as HTMLInputElement;
    input.type = "text";
    input.inputMode = "numeric";
    input.placeholder = round === 1 ? `지금 ${target.label}` : `바뀐 ${target.label}`;
    input.autocomplete = "off";
    const next = button("다음", "primary-command", () => runSearch(current, input, live));
    next.dataset.default = "true";
    row.append(input, next);
    body.append(row);

    const actions = el("div", "cheat-actions");
    if (round > 1) {
      actions.append(button("처음부터", "secondary-command", () => {
        statusText = "";
        step = { kind: "enter", target, round: 1, candidates: new Uint32Array(), width: 4, bigEndian: false };
        render();
      }));
    }
    actions.append(button("홈으로", "secondary-command", () => {
      statusText = "";
      step = { kind: "home" };
      render();
    }));
    body.append(actions);
    window.setTimeout(() => input.focus(), 50);
  };

  const runSearch = (current: Extract<Step, { kind: "enter" }>, input: HTMLInputElement, live: CheatApi) => {
    const value = parseNumber(input.value);
    if (value === undefined) {
      setStatus("숫자만 입력해 주세요.", true);
      return;
    }
    setStatus(current.round === 1 ? "메모리 전체를 검색하는 중… (몇 초 걸려요)" : "후보를 좁히는 중…");
    window.setTimeout(() => {
      try {
        let found: Uint32Array;
        let width = current.width;
        let bigEndian = current.bigEndian;
        if (current.round === 1) {
          const attempts: Array<[number, boolean]> = value > 0xffff
            ? [[4, false], [4, true]]
            : [[4, false], [4, true], [2, false], [2, true]];
          found = new Uint32Array();
          for (const [tryWidth, tryBigEndian] of attempts) {
            found = live.search(value, tryWidth, tryBigEndian);
            width = tryWidth;
            bigEndian = tryBigEndian;
            if (found.length > 0) break;
          }
        } else {
          found = live.search(value, width, bigEndian, current.candidates);
        }

        if (found.length === 0) {
          if (current.round === 1) {
            const scanned = Math.round(live.memorySize() / (1024 * 1024));
            setStatus(`그 숫자를 메모리(${scanned}MB)에서 못 찾았어요. 게임 화면의 숫자와 똑같은지 다시 확인해 주세요.`, true);
          } else {
            setStatus("이전 후보 중에 바뀐 숫자와 맞는 게 없어요. 숫자를 다시 확인하거나 “처음부터”를 눌러 주세요.", true);
          }
          return;
        }

        if (found.length <= 3) {
          statusText = "";
          step = {
            kind: "apply",
            target: current.target,
            candidates: Array.from(found),
            index: 0,
            width,
            bigEndian,
            value: current.target.defaultValue,
            freeze: true,
            awaiting: false,
          };
          render();
          return;
        }

        statusText = "";
        step = { kind: "enter", target: current.target, round: current.round + 1, candidates: found, width, bigEndian };
        render();
      } catch (error) {
        setStatus(String(error), true);
      }
    }, 30);
  };

  const renderApply = (current: Extract<Step, { kind: "apply" }>, live: CheatApi) => {
    const { target, candidates, index } = current;
    title.textContent = `${target.label} 치트 · 적용`;
    const address = candidates[index];

    if (!current.awaiting) {
      body.append(el("p", "cheat-lead", candidates.length > 1
        ? `후보 ${candidates.length}개 중 ${index + 1}번째를 시험해 볼게요.`
        : "찾았어요! 원하는 값으로 바꿀게요."));

      const row = el("div", "cheat-row");
      const input = el("input") as HTMLInputElement;
      input.type = "text";
      input.inputMode = "numeric";
      input.value = String(current.value);
      input.autocomplete = "off";
      row.append(el("span", undefined, "바꿀 값"), input);
      body.append(row);

      const check = el("label", "cheat-check");
      const freeze = el("input") as HTMLInputElement;
      freeze.type = "checkbox";
      freeze.checked = current.freeze;
      check.append(freeze, el("span", undefined, "항상 이 값으로 유지 (써도 안 줄어듦 = 무제한)"));
      body.append(check);

      const apply = button("적용하기", "primary-command cheat-big", () => {
        const value = parseNumber(input.value);
        if (value === undefined) {
          setStatus("바꿀 값을 숫자로 입력해 주세요.", true);
          return;
        }
        if (current.width === 2 && value > 0xffff) {
          setStatus("이 값은 2바이트짜리라 65,535까지만 넣을 수 있어요.", true);
          return;
        }
        try {
          const previousValue = live.read(address, current.width, current.bigEndian);
          live.write(address, current.width, current.bigEndian, value);
          statusText = "";
          step = { ...current, value, freeze: freeze.checked, awaiting: true, previousValue };
          render();
        } catch (error) {
          setStatus(String(error), true);
        }
      });
      apply.dataset.default = "true";
      body.append(apply);
    } else {
      body.append(
        el("p", "cheat-lead", `게임 화면에서 ${target.label}${target.particle} ${formatNumber(current.value)}(으)로 바뀌었나요?`),
        el("p", "cheat-muted", "바로 안 보이면 이 창을 닫고 게임에서 상태창/상점을 한 번 열었다 닫아 보세요. ✨를 다시 누르면 이 질문으로 돌아와요."),
      );
      const actions = el("div", "cheat-actions");
      actions.append(
        button("네, 바뀌었어요!", "primary-command", () => {
          const name = target.key === "custom" ? `치트 ${saved.length + 1}` : target.label;
          saved = saved.filter(cheat => cheat.address !== address);
          saved.push({ name, address, width: current.width, bigEndian: current.bigEndian, value: current.value, freeze: current.freeze });
          persist();
          if (current.freeze) {
            try {
              live.freeze(address, current.width, current.bigEndian, current.value);
            } catch {
              // ignore
            }
          }
          statusText = "";
          step = { kind: "done", target, name };
          render();
        }),
        button("아니요, 그대로예요", "secondary-command", () => {
          try {
            if (current.previousValue !== undefined) live.write(address, current.width, current.bigEndian, current.previousValue);
          } catch {
            // ignore
          }
          if (index + 1 < candidates.length) {
            statusText = "";
            step = { ...current, index: index + 1, awaiting: false, previousValue: undefined };
            render();
          } else {
            step = { kind: "enter", target, round: 1, candidates: new Uint32Array(), width: 4, bigEndian: false };
            setStatus("후보가 다 아니었어요. 게임에서 값을 한 번 바꾼 뒤 처음부터 다시 해 볼게요.", true);
          }
        }),
      );
      body.append(actions);
    }
  };

  const renderDone = (current: Extract<Step, { kind: "done" }>) => {
    title.textContent = "완료";
    body.append(
      el("p", "cheat-lead", `${current.name} 치트를 저장했어요.`),
      el("p", "cheat-muted", "다음에 게임을 켜도 자동으로 적용돼요. 끄거나 지우려면 ✨ → 저장된 치트에서 바꾸면 됩니다."),
    );
    const actions = el("div", "cheat-actions");
    actions.append(
      button("홈으로", "secondary-command", () => {
        step = { kind: "home" };
        render();
      }),
      button("닫기", "primary-command", () => dialog.close()),
    );
    body.append(actions);
  };

  panel = {
    open(next) {
      if (!context || context.appId !== next.appId) {
        saved = loadSaved(next.appId);
        step = { kind: "home" };
        statusText = "";
      }
      context = next;
      render();
      dialog.showModal();
    },
    restore(next) {
      const live = next.getCheats();
      if (!live) return;
      const cheatsForApp = loadSaved(next.appId);
      if (isHeroesLore3(next.appTitle) && cheatsForApp.some(cheat => cheat.name === BATTLE_KEY)) {
        try {
          freezeBattleStats(live, true);
        } catch {
          // ignore
        }
      }
      if (isHeroesLore3(next.appTitle) && cheatsForApp.some(cheat => cheat.name === AUTO_HEAL_KEY)) {
        startAutoHeal(next);
      } else if (autoHealContextId !== undefined && autoHealContextId !== next.appId) {
        stopAutoHeal();
      }
      for (const cheat of cheatsForApp) {
        if (cheat.name === BATTLE_KEY || cheat.name === AUTO_HEAL_KEY) continue;
        if (!cheat.freeze) continue;
        try {
          live.freeze(cheat.address, cheat.width, cheat.bigEndian, cheat.value);
        } catch {
          // ignore – memory may not be mapped yet
        }
      }
    },
  };

  return panel;
};
