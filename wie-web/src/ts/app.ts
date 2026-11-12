import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ellipsis, Keyboard, Map as MapIcon, Save, Settings, Sparkles, X, createIcons } from "lucide";

import { recordPageView } from "./analytics";
import { type AutoConfig, SLOT_KEYS, type SlotKey, automation, macroCandidates, skillSlotKeys } from "./automation";
import type { LibraryApp, PlayerSession, Wie } from "./backend";
import { getCheatPanel } from "./cheats";
import { isHeroesLore3, readSkills } from "./hl3";
import { Hl3Feedback } from "./hl3_feedback";
import { type Direction, applyPadProfile, padProfileFor, remapKey } from "./pad_profile";
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
const DIRECTION_KEYS = new Set(["UP", "DOWN", "LEFT", "RIGHT"]);
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
  // Some games walk with the number keys or use other quick slots: point the pad at this game's keys.
  const padProfile = padProfileFor(app);
  applyPadProfile(buttons, padProfile);
  if (padProfile.name) playerView.dataset.padProfile = padProfile.name;
  else delete playerView.dataset.padProfile;
  // Landscape sizes the screen column from the game's own aspect (240×320, 176×220, ...).
  const gameCanvas = document.getElementById("canvas") as HTMLCanvasElement;
  const feedback = backend.rendering === "canvas" && isHeroesLore3(app.title, app.filename) ? new Hl3Feedback(gameCanvas) : undefined;
  const updateScreenRatio = () => {
    if (gameCanvas.width > 0 && gameCanvas.height > 0) playerView.style.setProperty("--screen-ratio", String(gameCanvas.width / gameCanvas.height));
  };
  const screenRatioObserver = new MutationObserver(updateScreenRatio);
  screenRatioObserver.observe(gameCanvas, { attributes: true, attributeFilter: ["width", "height"] });
  updateScreenRatio();

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
    screenRatioObserver.disconnect();
    feedback?.dispose();
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

  const flashTimers = new Map<HTMLButtonElement, number>();
  /** Light up a pad button for a moment when the automation presses its key. */
  const flashKey = (key: string) => {
    for (const button of buttons) {
      if (button.dataset.key !== key) continue;
      button.classList.add("pressed", "auto-flash");
      window.clearTimeout(flashTimers.get(button));
      flashTimers.set(button, window.setTimeout(() => button.classList.remove("pressed", "auto-flash"), 220));
    }
  };
  const setKey = (source: string, key?: string) => {
    if (!session || preparing || suspended || ending) return;
    // Face the nearest monster (or NPC to talk to) unless the player is steering with a direction key.
    if (key === "OK" && inputs.get(source) !== "OK" && ![...inputs.values()].some(held => DIRECTION_KEYS.has(held))) {
      automation.aim(!source.startsWith("auto:"));
    }
    // While the player mashes attack, the automation turns some of those presses into skill keys.
    if (key === "OK" && !source.startsWith("auto:")) {
      const replacement = automation.interceptAttack();
      if (replacement) {
        key = replacement;
        flashKey(replacement);
      }
    }
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
    flashKey(key);
    setKey(source, key);
    window.setTimeout(() => setKey(source), holdMs);
  };
  const slotCaptions = new Map<HTMLButtonElement, string>();
  const macroButtons = playerView.querySelectorAll<HTMLButtonElement>("button[data-macro]");
  const macroBar = playerView.querySelector<HTMLElement>(".pad-macros");
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
    if (macroBar) macroBar.hidden = !anyMacro;
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
    showPadTools(padTools?.hidden !== false);
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

  // iOS turns a held or sliding touch into its own gestures (loupe, callout, pinch zoom) and then cancels the touch:
  // the stick or a held button would let go on its own. The pad's keys and stick work from pointer events only, so
  // their touches never need the browser's default handling. (The ⋯ tools still use clicks and keep theirs.)
  const pad = playerView.querySelector<HTMLElement>(".pad");
  const keepTouch = (event: TouchEvent) => {
    if (event.cancelable && event.target instanceof Element && event.target.closest(".key, .joystick-zone")) event.preventDefault();
  };
  pad?.addEventListener("touchstart", keepTouch, { passive: false, signal: abortController.signal });
  pad?.addEventListener("touchmove", keepTouch, { passive: false, signal: abortController.signal });
  document.addEventListener("gesturestart", event => event.preventDefault(), { signal: abortController.signal });

  // Floating joystick: a touch anywhere in the left zone puts the stick under the thumb, so it never has to be found.
  // The base follows the thumb only once it pulls past the knob's reach, so relaxing the thumb a little keeps walking;
  // what the stick shows is exactly what it sends. Directions are four 90° sectors with some hysteresis, sent as one
  // key at a time (the old key is released before the new one is pressed, so turning never leaves two held).
  const joystickZone = playerView.querySelector<HTMLElement>(".joystick-zone");
  const joystick = joystickZone?.querySelector<HTMLElement>("#joystick");
  if (joystickZone && joystick) {
    const zone = joystickZone;
    const knob = joystick.querySelector<HTMLElement>(".joystick-knob")!;
    const SECTOR_DIRECTIONS: readonly Direction[] = ["RIGHT", "DOWN", "LEFT", "UP"];
    const ENGAGE_PX = 10;
    const RELEASE_PX = 6;
    const HYSTERESIS_DEG = 10;
    const REACH = 0.7;
    let activePointer: number | undefined;
    let zoneRect = zone.getBoundingClientRect();
    let originX = 0;
    let originY = 0;
    let radius = 1;
    let reach = 1;
    let sector: number | undefined;

    const applyDirection = (dx: number, dy: number) => {
      const magnitude = Math.hypot(dx, dy);
      if (magnitude < (sector === undefined ? ENGAGE_PX : RELEASE_PX)) {
        sector = undefined;
      } else {
        let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (angle < 0) angle += 360;
        const nearest = Math.round(angle / 90) % 4;
        if (sector === undefined) sector = nearest;
        else {
          let delta = angle - sector * 90;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          if (Math.abs(delta) > 45 + HYSTERESIS_DEG) sector = nearest;
        }
      }
      const direction = sector === undefined ? undefined : SECTOR_DIRECTIONS[sector];
      joystick.dataset.direction = direction?.toLowerCase() ?? "";
      setKey("joystick", direction && padProfile.directions[direction]);
    };

    const track = (event: PointerEvent) => {
      let dx = event.clientX - originX;
      let dy = event.clientY - originY;
      const distance = Math.hypot(dx, dy);
      if (distance > reach) {
        originX = event.clientX - (dx * reach) / distance;
        originY = event.clientY - (dy * reach) / distance;
        dx = event.clientX - originX;
        dy = event.clientY - originY;
      }
      // Draw the base where it is, kept mostly inside the zone; the knob sits under the thumb within the ring.
      const clamp = (value: number, size: number) => Math.min(Math.max(value, radius * 0.6), size - radius * 0.6);
      const ringX = clamp(originX - zoneRect.left, zoneRect.width);
      const ringY = clamp(originY - zoneRect.top, zoneRect.height);
      joystick.style.left = `${ringX}px`;
      joystick.style.top = `${ringY}px`;
      let knobX = event.clientX - zoneRect.left - ringX;
      let knobY = event.clientY - zoneRect.top - ringY;
      const knobDistance = Math.hypot(knobX, knobY);
      const knobLimit = radius * 0.72;
      if (knobDistance > knobLimit) {
        knobX = (knobX * knobLimit) / knobDistance;
        knobY = (knobY * knobLimit) / knobDistance;
      }
      knob.style.transform = `translate(${knobX}px, ${knobY}px)`;
      applyDirection(dx, dy);
    };

    const resetJoystick = () => {
      activePointer = undefined;
      sector = undefined;
      joystick.classList.remove("active");
      joystick.style.left = "";
      joystick.style.top = "";
      knob.style.transform = "";
      applyDirection(0, 0);
    };

    zone.addEventListener(
      "pointerdown",
      (event) => {
        event.preventDefault();
        // A new touch always takes over. If the browser never delivered the end of the previous one (iOS can drop
        // it when a touch slides off or another finger lands), ignoring new touches left the stick stuck.
        if (activePointer !== undefined && activePointer !== event.pointerId && zone.hasPointerCapture(activePointer)) {
          zone.releasePointerCapture(activePointer);
        }
        zoneRect = zone.getBoundingClientRect();
        const ring = joystick.getBoundingClientRect();
        radius = Math.max(1, ring.width / 2);
        const ringX = ring.left + radius;
        const ringY = ring.top + radius;
        reach = radius * REACH;
        sector = undefined;
        // Pressing the resting stick's rim works like a d-pad: that is already a direction from its centre.
        // Anywhere else the stick comes to the thumb and starts neutral.
        const fromRing = Math.hypot(event.clientX - ringX, event.clientY - ringY);
        if (!joystick.classList.contains("active") && fromRing <= radius && fromRing >= radius * 0.45) {
          originX = ringX;
          originY = ringY;
        } else {
          originX = event.clientX;
          originY = event.clientY;
        }
        activePointer = event.pointerId;
        zone.setPointerCapture(event.pointerId);
        joystick.classList.add("active");
        track(event);
      },
      { signal: abortController.signal },
    );
    zone.addEventListener(
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
    zone.addEventListener("pointerup", endJoystick, { signal: abortController.signal });
    zone.addEventListener("pointercancel", endJoystick, { signal: abortController.signal });
    zone.addEventListener("lostpointercapture", endJoystick, { signal: abortController.signal });
    // Backstop for a release that does not reach the stick itself.
    window.addEventListener("pointerup", endJoystick, { signal: abortController.signal });
    window.addEventListener("pointercancel", endJoystick, { signal: abortController.signal });
    abortController.signal.addEventListener("abort", resetJoystick);
  }

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.target instanceof HTMLElement && event.target.closest("dialog")) {
        return;
      }

      const mapped = KEY_MAP[event.code];
      // Arrow keys walk like the joystick does.
      const key = mapped && DIRECTION_KEYS.has(mapped) ? padProfile.directions[mapped as Direction] : mapped && remapKey(padProfile, mapped);
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
      case "frame":
        if (!preparing && !suspended) feedback?.sample(session?.cheats);
        break;
      case "ready":
        if (preparing) recordPageView(app.title);
        preparing = false;
        updateControls();
        getCheatPanel().restore(cheatContext);
        attachAutomation();
        break;
      case "suspended":
        suspended = event.suspended;
        feedback?.clear();
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
