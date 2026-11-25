// 다크월드 web front-end: runs the ARM interpreter core (dwcore.wasm) and draws/plays/stores like the phone runner.
'use strict';
const DW_VERSION = '2026.11.24 (v1.57)';
// @DW_CHAT_BEGIN
const DW_CHAT_URL = "https://darkworld-chat.hyt0118.workers.dev/";
(function () {
  if (!DW_CHAT_URL) return;
  let ov = null, fr = null;
  // 오버레이가 열려 있는 동안 게임 쪽 키 입력 차단 (포커스가 iframe 으로 가기 전 순간 대비, 캡처 단계에서 막음)
  function stop(e) { if (ov) e.stopImmediatePropagation(); }
  window.addEventListener('keydown', stop, true);
  window.addEventListener('keyup', stop, true);
  function close() { if (ov) { ov.remove(); ov = null; fr = null; } try { window.focus(); } catch (e) {} }
  function open() {
    if (ov) return;
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
    ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:max(8px,env(safe-area-inset-top)) 8px max(8px,env(safe-area-inset-bottom));box-sizing:border-box;touch-action:auto';
    const box = document.createElement('div');
    box.style.cssText = 'width:min(560px,100%);height:min(640px,100%);display:flex;flex-direction:column;background:#101620;border:2px solid #d4b66b;box-sizing:border-box';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;justify-content:flex-end;padding:4px;background:#17261d;flex:0 0 auto';
    const x = document.createElement('button');
    x.textContent = '닫기';
    x.style.cssText = 'font:inherit;font-size:16px;color:#ffe064;background:#304333;border:2px solid #d4b66b;padding:4px 18px';
    x.onclick = close;
    bar.appendChild(x);
    fr = document.createElement('iframe');
    fr.src = DW_CHAT_URL;
    fr.title = '채팅';
    fr.style.cssText = 'flex:1 1 auto;min-height:0;width:100%;border:0;background:#101620';
    fr.addEventListener('load', function () { try { fr.focus(); } catch (e) {} });
    box.appendChild(bar); box.appendChild(fr); ov.appendChild(box);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    (document.getElementById('frame') || document.body).appendChild(ov);
    try { fr.focus(); } catch (e) {}
  }
  function add() {
    const b = document.createElement('button');
    b.id = 'dwchatbtn';
    b.textContent = '채팅';
    b.setAttribute('aria-label', '채팅');
    b.style.cssText = 'position:fixed;right:calc(max(6px,env(safe-area-inset-right)) + 40px);top:max(6px,env(safe-area-inset-top));z-index:5;height:34px;padding:0 10px;border-radius:17px;border:1px solid rgba(212,182,107,.5);background:rgba(16,29,22,.55);color:#d4b66b;font:14px/32px sans-serif';
    b.onclick = open;
    (document.getElementById('frame') || document.body).appendChild(b);
  }
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
// @DW_CHAT_END
// @DW_NOTES_BEGIN
const DW_NOTES = "[v1.57]\n\u25a0 \ucd94\uac00\n- \uc0c8 \uc9c0\uc5ed '\ub18d\uc7a5'\uc744 \ucd94\uac00\ud588\uc2b5\ub2c8\ub2e4. \ub9c8\uc744\uc758 \uc2a4\ub860\uc5d0\uac8c \ub9d0\uc744 \uac78\uba74 \ub4e4\uc5b4\uac08 \uc218 \uc788\uc2b5\ub2c8\ub2e4.\n  \u00b7 \uac00\ub9cc\ud788 \uc11c \uc788\uc73c\uba74 2\ucd08\ub9c8\ub2e4 \uac00\uc8fd\uc774 1\uac1c\uc529 \ub4e4\uc5b4\uc635\ub2c8\ub2e4. (\ub808\ubca8\uc774 \ub192\uc744\uc218\ub85d \uc88b\uc740 \uac00\uc8fd)\n  \u00b7 \uac00\ub054 \ud55c \ub2e8\uacc4 \uc544\ub798 \uac00\uc8fd\uc774\ub098 \uc624\uc0c9 \uac00\uc8fd\uc774 \ub098\uc635\ub2c8\ub2e4.\n  \u00b7 \uac00\uc8fd 5\uac1c\ub97c \ubc1b\uc744 \ub54c\ub9c8\ub2e4 \uc790\ub3d9\uc73c\ub85c \uc800\uc7a5\ub429\ub2c8\ub2e4.\n- \ubb34\ud55c\uc758 \ud0d1\uc5d0\uc11c \ub098\uc640 \ub9c8\uc744\uc5d0 \ub3c4\ucc29\ud558\uba74 \uc790\ub3d9\uc73c\ub85c \uc800\uc7a5\ub429\ub2c8\ub2e4. \uc774\ub54c \uce74\ub4dc \uc18c\ud658\uc218\ub294 \ud574\uc81c\ub429\ub2c8\ub2e4.\n\n\u25a0 \ubcc0\uacbd\n- '\ud0dc\ud48d\uc758\ubd84\ub178' \ud68c\uc624\ub9ac\uac00 \uc810\uc810 \uba40\uc5b4\uc9c0\uc9c0 \uc54a\uace0 \uce90\ub9ad\ud130 \uac00\uae4c\uc774\uc5d0\uc11c \uacc4\uc18d \ub3d5\ub2c8\ub2e4.\n\n\u25a0 \uc218\uc815\n- \uc2a4\ud0ac\uc744 \ub9ce\uc774 \uc4f8 \ub54c(\ubb34\ud55c\uc758 \ud0d1 \ub192\uc740 \uce35 \ub4f1) \uc2a4\ud0ac \ud6a8\uacfc \uadf8\ub9bc\uc774 \uc548 \ubcf4\uc774\ub358 \ubb38\uc81c\ub97c \uace0\ucce4\uc2b5\ub2c8\ub2e4.\n- '\ud53c\uc758\ubd84\ub178 \ud3ed\ubc1c' \uc0ac\uc6a9 \ub4a4 \uccb4\ub825\ubc14\uac00 \uc0ac\ub77c\uc9c0\uace0 \ud55c \ub300\uc5d0 \uc4f0\ub7ec\uc9c0\ub358 \ubb38\uc81c\ub97c \uace0\ucce4\uc2b5\ub2c8\ub2e4.";
(function () {
  if (!DW_NOTES) return;
  const KEY = 'dw_notes_shown';
  let last = '';
  try { last = localStorage.getItem(KEY) || ''; } catch (e) {}
  if (last === DW_VERSION) return;
  function show() {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box';
    const box = document.createElement('div');
    box.style.cssText = 'max-width:min(460px,92vw);max-height:84vh;display:flex;flex-direction:column;background:#17261d;border:2px solid #d4b66b;color:#e8e2c8;font:15px/1.5 sans-serif;padding:14px;box-sizing:border-box';
    const h = document.createElement('div');
    h.style.cssText = 'color:#ffdf72;font-size:17px;margin-bottom:8px';
    h.textContent = '업데이트 내역 (' + DW_VERSION + ')';
    const body = document.createElement('div');
    body.style.cssText = 'overflow:auto;white-space:pre-wrap;flex:1 1 auto;min-height:0';
    body.textContent = DW_NOTES;
    const ok = document.createElement('button');
    ok.textContent = '확인';
    ok.style.cssText = 'margin-top:12px;align-self:center;font:inherit;font-size:17px;color:#ffe064;background:#304333;border:2px solid #d4b66b;padding:6px 28px';
    ok.onclick = function () { try { localStorage.setItem(KEY, DW_VERSION); } catch (e) {} ov.remove(); };
    box.appendChild(h); box.appendChild(body); box.appendChild(ok); ov.appendChild(box);
    (document.getElementById('frame') || document.body).appendChild(ov);
  }
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
})();
// @DW_NOTES_END
(() => {
const $ = (id) => document.getElementById(id);
const canvas = $('screen'), ctx = canvas.getContext('2d');
let M = null;                 // wasm module
let running = false, paused = false;
const view = { x: 0, y: 0, w: 480, h: 320, dpr: 1 };

// ------------------------------------------------------------------ storage (IndexedDB: saves + settings)
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('darkworld', 1);
      r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('saves')) d.createObjectStore('saves'); if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(store, mode); const s = t.objectStore(store); const out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined); t.onerror = () => rej(t.error);
    });
  },
  put(store, k, v) { return this.tx(store, 'readwrite', (s) => s.put(v, k)); },
  del(store, k) { return this.tx(store, 'readwrite', (s) => s.delete(k)); },
  async all(store) {
    return new Promise((res, rej) => {
      const out = {}; const t = this.db.transaction(store, 'readonly'); const c = t.objectStore(store).openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } else res(out); };
      c.onerror = () => rej(c.error);
    });
  },
  clear(store) { return this.tx(store, 'readwrite', (s) => s.clear()); },
};
const settings = { cheat_flags: 0, hide_transform: 0, xbr: 0, mute: 0, arena: 0x7d0000, arena_on: 0, buttons: 1, padui: 0, fill: 2, smooth: 1, impact: 1, combo: 1, controls: 'classic', sides: 0 };
function saveSettings() { DB.put('settings', 'main', JSON.stringify(settings)).catch(() => {}); }

