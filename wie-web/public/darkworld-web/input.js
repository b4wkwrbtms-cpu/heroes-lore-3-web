// Input for the web version: on-screen touch controls, keyboard and gamepad.
// Same model as the PC version (validated there): every control becomes a logical button; buttons are sent to the
// game as phone key events (direction, attack repeat, held-skill re-cast, dash), menus/other UI get the single touch.
'use strict';
(() => {
const I = () => window.DWInternals;
const M = () => I().M;
const canvas = document.getElementById('screen');
const B = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, OK: 4, CLR: 5, Q1: 6, Q2: 7, Q3: 8, Q4: 9, Q5: 10, Q6: 11, SWAP: 12, MENU: 13, DASH: 14, COUNT: 15 };
const PAD_CODE = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 8, 7, 13, 14, 0];
const PHONE_KEY = [0, -4, -3, -1, -2, -5, -16, 48, 42, 49, 51, 55, 57, 35, -10];
const src = { key: new Array(B.COUNT).fill(false), touch: new Array(B.COUNT).fill(false), pad: new Array(B.COUNT).fill(false) };
const latched = new Array(B.COUNT).fill(false);
let order = [];
const held = (b) => src.key[b] || src.touch[b] || src.pad[b] || latched[b];
function press(b, down, s) {
  if (s[b] === down) return;
  s[b] = down;
  if (down) { latched[b] = true; order = order.filter((x) => x !== b); order.push(b); }
}
const rd32 = (a) => M()._dw_read32(a) >>> 0;
function phoneKey(code) {
  if (code === 7 || code === 8 || code === 11 || code === 12) { if (rd32(0x101ae008) & 0x100) code += (code === 7 || code === 11) ? 1 : -1; }
  return PHONE_KEY[code];
}
// mirror of the runner's held-shortcut filter (repeat only when the slot holds a ready skill)
function skillReady(code) {
  if (code < 7 || code > 12) return false;
  if (rd32(0x100c5694) & 0x100) code += (code === 7 || code === 11) ? 1 : -1;
  const set = rd32(0x100bed18) & 0xff; if (set > 1) return false;
  let w = code - 7; w = w < 2 ? 5 - w : w - 2;
  const base = 0x100e9d17 + set * 0x2d + w * 7;
  const v = rd32(base), kind = v & 0xff; if (kind > 1) return false;
  const flag = kind ? (v >>> 16) & 0xff : (v >>> 8) & 0xff; if (flag !== 1) return false;
  const id = rd32(base + kind + 3) & 0xff; if (id > 0x31) return false;
  if ((rd32(0x102d9f00) & 9) === 9) return true;
  return (rd32(0x100e668a + id * 2) & 0xffff) === 0;
}
let areas = [];
const areaByKey = (k) => areas.findIndex((a) => a.on && a.key === k);
const inGame = () => areaByKey(43) >= 0 && areaByKey(13) >= 0;
const kdown = (k) => M()._dw_event(1, 2, k, 0), kup = (k) => M()._dw_event(1, 3, k, 0);

