// 다크월드 player: runs the game's ARM library in dwcore.wasm and presents it on an iPhone in landscape.
const VERSION = "7";
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Preferences (prefixed: the origin is shared with the other games of this site)
const PREF_KEY = "dw.prefs";
const prefs = Object.assign(
  { quality: "pixel", color: "vivid", glow: "soft", screen: "notch", sound: "on", mod: "on", motion: "smooth", impact: "normal" },
  (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })(),
);
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };
// players found this game's art looks best as original pixels, so that became the default, once for everyone
if (!prefs.pixelDefault) { prefs.quality = "pixel"; prefs.pixelDefault = 1; savePrefs(); }

function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------------------------------------------------------------------------------------------
// IndexedDB: game files and saves
const DB_NAME = "darkworld-player";
let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("game");
      req.result.createObjectStore("files");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idb(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
const idbGet = (store, key) => idb(store, "readonly", s => s.get(key));
const idbPut = (store, key, v) => idb(store, "readwrite", s => s.put(v, key));
const idbDel = (store, key) => idb(store, "readwrite", s => s.delete(key));
const idbClear = store => idb(store, "readwrite", s => s.clear());
async function idbEntries(store) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = d.transaction(store, "readonly");
    const req = tx.objectStore(store).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c) { out.push([c.key, c.value]); c.continue(); }
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------------------------
// Zip reading (the game arrives as the apk, or as a zip holding it)
async function readZip(blob) {
  const tailLen = Math.min(blob.size, 66000);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip 또는 apk 파일이 아니에요");
  const count = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOff = tail.getUint32(eocd + 16, true);
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = [];
  const dec = new TextDecoder();
  for (let p = 0, n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true);
    const usize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const lho = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    entries.push({ name, method, csize, usize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
async function zipData(blob, e) {
  const lh = new DataView(await blob.slice(e.lho, e.lho + 30).arrayBuffer());
  const start = e.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const raw = blob.slice(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error("지원하지 않는 압축 방식이에요");
  const buf = await new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
  return new Blob([buf]);
}

const SO_NAME = "lib/armeabi/libDarkWorld.so";
const ENTRY = "Java_com_gamedoli_DarkWorldGoogle_Native_startCletN";

// Everything the game reads is kept as three records: the library, the asset files packed into one
// buffer with an index (the game asks for them by name through Native.getResource), and the title
// backgrounds and sounds of the Android resources.
async function importGame(file, progress) {
  progress(0.03);
  let apk = file;
  let entries = await readZip(file);
  if (!entries.some(e => e.name === SO_NAME)) {
    const inner = entries.find(e => /\.apk$/i.test(e.name));
    if (!inner) throw new Error("zip 안에서 다크월드 apk를 찾지 못했어요");
    progress(0.08);
    apk = await zipData(file, inner);
    entries = await readZip(apk);
  }
  const soEntry = entries.find(e => e.name === SO_NAME);
  if (!soEntry) throw new Error("다크월드 게임 파일이 아니에요");
  const so = new Uint8Array(await (await zipData(apk, soEntry)).arrayBuffer());
  if (so[0] !== 0x7f || so[1] !== 0x45 || !findBytes(so, new TextEncoder().encode(ENTRY))) throw new Error("게임 라이브러리를 읽지 못했어요");
  progress(0.15);
  const assetEntries = entries.filter(e => e.name.startsWith("assets/") && !e.name.endsWith("/"));
  const parts = [];
  const index = {};
  let total = 0;
  for (let i = 0; i < assetEntries.length; i++) {
    const e = assetEntries[i];
    const buf = new Uint8Array(await (await zipData(apk, e)).arrayBuffer());
    index[e.name.slice(7)] = [total, buf.length];
    parts.push(buf);
    total += buf.length;
    if (i % 64 === 0) progress(0.15 + 0.6 * (i / assetEntries.length));
  }
  const assets = new Uint8Array(total);
  for (const [name, [off]] of Object.entries(index)) assets.set(parts.shift(), off);
  const sounds = {};
  for (const e of entries.filter(e => /^res\/raw\/[a-z0-9_]+\.(mp3|wav|ogg)$/i.test(e.name))) {
    sounds[e.name.slice(8).replace(/\.[^.]+$/, "")] = await (await zipData(apk, e)).arrayBuffer();
  }
  progress(0.85);
  const bg = [];
  for (const n of ["res/drawable-hdpi/bg.png", "res/drawable-hdpi/bg_2.png"]) {
    const e = entries.find(x => x.name === n);
    if (e) bg.push(await (await zipData(apk, e)).arrayBuffer());
  }
  if (!Object.keys(index).length) throw new Error("게임 데이터(assets)가 없어요");
  await idbPut("game", "so", so.buffer);
  await idbPut("game", "assets", assets.buffer);
  await idbPut("game", "index", index);
  await idbPut("game", "sounds", sounds);
  await idbPut("game", "bg", bg);
  await idbPut("game", "meta", { version: VERSION, imported: Date.now() });
  progress(1);
}
function findBytes(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    if (hay[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Layout: the game is landscape. In portrait the whole frame is turned 90° so the phone can be held
// sideways even with the rotation lock on. The game draws at any screen size, so its width follows the
// phone's shape (240 lines high, as on the 800x480 phones it was made for) and it fills the screen.
const layout = { rotated: false, lw: 0, lh: 0, stage: { x: 0, y: 0, w: 0, h: 0 } };
let lcdW = 400;
const LCD_H = 240;

function readInsets() {
  const cs = getComputedStyle($("probe"));
  return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
}

// The camera (Dynamic Island) sits on one short edge. iOS reports the same safe-area inset on both sides,
// so the camera side comes from the screen angle: 90 = turned counter-clockwise, camera on the left.
function cameraOnLeft(rotated) {
  if (rotated) return true; // a portrait frame turned clockwise puts the camera edge on the left
  const a = typeof screen.orientation?.angle === "number" ? screen.orientation.angle : window.orientation;
  return !(a === 270 || a === -90);
}

function landscapeMetrics() {
  const vw = window.innerWidth, vh = window.innerHeight, ins = readInsets();
  const rotated = vh > vw;
  const lw = rotated ? vh : vw, lh = rotated ? vw : vh;
  const inset = Math.max(rotated ? ins.t : Math.max(ins.l, ins.r), 0);
  const camLeft = cameraOnLeft(rotated);
  // "notch": keep clear only the camera side, "safe": both sides, "full": edge to edge
  const mode = prefs.screen;
  const camMargin = mode === "full" ? 0 : inset;
  // when the frame is turned (the phone stays in portrait), the far side is where iOS keeps the home bar and
  // its swipe area, so the game stays clear of it unless the player asked for edge to edge
  const otherMargin = rotated ? (mode === "full" ? 0 : ins.b) : mode === "safe" ? inset : 0;
  const l = camLeft ? camMargin : otherMargin, r = camLeft ? otherMargin : camMargin;
  // safe-area insets as seen from inside the frame, for the screens and notices drawn in it
  const frameInsets = rotated ? [ins.r, ins.b, ins.l, ins.t] : [ins.t, ins.r, ins.b, ins.l];
  return { vw, vh, rotated, lw, lh, l, r, camLeft, frameInsets, bottom: rotated ? ins.r : ins.b };
}

function chooseLcdWidth() {
  const m = landscapeMetrics();
  const w = Math.round((LCD_H * (m.lw - m.l - m.r)) / m.lh / 2) * 2;
  return Math.max(400, Math.min(540, w || 400));
}

function applyLayout() {
  const m = landscapeMetrics();
  const frame = $("frame");
  frame.style.width = m.lw + "px";
  frame.style.height = m.lh + "px";
  frame.style.transform = m.rotated ? `translate(${m.vw}px, 0) rotate(90deg)` : "none";
  ["--ft", "--fr", "--fb", "--fl"].forEach((k, i) => frame.style.setProperty(k, m.frameInsets[i] + "px"));
  // iOS web apps cannot turn the screen themselves: only the phone's own rotation (orientation lock off) does
  $("tap-hint").hidden = !m.rotated;
  const aw = m.lw - m.l - m.r, ah = m.lh;
  const scale = Math.min(aw / lcdW, ah / LCD_H);
  const sw = Math.round(lcdW * scale), sh = Math.round(LCD_H * scale);
  // any rounding slack goes to the camera side so the game meets the opposite edge
  const sx = m.camLeft ? m.lw - m.r - sw : m.l, sy = Math.round((ah - sh) / 2);
  Object.assign(layout, { rotated: m.rotated, lw: m.lw, lh: m.lh, stage: { x: sx, y: sy, w: sw, h: sh } });
  const st = $("stage");
  st.style.left = sx + "px";
  st.style.top = sy + "px";
  st.style.width = sw + "px";
  st.style.height = sh + "px";
  // the settings button: centred in the margin beside the camera when it fits there; otherwise a small,
  // faint one in the game's top-right corner, which the field HUD and menus leave empty. A turned frame puts
  // that margin under the iOS status bar, which takes the touches there, so it never goes there then.
  const side = $("side");
  const margin = m.camLeft ? sx : m.lw - sx - sw;
  const roomy = margin >= 44 && !m.rotated;
  side.classList.toggle("mini", !roomy);
  if (roomy) {
    const cx = m.camLeft ? margin / 2 : m.lw - margin / 2;
    side.style.left = cx - 20 + "px";
    side.style.top = Math.max(8, Math.round(m.lh * 0.04)) + "px";
  } else {
    side.style.left = sx + sw - 36 + "px";
    side.style.top = sy + 6 + "px";
  }
  renderer?.resize(sw, sh);
  fx?.resize(sw, sh);
}

// client point -> LCD coordinates
function toLcd(cx, cy) {
  const r = $("stage").getBoundingClientRect();
  let x, y;
  if (layout.rotated) {
    x = ((cy - r.top) / r.height) * lcdW;
    y = ((r.right - cx) / r.width) * LCD_H;
  } else {
    x = ((cx - r.left) / r.width) * lcdW;
    y = ((cy - r.top) / r.height) * LCD_H;
  }
  return [Math.max(0, Math.min(lcdW - 1, Math.floor(x))), Math.max(0, Math.min(LCD_H - 1, Math.floor(y)))];
}

// ---------------------------------------------------------------------------------------------
// Renderer: RGB565 frame -> edge-directed (HD) or Scale2x x2 upscale -> sharp bilinear to the screen,
// with an optional glow on bright coloured parts and a little more colour.
const VS = `attribute vec2 aPos; varying vec2 vUv; uniform float uFlip;
void main(){ vUv = vec2(aPos.x * 0.5 + 0.5, uFlip > 0.5 ? 0.5 - aPos.y * 0.5 : aPos.y * 0.5 + 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FS_EPX = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uReg; uniform float uEq;
bool eq(vec3 a, vec3 b){ vec3 d = abs(a - b); return d.r + d.g + d.b < uEq; }
void main(){
  vec2 p = vUv * uReg; vec2 ip = floor(p); vec2 f = p - ip; vec2 ts = 1.0 / uTexSize; vec2 c = (ip + 0.5) * ts;
  vec2 lo = vec2(0.5) * ts, hi = (uReg - 0.5) * ts;
  vec3 P = texture2D(uTex, c).rgb;
  vec3 A = texture2D(uTex, clamp(c - vec2(0.0, ts.y), lo, hi)).rgb;
  vec3 B = texture2D(uTex, clamp(c + vec2(ts.x, 0.0), lo, hi)).rgb;
  vec3 C = texture2D(uTex, clamp(c - vec2(ts.x, 0.0), lo, hi)).rgb;
  vec3 D = texture2D(uTex, clamp(c + vec2(0.0, ts.y), lo, hi)).rgb;
  vec3 o = P;
  if (f.y < 0.5) {
    if (f.x < 0.5) { if (eq(C, A) && !eq(C, D) && !eq(A, B)) o = A; }
    else { if (eq(A, B) && !eq(A, C) && !eq(B, D)) o = B; }
  } else {
    if (f.x < 0.5) { if (eq(D, C) && !eq(D, B) && !eq(C, A)) o = C; }
    else { if (eq(B, D) && !eq(B, A) && !eq(D, C)) o = D; }
  }
  gl_FragColor = vec4(o, 1.0);
}`;
// Edge-directed upscaling. Pass 1 (one fragment per game pixel) decides for each corner of the pixel
// whether it sits on the far side of an edge, comparing how well the neighbourhood lines up along the
// two diagonals, and whether the edge is 45° or one of the 2:1 slopes. Pass 2 (at the output size)
// gives that part of the pixel the neighbour's colour, with a narrow smooth step across the edge line.
const FS_XBR_DEC = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uReg;
vec3 px(vec2 c, vec2 o){ return texture2D(uTex, clamp(c + o / uTexSize, vec2(0.5) / uTexSize, (uReg - 0.5) / uTexSize)).rgb; }
float wd(vec3 a, vec3 b){
  vec3 d = a - b;
  return 48.0 * abs(dot(d, vec3(0.299, 0.587, 0.114))) + 7.0 * abs(dot(d, vec3(-0.169, -0.331, 0.5))) + 6.0 * abs(dot(d, vec3(0.5, -0.419, -0.081)));
}
bool eq(vec3 a, vec3 b){ return wd(a, b) < 2.4; }
float corner(vec3 E, vec3 B, vec3 D, vec3 F, vec3 H, vec3 C, vec3 G, vec3 I, vec3 F4, vec3 H5, vec3 I4, vec3 I5){
  if (eq(E, F) || eq(E, H)) return 0.0;
  bool keep = (!eq(F, B) && !eq(H, D)) || (eq(E, I) && !eq(F, I4) && !eq(H, I5)) || eq(E, G) || eq(E, C);
  if (!keep) return 0.0;
  float slash = wd(E, C) + wd(E, G) + wd(I, F4) + wd(I, H5) + 4.0 * wd(H, F);
  float back = wd(H, D) + wd(H, I5) + wd(F, I4) + wd(F, B) + 4.0 * wd(E, I);
  if (slash >= back) return 0.0;
  float v = 1.0, fg = wd(F, G), hc = wd(H, C);
  if (2.0 * fg <= hc && !eq(E, G) && !eq(D, G)) v += 2.0;
  if (fg >= 2.0 * hc && !eq(E, C) && !eq(B, C)) v += 4.0;
  if (wd(E, F) > wd(E, H)) v += 8.0;
  return v;
}
void main(){
  vec2 c = (floor(vUv * uReg) + 0.5) / uTexSize;
  vec3 A1 = px(c, vec2(-1.0, -2.0)), B1 = px(c, vec2(0.0, -2.0)), C1 = px(c, vec2(1.0, -2.0));
  vec3 A0 = px(c, vec2(-2.0, -1.0)), A = px(c, vec2(-1.0, -1.0)), B = px(c, vec2(0.0, -1.0)), C = px(c, vec2(1.0, -1.0)), C4 = px(c, vec2(2.0, -1.0));
  vec3 D0 = px(c, vec2(-2.0, 0.0)), D = px(c, vec2(-1.0, 0.0)), E = px(c, vec2(0.0)), F = px(c, vec2(1.0, 0.0)), F4 = px(c, vec2(2.0, 0.0));
  vec3 G0 = px(c, vec2(-2.0, 1.0)), G = px(c, vec2(-1.0, 1.0)), H = px(c, vec2(0.0, 1.0)), I = px(c, vec2(1.0, 1.0)), I4 = px(c, vec2(2.0, 1.0));
  vec3 G5 = px(c, vec2(-1.0, 2.0)), H5 = px(c, vec2(0.0, 2.0)), I5 = px(c, vec2(1.0, 2.0));
  gl_FragColor = vec4(corner(E, B, D, F, H, C, G, I, F4, H5, I4, I5), corner(E, D, H, B, F, A, I, C, B1, F4, C1, C4),
                      corner(E, H, F, D, B, G, C, A, D0, B1, A0, A1), corner(E, F, B, H, D, I, A, G, H5, D0, G5, G0)) / 255.0;
}`;
const FS_XBR = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform sampler2D uDec; uniform vec2 uTexSize; uniform vec2 uReg; uniform float uScale;
vec3 px(vec2 c, vec2 o){ return texture2D(uTex, clamp(c + o / uTexSize, vec2(0.5) / uTexSize, (uReg - 0.5) / uTexSize)).rgb; }
void apply(float v, float s, float t, vec3 F, vec3 H, float d, inout float best, inout vec3 col){
  if (v < 0.5) return;
  float m = smoothstep(0.5 - d * 1.414, 0.5 + d * 1.414, s + t);
  if (mod(floor(v / 2.0), 2.0) > 0.5) m = max(m, smoothstep(0.25 - d * 1.118, 0.25 + d * 1.118, t + 0.5 * s));
  if (mod(floor(v / 4.0), 2.0) > 0.5) m = max(m, smoothstep(0.25 - d * 1.118, 0.25 + d * 1.118, s + 0.5 * t));
  if (m > best) { best = m; col = v >= 8.0 ? H : F; }
}
void main(){
  vec2 p = vUv * uReg; vec2 ip = floor(p); vec2 f = p - ip - 0.5; vec2 c = (ip + 0.5) / uTexSize;
  vec4 code = floor(texture2D(uDec, (ip + 0.5) / uReg) * 255.0 + 0.5);
  vec3 E = px(c, vec2(0.0));
  if (code.r + code.g + code.b + code.a < 0.5) { gl_FragColor = vec4(E, 1.0); return; }
  vec3 R = px(c, vec2(1.0, 0.0)), Dn = px(c, vec2(0.0, 1.0)), U = px(c, vec2(0.0, -1.0)), L = px(c, vec2(-1.0, 0.0));
  float d = 0.5 / uScale, best = 0.0; vec3 col = E;
  apply(code.r, f.x, f.y, R, Dn, d, best, col);
  apply(code.g, -f.y, f.x, U, R, d, best, col);
  apply(code.b, -f.x, -f.y, L, U, d, best, col);
  apply(code.a, f.y, -f.x, Dn, L, d, best, col);
  gl_FragColor = vec4(mix(E, col, best), 1.0);
}`;
// glow: bright parts of the frame at half size, blurred, added back over the picture
const FS_BRIGHT = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uReg;
void main(){
  vec2 q = (floor(vUv * uReg) * 2.0 + 1.0) / uTexSize;
  vec3 c = texture2D(uTex, q).rgb;
  float m = max(c.r, max(c.g, c.b)), n = min(c.r, min(c.g, c.b));
  float sat = (m - n) / max(m, 0.001);
  float k = smoothstep(0.5, 0.9, m) * smoothstep(0.3, 0.7, sat);
  gl_FragColor = vec4(c * k, 1.0);
}`;
const FS_BLUR = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uDir;
void main(){
  vec2 d = uDir / uTexSize;
  vec3 c = texture2D(uTex, vUv).rgb * 0.227;
  c += (texture2D(uTex, vUv + d * 1.385).rgb + texture2D(uTex, vUv - d * 1.385).rgb) * 0.316;
  c += (texture2D(uTex, vUv + d * 3.231).rgb + texture2D(uTex, vUv - d * 3.231).rgb) * 0.070;
  gl_FragColor = vec4(c, 1.0);
}`;
const FS_OUT = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uReg; uniform vec2 uOut;
uniform float uSharp; uniform float uVivid; uniform sampler2D uBloom; uniform float uGlow;
void main(){
  vec2 p = vUv * uReg; vec2 uv;
  if (uSharp > 0.5) {
    vec2 scale = max(floor(uOut / uReg + 0.001), vec2(1.0)) + fract(uOut / uReg);
    vec2 ip = floor(p); vec2 cd = p - ip - 0.5; vec2 rr = 0.5 - 0.5 / scale;
    vec2 f = (cd - clamp(cd, -rr, rr)) * scale + 0.5;
    uv = (ip + f) / uTexSize;
  } else uv = p / uTexSize;
  vec3 c = texture2D(uTex, uv).rgb;
  if (uGlow > 0.0) c = 1.0 - (1.0 - c) * (1.0 - clamp(texture2D(uBloom, vUv).rgb * uGlow, 0.0, 1.0));
  if (uVivid > 0.0) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.0 + 0.16 * uVivid);
    c = (c - 0.5) * (1.0 + 0.07 * uVivid) + 0.5;
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL을 쓸 수 없어요");
    this.gl = gl;
    this.epx = this.program(FS_EPX);
    this.xbr = this.program(FS_XBR);
    this.xbrDec = this.program(FS_XBR_DEC);
    this.out = this.program(FS_OUT);
    this.bright = this.program(FS_BRIGHT);
    this.blur = this.program(FS_BLUR);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.srcW = 512;
    this.srcH = 256;
    this.src = this.texture(512, 256, gl.RGB, gl.UNSIGNED_SHORT_5_6_5);
    this.fbos = [];
    this.dirty = true;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
  }
  program(fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    const u = {};
    for (const n of ["uTex", "uTexSize", "uReg", "uOut", "uSharp", "uVivid", "uFlip", "uEq", "uBloom", "uGlow", "uDir", "uScale", "uDec"]) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }
  texture(w, h, fmt, type, linear = true) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  fbo(i, w, h) {
    const gl = this.gl;
    let f = this.fbos[i];
    if (f && f.w === w && f.h === h) return f;
    if (f) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    const tex = this.texture(w, h, gl.RGBA, gl.UNSIGNED_BYTE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    f = this.fbos[i] = { fb, tex, w, h };
    return f;
  }
  resize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.dirty = true;
  }
  upload(pixels, w, h) {
    const gl = this.gl;
    if (w !== this.srcW || h !== this.srcH) {
      gl.deleteTexture(this.src);
      this.src = this.texture(w, h, gl.RGB, gl.UNSIGNED_SHORT_5_6_5);
      this.srcW = w;
      this.srcH = h;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.UNSIGNED_SHORT_5_6_5, pixels);
    this.dirty = true;
  }
  pass(prog, tex, texW, texH, regW, regH, target, outW, outH, extra) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.u.uTex, 0);
    gl.uniform2f(prog.u.uTexSize, texW, texH);
    gl.uniform2f(prog.u.uReg, regW, regH);
    gl.uniform1f(prog.u.uFlip, target ? 0 : 1);
    extra?.(gl, prog.u);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  draw() {
    const gl = this.gl;
    const W = this.srcW, H = this.srcH;
    let tex = this.src, tw = W, th = H, rw = W, rh = H;
    if (prefs.quality === "hd") {
      const dec = this.fbo(4, W, H), b = this.fbo(1, W * 4, H * 4);
      if (this.dirty) {
        this.pass(this.xbrDec, this.src, W, H, W, H, dec, W, H);
        this.pass(this.xbr, this.src, W, H, W, H, b, W * 4, H * 4, (gl, u) => {
          gl.uniform1f(u.uScale, 4);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, dec.tex);
          gl.uniform1i(u.uDec, 1);
          gl.activeTexture(gl.TEXTURE0);
        });
      }
      tex = b.tex; tw = rw = W * 4; th = rh = H * 4;
    } else if (prefs.quality !== "pixel") {
      const a = this.fbo(0, W * 2, H * 2), b = this.fbo(1, W * 4, H * 4);
      if (this.dirty) {
        const tol = (gl, u) => gl.uniform1f(u.uEq, 0.08);
        this.pass(this.epx, this.src, W, H, W, H, a, W * 2, H * 2, tol);
        this.pass(this.epx, a.tex, W * 2, H * 2, W * 2, H * 2, b, W * 4, H * 4, tol);
      }
      tex = b.tex; tw = rw = W * 4; th = rh = H * 4;
    }
    const glow = prefs.glow === "strong" ? 1.1 : prefs.glow === "soft" ? 0.6 : 0;
    let bloom = null;
    if (glow) {
      const bw = W >> 1, bh = H >> 1;
      const g0 = this.fbo(2, bw, bh), g1 = this.fbo(3, bw, bh);
      if (this.dirty) {
        this.pass(this.bright, this.src, W, H, bw, bh, g0, bw, bh);
        for (const [from, to, dx, dy] of [[g0, g1, 1, 0], [g1, g0, 0, 1], [g0, g1, 2, 0], [g1, g0, 0, 2]])
          this.pass(this.blur, from.tex, bw, bh, bw, bh, to, bw, bh, (gl, u) => gl.uniform2f(u.uDir, dx, dy));
      }
      bloom = g0.tex;
    }
    this.dirty = false;
    const ow = this.canvas.width, oh = this.canvas.height;
    this.pass(this.out, tex, tw, th, rw, rh, null, ow, oh, (gl, u) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloom || tex);
      gl.uniform1i(u.uBloom, 1);
      gl.uniform1f(u.uGlow, glow);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(u.uOut, ow, oh);
      gl.uniform1f(u.uSharp, prefs.quality === "smooth" ? 0 : 1);
      gl.uniform1f(u.uVivid, prefs.color === "vivid" ? 1 : 0);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Sound: the game names a sound; Native.QtPlaySound turns the name into an Android raw resource id
// with its own table, and ids up to bgm_worldship are music (one at a time, MediaPlayer) while the
// rest are effects (SoundPool). The table is kept as it is, including its quirk: "bgm_event" plays
// the resource after bgm_event (bgm_forest) and "e_cri" plays bgm_event.
const SOUND_IDS = {
  bgm_boss: 0, bgm_castle: 1, bgm_dungeon: 2, e_cri: 3, bgm_event: 4, bgm_gloomy: 5, bgm_ice: 6, bgm_title: 7,
  bgm_village: 8, bgm_worldair: 9, bgm_worldnormal: 10, bgm_worldship: 11, snd_attack1: 12, snd_attack2: 13,
  snd_attack3: 14, snd_attack4: 15, snd_attack5: 16, snd_attack_punch: 17, snd_attack_punch2: 18, snd_attack_slash: 19,
  snd_levelup: 20, snd_skill_buff: 21, snd_skill_downblow: 22, snd_skill_framewave: 23, snd_skill_hellfire: 24,
  snd_skill_howl: 25, snd_skill_ice: 26, snd_skill_metor: 27, snd_skill_powerwave: 28, snd_skill_soul: 29,
  snd_skill_thunder: 30, snd_skill_translycan: 31, snd_skill_upblow: 32, snd_skill_wind: 33,
};
const LAST_MUSIC_ID = 11;
class AudioEngine {
  constructor(sounds) {
    this.sounds = sounds; // raw resource name -> encoded bytes
    this.raw = Object.keys(sounds).sort(); // resource ids follow the sorted file names
    this.ctx = null;
    this.bufs = new Map();
    this.music = null; // { name, src }
    this.musicTicket = 0;
  }
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.applyVolumes();
      // a silent buffer started inside the gesture unlocks output on iOS
      const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
      for (const name of this.raw) if (!name.startsWith("bgm")) this.decode(name);
    }
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }
  applyVolumes() { if (this.ctx) this.master.gain.value = prefs.sound === "on" ? 1 : 0; }
  suspend() { this.ctx?.suspend().catch(() => {}); }
  resume() { this.ctx?.resume().catch(() => {}); }
  decode(name) {
    let p = this.bufs.get(name);
    if (!p) {
      const bytes = this.sounds[name];
      p = !bytes || !this.ctx ? Promise.resolve(null) : new Promise(resolve => this.ctx.decodeAudioData(bytes.slice(0), resolve, () => resolve(null)));
      this.bufs.set(name, p);
    }
    return p;
  }
  play(name, loop) {
    const id = SOUND_IDS[name];
    const file = id === undefined ? null : this.raw[id];
    if (!file || !this.ctx) return;
    if (id <= LAST_MUSIC_ID) {
      this.stopMusic();
      const ticket = ++this.musicTicket;
      // keep only the current piece of music decoded
      for (const n of this.bufs.keys()) if (n.startsWith("bgm") && n !== file) this.bufs.delete(n);
      this.decode(file).then(buf => {
        if (!buf || ticket !== this.musicTicket) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = loop;
        src.connect(this.master);
        src.start();
        this.music = { name: file, src };
      });
    } else {
      this.decode(file).then(buf => {
        if (!buf) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.master);
        src.start();
      });
    }
  }
  stopMusic() {
    this.musicTicket++;
    if (this.music) { try { this.music.src.stop(); } catch {} this.music = null; }
  }
}

// ---------------------------------------------------------------------------------------------
// Rule changes ("개조"), applied to the game's data tables as the game reads them. Each one first checks
// the table's column layout and the original value, so another build of the game is left as it is.
// The item descriptions keep their original numbers.

// XDT table: u32 column count, u32 type per column, u32 row count, rows. 0 and 3 are length-prefixed text.
const XDT_FIELD_SIZE = { 0: 0, 1: 4, 3: 0, 4: 1, 5: 2 };
function readXdt(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const n = dv.getUint32(0, true);
  const types = Array.from({ length: n }, (_, i) => dv.getUint32(4 + 4 * i, true));
  if (types.some(t => !(t in XDT_FIELD_SIZE))) return null;
  const countAt = 4 + 4 * n;
  let o = countAt + 4;
  const rows = [];
  for (let r = dv.getUint32(countAt, true); r > 0; r--) {
    const f = [];
    for (const t of types) { f.push(o); o += XDT_FIELD_SIZE[t] || 1 + b[o]; }
    rows.push(f);
  }
  return o === b.length ? { dv, layout: types.join(), countAt, rows } : null;
}

// Every item of the cash shop (which needed the publisher's payment server), plus the legendary card box,
// as [item kind, index]: 13 adventure tools, 14 bags, 15 consumables.
const CASH_ITEMS = [
  [13, 7], [13, 9], [13, 11], [13, 13], [13, 15], [13, 17], [13, 18], [14, 2], [14, 3],
  [15, 301], [15, 83], [15, 85], [15, 86], [15, 88], [15, 285], [15, 286], [15, 287], [15, 288], [15, 289],
  [15, 308], [15, 293], [15, 302], [15, 303], [15, 304], [15, 305], [15, 87], [15, 307], [15, 309], [15, 310],
  [15, 311], [15, 312], [15, 313], [15, 294], [15, 296], [15, 298], [15, 343], [15, 344], [15, 345], [15, 346],
  [15, 358], [15, 359],
];
const CASH_MAKE_PRICE = 100;

const MODS = {
  // the alchemist's crafting list also makes every cash item, from gold alone (the list holds up to 80)
  "res/make_alchemist.xdt": (b, x) => {
    if (x.layout !== "0,4,4,5,4,5,4,5,4,4,5,4,4,5,4,1" || x.rows.length !== 33) return b;
    const out = [b];
    CASH_ITEMS.forEach(([kind, idx], i) => {
      const id = String(x.rows.length + i);
      const row = new Uint8Array(1 + id.length + 23);
      const dv = new DataView(row.buffer);
      row[0] = id.length;
      for (let k = 0; k < id.length; k++) row[1 + k] = id.charCodeAt(k);
      let o = 1 + id.length + 1; // level 0
      for (let k = 0; k < 2; k++) { row[o] = kind; dv.setUint16(o + 1, idx, true); o += 3; } // made item, and the same on a great success
      o += 12; // no materials
      dv.setUint32(o, CASH_MAKE_PRICE, true);
      out.push(row);
    });
    const res = new Uint8Array(out.reduce((n, a) => n + a.length, 0));
    out.reduce((o, a) => (res.set(a, o), o + a.length), 0);
    new DataView(res.buffer).setUint32(x.countAt, x.rows.length + CASH_ITEMS.length, true);
    return res;
  },
  // 현자의 보주 (row 13): experience +50% -> +250%; 행운의 장신구 (row 17): drop rate +50% -> +250%
  "res/item_13_adventure.xdt": (b, x) => {
    if (x.layout !== "0,3,4,4,4,4,4,1,4" || x.rows.length !== 19) return b;
    for (const r of [13, 17]) if (b[x.rows[r][3]] === 50) b[x.rows[r][3]] = 250;
    return b;
  },
  // 워킹홀리데이 주문서 (row 305): experience and drop rate 100% -> 250%, 60 -> 240 minutes
  "res/item_15_use.xdt": (b, x) => {
    if (x.layout !== "0,3,4,4,4,4,4,5,4,1,4,5,4,1" || x.rows.length !== 367) return b;
    const f = x.rows[305];
    if (b[f[8]] === 100 && x.dv.getUint32(f[9], true) === 60) { b[f[8]] = 250; x.dv.setUint32(f[9], 240, true); }
    return b;
  },
};

function modAsset(name, bytes) {
  const b = bytes.slice();
  const x = readXdt(b);
  return x ? MODS[name](b, x) : bytes;
}

// ---------------------------------------------------------------------------------------------
// The emulator core
class Core {
  async init(game, files, onEvent) {
    this.game = game;
    this.modded = new Map(); // fixed for this run, so a table always reads the same
    this.useMods = prefs.mod === "on";
    this.onEvent = onEvent;
    this.utf = new TextDecoder();
    this.euc = new TextDecoder("euc-kr");
    this.logs = [];
    const env = {
      host_log: (p, n) => {
        const s = this.euc.decode(new Uint8Array(this.mem.buffer, p, n).slice());
        this.logs.push(s);
        if (this.logs.length > 200) this.logs.shift();
        if (window.DW_DEBUG) console.debug("[game]", s);
      },
      host_now: () => Date.now(),
      host_file_saved: (p, pl, d, n) => saves.write(this.utf.decode(new Uint8Array(this.mem.buffer, p, pl)), new Uint8Array(this.mem.buffer, d, n).slice()),
      host_file_deleted: (p, pl) => saves.remove(this.utf.decode(new Uint8Array(this.mem.buffer, p, pl))),
      host_event: (kind, a, b, c) => this.onEvent(kind, a, b, c) | 0,
      host_asset: (p, n, dst, cap) => {
        const name = this.utf.decode(new Uint8Array(this.mem.buffer, p, n));
        const data = this.asset(name);
        if (!data) return -1;
        if (dst) new Uint8Array(this.mem.buffer, dst, Math.min(cap, data.length)).set(data.subarray(0, cap));
        return data.length;
      },
      host_sound: (op, p, n, loop) => {
        if (op === 1) audio.play(this.utf.decode(new Uint8Array(this.mem.buffer, p, n)), !!loop);
        else audio.stopMusic();
      },
    };
    const resp = fetch(`dwcore.wasm?v=${VERSION}`);
    const { instance } = await (WebAssembly.instantiateStreaming
      ? WebAssembly.instantiateStreaming(resp, { env })
      : WebAssembly.instantiate(await (await resp).arrayBuffer(), { env }));
    this.ex = instance.exports;
    this.mem = this.ex.memory;
    const ex = this.ex;
    const so = game.so;
    const p = ex.host_alloc(so.length);
    new Uint8Array(this.mem.buffer, p, so.length).set(so);
    ex.set_logging(window.DW_DEBUG ? 1 : 0);
    if (ex.load_library(p, so.length) !== 0) throw new Error("게임 라이브러리를 불러오지 못했어요");
    ex.install_fast_paths(); // native drawing routines, the same pixels; only for the known library build
    ex.host_free(p);
    for (const [path, data] of files) {
      const dp = ex.host_alloc(Math.max(1, data.length));
      new Uint8Array(this.mem.buffer, dp, data.length).set(data);
      ex.fs_put(this.cstr(path), dp, data.length);
    }
  }
  // Native.getResource: AssetManager.open(name + ".png")
  asset(name) {
    const hit = this.game.index[name + ".png"];
    if (!hit) return null;
    const raw = this.game.assets.subarray(hit[0], hit[0] + hit[1]);
    if (!this.useMods || !MODS[name]) return raw;
    if (!this.modded.has(name)) this.modded.set(name, modAsset(name, raw));
    return this.modded.get(name);
  }
  cstr(s) {
    const b = new TextEncoder().encode(s + "\0");
    const p = this.ex.host_alloc(b.length);
    new Uint8Array(this.mem.buffer, p, b.length).set(b);
    return p;
  }
  start(w) {
    if (this.ex.app_start(w, LCD_H) !== 0) return -1;
    return 0;
  }
  // The title shows an Android bitmap behind the game (AndDark.ProcessGame). The original stretches it
  // over the screen; here it keeps its shape: fitted to the height, with a dimmed, blurred copy of
  // itself filling the sides of the wider iPhone screen.
  async setTitleBackgrounds() {
    const w = this.ex.screen_w(), h = this.ex.screen_h();
    const canvas = (cw, ch) => Object.assign(document.createElement("canvas"), { width: cw, height: ch });
    for (let i = 0; i < this.game.bg.length && i < 2; i++) {
      const img = await createImageBitmap(new Blob([this.game.bg[i]]));
      const c = canvas(w, h);
      const g = c.getContext("2d", { willReadFrequently: true });
      // the blur: the picture shrunk to a few pixels and stretched back with smoothing
      const cover = Math.max(w / img.width, h / img.height);
      const small = canvas(Math.ceil(w / 12), Math.ceil(h / 12));
      const sg = small.getContext("2d");
      sg.drawImage(img, (small.width - (img.width * cover) / 12) / 2, (small.height - (img.height * cover) / 12) / 2, (img.width * cover) / 12, (img.height * cover) / 12);
      g.imageSmoothingEnabled = true;
      g.drawImage(small, 0, 0, w, h);
      g.fillStyle = "rgba(0, 0, 0, 0.55)";
      g.fillRect(0, 0, w, h);
      const fit = h / img.height, fw = Math.round(img.width * fit);
      g.imageSmoothingQuality = "high";
      g.drawImage(img, Math.round((w - fw) / 2), 0, fw, h);
      const rgba = g.getImageData(0, 0, w, h).data;
      const dst = new Uint16Array(this.mem.buffer, this.ex.set_title_bg(i), w * h);
      for (let k = 0, j = 0; k < dst.length; k++, j += 4) dst[k] = ((rgba[j] >> 3) << 11) | ((rgba[j + 1] >> 2) << 5) | (rgba[j + 2] >> 3);
    }
  }
  tick() {
    this.ex.interp_tick(0);
    const r = this.ex.app_tick();
    this.ex.interp_tick(1);
    return r;
  }
  // the field at fraction f (0..256) of the way from the previous game frame to the last one, or null
  between(f) {
    const w = this.ex.screen_w(), h = this.ex.screen_h(), n = w * h;
    if (!this.mid || this.midN !== n) { if (this.mid) this.ex.host_free(this.mid); this.mid = this.ex.host_alloc(n * 2); this.midN = n; }
    const out = new Uint16Array(this.mem.buffer, this.mid, n);
    out.set(new Uint16Array(this.mem.buffer, this.ex.screen(), n));
    if (this.ex.interp_draw(f, this.mid, w, h) !== 0) return null;
    return { w, h, px: new Uint16Array(this.mem.buffer, this.mid, n) };
  }
  touch(type, x, y) { this.ex.app_touch(type, x, y); }
  key(type, code) { this.ex.app_touch(type, code, 0); }
  frame() {
    const w = this.ex.screen_w(), h = this.ex.screen_h();
    return { w, h, px: new Uint16Array(this.mem.buffer, this.ex.screen(), w * h) };
  }
}

// ---------------------------------------------------------------------------------------------
// Saves: every file the game writes is mirrored to IndexedDB
const saves = {
  pending: new Map(),
  timer: 0,
  write(path, data) {
    this.pending.set(path, data);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  },
  remove(path) {
    this.pending.set(path, null);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  },
  async flush() {
    const items = [...this.pending];
    this.pending.clear();
    for (const [path, data] of items) {
      try { data ? await idbPut("files", path, data) : await idbDel("files", path); } catch (e) { console.warn("save failed", e); }
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Input. The game takes one touch point, as on Android where it reads the first finger only (down 23,
// up 24, move 25): while any finger is on the screen the touch stays down, and when the finger being
// followed lifts, the next one takes over without lifting.
const fingers = []; // [{ id, p }] in the order they touched
let core, audio, renderer;
let running = false;
let pendingMove = null;

function touchStart(id, cx, cy) {
  const p = toLcd(cx, cy);
  fingers.push({ id, p });
  if (fingers.length === 1) { pendingMove = null; core.touch(23, p[0], p[1]); }
}
function touchMove(id, cx, cy) {
  const f = fingers.find(f => f.id === id);
  if (!f) return;
  const p = toLcd(cx, cy);
  if (p[0] === f.p[0] && p[1] === f.p[1]) return;
  f.p = p;
  if (fingers[0] === f) pendingMove = p;
}
function sendMove() {
  if (!pendingMove) return;
  core.touch(25, pendingMove[0], pendingMove[1]);
  pendingMove = null;
}
function touchEnd(id, cx, cy) {
  const i = fingers.findIndex(f => f.id === id);
  if (i < 0) return;
  const [f] = fingers.splice(i, 1);
  if (i !== 0) return;
  sendMove();
  if (fingers.length) { core.touch(25, fingers[0].p[0], fingers[0].p[1]); return; }
  const p = cx === undefined ? f.p : toLcd(cx, cy);
  core.touch(24, p[0], p[1]);
}
function releaseAll() {
  while (fingers.length) touchEnd(fingers[fingers.length - 1].id);
}

function bindInput() {
  const opts = { passive: false };
  const isUi = t => t.closest?.(".side, .overlay.show");
  document.addEventListener("touchstart", e => {
    if (isUi(e.target)) return;
    e.preventDefault();
    audio?.unlock();
    if (!running) return;
    for (const t of e.changedTouches) touchStart(t.identifier, t.clientX, t.clientY);
  }, opts);
  document.addEventListener("touchmove", e => {
    if (e.target.closest?.("#settings .panel")) return;
    e.preventDefault();
    if (!running) return;
    for (const t of e.changedTouches) touchMove(t.identifier, t.clientX, t.clientY);
  }, opts);
  const end = e => {
    if (!running) return;
    for (const t of e.changedTouches) touchEnd(t.identifier, t.clientX, t.clientY);
  };
  document.addEventListener("touchend", end, opts);
  document.addEventListener("touchcancel", end, opts);
  // mouse and keys, for playing on a computer: the game still understands the phone keys of the
  // original version (arrows and OK, CLR, # and *)
  let mouseDown = false;
  document.addEventListener("mousedown", e => { if (isUi(e.target) || !running) return; mouseDown = true; audio?.unlock(); touchStart("m", e.clientX, e.clientY); });
  document.addEventListener("mousemove", e => { if (mouseDown) touchMove("m", e.clientX, e.clientY); });
  document.addEventListener("mouseup", e => { if (mouseDown) { mouseDown = false; touchEnd("m", e.clientX, e.clientY); } });
  const keys = { ArrowUp: -1, ArrowDown: -2, ArrowLeft: -3, ArrowRight: -4, Enter: -5, " ": -5, Escape: -16, Backspace: -16, "#": 35, "*": 42 };
  const code = e => keys[e.key] ?? (/^[0-9]$/.test(e.key) ? e.key.charCodeAt(0) : null);
  document.addEventListener("keydown", e => { const k = code(e); if (k !== null && running && !e.repeat) { audio?.unlock(); core.key(2, k); e.preventDefault(); } });
  document.addEventListener("keyup", e => { const k = code(e); if (k !== null && running) core.key(3, k); });
  document.addEventListener("gesturestart", e => e.preventDefault());
  document.addEventListener("dblclick", e => e.preventDefault());
}

// events from the core: 1 vibrate, 3 timer interval changed, 4 in-app purchase asked
function onCoreEvent(kind, a, b, c) {
  if (kind === 10 && fx) {
    // a damage number appears at (x, y) above the monster's head; the blow lands between head and feet
    const x = (c << 16) >> 16, y = c >> 16, feet = a >> 16;
    if ((a & 255) === 1) fx.hit(x, feet > y ? Math.round((y + 10 + feet) / 2) : y + 14, b, (a >> 8) & 1);
    else if ((a & 255) === 2 && b > 0) fx.hurtHero();
  }
  if (kind === 4) {
    // buying needed Google Play; the game hears the same as a cancelled purchase
    toast("결제는 이 플레이어에서 쓸 수 없어요");
    setTimeout(() => core?.ex.app_charge(0), 0);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Hit feedback drawn over the game: sparks, a glow and a slash where a monster is struck, a pixel star,
// a ring and a short shake on critical hits, red edges when the hero is hit. Driven by the game's own
// damage numbers (dwcore event 10); the game's hits, damage and effects are unchanged. Positions are map
// pixels, drawn relative to the camera of the picture on screen so they stay on the monster, as squares on
// the game's pixel grid so they read as part of the pixel art.
class Fx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.parts = []; this.rings = []; this.glows = []; this.slashes = []; this.bursts = [];
    this.hurt = 0; this.shake = 0; this.shakeT = 0; this.shakeAng = 0;
    this.cam = [0, 0];
    this.drawn = false;
    this.avg = 0;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.scale = (w * dpr) / lcdW;
    this.drawn = true;
  }
  level() { return prefs.impact === "strong" ? 1.4 : prefs.impact === "normal" ? 1 : 0; }
  hit(x, y, dmg, crit) {
    const k = this.level();
    if (!k) return;
    // a blow well above the recent average counts as big too (strong skills)
    const big = crit || (this.avg > 0 && dmg > this.avg * 1.35);
    this.avg = this.avg ? this.avg * 0.85 + dmg * 0.15 : dmg;
    const n = Math.round((big ? 16 : 9) * k);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (big ? 2.4 : 1.8) * (0.5 + Math.random()) * k;
      this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.6, life: 1, decay: 0.045 + Math.random() * 0.035, w: big && i % 3 === 0 ? 2 : 1, hue: big ? 45 : 25 + Math.random() * 20 });
    }
    this.glows.push({ x, y, r: (big ? 22 : 14) * k, life: 1, decay: big ? 0.08 : 0.12, hue: big ? 48 : 32 });
    const ang = -0.6 + Math.random() * 1.2 + (Math.random() < 0.5 ? 0 : Math.PI / 2);
    this.slashes.push({ x, y, ang, len: (big ? 28 : 20) * k, life: 1, decay: big ? 0.1 : 0.15, hue: big ? 45 : 28 });
    if (big) {
      this.bursts.push({ x, y, len: 12 * k, life: 1, decay: 0.09 });
      this.rings.push({ x, y, r: 5, vr: 2.6 * k, life: 1, decay: 0.07, hue: 45 });
      this.kick(2.2 * k);
    } else this.kick(0.8 * k);
  }
  hurtHero() {
    const k = this.level();
    if (!k) return;
    this.hurt = Math.min(1, 0.55 * k + this.hurt * 0.5);
    this.kick(1.8 * k);
  }
  // a short damped sway in one direction instead of a random jitter every frame
  kick(px) {
    if (this.reduced) return;
    if (px <= this.shake) return;
    this.shake = px; this.shakeT = 0; this.shakeAng = Math.random() * Math.PI * 2;
  }
  shakeOffset() {
    if (!this.shake) return [0, 0];
    const v = Math.sin(this.shakeT * 0.09) * this.shake;
    return [Math.cos(this.shakeAng) * v, Math.sin(this.shakeAng) * v * 0.7];
  }
  busy() { return this.parts.length || this.rings.length || this.glows.length || this.slashes.length || this.bursts.length || this.hurt > 0 || this.shake > 0; }
  update(dt) {
    const f = Math.min(dt / 16.7, 3);
    for (const p of this.parts) { p.x += p.vx * f; p.y += p.vy * f; p.vy += 0.08 * f; p.vx *= 0.96; p.life -= p.decay * f; }
    for (const r of this.rings) { r.r += r.vr * f; r.vr *= 0.93; r.life -= r.decay * f; }
    for (const g of this.glows) g.life -= g.decay * f;
    for (const sl of this.slashes) sl.life -= sl.decay * f;
    for (const b of this.bursts) b.life -= b.decay * f;
    this.parts = this.parts.filter(p => p.life > 0);
    this.rings = this.rings.filter(r => r.life > 0);
    this.glows = this.glows.filter(g => g.life > 0);
    this.slashes = this.slashes.filter(sl => sl.life > 0);
    this.bursts = this.bursts.filter(b => b.life > 0);
    this.hurt = Math.max(0, this.hurt - 0.035 * f);
    this.shakeT += dt;
    this.shake = this.shake < 0.15 ? 0 : this.shake * Math.pow(0.84, f);
  }
  draw() {
    const c = this.ctx, s = this.scale;
    if (!this.busy() && !this.drawn) return;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawn = !!this.busy();
    const [cx, cy] = this.cam;
    const dot = (x, y, size) => c.fillRect(Math.round(x - cx - size / 2) * s, Math.round(y - cy - size / 2) * s, size * s, size * s);
    const line = (x0, y0, x1, y1, size) => {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let i = 0; i <= n; i++) dot(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, size);
    };
    if (this.hurt > 0) { // red edges
      const W = this.canvas.width, H = this.canvas.height;
      const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.62);
      g.addColorStop(0, "rgba(200,0,0,0)");
      g.addColorStop(1, `rgba(200,0,0,${0.45 * this.hurt})`);
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }
    c.globalCompositeOperation = "lighter";
    for (const g of this.glows) {
      const r = g.r * s * (1.2 - g.life * 0.4), gx = (g.x - cx) * s, gy = (g.y - cy) * s;
      const grd = c.createRadialGradient(gx, gy, 0, gx, gy, r);
      grd.addColorStop(0, `hsla(${g.hue},100%,85%,${0.75 * g.life})`);
      grd.addColorStop(0.35, `hsla(${g.hue},100%,60%,${0.35 * g.life})`);
      grd.addColorStop(1, `hsla(${g.hue},100%,50%,0)`);
      c.fillStyle = grd;
      c.fillRect(gx - r, gy - r, r * 2, r * 2);
    }
    for (const sl of this.slashes) {
      const half = (sl.len * (1.25 - sl.life * 0.25)) / 2;
      const dx = Math.cos(sl.ang) * half, dy = Math.sin(sl.ang) * half * 0.8;
      c.fillStyle = `hsla(${sl.hue},100%,60%,${0.5 * sl.life})`;
      line(sl.x - dx, sl.y - dy, sl.x + dx, sl.y + dy, sl.life > 0.5 ? 3 : 2);
      c.fillStyle = `rgba(255,255,240,${sl.life})`;
      line(sl.x - dx * 0.85, sl.y - dy * 0.85, sl.x + dx * 0.85, sl.y + dy * 0.85, 1);
    }
    for (const b of this.bursts) {
      const len = b.len * (1.35 - b.life * 0.35);
      c.fillStyle = `rgba(255,250,215,${b.life})`;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4, l = i % 2 ? len * 0.55 : len, r0 = len * 0.18 * (1 - b.life);
        line(b.x + Math.cos(a) * r0, b.y + Math.sin(a) * r0 * 0.8, b.x + Math.cos(a) * l, b.y + Math.sin(a) * l * 0.8, 1);
      }
      c.fillStyle = `rgba(255,220,120,${0.8 * b.life})`;
      dot(b.x, b.y, 3);
    }
    for (const p of this.parts) {
      c.fillStyle = `hsla(${p.hue},100%,${62 + 30 * p.life}%,${p.life})`;
      dot(p.x, p.y, p.w);
      c.fillStyle = `hsla(${p.hue},100%,55%,${0.45 * p.life})`;
      dot(p.x - p.vx * 0.9, p.y - p.vy * 0.9, 1);
    }
    for (const r of this.rings) {
      c.fillStyle = `hsla(${r.hue},100%,70%,${0.8 * r.life})`;
      const n = Math.max(12, Math.ceil(r.r * 4.2));
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; dot(r.x + Math.cos(a) * r.r, r.y + Math.sin(a) * r.r * 0.6, 1); }
    }
    c.globalCompositeOperation = "source-over";
  }
}
let fx;

