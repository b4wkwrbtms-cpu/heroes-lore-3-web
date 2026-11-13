import { X, createIcons } from "lucide";

import type { CheatApi } from "./backend";
import { loadGamePreference, storeGamePreference } from "./game_preferences";
import { allowsCheats, clearRetiredCheats } from "./cheat_policy";
import {
  type ExpWatch, GOLD_MAX, INOTIA, countDamagedItems, getGold as getInotiaGold, healParty, isInItemTable, keepElixirFree, keepGold,
  multiplyExp, readRolledStats, repairItems, setGold as setInotiaGold, setRolledStats,
} from "./inotia";
import { isInotia } from "./pad_profile";

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
  detach(appId: string): void;
}

interface Target {
  key: "gold" | "cash" | "custom";
  label: string;
  particle: string; // 이/가
  defaultValue: number;
  hint: string;
}

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
const AUTO_HEAL_KEY = "자동 회복";
const GOLD_KEY = "소지금 유지";
const EXP_KEY = "경험치 3배";
const EXP_FACTOR = 3;
/** Saved toggles that run in the background rather than freezing an address. */
const TOGGLE_KEYS: string[] = [AUTO_HEAL_KEY, GOLD_KEY, EXP_KEY];

const isInotiaContext = (context: CheatContext) => isInotia({ id: context.appId });

let tickTimer: number | undefined;
let tickContextId: string | undefined;

const stopTicks = () => {
  if (tickTimer !== undefined) window.clearInterval(tickTimer);
  tickTimer = undefined;
  tickContextId = undefined;
};

/** Runs the app's toggled background cheats (auto-heal, gold top-up); stops whatever ran before. */
const startTicks = (context: CheatContext, cheats: SavedCheat[]) => {
  stopTicks();
  const live = context.getCheats();
  if (!live) return;
  const on = (name: string) => cheats.some(cheat => cheat.name === name);
  const ticks: Array<(api: CheatApi) => void> = [];
  if (isInotiaContext(context)) {
    if (on(AUTO_HEAL_KEY)) ticks.push(api => healParty(api));
    if (on(GOLD_KEY)) ticks.push(api => keepGold(api, GOLD_MAX));
    if (on(EXP_KEY)) {
      const watch: ExpWatch = [];
      ticks.push(api => multiplyExp(api, watch, EXP_FACTOR));
    }
    if (loadGamePreference(context.appId, "elixir_free", "on") !== "off") ticks.push(keepElixirFree);
  }
  if (ticks.length === 0) return;
  tickContextId = context.appId;
  tickTimer = window.setInterval(() => {
    const api = context.getCheats();
    if (!api) {
      stopTicks();
      return;
    }
    for (const tick of ticks) {
      try {
        tick(api);
      } catch {
        // game not in a playable state yet
      }
    }
  }, 150);
};

let movedCheatsNotice = "";

/**
 * 이노티아 keeps gold and item values in records that move with the bag, so a cheat pinned to one of those addresses
 * ends up overwriting whichever item moves in. Drops such saved cheats and leaves a notice for the panel.
 */
const dropMovingCheats = (context: CheatContext, cheats: SavedCheat[]): SavedCheat[] => {
  if (!isInotiaContext(context)) return cheats;
  const kept = cheats.filter(cheat => !isInItemTable(cheat.address));
  if (kept.length === cheats.length) return cheats;
  const names = cheats.filter(cheat => !kept.includes(cheat)).map(cheat => `‘${cheat.name}’`).join(", ");
  storeSaved(context.appId, kept);
  movedCheatsNotice = `저장돼 있던 ${names} 치트를 지웠어요. 이노티아는 아이템 칸 자리가 계속 바뀌어서, 한 자리를 고정하면 그 자리로 옮겨 온 장비 수치를 덮어써요 (DMG/DEF가 튀던 원인). 위의 ‘아이템 수치 복구’를 눌러 주세요.`;
  return kept;
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
  let filename = `${context.appTitle.replace(/[\\/:*?"<>|\s]+/g, "_")}-diagnostics-${Date.now()}.json`;
  if (typeof CompressionStream === "function") {
    const compressed = blob.stream().pipeThrough(new CompressionStream("gzip"));
    blob = await new Response(compressed).blob();
    filename += ".gz";
  }
  return new File([blob], filename, { type: "application/octet-stream" });
};