// ------------------------------------------------------------------ touch
const toGame = (e) => {
  const v = I().view, d = v.dpr, [cx, cy] = window.Layout.toCanvas(e);
  return [((cx * d - v.x) * 480 / v.w), ((cy * d - v.y) * 320 / v.h)];
};
const pointers = new Map();  // id -> { role: 'dir'|'btn'|'touch', b, x, y }
let touchPtr = null;         // pointer id driving the game's single touch
let touchState = null;       // { kind: 'down'|'move'|'up', x, y } pending for the next tick
const pending = [];
function controlAt(gx, gy) {
  if (I().Input_skinMode !== 1 || !inGame() || I().settings.buttons === 0) return null;
  if (I().padUiOn(1)) {  // pad UI: only the moved skill bar is touchable
    for (let i = 8; i <= 13; i++) { const a = areas[i]; if (a && a.on && (gx - I().padNx(i)) ** 2 + (gy - I().PAD_NY) ** 2 <= 20 * 20) return { role: 'btn', b: B.Q1 + (i - 8) }; }
    const sw = areas[14]; if (sw && sw.on && (gx - I().padNx(14)) ** 2 + (gy - I().PAD_NY) ** 2 <= 20 * 20) return { role: 'btn', b: B.SWAP };
    return null;
  }
  const [dx, dy, dr] = I().dashSpot();
  if ((gx - dx) ** 2 + (gy - dy) ** 2 <= (dr + 5) ** 2) return { role: 'btn', b: B.DASH };
  const d = areas[15];
  if (d && d.on && Math.abs(gx - d.cx) <= 58 && Math.abs(gy - d.cy) <= 58) return { role: 'dir' };
  const a0 = areas[0];
  if (a0 && a0.on && (gx - a0.cx) ** 2 + (gy - a0.cy) ** 2 <= 28 * 28) return { role: 'btn', b: B.OK };
  for (let i = 8; i <= 13; i++) { const a = areas[i]; if (a && a.on && (gx - a.cx) ** 2 + (gy - a.cy) ** 2 <= 20 * 20) return { role: 'btn', b: B.Q1 + (i - 8) }; }
  const s = areas[14];
  if (s && s.on && gx >= s.x1 - 4 && gx <= s.x2 + 4 && gy >= s.y1 - 4 && gy <= s.y2 + 4) return { role: 'btn', b: B.SWAP };
  return null;
}
function dirFrom(p) {
  const d = areas[15]; if (!d) return -1;
  const dx = p.x - d.cx, dy = p.y - d.cy;
  if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return -1;
  return Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? B.LEFT : B.RIGHT) : (dy < 0 ? B.UP : B.DOWN);
}
function refreshTouchButtons() {
  const want = new Array(B.COUNT).fill(false);
  for (const p of pointers.values()) {
    if (p.role === 'btn') want[p.b] = true;
    else if (p.role === 'dir') { const b = dirFrom(p); if (b >= 0) want[b] = true; }
  }
  for (let b = 0; b < B.COUNT; b++) press(b, want[b], src.touch);
}
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (I().Boss.active) { I().Boss.skip(); return; }
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  const [x, y] = toGame(e);
  const c = controlAt(x, y);
  if (c) { pointers.set(e.pointerId, { role: c.role, b: c.b, x, y }); refreshTouchButtons(); return; }
  if (touchPtr !== null) return;           // the game follows one finger for plain touches
  touchPtr = e.pointerId; pointers.set(e.pointerId, { role: 'touch', x, y });
  pending.push([0x17, x, y]);
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId); if (!p) return;
  const [x, y] = toGame(e); p.x = x; p.y = y;
  if (p.role === 'touch') pending.push([0x19, x, y]);
  else if (p.role === 'dir') refreshTouchButtons();
});
const lift = (e) => {
  const p = pointers.get(e.pointerId); if (!p) return;
  pointers.delete(e.pointerId);
  if (p.role === 'touch') { pending.push([0x18, p.x, p.y]); touchPtr = null; }
  refreshTouchButtons();
};
canvas.addEventListener('pointerup', lift); canvas.addEventListener('pointercancel', lift);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ------------------------------------------------------------------ key / pad map (changeable in 키 설정, same defaults as the PC version)
// action ids (PC order): 0 위 1 아래 2 왼쪽 3 오른쪽 4 확인·공격 5 취소 6~11 스킬1~6 12 세트 전환 13 Start 14 지도 15 저장 16 대시
const ACTIONS = ['위', '아래', '왼쪽', '오른쪽', '확인 · 공격', '취소 (CLR)', '스킬 1', '스킬 2', '스킬 3', '스킬 4', '스킬 5', '스킬 6', '스킬 세트 전환', 'Start (메뉴)', '지도', '저장 (SAVE)', '대시'];
const A2B = [B.UP, B.DOWN, B.LEFT, B.RIGHT, B.OK, B.CLR, B.Q1, B.Q2, B.Q3, B.Q4, B.Q5, B.Q6, B.SWAP, B.MENU, 'MAP', 'SAVE', B.DASH];
const KB_DEFAULT = [['ArrowUp', 'KeyW'], ['ArrowDown', 'KeyS'], ['ArrowLeft', 'KeyA'], ['ArrowRight', 'KeyD'], ['KeyZ', 'Space'], ['KeyX', 'Escape'],
  ['Digit1', 'KeyU'], ['Digit2', 'KeyI'], ['Digit3', 'KeyO'], ['Digit4', 'KeyH'], ['Digit5', 'KeyL'], ['Digit6', 'Semicolon'],
  ['KeyQ', 'Tab'], ['KeyC', ''], ['KeyM', ''], ['KeyP', 'F5'], ['ShiftLeft', 'KeyV']];
