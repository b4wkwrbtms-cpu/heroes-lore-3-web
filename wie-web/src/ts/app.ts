import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ellipsis, Keyboard, Map as MapIcon, Save, Settings, Sparkles, X, createIcons } from "lucide";

import { recordPageView } from "./analytics";
import { type AutoConfig, SLOT_KEYS, type SlotKey, automation, macroCandidates, skillSlotKeys } from "./automation";
import type { LibraryApp, PlayerSession, Wie } from "./backend";
import { getCheatPanel } from "./cheats";
import { isHeroesLore3, readSkills } from "./hl3";
import type { SettingsController } from "./settings";

const KEY_MAP: Record<string, string> = {
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  KeyQ: "4",
  KeyW: "5",
  KeyE: "6",
  KeyA: "7",
  KeyS: "8",
  KeyD: "9",
  KeyZ: "*",
  KeyX: "0",
  KeyC: "#",
  Backspace: "CLR",
  ShiftLeft: "SOFT1",
  ShiftRight: "SOFT2",
  ArrowUp: "UP",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  ArrowDown: "DOWN",
  Enter: "OK",
  NumpadEnter: "OK",
  Space: "OK",
};
const icons = {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ellipsis,
  Keyboard,
  Map: MapIcon,
  Save,
  Settings,
  Sparkles,
  X,
};