// called from wasm
window.DW = {
  saves: {},
  onSave(name, bytes) { this.saves[name] = bytes; DB.put('saves', name, bytes).catch(() => {}); },
  onRemove(name) { delete this.saves[name]; DB.del('saves', name).catch(() => {}); },
};

// ------------------------------------------------------------------ boot
function loadImage(src) {
  return DWDATA.url(src).then((u) => new Promise((res) => { if (!u) { res(null); return; } const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = u; }));
}
const skin = [];
const SKIN_FILES = ['control-shell', 'direction-spaced-pad', 'map-button', 'clr-button', 'save-button', 'pressed-0', 'pressed-1', 'pressed-2', 'pressed-3'];
let soundMap = {};

async function boot() {
  const prog = $('prog'), msg = $('bootmsg');
  try {
    await DB.open();
    const st = (await DB.all('settings')).main; if (st) Object.assign(settings, JSON.parse(st));
    const saves = await DB.all('saves');
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    // no progress here yet: offer the saves of /darkworld/ (copied; the originals stay as they are)
    if (!saves['_characterInfo.sav'] && !settings.oldAsked) {
      const old = await OldSaves.read();
      if (old) {
        settings.oldAsked = 1; saveSettings();
        if (confirm('기존 다크월드(/darkworld/)에서 하던 저장을 찾았어요.\n이 버전으로 복사해 올까요? (원래 저장은 그대로 남아요)')) {
          for (const [n, d] of Object.entries(old)) { await DB.put('saves', n, d); saves[n] = d; }
        }
      }
    }
    await DWDATA.ready(msg, prog);
    msg.textContent = '게임 자료를 여는 중…';
    const [mod, pack] = await Promise.all([createDW(), DWDATA.bytes('dw.pack')]);
    M = mod;
    const classicArt = settings.controls !== 'pad' ? await ClassicArt.load() : null;
    if (!M.setPack(pack, { classicUi: settings.controls !== 'pad', classicArt })) throw new Error(M.UTF8ToString(M._dw_error()));
    M.onEvent = coreEvent;
    for (const [name, bytes] of Object.entries(saves)) addSave(name, bytes);
    const imgs = await Promise.all(SKIN_FILES.map((f) => loadImage('data/runner/skin424/' + f + '.png')));
    imgs.forEach((im, i) => { skin[i] = im; });
    try { const t = await (await DWDATA.get('data/runner/sounds.tsv')).text(); for (const l of t.split('\n')) { const [k, v] = l.replace('\r', '').split('\t'); if (k && v) soundMap[k] = v.trim(); } } catch (e) {}
    prog.style.width = '100%';
    msg.textContent = (Object.keys(saves).length ? '저장된 진행을 찾았습니다.\n' : '') + '웹판 ' + DW_VERSION;
    const b = $('start'); b.style.display = 'block';
    b.onclick = () => { b.disabled = true; Audio.unlock(); start(); };
  } catch (e) { msg.textContent = '불러오지 못했습니다: ' + e.message; }
}
function addSave(name, bytes) {
  DW.saves[name] = bytes;
  const q = M._dw_alloc(bytes.length); M.HEAPU8.set(bytes, q);
  const n = M.stringToNewUTF8(name); M._dw_add_save(n, q, bytes.length); M._free(n); M._dw_free(q);
}
function start() {
  if (!M._dw_create()) { $('bootmsg').textContent = '시작하지 못했습니다: ' + M.UTF8ToString(M._dw_error()); return; }
  areaTable = M._dw_symbol(M.stringToNewUTF8('Touch_Area'));
  $('boot').style.display = 'none'; $('gear').style.display = 'block';
  document.body.classList.add('playing');
  running = true; nextTick = performance.now();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ main loop
let nextTick = 0, areaTable = 0, lastFrameT = 0, frameSerial = 0, renderedSerial = -1, lastMs = 60, lastTickAt = 0, shownF = 256;
const Perf = window.DWPerf = { n: 0, sum: 0, max: 0, rn: 0, rsum: 0, rmax: 0, reset() { this.n = this.sum = this.max = this.rn = this.rsum = this.rmax = 0; } };
function frame(t) {
  if (!running) return;
  requestAnimationFrame(frame);
  if (paused) { render(t); return; }
  if (Boss.active) { Boss.advance(t); nextTick = t; render(t); return; }
  let n = 0;
  while (t >= nextTick && n < 4) {
    if (!tick()) return;
    n++;
    if (Boss.active) { nextTick = t; break; }
  }
  if (t - nextTick > 250) nextTick = t;
  if (n) lastTickAt = nextTick - lastMs;
  render(t);
}
function tick() {
  Runner.flush();
  padUiSync();
  Input.beforeTick();
  const t0 = performance.now();
  const ms = M._dw_tick();
  frameSerial++;
  const dt = performance.now() - t0; Perf.n++; Perf.sum += dt; Perf.max = Math.max(Perf.max, dt);
  if (ms < 0) { fatal(M.UTF8ToString(M._dw_error())); return false; }
  nextTick += ms; lastMs = ms;
  Input.afterTick();
  const s = M.UTF8ToString(M._dw_take_sounds());
  if (s) for (const line of s.split('\n')) {
    if (!line) continue;
    if (line === 'X') { Audio.stopBgm(); continue; }
    const [, name, loop, vol] = line.split('\t');
    if (!Runner.command(name)) Audio.play(name, +loop, +vol);
  }
  if (M._dw_take_quantity_request()) {
    const v = parseInt(prompt('수량 입력 (1~99)', '1'), 10);
    if (v > 0) M._dw_quantity(Math.min(99, v));
    nextTick = performance.now();
  }
  Boss.check(); Runner.xbrCheck();
  return true;
}
function fatal(m) { running = false; const b = $('boot'); b.style.display = 'flex'; $('start').style.display = 'none'; $('bootmsg').textContent = '게임 실행 중 오류: ' + m + '\n저장은 브라우저에 남아 있습니다. 새로고침해 주세요.'; }


// ------------------------------------------------------------------ xBR on the GPU (port of the phone runner's assets/xbr.agsl)
const GLX = window.DWGLX = {
  canvas: null, gl: null, prog: null, tex: null, w: 0, h: 0, failed: false, uScale: null, uSize: null,
  ok() {
    if (this.gl) return true;
    if (this.failed) return false;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
      if (!gl) throw new Error('no webgl');
      const vs = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';
      const fs = `precision highp float;
uniform sampler2D img; uniform vec2 scale; uniform vec2 size;
const vec3 rgbw = vec3(14.352, 28.176, 5.472);
const vec4 delta = vec4(1.0/3.0); const vec4 delta_l = vec4(0.5/3.0, 1.0/3.0, 0.5/3.0, 1.0/3.0); const vec4 delta_u = vec4(1.0/3.0, 0.5/3.0, 1.0/3.0, 0.5/3.0);
const vec4 Ao = vec4(1.0, -1.0, -1.0, 1.0); const vec4 Bo = vec4(1.0, 1.0, -1.0, -1.0); const vec4 Co = vec4(1.5, 0.5, -0.5, 0.5);
const vec4 Ax = vec4(1.0, -1.0, -1.0, 1.0); const vec4 Bx = vec4(0.5, 2.0, -0.5, -2.0); const vec4 Cx = vec4(1.0, 1.0, -0.5, 0.0);
const vec4 Ay = vec4(1.0, -1.0, -1.0, 1.0); const vec4 By = vec4(2.0, 0.5, -2.0, -0.5); const vec4 Cy = vec4(2.0, 0.0, -1.0, 0.5);
const vec4 Ci = vec4(0.25);
vec4 df(vec4 A, vec4 B) { return abs(A - B); }
vec4 dif(vec4 A, vec4 B) { return vec4(A.x != B.x ? 1.0 : 0.0, A.y != B.y ? 1.0 : 0.0, A.z != B.z ? 1.0 : 0.0, A.w != B.w ? 1.0 : 0.0); }
vec4 eq(vec4 A, vec4 B) { return step(df(A, B), vec4(15.0)); }
vec4 neq(vec4 A, vec4 B) { return vec4(1.0) - eq(A, B); }
vec4 wd(vec4 a, vec4 b, vec4 c, vec4 d, vec4 e, vec4 f, vec4 g, vec4 h) { return df(a,b) + df(a,c) + df(d,e) + df(d,f) + 4.0*df(g,h); }
float c_df(vec3 c1, vec3 c2) { vec3 d = abs(c1 - c2); return d.r + d.g + d.b; }
vec3 T(vec2 q) { return texture2D(img, clamp(q, vec2(0.5), size - 0.5) / size).rgb; }
void main() {
  vec2 p = vec2(gl_FragCoord.x, (size.y * scale.y) - gl_FragCoord.y) / scale;
  vec2 fp = fract(p); vec2 c0 = floor(p) + 0.5;
  vec3 A1 = T(c0 + vec2(-1.0,-2.0)), B1 = T(c0 + vec2(0.0,-2.0)), C1 = T(c0 + vec2(1.0,-2.0));
  vec3 A = T(c0 + vec2(-1.0,-1.0)), B = T(c0 + vec2(0.0,-1.0)), C = T(c0 + vec2(1.0,-1.0));
  vec3 D = T(c0 + vec2(-1.0,0.0)), E = T(c0), F = T(c0 + vec2(1.0,0.0));
  vec3 G = T(c0 + vec2(-1.0,1.0)), H = T(c0 + vec2(0.0,1.0)), I = T(c0 + vec2(1.0,1.0));
  vec3 G5 = T(c0 + vec2(-1.0,2.0)), H5 = T(c0 + vec2(0.0,2.0)), I5 = T(c0 + vec2(1.0,2.0));
  vec3 A0 = T(c0 + vec2(-2.0,-1.0)), D0 = T(c0 + vec2(-2.0,0.0)), G0 = T(c0 + vec2(-2.0,1.0));
  vec3 C4 = T(c0 + vec2(2.0,-1.0)), F4 = T(c0 + vec2(2.0,0.0)), I4 = T(c0 + vec2(2.0,1.0));
  vec4 b = vec4(dot(B,rgbw), dot(D,rgbw), dot(H,rgbw), dot(F,rgbw));
  vec4 c = vec4(dot(C,rgbw), dot(A,rgbw), dot(G,rgbw), dot(I,rgbw));
  vec4 d = b.yzwx; vec4 e = vec4(dot(E,rgbw)); vec4 f = b.wxyz; vec4 g = c.zwxy; vec4 h = b.zwxy; vec4 i = c.wxyz;
  vec4 i4 = vec4(dot(I4,rgbw), dot(C1,rgbw), dot(A0,rgbw), dot(G5,rgbw));
  vec4 i5 = vec4(dot(I5,rgbw), dot(C4,rgbw), dot(A1,rgbw), dot(G0,rgbw));
  vec4 h5 = vec4(dot(H5,rgbw), dot(F4,rgbw), dot(B1,rgbw), dot(D0,rgbw));
  vec4 f4 = h5.yzwx;
  vec4 fx = Ao*fp.y + Bo*fp.x, fx_l = Ax*fp.y + Bx*fp.x, fx_u = Ay*fp.y + By*fp.x;
  vec4 irlv0 = dif(e,f) * dif(e,h);
  vec4 irlv1 = irlv0 * (neq(f,b) * neq(f,c) + neq(h,d) * neq(h,g) + eq(e,i) * (neq(f,f4) * neq(f,i4) + neq(h,h5) * neq(h,i5)) + eq(e,g) + eq(e,c));
  vec4 irlv2l = dif(e,g) * dif(d,g), irlv2u = dif(e,c) * dif(b,c);
  vec4 fx45i = clamp((fx + delta - Co - Ci) / (2.0*delta), 0.0, 1.0);
  vec4 fx45 = clamp((fx + delta - Co) / (2.0*delta), 0.0, 1.0);
  vec4 fx30 = clamp((fx_l + delta_l - Cx) / (2.0*delta_l), 0.0, 1.0);
  vec4 fx60 = clamp((fx_u + delta_u - Cy) / (2.0*delta_u), 0.0, 1.0);
  vec4 wd1 = wd(e, c, g, i, h5, f4, h, f), wd2 = wd(h, d, i5, f, i4, b, e, i);
  vec4 edri = step(wd1, wd2) * irlv0;
  vec4 edr = step(wd1 + vec4(0.1), wd2) * step(vec4(0.5), irlv1);
  vec4 edr_l = step(2.0*df(f,g), df(h,c)) * irlv2l * edr;
  vec4 edr_u = step(2.0*df(h,c), df(f,g)) * irlv2u * edr;
  fx45 = edr * fx45; fx30 = edr_l * fx30; fx60 = edr_u * fx60; fx45i = edri * fx45i;
  vec4 px = step(df(e,f), df(e,h));
  vec4 mx = max(max(fx30, fx60), max(fx45, fx45i));
  vec3 res1 = E; res1 = mix(res1, mix(H, F, px.x), mx.x); res1 = mix(res1, mix(B, D, px.z), mx.z);
  vec3 res2 = E; res2 = mix(res2, mix(F, B, px.y), mx.y); res2 = mix(res2, mix(D, H, px.w), mx.w);
  gl_FragColor = vec4(mix(res1, res2, step(c_df(E, res1), c_df(E, res2))), 1.0);
}`;
      const sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 480, 320, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.uniform1i(gl.getUniformLocation(pr, 'img'), 0);
      this.uScale = gl.getUniformLocation(pr, 'scale'); this.uSize = gl.getUniformLocation(pr, 'size');
      gl.uniform2f(this.uSize, 480, 320);
      c.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); this.gl = null; this.failed = true; });
      Object.assign(this, { canvas: c, gl, prog: pr, tex });
      return true;
    } catch (e) { console.warn('xBR WebGL off:', e); this.failed = true; return false; }
  },
  draw(rgba, w, h) {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.w = w; this.h = h;
    gl.viewport(0, 0, w, h);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 480, 320, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.uniform2f(this.uScale, w / 480, h / 320);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  },
};