const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L스틱', 'R스틱'];
const PAD_DEFAULT = [4, 5, 6, 7, 10, 8, 11, 9, 12, 13, 16, 12];  // pad button index -> action id
const RESERVED = /^F([1-4]|[6-9]|1[0-2])$/;  // F5 is a game key by default; other F keys are the page's own
const KS = () => { const s = I().settings; if (!s.kb) s.kb = KB_DEFAULT.map((x) => x.slice()); if (!s.pad) s.pad = PAD_DEFAULT.slice(); return s; };
function actionOfKey(code) {
  const kb = KS().kb;
  for (let a = 0; a < kb.length; a++) if (kb[a][0] === code || kb[a][1] === code) return a;
  if (code === 'Enter') return 4;          // fixed extras when not bound to anything else
  if (code === 'Backspace') return 5;
  return -1;
}
// MAP / SAVE: touch the game's MAP / SAVE button, like the PC version
const tapHeld = new Map();
function tapAction(id, which, down) {
  if (down) {
    if (tapHeld.has(id)) return;
    areas = I().readAreas();
    const i = areaByKey(which === 'MAP' ? 10 : 32); if (i < 0) return;
    const a = areas[i]; tapHeld.set(id, [a.cx, a.cy]); pending.push([0x17, a.cx, a.cy]);
  } else {
    const p = tapHeld.get(id); if (!p) return;
    tapHeld.delete(id); pending.push([0x18, p[0], p[1]]);
  }
}
const menuOpen = () => document.getElementById('menu').classList.contains('open');
const keyDown = new Map();
window.addEventListener('keydown', (e) => {
  if (menuOpen() || (window.DWInput && window.DWInput.capturing)) return;
  if (I().Boss.active) { I().Boss.skip(); e.preventDefault(); return; }
  const a = actionOfKey(e.code); if (a < 0) return;
  e.preventDefault();
  if (keyDown.has(e.code)) return;
  keyDown.set(e.code, a);
  const t = A2B[a];
  if (typeof t === 'string') tapAction('k' + e.code, t, true); else press(t, true, src.key);
});
window.addEventListener('keyup', (e) => {
  if (!keyDown.has(e.code)) return;
  const a = keyDown.get(e.code); keyDown.delete(e.code);
  const t = A2B[a];
  if (typeof t === 'string') tapAction('k' + e.code, t, false);
  else { let still = false; for (const v of keyDown.values()) if (A2B[v] === t) still = true; if (!still) press(t, false, src.key); }
});
window.addEventListener('blur', () => { for (let b = 0; b < B.COUNT; b++) src.key[b] = false; keyDown.clear(); });

// ------------------------------------------------------------------ gamepad (standard mapping; directions = d-pad + left stick)
let padPrev = [];
function padRaw() {
  const raw = new Array(12).fill(false), dir = [false, false, false, false];
  if (!navigator.getGamepads) return { raw, dir };
  for (const gp of navigator.getGamepads()) {
    if (!gp || !gp.connected) continue;
    for (let i = 0; i < 12; i++) { const bt = gp.buttons[i]; if (bt && (bt.pressed || bt.value > 0.4)) raw[i] = true; }
    const btn = (i) => gp.buttons[i] && gp.buttons[i].pressed;
    const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
    if (btn(12) || ay < -0.4) dir[0] = true; if (btn(13) || ay > 0.4) dir[1] = true;
    if (btn(14) || ax < -0.4) dir[2] = true; if (btn(15) || ax > 0.4) dir[3] = true;
  }
  return { raw, dir };
}
function pollPad() {
  const { raw, dir } = padRaw();
  if (window.DWInput && window.DWInput.padCapture) {  // 키 설정 is waiting for a pad button
    for (let i = 0; i < 12; i++) if (raw[i] && !padPrev[i]) { window.DWInput.padCapture(i); break; }
    padPrev = raw; return;
  }
  const now = new Array(B.COUNT).fill(false);
  for (let k = 0; k < 4; k++) if (dir[k]) now[[B.UP, B.DOWN, B.LEFT, B.RIGHT][k]] = true;
  const pad = KS().pad;
  for (let i = 0; i < 12; i++) {
    const a = pad[i]; if (a === undefined || a < 0) continue;
    const t = A2B[a];
    if (typeof t === 'string') { if (raw[i] !== !!padPrev[i]) tapAction('p' + i, t, raw[i]); }
    else if (raw[i]) now[t] = true;
  }
  padPrev = raw;
  for (let b = 0; b < B.COUNT; b++) press(b, now[b], src.pad);
}