export const runApp = (backend: Wie, app: LibraryApp, settings: SettingsController): Promise<boolean> => new Promise((resolve, reject) => {
  const playerView = document.getElementById("player-view") as HTMLElement;
  const playerTitle = document.getElementById("player-title") as HTMLElement;
  const playerStatus = document.getElementById("player-status") as HTMLElement;
  const playerWarning = document.getElementById("player-warning") as HTMLElement;
  const backToLibrary = document.getElementById("back-to-library") as HTMLButtonElement;
  const appSettings = document.getElementById("app-settings") as HTMLButtonElement;
  const appCheats = document.getElementById("app-cheats") as HTMLButtonElement | null;
  const keypadToggle = document.getElementById("keypad-toggle") as HTMLButtonElement | null;
  const keypadSheet = document.getElementById("keypad-sheet") as HTMLElement | null;
  const keypadSheetClose = document.getElementById("keypad-sheet-close") as HTMLButtonElement | null;
  const buttons = playerView.querySelectorAll<HTMLButtonElement>("button[data-key]");

  const abortController = new AbortController();
  const inputs = new Map<string, string>();
  let session: PlayerSession | undefined;
  let preparing = true;
  let suspended = false;
  let ending = false;
  let start: Promise<PlayerSession | undefined>;
  let warningTimer: ReturnType<typeof setTimeout> | undefined;

  playerTitle.textContent = app.title;
  playerWarning.hidden = true;
  createIcons({ icons, root: playerView });

  const updateControls = () => {
    const busy = preparing || suspended || !session || ending;
    playerStatus.hidden = !preparing || ending;
    playerView.setAttribute("aria-busy", String(busy));
    for (const button of buttons) button.disabled = busy;
    for (const button of macroButtons) button.disabled = busy;
  };
  const finish = async (error?: unknown, failed = false) => {
    if (ending) return;
    ending = true;
    clearTimeout(warningTimer);
    abortController.abort();
    automation.detach();
    unsubscribeAuto();
    inputs.clear();
    updateControls();
    try {
      await (await start)?.stop();
      if (error !== undefined) reject(error);
      else resolve(failed);
    } catch (stopError) {
      if (failed) resolve(true);
      else reject(error ?? stopError);
    } finally {
      playerStatus.hidden = true;
      playerWarning.hidden = true;
      playerView.removeAttribute("aria-busy");
    }
  };

  const setKey = (source: string, key?: string) => {
    if (!session || preparing || suspended || ending) return;
    const previous = inputs.get(source);
    if (previous === key) return;
    if (previous) {
      inputs.delete(source);
      if (![...inputs.values()].includes(previous)) {
        automation.notifyKey(previous, false);
        void session.key(previous, false).catch(finish);
      }
    }
    if (key) {
      const pressed = [...inputs.values()].includes(key);
      inputs.set(source, key);
      if (!pressed) {
        automation.notifyKey(key, true);
        void session.key(key, true).catch(finish);
      }
    }
  };
  let autoPressId = 0;
  const pressKey = (key: string, holdMs = 90) => {
    const source = `auto:${key}:${autoPressId++}`;
    setKey(source, key);
    window.setTimeout(() => setKey(source), holdMs);
  };
  const slotCaptions = new Map<HTMLButtonElement, string>();
  const macroButtons = playerView.querySelectorAll<HTMLButtonElement>("button[data-macro]");
  const actionGrid = playerView.querySelector<HTMLElement>(".action-grid");
  const skillName = (weapon: "A" | "B", index: number): string => {
    const api = cheatContext.getCheats();
    if (!api) return `${weapon}${index}`;
    try {
      return macroCandidates(readSkills(api)).find(skill => skill.weapon === weapon && skill.index === index)?.name ?? `${weapon}${index}`;
    } catch {
      return `${weapon}${index}`;
    }
  };
  const applyPadLabels = (config: AutoConfig) => {
    let anyMacro = false;
    macroButtons.forEach((button, i) => {
      const macro = config.macros[i];
      const show = !!macro && macro.skills.length > 0;
      button.hidden = !show;
      if (show) {
        anyMacro = true;
        const caption = button.querySelector("span");
        if (caption) caption.textContent = macro.skills.map(ref => skillName(ref.weapon, ref.index)).join("·");
      }
    });
    actionGrid?.classList.toggle("has-macros", anyMacro);
    for (const button of buttons) {
      const key = button.dataset.key;
      if (!key || !button.classList.contains("key-slot") || !(SLOT_KEYS as readonly string[]).includes(key)) continue;
      const slot = key as SlotKey;
      const caption = button.querySelector("span");
      if (!caption) continue;
      if (!slotCaptions.has(button)) slotCaptions.set(button, caption.textContent ?? "");
      let text = slotCaptions.get(button) ?? "";
      if (config.potionOn && slot === config.hpKey) text = "HP 물약";
      else if (config.potionOn && slot === config.spKey) text = "SP 물약";
      else if (config.skillOn && skillSlotKeys(config).includes(slot) && config.skillSlots.includes(slot)) text = "자동 스킬";
      caption.textContent = text;
    }
  };
  const releaseKeys = () => {
    inputs.clear();
    if (session && !ending) void session.releaseKeys().catch(finish);
  };

  backToLibrary.addEventListener("click", () => {
    releaseKeys();
    if (!window.confirm("게임을 끝내고 라이브러리로 갈까요? 저장하지 않은 진행은 사라져요.")) return;
    void finish();
  }, { signal: abortController.signal });
  // The system tools hide behind ⋯ so a thumb sliding off the joystick cannot hit them.
  const padMore = document.getElementById("pad-more") as HTMLButtonElement | null;
  const padTools = document.getElementById("pad-tools") as HTMLElement | null;
  let padToolsTimer: number | undefined;
  const showPadTools = (show: boolean) => {
    if (!padTools || !padMore) return;
    padTools.hidden = !show;
    padMore.setAttribute("aria-expanded", String(show));
    window.clearTimeout(padToolsTimer);
    if (show) padToolsTimer = window.setTimeout(() => showPadTools(false), 6000);
  };
  padMore?.addEventListener("click", () => {
    releaseKeys();
    showPadTools(padTools?.hidden ?? true);
  }, { signal: abortController.signal });
  padTools?.addEventListener("click", () => showPadTools(false), { signal: abortController.signal });
  abortController.signal.addEventListener("abort", () => window.clearTimeout(padToolsTimer));
  appSettings.addEventListener("click", () => {
    releaseKeys();
    settings.open();
  }, { signal: abortController.signal });
  const cheatContext = {
    appId: app.id,
    appTitle: app.title,
    getCheats: () => (session && !ending ? session.cheats : undefined),
  };
  const unsubscribeAuto = automation.onChange(applyPadLabels);
  macroButtons.forEach((button, i) => {
    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      if (!session || preparing || suspended || ending) return;
      button.classList.add("pressed");
      automation.runMacro(i);
    }, { signal: abortController.signal });
    const release = () => button.classList.remove("pressed");
    button.addEventListener("pointerup", release, { signal: abortController.signal });
    button.addEventListener("pointercancel", release, { signal: abortController.signal });
    button.addEventListener("pointerleave", release, { signal: abortController.signal });
  });
  const attachAutomation = () => {
    if (!isHeroesLore3(app.title) || automation.appId === app.id) return;
    automation.attach({ appId: app.id, getCheats: cheatContext.getCheats, pressKey });
  };
  appCheats?.addEventListener("click", () => {
    releaseKeys();
    getCheatPanel().open(cheatContext);
  }, { signal: abortController.signal });
  if (keypadSheet) {
    keypadSheet.hidden = true;
    keypadToggle?.addEventListener("click", () => {
      releaseKeys();
      keypadSheet.hidden = !keypadSheet.hidden;
    }, { signal: abortController.signal });
    keypadSheetClose?.addEventListener("click", () => {
      releaseKeys();
      keypadSheet.hidden = true;
    }, { signal: abortController.signal });
    abortController.signal.addEventListener("abort", () => {
      keypadSheet.hidden = true;
    });
  }
  window.addEventListener("blur", releaseKeys, { signal: abortController.signal });
  window.addEventListener("pagehide", () => { void finish(); }, { signal: abortController.signal });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseKeys();
  }, { signal: abortController.signal });

  for (const button of buttons) {
    const key = button.dataset.key!;
    button.addEventListener(
      "pointerdown",
      (event) => {
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        button.classList.add("pressed");
        setKey(`pointer:${event.pointerId}`, key);
      },
      { signal: abortController.signal },
    );
    const releaseKey = (event: PointerEvent) => {
      event.preventDefault();
      button.classList.remove("pressed");
      setKey(`pointer:${event.pointerId}`);
    };
    button.addEventListener("pointerup", releaseKey, { signal: abortController.signal });
    button.addEventListener("pointercancel", releaseKey, { signal: abortController.signal });
    button.addEventListener("lostpointercapture", releaseKey, { signal: abortController.signal });
  }

  // 360° joystick with a floating origin: the direction is measured from where the thumb first
  // touched and mapped to four 90° sectors with a little hysteresis so it never flickers at the
  // borders. (The game ignores a second held direction, so diagonals would only add noise.)
  const joystick = playerView.querySelector<HTMLElement>("#joystick");
  if (joystick) {
    const knob = joystick.querySelector<HTMLElement>(".joystick-knob")!;
    const DEAD_ZONE_PX = 9;
    const HYSTERESIS_DEG = 9;
    const KNOB_LIMIT = 0.62;
    let activePointer: number | undefined;
    let originX = 0;
    let originY = 0;
    let centerX = 0;
    let centerY = 0;
    let radius = 1;
    let sector: number | undefined;
    let horizontal: "LEFT" | "RIGHT" | undefined;
    let vertical: "UP" | "DOWN" | undefined;

    const applyDirection = (dx: number, dy: number) => {
      const magnitude = Math.hypot(dx, dy);
      if (magnitude < DEAD_ZONE_PX) {
        sector = undefined;
        horizontal = undefined;
        vertical = undefined;
      } else {
        const sectors = 4;
        const width = 360 / sectors;
        let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (angle < 0) angle += 360;
        const nearest = Math.round(angle / width) % sectors;
        if (sector === undefined || sector >= sectors) sector = nearest;
        else {
          let delta = angle - sector * width;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          if (Math.abs(delta) > width / 2 + HYSTERESIS_DEG) sector = nearest;
        }
        const heading = sector * width;
        const cos = Math.cos((heading * Math.PI) / 180);
        const sin = Math.sin((heading * Math.PI) / 180);
        horizontal = cos > 0.5 ? "RIGHT" : cos < -0.5 ? "LEFT" : undefined;
        vertical = sin > 0.5 ? "DOWN" : sin < -0.5 ? "UP" : undefined;
      }
      setKey("joystick:h", horizontal);
      setKey("joystick:v", vertical);
    };

    const moveKnob = (x: number, y: number) => {
      const dx = (x - centerX) / radius;
      const dy = (y - centerY) / radius;
      const magnitude = Math.hypot(dx, dy);
      const scale = magnitude > KNOB_LIMIT ? KNOB_LIMIT / magnitude : 1;
      knob.style.transform = `translate(${dx * scale * radius}px, ${dy * scale * radius}px)`;
    };

    const resetJoystick = () => {
      activePointer = undefined;
      joystick.classList.remove("active");
      knob.style.transform = "";
      applyDirection(0, 0);
    };

    const track = (event: PointerEvent) => {
      moveKnob(event.clientX, event.clientY);
      applyDirection(event.clientX - originX, event.clientY - originY);
    };

    joystick.addEventListener(
      "pointerdown",
      (event) => {
        if (activePointer !== undefined) return;
        event.preventDefault();
        const rect = joystick.getBoundingClientRect();
        centerX = rect.left + rect.width / 2;
        centerY = rect.top + rect.height / 2;
        radius = Math.max(1, rect.width / 2);
        // Floating origin: a touch well inside the ring starts from where the thumb landed; a touch
        // near the rim is already a direction, so measure that one from the centre.
        const fromCenter = Math.hypot(event.clientX - centerX, event.clientY - centerY);
        if (fromCenter < radius * 0.45) {
          originX = event.clientX;
          originY = event.clientY;
        } else {
          originX = centerX;
          originY = centerY;
        }
        activePointer = event.pointerId;
        joystick.setPointerCapture(event.pointerId);
        joystick.classList.add("active");
        track(event);
      },
      { signal: abortController.signal },
    );
    joystick.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== activePointer) return;
        event.preventDefault();
        track(event);
      },
      { signal: abortController.signal },
    );
    const endJoystick = (event: PointerEvent) => {
      if (event.pointerId !== activePointer) return;
      event.preventDefault();
      resetJoystick();
    };
    joystick.addEventListener("pointerup", endJoystick, { signal: abortController.signal });
    joystick.addEventListener("pointercancel", endJoystick, { signal: abortController.signal });
    joystick.addEventListener("lostpointercapture", endJoystick, { signal: abortController.signal });
    abortController.signal.addEventListener("abort", resetJoystick);
  }

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("dialog")) {
        return;
      }

      const key = KEY_MAP[event.code];
      if (key) {
        event.preventDefault();
        if (!event.repeat) {
          setKey(`keyboard:${event.code}`, key);
        }
      }
    },
    { signal: abortController.signal },
  );
  document.addEventListener(
    "keyup",
    (event) => {
      const key = KEY_MAP[event.code];
      if (key) {
        event.preventDefault();
        setKey(`keyboard:${event.code}`);
      }
    },
    { signal: abortController.signal },
  );

  updateControls();
  start = backend.startApp(app.id, event => {
    if (ending) return;
    switch (event.type) {
      case "ready":
        if (preparing) recordPageView(app.title);
        preparing = false;
        updateControls();
        getCheatPanel().restore(cheatContext);
        attachAutomation();
        break;
      case "suspended":
        suspended = event.suspended;
        inputs.clear();
        updateControls();
        break;
      case "warning":
        clearTimeout(warningTimer);
        playerWarning.textContent = event.message;
        playerWarning.hidden = false;
        warningTimer = setTimeout(() => { playerWarning.hidden = true; }, 5000);
        break;
      case "stopped":
        void finish(undefined, event.failed);
        break;
      case "error":
        void finish(event.cause ?? new Error(event.message));
        break;
    }
  });
  void start.then(started => {
    session = started;
    updateControls();
    if (!preparing) {
      getCheatPanel().restore(cheatContext);
      attachAutomation();
    }
  }).catch(finish);
});
