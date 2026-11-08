import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Settings, Sparkles, createIcons } from "lucide";

import { recordPageView } from "./analytics";
import type { LibraryApp, PlayerSession, Wie } from "./backend";
import { getCheatPanel } from "./cheats";
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
  Settings,
  Sparkles,
};

export const runApp = (backend: Wie, app: LibraryApp, settings: SettingsController): Promise<boolean> => new Promise((resolve, reject) => {
  const playerView = document.getElementById("player-view") as HTMLElement;
  const playerTitle = document.getElementById("player-title") as HTMLElement;
  const playerStatus = document.getElementById("player-status") as HTMLElement;
  const playerWarning = document.getElementById("player-warning") as HTMLElement;
  const backToLibrary = document.getElementById("back-to-library") as HTMLButtonElement;
  const appSettings = document.getElementById("app-settings") as HTMLButtonElement;
  const appCheats = document.getElementById("app-cheats") as HTMLButtonElement | null;
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
  };
  const finish = async (error?: unknown, failed = false) => {
    if (ending) return;
    ending = true;
    clearTimeout(warningTimer);
    abortController.abort();
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
      if (![...inputs.values()].includes(previous)) void session.key(previous, false).catch(finish);
    }
    if (key) {
      const pressed = [...inputs.values()].includes(key);
      inputs.set(source, key);
      if (!pressed) void session.key(key, true).catch(finish);
    }
  };
  const releaseKeys = () => {
    inputs.clear();
    if (session && !ending) void session.releaseKeys().catch(finish);
  };

  backToLibrary.addEventListener("click", () => { void finish(); }, { signal: abortController.signal });
  appSettings.addEventListener("click", () => {
    releaseKeys();
    settings.open();
  }, { signal: abortController.signal });
  const cheatContext = {
    appId: app.id,
    appTitle: app.title,
    getCheats: () => (session && !ending ? session.cheats : undefined),
  };
  appCheats?.addEventListener("click", () => {
    releaseKeys();
    getCheatPanel().open(cheatContext);
  }, { signal: abortController.signal });
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

  // 360° joystick: the knob follows the finger freely; the game receives the
  // dominant direction (4-way, with hysteresis so the stick doesn't flicker
  // between axes near the diagonals).
  const joystick = playerView.querySelector<HTMLElement>("#joystick");
  if (joystick) {
    const knob = joystick.querySelector<HTMLElement>(".joystick-knob")!;
    const DEAD_ZONE = 0.22;
    const AXIS_HYSTERESIS = 1.3;
    let activePointer: number | undefined;
    let centerX = 0;
    let centerY = 0;
    let radius = 1;
    let horizontal: "LEFT" | "RIGHT" | undefined;
    let vertical: "UP" | "DOWN" | undefined;

    const applyDirection = (dx: number, dy: number) => {
      const magnitude = Math.hypot(dx, dy);
      if (magnitude < DEAD_ZONE) {
        horizontal = undefined;
        vertical = undefined;
      } else {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        let useHorizontal: boolean;
        if (horizontal && !vertical) useHorizontal = ay <= ax * AXIS_HYSTERESIS;
        else if (vertical && !horizontal) useHorizontal = ax > ay * AXIS_HYSTERESIS;
        else useHorizontal = ax >= ay;
        if (useHorizontal) {
          horizontal = dx > 0 ? "RIGHT" : "LEFT";
          vertical = undefined;
        } else {
          vertical = dy > 0 ? "DOWN" : "UP";
          horizontal = undefined;
        }
      }
      setKey("joystick:h", horizontal);
      setKey("joystick:v", vertical);
    };

    const moveKnob = (dx: number, dy: number) => {
      const magnitude = Math.hypot(dx, dy);
      const limit = 0.58;
      const scale = magnitude > limit ? limit / magnitude : 1;
      knob.style.transform = `translate(${dx * scale * radius}px, ${dy * scale * radius}px)`;
    };

    const resetJoystick = () => {
      activePointer = undefined;
      joystick.classList.remove("active");
      knob.style.transform = "";
      applyDirection(0, 0);
    };

    const track = (event: PointerEvent) => {
      const dx = (event.clientX - centerX) / radius;
      const dy = (event.clientY - centerY) / radius;
      moveKnob(dx, dy);
      applyDirection(dx, dy);
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
    if (!preparing) getCheatPanel().restore(cheatContext);
  }).catch(finish);
});