// ------------------------------------------------------------------ per tick (port of the PC reconcile())
const sent = new Array(B.COUNT).fill(0), holdTicks = new Array(B.COUNT).fill(0);
let idleTicks = 0, okOwner = -1;
let dirSent = -1, attackRepeat = false, dashPrev = false, dashKey = 0, dashRelease = 0, dashIdle = 0;
let gameTouch = null, feedbackArea = -1;

function reconcile() {
  areas = I().readAreas();
  // playing = HUD in play mode (skin flag 1); menus/settings (flag 2) get no attack repeat / skill re-cast / dash
  // a game message box (YES/NO 등, MB 열림 플래그 0x100c5750) open over the play HUD: keys go to the box as plain
  // presses, so no attack repeat / direction re-press / dash (the re-press flipped the YES/NO cursor back)
  const mbOpen = (rd32(0x100c5750) & 0xff) !== 0;
  const playing = inGame() && (M().classicArt ? I().fieldPlay() : (rd32(0x10296000) & 0xff) === 1) && !mbOpen;
  let resume = false;
  let dir = -1;
  for (let i = order.length - 1; i >= 0; i--) if (order[i] <= B.RIGHT && held(order[i])) { dir = order[i]; break; }
  if (dir !== dirSent) { if (dirSent >= 0) kup(PHONE_KEY[PAD_CODE[dirSent]]); if (dir >= 0) kdown(PHONE_KEY[PAD_CODE[dir]]); dirSent = dir; }
  for (let b = B.OK; b < B.COUNT; b++) {
    if (!PAD_CODE[b]) continue;
    const want = held(b);
    if (b === B.OK) {
      // a press that began in a dialog / menu / message box (or in play) only counts in that mode: when the mode
      // changes while it is still held (talk closes, menu opens), ignore it until released, so closing an NPC talk
      // with the attack key does not start the talk again (and talking does not skip the first line)
      if (!want) okOwner = -1;
      else if (okOwner < 0) okOwner = playing ? 1 : 0;
      if (want && okOwner !== (playing ? 1 : 0)) {
        if (sent[b]) { kup(sent[b]); sent[b] = 0; }
        holdTicks[b] = 0; attackRepeat = false;
        continue;
      }
      if (!want && playing) holdTicks[b] = 0;
    }
    if (b === B.OK && playing) {
      if (want) {
        if (!sent[b]) { kdown(attackRepeat ? -105 : -5); sent[b] = -5; attackRepeat = true; }
        else { kup(-5); sent[b] = 0; }
      } else {
        if (sent[b]) { kup(-5); sent[b] = 0; }
        if (attackRepeat) { attackRepeat = false; resume = true; }
      }
      continue;
    }
    if (want && !sent[b] && !holdTicks[b]) { sent[b] = phoneKey(PAD_CODE[b]); kdown(sent[b]); holdTicks[b] = 1; }
    else if (want) {
      holdTicks[b]++;
      const skill = b >= B.Q1 && b <= B.Q6;
      if (skill && playing && holdTicks[b] >= 4 && holdTicks[b] % 3 === 1) {
        if (sent[b]) { kup(sent[b]); sent[b] = 0; }
        if (skillReady(PAD_CODE[b])) { const k = phoneKey(PAD_CODE[b]); kdown(k); kup(k); }
        resume = true;
      }
    } else {
      if (sent[b]) { kup(sent[b]); sent[b] = 0; resume = true; }
      holdTicks[b] = 0;
    }
  }
  if (resume && dirSent >= 0) kdown(PHONE_KEY[PAD_CODE[dirSent]]);
  // a direction pressed while the hero was busy (attack / skill animation) is ignored by the game, and it does not
  // start walking by itself afterwards: when the hero is idle (state 0) for 2 ticks with a direction held, press it again
  {
    let busy = dashKey !== 0;
    for (let b = B.OK; b < B.COUNT; b++) if (held(b)) busy = true;
    if (playing && dirSent >= 0 && !busy && rd32(0x100d4dc4 + 0x104) === 0) {
      if (++idleTicks === 2) { const k = PHONE_KEY[PAD_CODE[dirSent]]; kup(k); kdown(k); }
    } else idleTicks = 0;
  }
  // DASH: double-tap of the held direction (or the facing direction)
  const dash = held(B.DASH);
  // release the dash once the dash motion is over (hero state 2 = dashing), so a held direction resumes walking
  if (dashKey) dashIdle = rd32(0x100d4dc4 + 0x104) !== 2 ? dashIdle + 1 : 0;
  if (dashKey && ++dashRelease >= 6 && (dashIdle >= 2 || dashRelease >= 30)) { kup(dashKey); dashKey = 0; dashRelease = 0; if (dirSent >= 0) kdown(PHONE_KEY[PAD_CODE[dirSent]]); }
  if (dash && !dashPrev && playing && !dashKey) {
    if (dirSent >= 0) { const k = PHONE_KEY[PAD_CODE[dirSent]]; kup(k); kdown(k); kup(k); kdown(k); dashKey = k; dashRelease = 0; }
    else {
      const f = (rd32(0x100d4dd0) >> 16) << 16 >> 16; let k;
      if (f === 1) k = -4; else if (f === -1) k = -3; else if (f === 2) k = -1; else k = -2;
      if (rd32(0x100c5694) === 1) k = k === -4 ? -2 : k === -3 ? -1 : k === -2 ? -3 : -4;
      kdown(k); kup(k); kdown(k); dashKey = k; dashRelease = 0;
    }
  }
  dashPrev = dash;
  // plain touches (menus, MAP/SAVE/CLR, anything that is not an on-screen control)
  let downNow = false;
  while (pending.length) {
    // a lift right after a press waits for the next frame, so the game sees the press for a frame: iOS gives a tap at
    // the screen edge (MAP, CLR, SAVE) as a press and a lift at once
    if (downNow && pending[0][0] === 0x18) break;
    const [t, x, y] = pending.shift();
    if (t === 0x17) downNow = true;
    const gx = Math.max(0, Math.min(479, Math.round(x))), gy = Math.max(0, Math.min(319, Math.round(y)));
    if (t === 0x17) { if (gameTouch) M()._dw_event(0, 0x18, gameTouch.x, gameTouch.y); gameTouch = { x: gx, y: gy }; M()._dw_event(0, 0x17, gx, gy); }
    else if (t === 0x19) { if (gameTouch && (gameTouch.x !== gx || gameTouch.y !== gy)) { gameTouch = { x: gx, y: gy }; M()._dw_event(0, 0x19, gx, gy); } }
    else if (gameTouch) { M()._dw_event(0, 0x18, gameTouch.x, gameTouch.y); gameTouch = null; }
  }
  feedbackArea = -1;
  if (gameTouch) for (let i = 0; i < 25; i++) { const a = areas[i]; if (a.on && a.key >= 0 && gameTouch.x >= a.x1 && gameTouch.x < a.x2 && gameTouch.y >= a.y1 && gameTouch.y < a.y2) { feedbackArea = i; break; } }
}

window.DWInput = {
  touchActive() { return !!gameTouch; },
  dashHeld() { return held(B.DASH); },
  ACTIONS, KB_DEFAULT, PAD_DEFAULT, PAD_NAMES, RESERVED, keymap: KS, capturing: false, padCapture: null, padRaw,
  set skinMode(v) { I().Input_skinMode = v; },
  get skinMode() { return I().Input_skinMode; },
  beforeTick() { pollPad(); reconcile(); },
  afterTick() { for (let b = 0; b < B.COUNT; b++) latched[b] = false; },
  feedback(i) {
    if (i === feedbackArea) return true;
    if (i === 0) return held(B.OK);
    if (i >= 8 && i <= 13) return held(B.Q1 + (i - 8));
    if (i === 14) return held(B.SWAP);
    return false;
  },
  releaseAll() {
    for (const s of [src.key, src.touch, src.pad]) s.fill(false);
    latched.fill(false); pointers.clear(); touchPtr = null;
    pending.push([0x18, 0, 0]);
  },
};
})();
