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
  value: number;
  freeze: boolean;
}

export interface CheatPanel {
  open(context: CheatContext): void;
  /** Re-apply saved "freeze" cheats for the app; call once the session is ready. */
  restore(context: CheatContext): void;
}

const storageKey = (appId: string) => `wie_cheats_${appId}`;

const loadSaved = (appId: string): SavedCheat[] => {
  try {
    const raw = window.localStorage.getItem(storageKey(appId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedCheat =>
      typeof item === "object" && item !== null
      && typeof (item as SavedCheat).address === "number"
      && typeof (item as SavedCheat).value === "number",
    ).map(item => ({
      name: String(item.name ?? ""),
      address: item.address >>> 0,
      width: item.width === 2 ? 2 : 4,
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

const hex = (address: number) => `0x${(address >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
const formatNumber = (value: number) => value.toLocaleString("ko-KR");

let panel: CheatPanel | undefined;

export const getCheatPanel = (): CheatPanel => {
  if (panel) return panel;

  const dialog = document.getElementById("cheat-dialog") as HTMLDialogElement;
  const savedList = document.getElementById("cheat-saved") as HTMLUListElement;
  const savedEmpty = document.getElementById("cheat-saved-empty") as HTMLElement;
  const valueInput = document.getElementById("cheat-value") as HTMLInputElement;
  const searchButton = document.getElementById("cheat-search") as HTMLButtonElement;
  const resetButton = document.getElementById("cheat-reset") as HTMLButtonElement;
  const status = document.getElementById("cheat-status") as HTMLElement;
  const resultsList = document.getElementById("cheat-results") as HTMLUListElement;
  const editSection = document.getElementById("cheat-edit") as HTMLElement;
  const editAddress = document.getElementById("cheat-edit-address") as HTMLElement;
  const newValueInput = document.getElementById("cheat-new-value") as HTMLInputElement;
  const applyButton = document.getElementById("cheat-apply") as HTMLButtonElement;
  const freezeCheckbox = document.getElementById("cheat-freeze") as HTMLInputElement;
  const nameInput = document.getElementById("cheat-name") as HTMLInputElement;
  const saveButton = document.getElementById("cheat-save") as HTMLButtonElement;

  createIcons({ icons: { X }, root: dialog });
  // Enter inside a text field must not submit the form (which would close the dialog).
  dialog.addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
      event.preventDefault();
    }
  });

  let context: CheatContext | undefined;
  let saved: SavedCheat[] = [];
  let results: Uint32Array = new Uint32Array();
  let width = 4;
  let searchCount = 0;
  let selected: number | undefined;

  const setStatus = (text: string, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };

  const cheats = () => {
    const api = context?.getCheats();
    if (!api) setStatus("게임이 실행 중일 때만 사용할 수 있어요.", true);
    return api;
  };

  const renderSaved = () => {
    savedList.replaceChildren();
    savedEmpty.hidden = saved.length > 0;
    const api = context?.getCheats();
    saved.forEach((cheat, index) => {
      const item = document.createElement("li");
      item.className = "cheat-item";

      const info = document.createElement("div");
      info.className = "cheat-item-info";
      const name = document.createElement("strong");
      name.textContent = cheat.name || `치트 ${index + 1}`;
      const detail = document.createElement("span");
      let current = "";
      try {
        if (api) current = ` · 현재 ${formatNumber(api.read(cheat.address, cheat.width))}`;
      } catch {
        current = "";
      }
      detail.textContent = `${hex(cheat.address)} → ${formatNumber(cheat.value)}${current}`;
      info.append(name, detail);

      const actions = document.createElement("div");
      actions.className = "cheat-item-actions";

      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "primary-command";
      apply.textContent = "적용";
      apply.addEventListener("click", () => {
        const live = cheats();
        if (!live) return;
        try {
          live.write(cheat.address, cheat.width, cheat.value);
          setStatus(`${cheat.name || hex(cheat.address)} 에 ${formatNumber(cheat.value)} 적용했어요.`);
          renderSaved();
        } catch (error) {
          setStatus(String(error), true);
        }
      });

      const freeze = document.createElement("button");
      freeze.type = "button";
      freeze.className = cheat.freeze ? "primary-command" : "secondary-command";
      freeze.textContent = cheat.freeze ? "고정 중" : "고정";
      freeze.title = "값을 계속 이 값으로 유지합니다 (무제한)";
      freeze.addEventListener("click", () => {
        const live = cheats();
        if (!live) return;
        try {
          cheat.freeze = !cheat.freeze;
          if (cheat.freeze) live.freeze(cheat.address, cheat.width, cheat.value);
          else live.unfreeze(cheat.address);
          if (context) storeSaved(context.appId, saved);
          setStatus(cheat.freeze ? "고정했어요. 게임을 켤 때마다 자동으로 유지됩니다." : "고정을 해제했어요.");
          renderSaved();
        } catch (error) {
          setStatus(String(error), true);
        }
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-command";
      remove.textContent = "삭제";
      remove.addEventListener("click", () => {
        try {
          context?.getCheats()?.unfreeze(cheat.address);
        } catch {
          // ignore
        }
        saved.splice(index, 1);
        if (context) storeSaved(context.appId, saved);
        renderSaved();
      });

      actions.append(apply, freeze, remove);
      item.append(info, actions);
      savedList.append(item);
    });
  };

  const renderResults = () => {
    resultsList.replaceChildren();
    const api = context?.getCheats();
    const shown = Math.min(results.length, 40);
    for (let i = 0; i < shown; i += 1) {
      const address = results[i];
      const item = document.createElement("li");
      item.className = "cheat-result";
      const button = document.createElement("button");
      button.type = "button";
      button.className = selected === address ? "primary-command" : "secondary-command";
      let current = "";
      try {
        if (api) current = ` = ${formatNumber(api.read(address, width))}`;
      } catch {
        current = "";
      }
      button.textContent = `${hex(address)}${current}`;
      button.addEventListener("click", () => {
        selected = address;
        editAddress.textContent = hex(address);
        editSection.hidden = false;
        renderResults();
      });
      item.append(button);
      resultsList.append(item);
    }
    if (results.length > shown) {
      const more = document.createElement("li");
      more.className = "cheat-muted";
      more.textContent = `… 외 ${formatNumber(results.length - shown)}개. 게임에서 값을 바꾼 뒤 새 값으로 다시 검색하면 좁혀져요.`;
      resultsList.append(more);
    }
  };

  const resetSearch = () => {
    results = new Uint32Array();
    width = 4;
    searchCount = 0;
    selected = undefined;
    editSection.hidden = true;
    resultsList.replaceChildren();
    setStatus("");
  };

  const runSearch = () => {
    const api = cheats();
    if (!api) return;
    const value = Number(valueInput.value.replace(/[^0-9]/g, ""));
    if (!Number.isFinite(value) || valueInput.value.trim() === "") {
      setStatus("찾을 값을 숫자로 입력하세요.", true);
      return;
    }
    if (value > 0xffffffff) {
      setStatus("값이 너무 커요 (최대 4,294,967,295).", true);
      return;
    }
    searchButton.disabled = true;
    setStatus(searchCount === 0 ? "메모리 전체를 검색 중…" : "이전 결과에서 좁히는 중…");
    // Let the status paint before the (synchronous) scan.
    window.setTimeout(() => {
      try {
        if (searchCount === 0) {
          let found = api.search(value, 4);
          width = 4;
          if (found.length === 0) {
            found = api.search(value, 2);
            if (found.length > 0) width = 2;
          }
          results = found;
        } else {
          results = api.search(value, width, results);
        }
        searchCount += 1;
        selected = undefined;
        editSection.hidden = true;
        if (results.length === 0) {
          setStatus("일치하는 값이 없어요. 값을 다시 확인하거나 “처음부터”로 재검색하세요.", true);
        } else if (results.length === 1) {
          setStatus("1개 찾았어요! 아래 주소를 누르고 값을 바꾸세요.");
          selected = results[0];
          editAddress.textContent = hex(selected);
          editSection.hidden = false;
        } else {
          setStatus(`${formatNumber(results.length)}개 일치 (${width}바이트). 게임에서 값을 바꾼 뒤 새 값을 넣고 다시 “검색”을 누르면 좁혀져요.`);
        }
        renderResults();
      } catch (error) {
        setStatus(String(error), true);
      } finally {
        searchButton.disabled = false;
      }
    }, 30);
  };

  searchButton.addEventListener("click", runSearch);
  valueInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch();
    }
  });
  resetButton.addEventListener("click", () => {
    resetSearch();
    setStatus("처음부터 다시 검색합니다.");
  });

  const readNewValue = (): number | undefined => {
    const value = Number(newValueInput.value.replace(/[^0-9]/g, ""));
    if (newValueInput.value.trim() === "" || !Number.isFinite(value) || value > 0xffffffff) {
      setStatus("바꿀 값을 숫자로 입력하세요.", true);
      return undefined;
    }
    if (width === 2 && value > 0xffff) {
      setStatus("이 값은 2바이트라서 최대 65,535까지만 넣을 수 있어요.", true);
      return undefined;
    }
    return value;
  };

  applyButton.addEventListener("click", () => {
    const api = cheats();
    if (!api || selected === undefined) return;
    const value = readNewValue();
    if (value === undefined) return;
    try {
      if (freezeCheckbox.checked) api.freeze(selected, width, value);
      else api.write(selected, width, value);
      setStatus(`${hex(selected)} 에 ${formatNumber(value)} ${freezeCheckbox.checked ? "적용 + 고정" : "적용"}했어요. 게임 화면에서 확인해 보세요.`);
      renderResults();
    } catch (error) {
      setStatus(String(error), true);
    }
  });

  saveButton.addEventListener("click", () => {
    if (!context || selected === undefined) return;
    const value = readNewValue();
    if (value === undefined) return;
    const name = nameInput.value.trim() || `치트 ${saved.length + 1}`;
    saved = saved.filter(cheat => cheat.address !== selected);
    saved.push({ name, address: selected, width, value, freeze: freezeCheckbox.checked });
    storeSaved(context.appId, saved);
    const api = context.getCheats();
    if (api && freezeCheckbox.checked) {
      try {
        api.freeze(selected, width, value);
      } catch {
        // ignore
      }
    }
    nameInput.value = "";
    setStatus(`“${name}” 저장했어요. 다음에 게임을 켜도 위 목록에서 바로 쓸 수 있어요.`);
    renderSaved();
  });

  panel = {
    open(next) {
      if (!context || context.appId !== next.appId) {
        resetSearch();
        saved = loadSaved(next.appId);
      }
      context = next;
      renderSaved();
      renderResults();
      dialog.showModal();
    },
    restore(next) {
      const api = next.getCheats();
      if (!api) return;
      const cheatsForApp = loadSaved(next.appId);
      for (const cheat of cheatsForApp) {
        if (!cheat.freeze) continue;
        try {
          api.freeze(cheat.address, cheat.width, cheat.value);
        } catch {
          // ignore – memory may not be mapped yet
        }
      }
    },
  };

  return panel;
};