// ---------------------------------------------------------------------------------------------
// Game loop: the Android timer (QtGameView) runs the game every `interval` ms (setTimer, 60 by default)
let acc = 0;
let lastT = 0;
// The game updates about 16 times a second. With 부드럽게 on, the display runs one game frame behind and
// shows the frames in between: the field drawn with the hero, the monsters and the camera part of the way
// between their positions in the last two game frames (dwcore interp.c). Menus, scripts and screen shakes
// show the game's own frames. A device too slow for that gets one in-between frame per game frame.
const motion = { cost: 0, shown: -1 };
function frameLoop(t) {
  requestAnimationFrame(frameLoop);
  if (!running) { lastT = t; return; }
  const dt = lastT ? Math.min(t - lastT, 250) : 0;
  lastT = t;
  const interval = Math.max(16, core.ex.interval());
  acc += dt;
  let ran = 0;
  while (acc >= interval && ran < 2) {
    sendMove();
    if (core.tick() !== 0) return crashed();
    acc -= interval;
    ran++;
  }
  if (acc > interval) acc = 0; // fell behind: drop the backlog instead of rushing
  let f = 256;
  if (prefs.motion === "smooth") {
    f = Math.min(256, Math.round((acc / interval) * 256));
    if (motion.cost > 9) f = f < 128 ? 128 : 256; // slow device: one in-between frame per game frame
    if (f > 240) f = 256;
  }
  if (!ran && f === motion.shown) { if (renderer.dirty) renderer.draw(); fxFrame(f); return; }
  let frame = null;
  if (f < 256) {
    const t0 = performance.now();
    frame = core.between(f);
    if (frame) motion.cost = motion.cost * 0.9 + (performance.now() - t0) * 0.1;
  }
  if (!frame) {
    if (!ran && motion.shown === 256) { if (renderer.dirty) renderer.draw(); fxFrame(256); return; }
    f = 256;
    frame = core.frame();
  }
  motion.shown = f;
  renderer.upload(frame.px, frame.w, frame.h);
  renderer.draw();
  fxFrame(f);
}

