import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ellipsis, Keyboard, Map as MapIcon, Save, Settings, Sparkles, X, createIcons } from "lucide";

import { recordPageView } from "./analytics";
import type { LibraryApp, PlayerSession, Wie } from "./backend";
import { allowsCheats, clearRetiredCheats } from "./cheat_policy";
import { getCheatPanel } from "./cheats";
import { loadGamePreference } from "./game_preferences";
import { isHeroesLore3 } from "./hl3";
import { Hl3ComboTiming } from "./hl3_combo";
import { Hl3Feedback } from "./hl3_feedback";
import { Hl3MotionGame } from "./hl3_motion";
import { Hl3QuestGuide } from "./hl3_quest_guide";
import { Hl4Feedback } from "./hl4_feedback";
import { Hl4SlotIcons } from "./hl4_slots";
import { InotiaHunt } from "./inotia_hunt";
import { InBetweenFrames } from "./motion";
import { type Direction, HL4_DODGE_KEY, applyPadProfile, isHeroesLore4, isInotia, isZero, padProfileFor, remapKey } from "./pad_profile";
import type { SettingsController } from "./settings";
import { OCTANT_DIRECTIONS, pickOctant, pickStraight } from "./stick";
import { type SaveResult, ZERO_SAVE_KEY, readZeroState, saveZero } from "./zero";
import { ZeroFeedback } from "./zero_feedback";
import { openHiddenStyles, openSpirit } from "./zero_styles";

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
  if (appCheats) appCheats.hidden = !allowsCheats(app.id);
  clearRetiredCheats(app.id);
  const keypadToggle = document.getElementById("keypad-toggle") as HTMLButtonElement | null;
  const keypadSheet = document.getElementById("keypad-sheet") as HTMLElement | null;
  const keypadSheetClose = document.getElementById("keypad-sheet-close") as HTMLButtonElement | null;
  const buttons = playerView.querySelectorAll<HTMLButtonElement>("button[data-key]");
  // Some games walk with the number keys or use other quick slots: point the pad at this game's keys.
  const padProfile = padProfileFor(app);
  applyPadProfile(buttons, padProfile);
  if (padProfile.name) playerView.dataset.padProfile = padProfile.name;
  else delete playerView.dataset.padProfile;
  if (padProfile.layout) playerView.dataset.padLayout = padProfile.layout;
  else delete playerView.dataset.padLayout;
  // Landscape sizes the screen column from the game's own aspect (240×320, 176×220, ...).
  const gameCanvas = document.getElementById("canvas") as HTMLCanvasElement;
  const questGuide = backend.rendering === "canvas" && isHeroesLore3(app.id) ? new Hl3QuestGuide(gameCanvas, app.id) : undefined;
  const feedback = backend.rendering !== "canvas" ? undefined
    : isHeroesLore3(app.id) ? new Hl3Feedback(gameCanvas, app.id)
    : isZero(app) ? new ZeroFeedback(gameCanvas, app.id)
    : isHeroesLore4(app) ? new Hl4Feedback(gameCanvas, app.id)
    : undefined;
  const slotIcons = backend.rendering === "canvas" && isHeroesLore4(app) ? new Hl4SlotIcons(gameCanvas, buttons) : undefined;
  // 영웅서기 제로: its new-game screen also offers the two hidden battle styles (checked twice a second), and a
  // 정령사's menu opens the spirit from the start (every frame, so the entry is open before 5 can be pressed).
  let stylesCheckedAt = 0;
  const openStyles = isZero(app) ? () => {
    const api = session?.cheats;
    if (!api) return;
    try {
      openSpirit(api);
      const now = performance.now();
      if (now - stylesCheckedAt < 500) return;
      stylesCheckedAt = now;
      openHiddenStyles(api);
    } catch {
      // Memory not readable while the game loads; the next frame tries again.
    }
  } : undefined;
  const updateScreenRatio = () => {
    if (gameCanvas.width > 0 && gameCanvas.height > 0) playerView.style.setProperty("--screen-ratio", String(gameCanvas.width / gameCanvas.height));
  };
  const screenRatioObserver = new MutationObserver(updateScreenRatio);
  screenRatioObserver.observe(gameCanvas, { attributes: true, attributeFilter: ["width", "height"] });
  updateScreenRatio();

  const abortController = new AbortController();
  const inputs = new Map<string, string>();
  let session: PlayerSession | undefined;
  let motion: { dispose(): void } | undefined;
  let combo: Hl3ComboTiming | undefined;
  let preparing = true;
  let suspended = false;
  let ending = false;
  /** A one-tap save is walking the game's menu. */
  let saving = false;
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
    screenRatioObserver.disconnect();
    feedback?.dispose();
    motion?.dispose();
    combo = undefined;
    slotIcons?.dispose();
    questGuide?.dispose();
    hunt?.stop();
    getCheatPanel().detach(app.id);
    for (const timer of flashTimers.values()) window.clearTimeout(timer);
    for (const button of buttons) button.classList.remove("pressed", "auto-flash");
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
    // While a save walks the game's menu, the player's presses would land in it.
    if (saving && key && !source.startsWith("auto:")) return;
    const previous = inputs.get(source);
    if (previous === key) return;
    if (previous) {
      inputs.delete(source);
      if (![...inputs.values()].includes(previous)) {
        void session.key(previous, false).catch(finish);
      }
    }
    if (key) {
      if (walkKeys.has(key)) lastWalk = key;
      const pressed = [...inputs.values()].includes(key);
      inputs.set(source, key);
      if (!pressed) {
        combo?.press(key);
        void session.key(key, true).catch(finish);
      }
    }
    if (hunt && !source.startsWith("auto:")) {
      const held = [...inputs.entries()].some(([from, pressed]) => !from.startsWith("auto:") && pressed === attackKey);
      hunt.setHeld(held && loadGamePreference(app.id, "auto_approach", "on") !== "off");
    }
  };
  const attackKey = remapKey(padProfile, "OK");
  const walkKeys = new Set<string>(Object.values(padProfile.directions));
  /** The arrow the hero last walked with: 영웅서기4's 회피 taps it. */
  let lastWalk = padProfile.directions.DOWN;
  /**
   * 영웅서기4's 회피: tapping one arrow twice quickly rolls (휴먼) or teleports (네베드). An arrow the player still holds
   * is let go for the taps and held again after them.
   */
  const dodge = async () => {
    const current = session;
    if (!current || preparing || suspended || ending || saving) return;
    const key = lastWalk;
    const alive = () => session === current && !ending;
    const pause = () => new Promise(resolve => window.setTimeout(resolve, 60));
    await current.key(key, false);
    for (let tap = 0; tap < 2 && alive(); tap++) {
      await pause();
      await current.key(key, true);
      await pause();
      await current.key(key, false);
    }
    if (alive() && [...inputs.values()].includes(key)) await current.key(key, true);
  };
  /** A fresh attack press for the game, held or not by the player; the key ends up as the player holds it. */
  const strikeAttack = () => {
    const current = session;
    if (!current || ending) return;
    const held = [...inputs.values()].includes(attackKey);
    flashKey(attackKey);
    void current.key(attackKey, !held).catch(finish);
    window.setTimeout(() => {
      if (session !== current || ending) return;
      const wanted = [...inputs.values()].includes(attackKey);
      if (wanted === held) void current.key(attackKey, wanted).catch(finish);
    }, 60);
  };
  const hunt = isInotia(app)
    ? new InotiaHunt({
      getCheats: () => cheatContext.getCheats(),
      steer: key => setKey("auto:hunt", key),
      strike: strikeAttack,
      playerSteering: () => [...inputs.entries()].some(([from, pressed]) => !from.startsWith("auto:") && walkKeys.has(pressed)),
      directions: padProfile.directions,
    })
    : undefined;
  const SAVE_NOTICES: Record<Exclude<SaveResult, "stopped">, string> = {
    saved: "저장했어요",
    "not-field": "필드에서 저장 버튼을 눌러 주세요 (메뉴·대화 중에는 저장하지 않아요)",
    unreadable: "이 화면에서는 저장 버튼을 쓸 수 없어요. 메뉴 → 7 시스템 → 세이브로 저장해 주세요",
    failed: "저장 창이 예상과 달라 멈췄어요. 메뉴 → 7 시스템 → 세이브로 저장해 주세요",
  };
  /** One-tap save through the game's own menu (영웅서기 제로), checking every window before the next key. */
  const saveFromField = async () => {
    const current = session;
    if (saving || !current || preparing || suspended || ending) return;
    saving = true;
    releaseKeys();
    const alive = () => session === current && !ending && !suspended;
    let result: SaveResult = "stopped";
    try {
      result = await saveZero({
        press: async key => {
          if (!alive()) return;
          flashKey(key);
          setKey("auto:save", key);
          await new Promise(resolve => window.setTimeout(resolve, 90));
          setKey("auto:save");
          await new Promise(resolve => window.setTimeout(resolve, 60));
        },
        frame: () => {
          if (backend.rendering !== "canvas") return undefined;
          try {
            return gameCanvas.getContext("2d")?.getImageData(0, 0, gameCanvas.width, gameCanvas.height) ?? undefined;
          } catch {
            return undefined;
          }
        },
        sleep: ms => new Promise(resolve => window.setTimeout(resolve, ms)),
        alive,
        state: () => readZeroState(cheatContext.getCheats()),
      });
    } finally {
      saving = false;
      if (alive()) setKey("auto:save");
    }
    if (result === "stopped" || ending) return;
    clearTimeout(warningTimer);
    playerWarning.textContent = SAVE_NOTICES[result];
    playerWarning.hidden = false;
    warningTimer = setTimeout(() => { playerWarning.hidden = true; }, result === "saved" ? 2000 : 5000);
  };
  const releaseKeys = () => {
    hunt?.stop();
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
  padMore?.setAttribute("aria-label", allowsCheats(app.id) ? "설정·치트·나가기 메뉴" : "설정·나가기 메뉴");
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
  appCheats?.addEventListener("click", () => {
    releaseKeys();
    if (allowsCheats(app.id)) getCheatPanel().open(cheatContext);
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
        // Page actions are never sent to the game as keys.
        if (key === ZERO_SAVE_KEY) {
          void saveFromField();
          return;
        }
        if (key === HL4_DODGE_KEY) {
          void dodge().catch(finish);
          return;
        }
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
  // The base then stays put for the whole touch: a base that trailed the thumb crept up the screen, and pulling the
  // thumb back down kept pressing up until it crossed the moved centre. What the stick shows is what it sends.
  // Directions are four 90° sectors with some hysteresis, sent as one key at a time (the old key is released before
  // the new one is pressed, so turning never leaves two held).
  const joystickZone = playerView.querySelector<HTMLElement>(".joystick-zone");
  const joystick = joystickZone?.querySelector<HTMLElement>("#joystick");
  if (joystickZone && joystick) {
    const zone = joystickZone;
    const knob = joystick.querySelector<HTMLElement>(".joystick-knob")!;
    const SECTOR_DIRECTIONS: readonly Direction[] = ["RIGHT", "DOWN", "LEFT", "UP"];
    const ENGAGE_PX = 10;
    const RELEASE_PX = 6;
    const HYSTERESIS_DEG = 10;
    let activePointer: number | undefined;
    let zoneRect = zone.getBoundingClientRect();
    let originX = 0;
    let originY = 0;
    let radius = 1;
    let sector: number | undefined;

    // Games that walk diagonally (영웅서기 제로) get eight sectors and hold both keys of a diagonal, each from its own
    // source: turning from up to up-right only adds right, and from up-right to right only lets go of up. Keys that
    // go away are released before new ones are pressed. In the game's cursor windows (menu, shop, choices) the stick
    // is a d-pad instead: one straight direction, pressed again every REPEAT_MS while held, since those windows move
    // one step per press and would otherwise need a flick per item.
    const REPEAT_DELAY_MS = 380;
    const REPEAT_MS = 130;
    const REPEAT_GAP_MS = 40;
    let held: [string, string | undefined][] = [];
    let repeatSector: number | undefined;
    let repeatTimer: number | undefined;
    const windowed = () => padProfile.windowed?.(cheatContext.getCheats()) ?? false;
    const stopRepeat = () => {
      window.clearTimeout(repeatTimer);
      repeatTimer = undefined;
      repeatSector = undefined;
    };
    const repeat = () => {
      repeatTimer = undefined;
      if (sector === undefined || sector !== repeatSector || !windowed()) {
        repeatSector = undefined;
        return;
      }
      const keys = held;
      for (const [source] of keys) setKey(source);
      repeatTimer = window.setTimeout(() => {
        repeatTimer = undefined;
        if (sector !== repeatSector) return;
        for (const [source, key] of keys) if (key) setKey(source, key);
        repeatTimer = window.setTimeout(repeat, REPEAT_MS - REPEAT_GAP_MS);
      }, REPEAT_GAP_MS);
    };
    const applyOctant = (dx: number, dy: number) => {
      const magnitude = Math.hypot(dx, dy);
      const cursor = windowed();
      if (magnitude < (sector === undefined ? ENGAGE_PX : RELEASE_PX)) {
        sector = undefined;
      } else {
        let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (angle < 0) angle += 360;
        sector = cursor ? pickStraight(angle, sector) : pickOctant(angle, sector);
      }
      const directions = sector === undefined ? [] : OCTANT_DIRECTIONS[sector];
      joystick.dataset.direction = directions.map(direction => direction.toLowerCase()).join(" ");
      const vertical = directions.find(direction => direction === "UP" || direction === "DOWN");
      const horizontal = directions.find(direction => direction === "LEFT" || direction === "RIGHT");
      held = [
        ["joystick:v", vertical && padProfile.directions[vertical]],
        ["joystick:h", horizontal && padProfile.directions[horizontal]],
      ];
      if (sector !== repeatSector) stopRepeat();
      for (const [source, key] of held) if (inputs.get(source) !== key) setKey(source);
      for (const [source, key] of held) if (key) setKey(source, key);
      if (cursor && sector !== undefined && repeatSector === undefined) {
        repeatSector = sector;
        repeatTimer = window.setTimeout(repeat, REPEAT_DELAY_MS);
      }
    };

    const applyDirection = (dx: number, dy: number) => {
      if (padProfile.diagonals) {
        applyOctant(dx, dy);
        return;
      }
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
      const dx = event.clientX - originX;
      const dy = event.clientY - originY;
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
      if (padProfile.diagonals) stopRepeat();
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
        sector = undefined;
        // Pressing the resting stick's rim works like a d-pad: that is already a direction from its centre.
        // Anywhere else the stick comes to the thumb and starts neutral, unless the profile pins it in place.
        const fromRing = Math.hypot(event.clientX - ringX, event.clientY - ringY);
        const onRim = !joystick.classList.contains("active") && fromRing <= radius && fromRing >= radius * 0.45;
        if (padProfile.stick === "fixed" || onRim) {
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
        if (!preparing && !suspended) {
          feedback?.sample(session?.cheats);
          combo?.sample(performance.now());
          slotIcons?.update();
          openStyles?.();
          questGuide?.sample(session);
        }
        break;
      case "ready":
        if (preparing) recordPageView(app.title);
        preparing = false;
        updateControls();
        getCheatPanel().restore(cheatContext);
        break;
      case "suspended":
        suspended = event.suspended;
        feedback?.clear();
        questGuide?.clear();
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
    if (started?.guest && isHeroesLore3(app.id)) motion = new InBetweenFrames(started, gameCanvas, new Hl3MotionGame(), app.id);
    if (started && isHeroesLore3(app.id)) combo = new Hl3ComboTiming(started);
    questGuide?.attach(started);
    updateControls();
    if (!preparing) {
      getCheatPanel().restore(cheatContext);
    }
  }).catch(finish);
});