// ------------------------------------------------------------------ rendering
const fc = document.createElement('canvas'), fctx = fc.getContext('2d');
const ic = document.createElement('canvas'); ic.width = 480; ic.height = 320; const ictx = ic.getContext('2d');
let fImg = null, iImg = new ImageData(480, 320);
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  Layout.apply();
  const W = Math.round(Layout.cw * dpr), H = Math.round(Layout.ch * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  let vw = W, vh = Math.round(W * 2 / 3); if (vh > H) { vh = H; vw = Math.round(H * 3 / 2); }
  // 화면 모드 (게임 옵션 화면연출 → 화면 모드, phone Fill537): 0 원본 비율, 1 확장(중간), 2 전체(늘림)
  const fill = settings.fill === undefined ? 2 : settings.fill;
  vw = Math.round((W - vw) * fill / 2 + vw); vh = Math.round((H - vh) * fill / 2 + vh);
  Object.assign(view, { x: Math.floor((W - vw) / 2), y: Math.floor((H - vh) / 2), w: vw, h: vh, dpr });
}
window.addEventListener('resize', resize); resize();
function readAreas() {
  const out = [];
  const p = M._dw_host(areaTable, 25 * 0x2c);
  if (!p) return out;
  const d = new DataView(M.HEAPU8.buffer, p, 25 * 0x2c);
  for (let i = 0; i < 25; i++) {
    const o = i * 0x2c, w = (k) => d.getInt32(o + k * 4, true);
    out.push({ on: (w(0) & 0xff) === 1, x1: w(1), y1: w(2), x2: w(3), y2: w(4), cx: w(5), cy: w(6), key: w(7) });
  }
  return out;
}
let areas = [];
function render(t) {
  const r0 = performance.now();
  renderInner(t);
  const rd = performance.now() - r0; Perf.rn++; Perf.rsum += rd; Perf.rmax = Math.max(Perf.rmax, rd);
}
function renderInner(t) {
  resize();
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // in-between frames: one game frame behind, the field drawn part of the way to the last one
  let f = 256;
  if (settings.smooth !== 0 && !paused && !Boss.active && !(document.getElementById('menu').classList.contains('open'))) {
    f = Math.max(0, Math.min(256, Math.round((t - lastTickAt) / lastMs * 256)));
    if (Smooth.cost > 9) f = f < 128 ? 128 : 256;
    if (f > 240) f = 256;
  }
  let fpMid = 0;
  if (f < 256 && (f !== shownF || renderedSerial !== frameSerial)) {
    const t0 = performance.now();
    fpMid = M.between(f);
    if (fpMid) Smooth.cost = Smooth.cost * 0.9 + (performance.now() - t0) * 0.1;
    else f = 256;
  }
  const frameRGBA = (k) => fpMid || M._dw_frame_rgba(k);
  const fresh = renderedSerial !== frameSerial || f !== shownF;
  const [shx, shy] = Fx.shakeOffset(view);
  ctx.save(); ctx.translate(shx, shy);
  // 업스케일(xBR): 그래픽카드(WebGL)에서 화면 크기 그대로 계산. WebGL이 없으면 예전처럼 CPU로 3~4배
  if (settings.xbr && GLX.ok()) {
    if (fresh || GLX.w !== view.w || GLX.h !== view.h) {
      renderedSerial = frameSerial; shownF = f;
      const fp = frameRGBA(0);
      GLX.draw(M.HEAPU8.subarray(fp, fp + 480 * 320 * 4), view.w, view.h);
    }
    ctx.drawImage(GLX.canvas, view.x, view.y, view.w, view.h);
  } else {
    const k = 0; // without WebGL the picture is drawn as it is
    const fw = k ? 480 * k : 480, fh = k ? 320 * k : 320;
    if (fc.width !== fw || fc.height !== fh) { fc.width = fw; fc.height = fh; fImg = new ImageData(fw, fh); renderedSerial = -1; }
    // 게임 화면은 틱(약 60ms)마다 한 번만 바뀜 → 새 틱이 있을 때만 변환·업로드, 나머지 프레임은 그려 둔 화면 재사용
    if (fresh || GLX.w !== -1) {
      renderedSerial = frameSerial; shownF = f; GLX.w = -1;
      const fp = frameRGBA(k);
      fImg.data.set(M.HEAPU8.subarray(fp, fp + fw * fh * 4));
      fctx.putImageData(fImg, 0, 0);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(fc, view.x, view.y, view.w, view.h);
  }
  Fx.frame(ctx, view, shownF);
  ctx.restore();
  if (Title.match()) Title.draw();
  const flag = M._dw_read32(0x10296000), pressed = (flag >>> 8) & 0xff;
  // the game reports menu mode (2) while a message box is open over play (input-only signal): keep drawing the play layout
  let mode = flag & 0xff; if (mode === 2 && (M._dw_read32(0x100c5750) & 0xff)) mode = 1;
  // the game's own buttons, drawn by the game itself: in play, only DASH is added here
  if (M.classicArt) {
    areas = readAreas();
    const has = (k) => areas.some((a) => a.on && a.key === k);
    mode = has(43) && has(13) ? 1 : 0;
    if (mode && settings.buttons !== 0) drawClassicDash(ctx, view, dashSpot(), Input.dashHeld && Input.dashHeld());
  }
  Input.skinMode = mode;
  if (mode && settings.buttons !== 0 && !M.classicArt) {
    areas = readAreas();
    const s = view.w / 480, sy = view.h / 320;
    const padui = padUiOn(mode);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const put = (tile, x0, y0, x1, y1) => { const im = skin[tile]; if (im) ctx.drawImage(im, view.x + x0 * s, view.y + y0 * sy, (x1 - x0) * s, (y1 - y0) * sy); };
    for (let i = 0; i < 24; i++) {
      const a = areas[i]; if (!a.on || a.key < 0) continue;
      if (padui && (i === 0 || i === 15)) continue;
      let tile = -1, rad = 0, rect = false, cx = a.cx, cy = a.cy;
      if (padui && i >= 8 && i <= 13) { cx = padNx(i); cy = PAD_NY; }
      if (a.key === 10 || a.key === 0x40) { tile = 2; rect = true; }
      else if (a.key === 32 || a.key === 0x42) { tile = 4; rect = true; }
      else if (a.key === 11 || a.key === 0x41 || a.key === 0x0b) { tile = 3; rect = true; }
      // sizes in proportion to the button (the build's own places give its own sizes: 54, 23.65, 16.5)
      else if (i === 15) { tile = 1; rad = (a.x2 - a.x1) * 0.509; }
      else if (i === 0) { tile = 0; rad = (a.x2 - a.x1) * 0.364; }
      else if (i === 14) { tile = 0; rad = (a.x2 - a.x1) * 0.569; }
      else if (i >= 8 && i <= 13) { tile = 0; rad = (a.x2 - a.x1) * 0.367; }
      if (tile < 0) continue;
      if (rect) put(tile, a.x1, a.y1, a.x2, a.y2); else put(tile, cx - rad, cy - rad, cx + rad, cy + rad);
      if (i === 15) {
        let pt = -1;
        if (pressed === 0x0e || pressed === 0x45) pt = 5; else if (pressed === 0x10 || pressed === 0x47) pt = 6;
        else if (pressed === 0x0f || pressed === 0x46) pt = 7; else if (pressed === 0x11 || pressed === 0x48) pt = 8;
        if (pt >= 0) put(pt, cx - rad, cy - rad, cx + rad, cy + rad);
      }
      if (Input.feedback(i)) {
        const r = (rect ? (a.x2 - a.x1) / 2 : rad) * s;
        ctx.fillStyle = 'rgba(143,229,255,.35)'; ctx.beginPath(); ctx.ellipse(view.x + cx * s, view.y + cy * sy, r, r * sy / s, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    const [dx, dy, dr] = dashSpot();
    if (mode === 1 && !padui) put(0, dx - dr, dy - dr, dx + dr, dy + dr);
    const ip = M._dw_icons_rgba();
    if (ip) {
      iImg.data.set(M.HEAPU8.subarray(ip, ip + 480 * 320 * 4));
      if (padui) moveIcons(new Uint32Array(iImg.data.buffer));
      ictx.putImageData(iImg, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(ic, view.x, view.y, view.w, view.h);
    }
    if (mode === 1 && !padui) {
      ctx.font = `bold ${Math.max(8, 9 * s)}px Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const cx = view.x + dx * s, cy = view.y + dy * sy;
      ctx.fillStyle = '#000'; ctx.fillText('DASH', cx + 1, cy + 1); ctx.fillStyle = '#fff'; ctx.fillText('DASH', cx, cy);
    }
  }
  Boss.draw();
  overlayText();
}

// ------------------------------------------------------------------ pad UI (phone PadLayout / PC F6): no d-pad/attack, skills as a bottom bar
const PAD_NY = 297;
const padNx = (c) => (c === 14 ? 418 : 170 + (c - 8) * 40);
function padUiOn(mode) { return !!settings.padui && mode === 1 && !(M && M.classic); }
// the DASH button (game pixels: centre x, y, radius), where the build puts it
const dashSpot = () => [449, 251, 18];
let moved = new Uint32Array(480 * 320);
function moveIcons(px) {  // px: 480x320 RGBA as u32, alpha 0 = transparent
  moved.set(px);
  const clear = (x0, y0, x1, y1) => { for (let y = Math.max(0, y0); y < Math.min(320, y1); y++) moved.fill(0, y * 480 + Math.max(0, x0), y * 480 + Math.min(480, x1)); };
  const copy = (sx, sy, dx, dy, w, h) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const ax = sx + x, ay = sy + y, bx = dx + x, by = dy + y;
      if (ax < 0 || ay < 0 || ax >= 480 || ay >= 320 || bx < 0 || by < 0 || bx >= 480 || by >= 320) continue;
      const v = px[ay * 480 + ax]; if (v >>> 24) moved[by * 480 + bx] = v;
    }
  };
  for (let c = 0; c < 24; c++) {
    const a = areas[c]; if (!a || !a.on) continue;
    if (c === 0 || c === 15 || c === 14) clear(a.x1 - 1, a.y1 - 1, a.x2 + 2, a.y2 + 2);
    else if (c >= 8 && c <= 13) clear(a.cx - 18, a.cy - 18, a.cx + 30, a.cy + 18);
  }
  for (let c = 8; c <= 13; c++) { const a = areas[c]; if (a && a.on) copy(a.cx - 18, a.cy - 18, padNx(c) - 18, PAD_NY - 18, 36, 36); }
  const a = areas[14];
  if (a && a.on) { const dx = padNx(14) - a.cx, dy = PAD_NY - a.cy; copy(a.x1 - 1, a.y1 - 1, a.x1 - 1 + dx, a.y1 - 1 + dy, a.x2 - a.x1 + 2, a.y2 - a.y1 + 2); }
  px.set(moved);
}
// tell the game which HUD layout to use (moves HP/MP), like the phone runner / PC version
let padUiSent = -1, padUiTicks = 0;
function padUiSync() {
  const want = settings.padui ? 1 : 0;
  if (want !== padUiSent || ++padUiTicks >= 44) {
    padUiTicks = 0;
    if (Input.touchActive && Input.touchActive()) { padUiSent = -1; return; }
    padUiSent = want; M._dw_event(0, 0x17, 479, 240 + want); M._dw_event(0, 0x18, 479, 240 + want);
  }
}
window.addEventListener('gamepadconnected', () => { if (!settings.padui) { settings.padui = 1; saveSettings(); window.DWInternals && window.DWInternals.toast('패드 연결됨: 패드 UI'); } });
window.addEventListener('gamepaddisconnected', () => {
  const any = navigator.getGamepads && [...navigator.getGamepads()].some((g) => g && g.connected);
  if (!any && settings.padui) { settings.padui = 0; saveSettings(); window.DWInternals && window.DWInternals.toast('패드 해제: 터치 UI'); }
});

// ------------------------------------------------------------------ HD title / boss intro (phone TitleArtwork413 / BossIntro655)
const Title = {
  img: null, tried: false, last: 0, on: false,
  match() { const now = performance.now(); if (now - this.last > 90) { this.last = now; this.on = M._dw_title_match() === 1; } return this.on; },
  draw() {
    if (!this.tried) { this.tried = true; loadImage('data/runner/title-hd.png').then((im) => { this.img = im; }); }
    if (this.img) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(this.img, view.x, view.y, view.w, Math.round(view.h * 0.921875)); }
  },
};
const Boss = {
  active: false, seen: 0, id: 0, elapsed: 0, last: 0, img: null, cache: {},
  check() {
    const st = M._dw_read32(0x100ddc7c) >>> 0;
    let id = 0, cond = false;
    if (st - 9000 <= 1 && st >= 9000 && (M._dw_read32(0x1011c2b8) & 0xff) && M._dw_read32(0x1011c2bc) === 3) {
      id = M._dw_read32(0x1011c2c0); cond = [310, 317, 318, 319, 325].includes(id);
    }
    if (!cond) { this.seen = 0; this.active = false; return; }
    if (id === this.seen) return;
    this.seen = id;
    const go = (im) => { if (!im) return; this.img = im; this.active = true; this.id = id; this.elapsed = 0; this.last = 0; Input.releaseAll(); };
    if (this.cache[id]) go(this.cache[id]); else loadImage('data/runner/boss-intro/' + id + '.jpg').then((im) => { this.cache[id] = im; if (this.seen === id) go(im); });
  },
  skip() { if (this.active && this.elapsed >= 700 && this.elapsed < 2500) this.elapsed = 2500; },
  advance(t) {
    if (this.last) this.elapsed += Math.min(50, Math.max(0, t - this.last));
    this.last = t;
    if (this.elapsed >= 2800) { this.active = false; nextTick = performance.now(); }
  },
  draw() {
    if (!this.active || !this.img) return;
    const t = this.elapsed | 0; let a = 1;
    if (t > 2500) a = (2800 - t) / 300;
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0, a)})`; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (t < 240) a = t / 240;
    const W = canvas.width, H = canvas.height, im = this.img;
    const s = Math.min(W / im.width, H / im.height) * (0.98 + 0.02 * t / 2800);
    const w = im.width * s, h = im.height * s;
    ctx.globalAlpha = Math.max(0, Math.min(1, a)); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, (W - w) / 2, (H - h) / 2, w, h); ctx.globalAlpha = 1;
  },
};

// ------------------------------------------------------------------ audio (Web Audio; iOS needs a tap to unlock)
const Audio = {
  ctx: null, buffers: {}, loading: {}, lastPlay: {}, active: 0, bgm: null, bgmName: '', bgmTicket: 0, bgmGain: null, sfxGain: null, volB: 1, volS: 1,
  unlock() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    // iPhone: play like a game (heard with the silent switch on); the game's own '소리' setting mutes it
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    this.ctx = new AC(); this.bgmGain = this.ctx.createGain(); this.sfxGain = this.ctx.createGain();
    this.bgmGain.connect(this.ctx.destination); this.sfxGain.connect(this.ctx.destination);
    const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    this.applyMute();
  },
  // after another app, a call, a notification or the lock screen, iOS leaves the sound stopped ('suspended' or
  // 'interrupted') and lets it start again only from a touch or a key: every one tries
  wake() { if (this.ctx && this.ctx.state !== 'running' && !document.hidden) this.ctx.resume().catch(() => {}); },
  applyMute() { if (!this.ctx) return; this.bgmGain.gain.value = settings.mute ? 0 : this.volB; this.sfxGain.gain.value = settings.mute ? 0 : this.volS; },
  async load(name) {
    if (this.buffers[name]) return this.buffers[name];
    if (this.loading[name]) return this.loading[name];
    const file = soundMap[name] || name;
    this.loading[name] = (async () => {
      for (const ext of ['.mp3', '.wav']) {
        try {
          const r = await DWDATA.get('data/sound/' + file + ext); if (!r.ok) continue;
          const buf = await r.arrayBuffer();
          const ab = await new Promise((res, rej) => this.ctx.decodeAudioData(buf, res, rej));
          this.buffers[name] = ab; return ab;
        } catch (e) {}
      }
      delete this.loading[name]; // not there or not decoded: try again the next time it is asked for
      return null;
    })();
    return this.loading[name];
  },
  async play(name, loop) {
    if (!this.ctx || !name || name.startsWith('__')) return;
    this.wake();
    if (loop) {
      if (this.bgmName === name) return;
      this.stopBgm(); this.bgmName = name;
      // a stop and the same music again while it loads would start it twice, one copy past stopping
      const ticket = this.bgmTicket;
      const b = await this.load(name);
      if (ticket !== this.bgmTicket) return;
      if (!b) { this.bgmName = ''; return; }
      const s = this.ctx.createBufferSource(); s.buffer = b; s.loop = true; s.connect(this.bgmGain); s.start(0); this.bgm = s;
    } else {
      // 같은 효과음이 한 틱에 수십 번 겹치는 경우(보스전 스킬 연타) 소리가 뭉개지고 버벅임 → 같은 소리 80ms 간격, 동시에 최대 10개
      const now = performance.now();
      if (now - (this.lastPlay[name] || 0) < 80 || this.active >= 10) return;
      this.lastPlay[name] = now;
      const b = await this.load(name); if (!b) return;
      const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.sfxGain);
      this.active++; s.onended = () => { this.active--; }; s.start(0);
    }
  },
  stopBgm() { this.bgmTicket++; if (this.bgm) { try { this.bgm.stop(); } catch (e) {} } this.bgm = null; this.bgmName = ''; },
  volume(b, s) { this.volB = b / 5; this.volS = s / 5; this.applyMute(); },
};
document.addEventListener('visibilitychange', () => {
  if (!Audio.ctx) return;
  if (document.hidden) Audio.ctx.suspend(); else { Audio.wake(); nextTick = performance.now(); }
});
for (const ev of ['pointerdown', 'pointerup', 'touchend', 'keydown']) document.addEventListener(ev, () => Audio.wake(), true);

// ------------------------------------------------------------------ runner protocol (cheats, beast, volume, upscale, arena)
const Runner = {
  dirty: true, queue: [], arenaSent: -1, xbrLast: -1, synced: false,
  flush() {
    if (!this.synced) { this.synced = true; this.dirty = true; this.queue.unshift(0x5c00 + settings.hide_transform, 0x5a00 + (settings.xbr ? 1 : 0), 0x5b00 + (settings.fill === undefined ? 2 : settings.fill)); }
    if (this.dirty) { M._dw_quantity((0x6e000000 | settings.cheat_flags) >>> 0); this.dirty = false; }
    for (const c of this.queue) M._dw_quantity(c >>> 0);
    this.queue.length = 0;
    const ar = (settings.cheat_flags & 1) ? settings.arena : 0x7d0000;
    if (ar !== this.arenaSent) { M._dw_quantity((0x70000000 | ar) >>> 0); this.arenaSent = ar; }
  },
  command(s) {
    if (!s || !s.startsWith('__dw')) return false;
    if (s === '__dwcheat0' || s === '__dwcheat1') { settings.cheat_flags = (settings.cheat_flags & ~1) | (s.endsWith('1') ? 1 : 0); this.dirty = true; saveSettings(); }
    else if (s === '__dwcheatS') Cheat.open('settings');
    else if (s === '__dwcheatB') { if (settings.cheat_flags & 1) Cheat.open('shop'); }
    else if (s === '__dwcheatM') Cheat.open('save');  // 시스템 메뉴 '저장 관리'
    else if (s.startsWith('__dwcheatG')) Cheat.granted(parseInt(s.slice(10), 10) || 0);
    else if (s.startsWith('__dwfill') && s.length === 9 && s[8] >= '0' && s[8] <= '2') { settings.fill = +s[8]; saveSettings(); }
    else if (s === '__dwbeast0' || s === '__dwbeast1') { settings.hide_transform = s.endsWith('1') ? 1 : 0; saveSettings(); }
    else if (s.startsWith('__dwvol_') && s.length === 10) { const b = +s[8], e = +s[9]; if (b >= 0 && b <= 5 && e >= 0 && e <= 5) Audio.volume(b, e); }
    return true;
  },
  // 게임 옵션 "업스케일": the option screen bumps a counter when the row is chosen
  xbrCheck() {
    const scr = (M._dw_read32(0x100bed38) | 0) > 0 && M._dw_read32(0x100bed34) === 6 && M._dw_read32(0x1012475c) === 5 && (M._dw_read32(0x10124760) & 0xff) === 1;
    if (!scr) { this.xbrLast = -1; return; }
    const c = (M._dw_read32(0x10124768) >>> 16) & 0xff;
    if (this.xbrLast >= 0 && ((c - this.xbrLast) & 1)) { settings.xbr = settings.xbr ? 0 : 1; saveSettings(); M._dw_quantity(0x5a00 + settings.xbr); }
    this.xbrLast = c;
  },
};

// placeholder; replaced by input.js / cheat.js when present
window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });
let toastText = '', toastUntil = 0, showPerf = false, perfText = '', perfAt = 0;
function overlayText() {
  const now = performance.now();
  ctx.font = `${Math.round(14 * view.dpr)}px NeoDunggeunmo, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  if (showPerf) {
    if (now - perfAt > 1000 && Perf.n) { perfText = `게임 ${(Perf.sum / Perf.n).toFixed(1)}ms (최대 ${Perf.max.toFixed(1)}) · 그리기 ${(Perf.rsum / Perf.rn).toFixed(1)}ms`; perfAt = now; Perf.reset(); }
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(view.x + 4 * view.dpr, view.y + view.h - 26 * view.dpr, ctx.measureText(perfText).width + 12 * view.dpr, 22 * view.dpr);
    ctx.fillStyle = '#ffdf72'; ctx.fillText(perfText, view.x + 10 * view.dpr, view.y + view.h - 22 * view.dpr);
  }
  if (now < toastUntil) {
    const w = ctx.measureText(toastText).width + 20 * view.dpr;
    ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(view.x + (view.w - w) / 2, view.y + 12 * view.dpr, w, 26 * view.dpr);
    ctx.fillStyle = '#ffe064'; ctx.textAlign = 'center'; ctx.fillText(toastText, view.x + view.w / 2, view.y + 17 * view.dpr);
  }
}
window.DWInternals = {
  padNx, PAD_NY, padUiOn, dashSpot,
  toast(t) { toastText = t; toastUntil = performance.now() + 1500; },
  togglePerf() { showPerf = !showPerf; perfText = '측정 중…'; Perf.reset(); }, get M() { return M; }, view, settings, saveSettings, Runner, Audio, Boss, get areas() { return areas; }, readAreas, $, nextTickReset() { nextTick = performance.now(); }, setPaused(v) { paused = v; } };
const Input = window.DWInput = window.DWInput || { skinMode: 0, beforeTick() {}, afterTick() {}, feedback() { return false; }, releaseAll() {} };
const Cheat = window.DWCheat = window.DWCheat || { open() {}, granted() {} };
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // an older cached version was running: once the new worker takes over, reload once (before the game starts)
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!running && !reloaded) { reloaded = true; location.reload(); } });
}
boot();
})();