// the effects follow the camera of the picture on screen; the shake moves the game and the effects together
let fxT = 0;
function fxFrame(f) {
  if (!fx) return;
  const now = performance.now(), dt = fxT ? Math.min(now - fxT, 100) : 16.7;
  fxT = now;
  if (!fx.busy() && !fx.drawn) return;
  const ex = core.ex, k = Math.min(f, 256) / 256;
  fx.cam = [ex.interp_camera(0) + (ex.interp_camera(2) - ex.interp_camera(0)) * k, ex.interp_camera(1) + (ex.interp_camera(3) - ex.interp_camera(1)) * k];
  fx.update(dt);
  fx.draw();
  const [ox, oy] = fx.shakeOffset();
  const px = layout.stage.w / lcdW;
  $("stage").style.transform = ox || oy ? `translate(${(ox * px).toFixed(1)}px, ${(oy * px).toFixed(1)}px)` : "";
}

function crashed() {
  running = false;
  const logs = core?.logs.slice(-12).join("\n") || "";
  showOverlay("tap");
  $("tap-text").innerHTML = "게임이 멈췄어요.<br>화면을 터치하면 다시 시작해요.";
  $("tap-err").textContent = logs;
  $("tap").onclick = () => location.reload();
}

function showOverlay(id) {
  for (const o of document.querySelectorAll(".overlay")) o.classList.toggle("show", o.id === id);
}

