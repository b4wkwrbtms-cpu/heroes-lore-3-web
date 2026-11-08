import { X, createIcons } from "lucide";

import type { CheatApi } from "./backend";

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

  const renderHome = (live: CheatApi) => {
    title.textContent = "치트";

    if (saved.length > 0) {
      body.append(el("p", "cheat-lead", "저장된 치트"));
      const list = el("ul", "cheat-saved");
      saved.forEach((cheat, index) => {
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
      for (const cheat of loadSaved(next.appId)) {
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