/** Must be called directly from a tap: the share sheet needs a fresh user gesture. */
const shareDiagnostics = (file: File, appTitle: string): Promise<string> => {
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
    return navigator.share({ files: [file], title: `${appTitle} 진단 파일` })
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

    // On top and sticky: the result of a button deep in the list stays in view.
    if (statusText) body.prepend(el("p", `cheat-status${statusError ? " error" : ""}`, statusText));
  };

  const renderInotia = (live: CheatApi) => {
    body.append(el("p", "cheat-lead", "🐉 이노티아 전용 치트"));
    body.append(el("p", "cheat-muted", "게임 메모리 구조를 분석해서 만든 전용 기능이에요. 캐릭터로 필드에 나온 상태에서 쓰세요."));

    // 소지금: the pouch is an item and moves with the bag, so every write looks it up again.
    let goldText = "";
    try {
      goldText = ` (지금 ${formatNumber(getInotiaGold(live))})`;
    } catch {
      goldText = "";
    }
    const goldOn = saved.some(cheat => cheat.name === GOLD_KEY) && tickTimer !== undefined;
    const goldRow = el("div", "cheat-item-actions");
    goldRow.append(
      button(`💰 소지금 ${formatNumber(GOLD_MAX)}${goldText}`, "primary-command", () => {
        try {
          setInotiaGold(live, GOLD_MAX);
          setStatus(`소지금을 ${formatNumber(GOLD_MAX)}으로 바꿨어요. 메뉴를 열면 바로 보여요.`);
        } catch (error) {
          setStatus(String(error), true);
        }
      }),
      button(goldOn ? "무제한 끄기" : "무제한 (써도 다시 채움)", goldOn ? "primary-command" : "secondary-command", () => {
        saved = saved.filter(cheat => cheat.name !== GOLD_KEY);
        if (!goldOn) saved.push({ name: GOLD_KEY, address: INOTIA.PARTY, width: 4, bigEndian: false, value: GOLD_MAX, freeze: false });
        persist();
        if (context) startTicks(context, saved);
        setStatus(goldOn ? "소지금 무제한을 껐어요." : "소지금이 줄면 바로 다시 채워요. 게임을 켤 때마다 자동 적용.");
      }),
    );
    body.append(goldRow);

    // 아이템 수치 복구
    let damaged = 0;
    try {
      damaged = countDamagedItems(live);
    } catch {
      damaged = 0;
    }
    if (damaged > 0) {
      body.append(el("p", "cheat-alert", `수치가 망가진 아이템이 ${damaged}개 있어요. DMG/DEF가 수백만으로 튀는 원인이에요.`));
      const repairRow = el("div", "cheat-item-actions");
      repairRow.append(button(`🛠 아이템 수치 복구 (${damaged}개)`, "primary-command", () => {
        try {
          const fixed = repairItems(live);
          setStatus(`${fixed}개를 고쳤어요. 이제 메뉴(취소) → 시스템 → 저장, 그다음 나가기 → 이어하기를 하면 DMG/DEF가 정상으로 다시 계산돼요.`);
        } catch (error) {
          setStatus(String(error), true);
        }
      }));
      body.append(repairRow);
    }

    // 공격하면 다가가기 (app.ts → InotiaHunt)
    const approachOn = loadGamePreference(context?.appId, "auto_approach", "on") !== "off";
    const approachRow = el("div", "cheat-item-actions");
    approachRow.append(button(approachOn ? "🗡️ 공격하면 다가가서 때리기: 켜짐" : "🗡️ 공격하면 다가가서 때리기: 꺼짐", approachOn ? "primary-command" : "secondary-command", () => {
      storeGamePreference(context?.appId, "auto_approach", approachOn ? "off" : "on");
      setStatus(approachOn
        ? "껐어요. 공격 버튼이 원래 게임처럼 제자리에서만 때려요."
        : "켰어요. 공격을 누르면 게임이 고른 몬스터에게 걸어가서 때리고, 꾹 누르고 있으면 계속 때리면서 다음 몬스터로 넘어가요.");
    }));
    body.append(approachRow);
    body.append(el("p", "cheat-muted", "근접 직업용이에요. 멀리서 쏘는 직업이면 꺼 두세요. 조이스틱을 움직이면 그동안은 직접 조종이 우선이에요."));

    // 파티 자동 회복
    const healOn = saved.some(cheat => cheat.name === AUTO_HEAL_KEY) && tickTimer !== undefined;
    const healRow = el("div", "cheat-item-actions");
    healRow.append(button(healOn ? "💊 파티 자동 회복 끄기" : "💊 파티 자동 회복 켜기 (물약 없이 HP/MP 채움)", healOn ? "primary-command" : "secondary-command", () => {
      saved = saved.filter(cheat => cheat.name !== AUTO_HEAL_KEY);
      if (!healOn) saved.push({ name: AUTO_HEAL_KEY, address: INOTIA.PARTY, width: 4, bigEndian: false, value: 0, freeze: false });
      persist();
      if (context) startTicks(context, saved);
      setStatus(healOn ? "파티 자동 회복을 껐어요." : "주인공과 용병의 HP·MP가 35% 아래로 떨어지면 바로 가득 채워요. 쓰러진 동료는 그대로 둬요. 게임을 켤 때마다 자동 적용.");
    }));
    body.append(healRow);

    // 경험치 3배
    const expOn = saved.some(cheat => cheat.name === EXP_KEY) && tickTimer !== undefined;
    const expRow = el("div", "cheat-item-actions");
    expRow.append(button(expOn ? "⭐ 경험치 3배 끄기" : "⭐ 경험치 3배 켜기", expOn ? "primary-command" : "secondary-command", () => {
      saved = saved.filter(cheat => cheat.name !== EXP_KEY);
      if (!expOn) saved.push({ name: EXP_KEY, address: INOTIA.PARTY, width: 4, bigEndian: false, value: EXP_FACTOR, freeze: false });
      persist();
      if (context) startTicks(context, saved);
      setStatus(expOn ? "경험치 3배를 껐어요. 이제 원래대로 받아요." : "몬스터를 잡고 얻는 경험치가 주인공·용병 모두 3배가 돼요. 레벨업은 게임이 직접 해서 능력치도 그대로 올라요. 게임을 켤 때마다 자동 적용.");
    }));
    body.append(expRow);
    body.append(el("p", "cheat-muted", "경험치 바가 다 차면 남은 몫은 다음 사냥 때 레벨업한 뒤에 마저 들어와요."));

    // 초월의 영약: 6번째부터 게임이 네트워크 접속을 요구함
    const elixirOn = loadGamePreference(context?.appId, "elixir_free", "on") !== "off";
    const elixirRow = el("div", "cheat-item-actions");
    elixirRow.append(button(elixirOn ? "🧪 초월의 영약 계속 먹기: 켜짐" : "🧪 초월의 영약 계속 먹기: 꺼짐", elixirOn ? "primary-command" : "secondary-command", () => {
      storeGamePreference(context?.appId, "elixir_free", elixirOn ? "off" : "on");
      if (context) startTicks(context, saved);
      setStatus(elixirOn
        ? "껐어요. 원래 게임처럼 5번 마신 뒤에는 '네트워크에 접속한 상태에서만 이용가능합니다'가 떠요."
        : "켰어요. 초월의 영약을 몇 번이든 마실 수 있고, 마실 때마다 스탯이 1씩 올라요.");
    }));
    body.append(elixirRow);
    body.append(el("p", "cheat-muted", "원래 게임은 5번까지만 그냥 마실 수 있고, 그다음부터는 휴대폰 네트워크 접속을 요구해요. 에뮬레이터에는 네트워크가 없어서, 켜 두면 마신 횟수를 5번 아래로 유지해요."));

    // 스탯 결정
    let current = "";
    try {
      current = readRolledStats(live).map((value, i) => `${INOTIA.STAT_NAMES[i]} ${value}`).join(" · ");
    } catch {
      current = "";
    }
    const statRow = el("div", "cheat-item-actions");
    statRow.append(button("🎲 스탯 전부 20", "secondary-command", () => {
      try {
        setRolledStats(live, 20);
        setStatus("STR·DEX·CON·INT·MEN·LUK을 전부 20으로 바꿨어요. 창을 닫고 REROLL 없이 바로 확인을 누르세요.");
      } catch (error) {
        setStatus(String(error), true);
      }
    }));
    body.append(statRow);
    body.append(el("p", "cheat-muted", `새 캐릭터를 만들 때 '스탯 결정' 화면에서 누르세요. REROLL을 누르면 다시 굴려져요.${current ? ` 지금 굴린 값: ${current}` : ""}`));
    body.append(el("div", "cheat-divider"));
  };

  const renderHome = (live: CheatApi) => {
    title.textContent = "치트";
    if (context && isInotia({ id: context.appId })) {
      renderInotia(live);
    }

    const generic = saved.filter(cheat => !TOGGLE_KEYS.includes(cheat.name));
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
      if (target.key === "gold" && context && isInotiaContext(context)) continue;
      const label = target.key === "gold" ? "💰 소지금 1천만으로" : target.key === "cash" ? "💎 캐시 무제한으로" : "🔧 다른 숫자 바꾸기";
      body.append(button(label, "primary-command cheat-big", () => {
        statusText = "";
        step = { kind: "enter", target, round: 1, candidates: new Uint32Array(), width: 4, bigEndian: false };
        render();
      }));
    }

    body.append(el("div", "cheat-divider"), el("p", "cheat-lead", "진단 파일 (치트·오류 분석용)"));
    body.append(el("p", "cheat-muted", "새 치트를 만들거나 이상한 수치를 분석하려면 게임 메모리와 세이브가 필요해요. 게임을 켜 둔 채 아래 버튼으로 진단 파일을 만들어 대화창에 보내 주세요. 게임 파일 자체는 포함되지 않아요."));
    const noteRow = el("div", "cheat-row");
    const note = el("input") as HTMLInputElement;
    note.type = "text";
    note.placeholder = "메모 (예: 소지금 1250, 포션 3개)";
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
        void shareDiagnostics(file, context?.appTitle ?? "WIE").then(text => setStatus(text));
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
          if (context && isInotiaContext(context) && isInItemTable(address)) {
            step = { kind: "home" };
            setStatus("바꿨어요. 다만 이 숫자는 아이템 칸에 있어서 가방이 바뀌면 자리가 옮겨져요. 다른 장비를 덮어쓰지 않도록 저장·자동 유지는 하지 않았어요.");
            return;
          }
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
    detach(appId) {
      if (tickContextId === appId) stopTicks();
      if (context?.appId === appId) {
        context = undefined;
        dialog.close();
      }
    },
    open(next) {
      if (!allowsCheats(next.appId)) {
        clearRetiredCheats(next.appId, next.getCheats());
        return;
      }
      if (!context || context.appId !== next.appId || movedCheatsNotice) {
        saved = dropMovingCheats(next, loadSaved(next.appId));
        step = { kind: "home" };
        statusText = movedCheatsNotice;
        statusError = false;
        movedCheatsNotice = "";
      }
      context = next;
      render();
      dialog.showModal();
    },
    restore(next) {
      if (!allowsCheats(next.appId)) {
        if (tickContextId === next.appId) stopTicks();
        clearRetiredCheats(next.appId, next.getCheats());
        return;
      }
      const live = next.getCheats();
      if (!live) return;
      const cheatsForApp = dropMovingCheats(next, loadSaved(next.appId));
      startTicks(next, cheatsForApp);
      for (const cheat of cheatsForApp) {
        if (TOGGLE_KEYS.includes(cheat.name) || !cheat.freeze) continue;
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