// pause when the app goes to the background, like AndDark.onWindowFocusChanged (timer and music stop)
document.addEventListener("visibilitychange", () => {
  if (!core?.ex || !started) return;
  if (document.hidden) {
    if (running) { releaseAll(); running = false; audio.suspend(); }
    saves.flush();
  } else if (!running && !$("settings").classList.contains("show") && !$("tap").classList.contains("show")) {
    audio.resume();
    running = true;
  }
});
window.addEventListener("pagehide", () => saves.flush());

// ---------------------------------------------------------------------------------------------
// Settings
function syncSettings() {
  for (const seg of document.querySelectorAll(".seg[data-pref]")) {
    for (const b of seg.querySelectorAll("button")) b.classList.toggle("on", prefs[seg.dataset.pref] === b.dataset.v);
  }
}
function bindSettings() {
  for (const seg of document.querySelectorAll(".seg[data-pref]")) {
    seg.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (!b) return;
      const key = seg.dataset.pref;
      if (prefs[key] === b.dataset.v) return;
      prefs[key] = b.dataset.v;
      savePrefs();
      syncSettings();
      if (key === "screen" && started) toast("화면 크기는 게임을 다시 시작하면 맞춰져요");
      if (key === "mod" && started) toast("개조는 게임을 다시 시작하면 적용돼요");
      if (key === "motion") motion.shown = -1;
      if (key === "sound") audio?.applyVolumes();
      if (key === "screen" && !started) lcdW = chooseLcdWidth();
      if (key === "screen") applyLayout();
      if (renderer) renderer.dirty = true;
    });
  }
  let settingsPaused = false;
  $("btn-settings").addEventListener("click", () => {
    if (running) { releaseAll(); running = false; settingsPaused = true; }
    syncSettings();
    $("settings").classList.add("show");
  });
  $("btn-close").addEventListener("click", () => {
    $("settings").classList.remove("show");
    if (settingsPaused) { settingsPaused = false; running = true; }
  });
  $("btn-settings").addEventListener("touchstart", e => { e.stopPropagation(); audio?.unlock(); }, { passive: true });
  $("btn-restart").addEventListener("click", async () => { await saves.flush(); location.reload(); });
  $("btn-replace").addEventListener("click", async () => {
    if (!confirm("게임 파일을 지우고 다시 넣을까요? 세이브는 그대로 남아요.")) return;
    await saves.flush();
    await idbClear("game");
    location.reload();
  });
  $("btn-export").addEventListener("click", exportSaves);
  $("btn-import-save").addEventListener("click", () => $("save-file").click());
  $("save-file").addEventListener("change", async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.game !== "darkworld" || typeof data.files !== "object") throw new Error();
      if (!confirm("가져온 세이브로 바꾸고 게임을 다시 시작할까요?")) return;
      await idbClear("files");
      for (const [path, b64] of Object.entries(data.files)) await idbPut("files", path, Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)));
      location.reload();
    } catch { toast("세이브 파일을 읽지 못했어요"); }
  });
}

async function exportSaves() {
  await saves.flush();
  const entries = await idbEntries("files");
  if (!entries.length) return toast("아직 세이브가 없어요");
  const files = {};
  for (const [path, data] of entries) { let s = ""; for (const b of data) s += String.fromCharCode(b); files[path] = btoa(s); }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const name = `darkworld-save-${stamp}.json`;
  const file = new File([JSON.stringify({ game: "darkworld", saved: Date.now(), files })], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "다크월드 세이브" }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------------------------------------
// Boot
let started = false;
async function loadGame() {
  const [so, assets, index, sounds, bg, files] = await Promise.all(
    ["so", "assets", "index", "sounds", "bg"].map(k => idbGet("game", k)).concat(idbEntries("files")),
  );
  if (!so || !assets || !index) return null;
  return { so: new Uint8Array(so), assets: new Uint8Array(assets), index, sounds: sounds || {}, bg: bg || [], files };
}

async function prepareAndWait(game) {
  showOverlay("tap");
  $("tap-text").textContent = "불러오는 중…";
  lcdW = chooseLcdWidth();
  applyLayout();
  audio = new AudioEngine(game.sounds);
  core = new Core();
  try {
    await core.init(game, game.files, onCoreEvent);
  } catch (e) {
    $("tap-text").textContent = "게임을 불러오지 못했어요";
    $("tap-err").textContent = String(e?.message || e);
    return;
  }
  $("tap-text").textContent = "화면을 터치하면 시작해요";
  window.__dw = { core, fx: () => fx, audio: () => audio, lcd: () => lcdW, running: () => running, hold: v => { running = !v; }, ready: true };
  $("tap").onclick = () => {
    if (started) return;
    started = true;
    audio.unlock();
    startGame();
  };
}

async function startGame() {
  try {
    if (core.start(lcdW) !== 0) return crashed();
    await core.setTitleBackgrounds();
  } catch (e) {
    $("tap-err").textContent = String(e?.message || e);
    return;
  }
  showOverlay(null);
  running = true;
  requestAnimationFrame(frameLoop);
}

// The home-screen app can keep an old index.html for a while; version.txt is always fetched fresh, and
// when it names a newer version the page reloads once under a new address, which bypasses the cache.
async function checkForUpdate() {
  try {
    const r = await fetch(`version.txt?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return false;
    const v = (await r.text()).trim();
    if (!/^\d+$/.test(v) || Number(v) <= Number(VERSION) || sessionStorage.getItem("dw.update") === v) return false;
    sessionStorage.setItem("dw.update", v);
    location.replace(`./?v=${v}`);
    return true;
  } catch { return false; }
}

async function boot() {
  $("version").textContent = `버전 ${VERSION}`;
  if (await checkForUpdate()) return;
  bindInput();
  bindSettings();
  syncSettings();
  renderer = new Renderer($("screen"));
  fx = new Fx($("fx"));
  // iOS may drop the GL context while the app is in the background
  $("screen").addEventListener("webglcontextlost", e => e.preventDefault());
  $("screen").addEventListener("webglcontextrestored", () => {
    renderer = new Renderer($("screen"));
    applyLayout();
  });
  applyLayout();
  window.addEventListener("resize", () => setTimeout(applyLayout, 50));
  window.addEventListener("orientationchange", () => setTimeout(applyLayout, 200));
  screen.orientation?.addEventListener?.("change", () => setTimeout(applyLayout, 100));
  try { navigator.storage?.persist?.(); } catch {}
  let game = null;
  try { game = await loadGame(); } catch (e) { console.warn(e); }
  if (game) return prepareAndWait(game);
  showOverlay("home");
  $("btn-import").onclick = () => $("file").click();
  $("file").onchange = async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    $("home-err").textContent = "";
    $("btn-import").disabled = true;
    $("home-text").textContent = "게임 파일을 읽는 중이에요…";
    const bar = $("progress").firstElementChild;
    try {
      await importGame(f, p => (bar.style.width = Math.round(p * 100) + "%"));
      const g = await loadGame();
      await prepareAndWait(g);
    } catch (err) {
      $("home-err").textContent = String(err?.message || err);
      $("home-text").textContent = "다른 파일로 다시 시도해 주세요.";
      $("btn-import").disabled = false;
      bar.style.width = "0";
    }
  };
}

boot();
