// 제노니아4 player: runs the game's ARM library (Thumb-2, VFP) in z4core.wasm and presents it on an
// iPhone in landscape. The game draws its own touch controls (d-pad, attack and skill buttons); the page
// hands it the fingers with their pointer ids, like Android's multi-touch view did.
const VERSION = "21";
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Preferences (prefixed: the origin is shared with the other games of this site)
const PREF_KEY = "z4.prefs";
const prefs = Object.assign(
  { quality: "hd", color: "vivid", glow: "soft", motion: "smooth", impact: "normal", money: "max", refine: "easy", statPoints: "max", statStep: "10000", damage: "uncapped", skills: "max", sp: "max", critZoom: "off", perf: "off", dpad: "smooth", screen: "notch", sound: "on" },
  (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } })(),
);
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };

function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------------------------------------------------------------------------------------------
// IndexedDB: game files and saves
const DB_NAME = "zenonia4-player";
let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      // "backup": the version of each of the game's save files from before it was last replaced or removed
      for (const name of ["game", "files", "backup"]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
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
  if (e.method === 0) return new Uint8Array(await raw.arrayBuffer());
  if (e.method !== 8) throw new Error("지원하지 않는 압축 방식이에요");
  return new Uint8Array(await new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}

const SO_NAME = "lib/armeabi-v7a/libgameDSO.so";
const ENTRY = "Java_com_gamevil_nexus2_Natives_NativeRender";

// Everything the game reads is kept as records: the library, the asset files packed into one buffer
// with an index (Natives.readAssete opens them by name), and the sounds of res/raw.
// The accelerated core (z4fast.wasm) is the same core with the game's busiest functions translated ahead
// of time from the player's own copy of the library. It holds code made from the game, so it is not part of
// this site: the player adds it next to the apk.
// The names a WebAssembly file exports, read from its export section (no compiling: a phone compiles the
// 4 MB core once, when the game starts).
function wasmExports(b) {
  if (b.length < 8 || b[0] !== 0 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return null;
  let i = 8;
  const leb = () => { let r = 0, sh = 0, x; do { x = b[i++]; r += (x & 0x7f) * 2 ** sh; sh += 7; } while (x & 0x80 && i < b.length); return r; };
  const dec = new TextDecoder();
  while (i < b.length) {
    const id = b[i++], n = leb(), end = i + n;
    if (id === 7) {
      const names = [];
      for (let k = leb(); k > 0 && i < end; k--) { const len = leb(); names.push(dec.decode(b.subarray(i, i + len))); i += len + 1; leb(); }
      return names;
    }
    i = end;
  }
  return [];
}
const isWasm = b => b.length >= 4 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
async function importFastCore(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const names = wasmExports(bytes);
  if (!names) throw new Error(`가속 파일(z4fast.wasm)이 아니에요 (${file.name || "이름 없음"}, ${bytes.length} 바이트)`);
  // the accelerated part is a module of its own (aot_side.c) that goes next to the site's core, so the
  // site's updates reach the player without a new file; a whole core with it linked in is from before that
  if (!names.includes("aot_side")) {
    if (names.includes("aot_build") && bytes.length > 1000000) throw new Error("예전 방식의 가속 파일이에요. 새로 받은 z4fast.wasm을 골라 주세요(이번 한 번만 바꾸면 이후 업데이트는 자동으로 돼요)");
    throw new Error("이건 가속 파일이 아니라 기본 실행기예요");
  }
  await idbPut("game", "fast", bytes.buffer);
}

// The accelerated module (aot_side.c): a WebAssembly side module (dylink.0) that shares the core's memory
// and function table and reaches the interpreter's state through the core's exported addresses (GOT.mem).
function dylinkInfo(mod) {
  const sec = WebAssembly.Module.customSections(mod, "dylink.0")[0];
  if (!sec) return null;
  const b = new Uint8Array(sec);
  let i = 0;
  const leb = () => { let r = 0, sh = 0, c; do { c = b[i++]; r += (c & 127) * 2 ** sh; sh += 7; } while (c & 128); return r; };
  while (i < b.length) {
    const type = b[i++], len = leb(), end = i + len;
    if (type === 1) return { memSize: leb(), memAlign: leb(), tabSize: leb() }; // WASM_DYLINK_MEM_INFO
    i = end;
  }
  return { memSize: 0, memAlign: 0, tabSize: 0 };
}
async function attachSide(ex, bytes) {
  const mod = await WebAssembly.compile(bytes);
  const info = dylinkInfo(mod);
  if (!info) throw new Error("가속 파일의 형식이 달라요");
  const align = 2 ** info.memAlign;
  const memBase = Math.ceil(ex.host_alloc(info.memSize + align) / align) * align;
  new Uint8Array(ex.memory.buffer, memBase, info.memSize).fill(0);
  const table = ex.__indirect_function_table;
  const tableBase = table.length;
  table.grow(info.tabSize);
  const got = {};
  for (const imp of WebAssembly.Module.imports(mod))
    if (imp.module === "GOT.mem") got[imp.name] = new WebAssembly.Global({ value: "i32", mutable: true }, ex[imp.name].value);
  const i32 = v => new WebAssembly.Global({ value: "i32", mutable: false }, v);
  const env = { memory: ex.memory, __indirect_function_table: table, __memory_base: i32(memBase), __table_base: i32(tableBase), aot_call: ex.aot_call, cow_save_page: ex.cow_save_page };
  const side = await WebAssembly.instantiate(mod, { env, "GOT.mem": got });
  side.exports.__wasm_apply_data_relocs?.();
  const out = ex.host_alloc(24);
  side.exports.aot_side(out);
  const v = new Uint32Array(ex.memory.buffer, out, 6);
  return ex.aot_attach(v[0], v[1], v[2], v[3], v[4], v[5]); // -1: made for another build of the interpreter
}
async function importFiles(files, progress) {
  const list = [...files];
  // a wasm file is told apart by its first bytes: a download may lose the .wasm in its name
  const heads = await Promise.all(list.map(async f => new Uint8Array(await f.slice(0, 4).arrayBuffer())));
  const fast = list.filter((f, k) => isWasm(heads[k]));
  const games = list.filter((f, k) => !isWasm(heads[k]));
  for (const f of fast) await importFastCore(f);
  if (games.length) await importGame(games[0], progress);
  else if (!(await idbGet("game", "so"))) throw new Error("게임 파일(apk)도 함께 골라 주세요");
}
async function importGame(file, progress) {
  progress(0.02);
  let apk = file;
  let entries = await readZip(file);
  if (!entries.some(e => e.name === SO_NAME)) {
    const inner = entries.find(e => /\.apk$/i.test(e.name));
    if (!inner) throw new Error("zip 안에서 제노니아4 apk를 찾지 못했어요");
    progress(0.05);
    apk = new Blob([await zipData(file, inner)]);
    entries = await readZip(apk);
  }
  const soEntry = entries.find(e => e.name === SO_NAME);
  if (!soEntry) throw new Error("제노니아4 게임 파일이 아니에요 (lib/armeabi-v7a/libgameDSO.so가 없어요)");
  const so = await zipData(apk, soEntry);
  if (so[0] !== 0x7f || so[1] !== 0x45 || !findBytes(so, new TextEncoder().encode(ENTRY))) throw new Error("게임 라이브러리를 읽지 못했어요");
  progress(0.08);
  const assetEntries = entries.filter(e => e.name.startsWith("assets/") && !e.name.endsWith("/"));
  const parts = [];
  const index = {};
  let total = 0;
  for (let i = 0; i < assetEntries.length; i++) {
    const e = assetEntries[i];
    const buf = await zipData(apk, e);
    index[e.name.slice(7)] = [total, buf.length];
    parts.push(buf);
    total += buf.length;
    if (i % 32 === 0) progress(0.08 + 0.74 * (i / assetEntries.length));
  }
  const assets = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { assets.set(p, off); off += p.length; }
  progress(0.84);
  const sounds = {};
  for (const e of entries.filter(e => /^res\/raw\/s\d+\.ogg$/i.test(e.name))) {
    sounds[e.name.slice(8).replace(/\.[^.]+$/, "")] = (await zipData(apk, e)).buffer;
  }
  if (!Object.keys(index).length) throw new Error("게임 데이터(assets)가 없어요");
  progress(0.92);
  await idbPut("game", "so", so.buffer);
  await idbPut("game", "assets", assets.buffer);
  await idbPut("game", "index", index);
  await idbPut("game", "sounds", sounds);
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
// sideways even with the rotation lock on. The game lays itself out for any screen width (its HUD keeps
// to the edges and the field shows more of the map), so it is created 480 lines high and as wide as the
// phone's shape asks: on an iPhone 14 Pro that is about 1040, filling the screen without stretching.
const layout = { rotated: false, lw: 0, lh: 0, stage: { x: 0, y: 0, w: 0, h: 0 } };
let lcdW = 800;
const LCD_H = 480;

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
  const otherMargin = mode === "safe" ? (rotated ? ins.b : inset) : 0;
  const l = camLeft ? camMargin : otherMargin, r = camLeft ? otherMargin : camMargin;
  return { vw, vh, rotated, lw, lh, l, r, camLeft };
}

function chooseLcdWidth() {
  const m = landscapeMetrics();
  const w = Math.round((LCD_H * (m.lw - m.l - m.r)) / m.lh / 2) * 2;
  return Math.max(800, Math.min(1120, w || 800));
}

function applyLayout() {
  const m = landscapeMetrics();
  const frame = $("frame");
  frame.style.width = m.lw + "px";
  frame.style.height = m.lh + "px";
  frame.style.transform = m.rotated ? `translate(${m.vw}px, 0) rotate(90deg)` : "none";
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
  // the settings button: in the margin beside the camera when it fits there; otherwise a small, faint one
  // at the top edge between the game's top-left buttons and the minimap
  const side = $("side");
  const margin = m.camLeft ? sx : m.lw - sx - sw;
  const roomy = margin >= 44;
  side.classList.toggle("mini", !roomy);
  if (roomy) {
    const cx = m.camLeft ? margin / 2 : m.lw - margin / 2;
    side.style.left = cx - 20 + "px";
    side.style.top = Math.max(8, Math.round(m.lh * 0.04)) + "px";
  } else {
    side.style.left = sx + Math.round(sw * 0.5) - 15 + "px";
    side.style.top = sy + 4 + "px";
  }
  renderer?.resize(sw, sh);
  fx?.resize(sw, sh);
}

// client point -> game coordinates
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
// Renderer: RGB565 frame -> screen (smooth or sharp bilinear, or the original pixels), with an optional
// glow on bright coloured parts and a little more colour. The game is drawn at about the screen's own
// resolution, so no upscaling filter is needed.
const VS = `attribute vec2 aPos; varying vec2 vUv; uniform float uFlip;
void main(){ vUv = vec2(aPos.x * 0.5 + 0.5, uFlip > 0.5 ? 0.5 - aPos.y * 0.5 : aPos.y * 0.5 + 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;
// HD: an xBR-style pass doubles the picture, rounding the stair steps of diagonal edges into lines (pass 1
// decides per pixel corner, pass 2 draws); the output pass then scales that the last bit to the screen.
const FS_XBR_DEC = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uReg;
vec3 px(vec2 c, vec2 o){ return texture2D(uTex, clamp(c + o / uTexSize, vec2(0.5) / uTexSize, (uReg - 0.5) / uTexSize)).rgb; }
float wd(vec3 a, vec3 b){
  vec3 d = a - b;
  return 48.0 * abs(dot(d, vec3(0.299, 0.587, 0.114))) + 7.0 * abs(dot(d, vec3(-0.169, -0.331, 0.5))) + 6.0 * abs(dot(d, vec3(0.5, -0.419, -0.081)));
}
bool eq(vec3 a, vec3 b){ return wd(a, b) < 2.4; }
// one corner, named as if it were the bottom-right one. Result: 0 none, else 1 + 2 shallow + 4 steep + 8 if H's colour
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
  // bottom-right, top-right, top-left, bottom-left: the neighbourhood turned so each is bottom-right
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
  vec4 code = floor(texture2D(uDec, (ip + 0.5) / uReg) * 255.0 + 0.5); // the decisions of pass 1
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
const FS_BRIGHT = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uReg;
void main(){
  vec2 q = (floor(vUv * uReg) * 2.0 + 1.0) / uTexSize;
  vec3 c = texture2D(uTex, q).rgb;
  float m = max(c.r, max(c.g, c.b)), n = min(c.r, min(c.g, c.b));
  float sat = (m - n) / max(m, 0.001);
  float k = smoothstep(0.55, 0.92, m) * smoothstep(0.3, 0.7, sat);
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
uniform float uMode; uniform float uVivid; uniform sampler2D uBloom; uniform float uGlow;
void main(){
  vec2 p = vUv * uReg; vec2 uv;
  if (uMode > 1.5) uv = (floor(p) + 0.5) / uTexSize; // original pixels
  else if (uMode > 0.5) { // sharp bilinear: whole-pixel steps with a thin blend at the seams
    vec2 scale = max(uOut / uReg, vec2(1.0));
    vec2 ip = floor(p); vec2 cd = p - ip - 0.5; vec2 rr = 0.5 - 0.5 / scale;
    vec2 f = (cd - clamp(cd, -rr, rr)) * scale + 0.5;
    uv = (ip + f) / uTexSize;
  } else uv = p / uTexSize;
  vec3 c = texture2D(uTex, uv).rgb;
  if (uGlow > 0.0) c = 1.0 - (1.0 - c) * (1.0 - clamp(texture2D(uBloom, vUv).rgb * uGlow, 0.0, 1.0));
  if (uVivid > 0.0) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.0 + 0.14 * uVivid);
    c = (c - 0.5) * (1.0 + 0.06 * uVivid) + 0.5;
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL을 쓸 수 없어요");
    this.gl = gl;
    this.out = this.program(FS_OUT);
    this.bright = this.program(FS_BRIGHT);
    this.blur = this.program(FS_BLUR);
    this.xbr = this.program(FS_XBR);
    this.xbrDec = this.program(FS_XBR_DEC);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.srcW = 800;
    this.srcH = 480;
    this.src = this.texture(800, 480, gl.RGB, gl.UNSIGNED_SHORT_5_6_5);
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
    for (const n of ["uTex", "uTexSize", "uReg", "uOut", "uMode", "uVivid", "uFlip", "uBloom", "uGlow", "uDir", "uDec", "uScale"]) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }
  texture(w, h, fmt, type) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
    const glow = prefs.glow === "strong" ? 0.9 : prefs.glow === "soft" ? 0.45 : 0;
    let bloom = null;
    if (glow) {
      const bw = W >> 1, bh = H >> 1;
      const g0 = this.fbo(0, bw, bh), g1 = this.fbo(1, bw, bh);
      this.pass(this.bright, this.src, W, H, bw, bh, g0, bw, bh);
      for (const [from, to, dx, dy] of [[g0, g1, 1, 0], [g1, g0, 0, 1], [g0, g1, 2, 0], [g1, g0, 0, 2]])
        this.pass(this.blur, from.tex, bw, bh, bw, bh, to, bw, bh, (gl, u) => gl.uniform2f(u.uDir, dx, dy));
      bloom = g0.tex;
    }
    let tex = this.src, tw = W, th = H;
    if (prefs.quality === "hd") {
      const dec = this.fbo(2, W, H), b = this.fbo(3, W * 2, H * 2);
      this.pass(this.xbrDec, this.src, W, H, W, H, dec, W, H);
      this.pass(this.xbr, this.src, W, H, W, H, b, W * 2, H * 2, (gl, u) => {
        gl.uniform1f(u.uScale, 2);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, dec.tex);
        gl.uniform1i(u.uDec, 1);
        gl.activeTexture(gl.TEXTURE0);
      });
      tex = b.tex; tw = W * 2; th = H * 2;
    }
    this.dirty = false;
    const ow = this.canvas.width, oh = this.canvas.height;
    this.pass(this.out, tex, tw, th, tw, th, null, ow, oh, (gl, u) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloom || tex);
      gl.uniform1i(u.uBloom, 1);
      gl.uniform1f(u.uGlow, glow);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(u.uOut, ow, oh);
      gl.uniform1f(u.uMode, prefs.quality === "pixel" ? 2 : prefs.quality === "sharp" || prefs.quality === "hd" ? 1 : 0);
      gl.uniform1f(u.uVivid, prefs.color === "vivid" ? 1 : 0);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Text: the game draws its words through Java (NexusFont), one character cell at a time into a small
// bitmap that it then reads back; here a canvas does what Android's Paint and Canvas did.
const FONT_FAMILY = '"Apple SD Gothic Neo", "Noto Sans KR", "Helvetica Neue", "Malgun Gothic", sans-serif';
class TextEngine {
  constructor() {
    this.size = 12;
    this.color = 0xff000000 | 0;
    this.aa = true;
    this.colorkey = 0xffff00ff | 0;
    this.bpp = 32;
    this.str = "";
    this.rect = [0, 0, 0, 0];
    this.size2 = [0, 0];
    this.utf8 = new TextDecoder("utf-8");
    this.euc = new TextDecoder("euc-kr");
    this.u16 = new TextDecoder("utf-16le");
    this.setBitmap(32, 32);
    this.widthCache = new Map();
    this.metricsCache = new Map();
    this.decoded = new Map();
    this.f32 = new Float32Array(1);
    this.i32 = new Int32Array(this.f32.buffer);
  }
  setBitmap(w, h) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(this.w, this.h) : Object.assign(document.createElement("canvas"), { width: this.w, height: this.h });
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }
  font() { return `${this.size}px ${FONT_FAMILY}`; }
  width(s) {
    const key = this.size + "\u0001" + s;
    let v = this.widthCache.get(key);
    if (v === undefined) {
      this.ctx.font = this.font();
      v = this.ctx.measureText(s).width;
      if (this.widthCache.size > 20000) this.widthCache.clear();
      this.widthCache.set(key, v);
    }
    return v;
  }
  metrics() {
    let m = this.metricsCache.get(this.size);
    if (!m) {
      this.ctx.font = this.font();
      const t = this.ctx.measureText("Ag한");
      const asc = t.fontBoundingBoxAscent ?? this.size * 0.93;
      const desc = t.fontBoundingBoxDescent ?? this.size * 0.24;
      // Paint.FontMetricsInt rounds outwards; Java's GFA_GetAscent returns -ceil(ascent)
      m = { ascent: Math.ceil(asc), descent: Math.ceil(desc) };
      this.metricsCache.set(this.size, m);
    }
    return m;
  }
  charHeight() { return Math.trunc(this.size); }
  // Paint.breakText(s, true, maxWidth): how many characters from the start fit in maxWidth
  breakText(s, maxW) {
    if (this.width(s) <= maxW) return s.length;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.width(s.slice(0, mid)) <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  // the game sets the same few strings again every frame: decoded strings are kept by their bytes
  decode(mode, bytes) {
    let h = 2166136261 ^ mode;
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
    const key = h + ":" + bytes.length;
    const hit = this.decoded.get(key);
    if (hit && hit.b.length === bytes.length && hit.b.every((v, i) => v === bytes[i])) return hit.s;
    const s = mode === 2 ? this.euc.decode(bytes) : mode === 3 ? this.u16.decode(bytes) : this.utf8.decode(bytes);
    if (this.decoded.size > 4000) this.decoded.clear();
    this.decoded.set(key, { b: bytes.slice(), s });
    return s;
  }
  draw(mem, ptr, x, y) {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (this.bpp === 16) {
      g.fillStyle = argbCss(this.colorkey);
      g.fillRect(0, 0, this.w, this.h);
    }
    g.font = this.font();
    g.textBaseline = "alphabetic";
    g.fillStyle = argbCss(this.color);
    g.fillText(this.str, x, y);
    if (!ptr) return;
    const img = g.getImageData(0, 0, this.w, this.h).data;
    const n = this.w * this.h;
    if (this.bpp === 16) {
      const out = new Uint16Array(mem.buffer, ptr, n);
      for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = ((img[j] >> 3) << 11) | ((img[j + 1] >> 2) << 5) | (img[j + 2] >> 3);
    } else {
      // Bitmap.copyPixelsToBuffer: premultiplied colour, alpha in the top byte
      const out = new Uint32Array(mem.buffer, ptr, n);
      const aa = this.aa;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        let a = img[j + 3];
        if (!a) { out[i] = 0; continue; }
        let r = img[j], gg = img[j + 1], b = img[j + 2];
        if (!aa) {
          if (a < 128) { out[i] = 0; continue; }
          a = 255;
        } else if (a < 255) {
          r = (r * a + 127) / 255 | 0; gg = (gg * a + 127) / 255 | 0; b = (b * a + 127) / 255 | 0;
        }
        out[i] = ((a << 24) | (r << 16) | (gg << 8) | b) >>> 0;
      }
    }
  }
  // the operations core/jni.c asks for
  fromBits(v) { this.i32[0] = v; return this.f32[0]; }
  toBits(v) { this.f32[0] = v; return this.i32[0]; }
  op(mem, op, a, b, ptr, len) {
    switch (op) {
      case 1: { // set the string: a = 0 UTF-8 (b = character count to keep, 0 for all), 2 KSC5601, 3 UTF-16
        let s = ptr ? this.decode(a, new Uint8Array(mem.buffer, ptr, len)) : "";
        if (a === 0 && b > 0 && b < s.length) s = s.slice(0, b);
        this.str = s;
        return 0;
      }
      case 2: this.size = this.fromBits(a) || 12; return 0;
      case 3: this.color = a; return 0;
      case 4: { // GFA_DrawFont: the string at the left edge, baseline one line down
        const m = this.metrics();
        this.draw(mem, ptr, 0, this.charHeight() - m.descent + 1);
        this.rect = [0, 0, this.width(this.str), this.charHeight() + 1];
        return 0;
      }
      case 5: return this.toBits(this.width(this.str));
      case 6: this.bpp = len & 0xff; this.aa = !!(len & 0x100); this.setBitmap(a, b); return 0;
      case 7: { const m = this.metrics(); return (m.ascent << 16) | (m.descent & 0xffff); }
      case 9: { // GFA_GetWordwrapPositionEx(maxWidth, int[] out)
        const maxW = this.fromBits(a);
        let s = this.str, count = 0, pos = 0;
        const out = ptr ? new Int32Array(mem.buffer, ptr, b) : null;
        for (;;) {
          const brk = this.breakText(s, maxW);
          if (s.length <= 0 || brk <= 0 || brk >= s.length) return count;
          s = s.slice(brk);
          pos += brk;
          if (out && count < b) out[count] = pos;
          count++;
        }
      }
      case 10: return this.str.length;
      case 11: return this.color;
      case 12: return this.toBits(this.size);
      case 13: return this.charHeight();
      case 14: return Math.trunc(this.width("뷁"));
      case 15: { const r = new Float32Array(mem.buffer, ptr, 4); r.set(this.rect); return 0; }
      case 16: { // GFA_MeasureText(?, maxWidth): widest wrapped line and the height of the lines
        const maxW = this.fromBits(b) || 1e9;
        let s = this.str, lines = 1, widest = 0;
        for (;;) {
          const brk = Math.max(1, this.breakText(s, maxW));
          widest = Math.max(widest, this.width(s.slice(0, brk)));
          if (brk >= s.length) break;
          s = s.slice(brk);
          lines++;
        }
        const r = new Float32Array(mem.buffer, ptr, 2);
        r[0] = widest;
        r[1] = lines * this.charHeight() + this.metrics().descent;
        return 0;
      }
      case 18: this.colorkey = a; return 0;
      case 20: this.aa = !!a; return 0;
      case 21: { // GFA_DrawText(x, y, ?, maxWidth)
        const x = this.fromBits(a), y = this.fromBits(b);
        this.draw(mem, ptr, x, y + this.charHeight());
        this.rect = [x, y, this.width(this.str), this.charHeight() + this.metrics().descent];
        return 0;
      }
      case 22: { // GFA_GetWordwrapPosition(line, maxWidth): start of the given line
        const maxW = this.fromBits(b);
        let s = this.str, pos = 0;
        for (let line = 0; line < a; line++) {
          const brk = this.breakText(s, maxW);
          if (brk <= 0 || brk >= s.length) return -1;
          s = s.slice(brk);
          pos += brk;
        }
        return pos;
      }
      default: return 0;
    }
  }
}
function argbCss(c) {
  const a = ((c >>> 24) & 255) / 255, r = (c >>> 16) & 255, g = (c >>> 8) & 255, b = c & 255;
  return `rgba(${r},${g},${b},${a})`;
}

// ---------------------------------------------------------------------------------------------
// Sound: Natives.OnSoundPlay(id, volume, loop). As the Java side does it: volume 0 with loop stops the
// music; ids 1..30 are effects (SoundPool), the others music (MediaPlayer). Both name res/raw files by
// their resource number, which follows the sorted file names (s000, s001, ... with a few numbers missing).
class AudioEngine {
  constructor(sounds) {
    this.sounds = sounds;
    this.raw = Object.keys(sounds).sort();
    this.ctx = null;
    this.bufs = new Map();
    this.music = null;
    this.musicTicket = 0;
    this.musicVol = 0.7;
  }
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.connect(this.master);
      this.musicGain.gain.value = this.musicVol;
      this.applyVolumes();
      // a silent buffer started inside the gesture unlocks output on iOS
      const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
      for (let id = 1; id < 31 && id < this.raw.length; id++) this.decode(this.raw[id]);
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
  play(id, vol, loop) {
    if (!this.ctx) return;
    if (vol === 0 && loop) { this.stopMusic(); return; }
    const file = this.raw[id];
    if (id > 0 && id < 31) {
      if (!file) return;
      this.decode(file).then(buf => {
        if (!buf) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.master);
        src.start();
      });
      return;
    }
    this.musicVol = Math.max(0, Math.min(1, vol / 100));
    this.musicGain.gain.value = this.musicVol;
    if (!file) return;
    if (this.music?.name === file && this.music.loop && loop) return; // the same piece goes on
    this.stopMusic();
    const ticket = ++this.musicTicket;
    for (const [n] of this.bufs) if (!this.isEffect(n) && n !== file) this.bufs.delete(n);
    this.decode(file).then(buf => {
      if (!buf || ticket !== this.musicTicket) return;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = !!loop;
      src.connect(this.musicGain);
      src.start();
      this.music = { name: file, src, loop: !!loop };
    });
  }
  isEffect(name) { const i = this.raw.indexOf(name); return i > 0 && i < 31; }
  stopMusic() {
    this.musicTicket++;
    if (this.music) { try { this.music.src.stop(); } catch {} this.music = null; }
  }
}

// ---------------------------------------------------------------------------------------------
// The emulator core
class Core {
  async init(game, files, onEvent) {
    this.game = game;
    this.onEvent = onEvent;
    this.utf = new TextDecoder();
    this.logs = [];
    this.text = new TextEngine();
    const env = {
      host_log: (p, n) => {
        const s = this.utf.decode(new Uint8Array(this.mem.buffer, p, n).slice());
        this.logs.push(s);
        if (this.logs.length > 200) this.logs.shift();
        if (window.Z4_DEBUG) console.debug("[game]", s);
      },
      host_now: () => Date.now(),
      host_file_saved: (p, pl, d, n) => this.painting || saves.write(this.utf.decode(new Uint8Array(this.mem.buffer, p, pl)), new Uint8Array(this.mem.buffer, d, n).slice()),
      host_file_deleted: (p, pl) => this.painting || saves.remove(this.utf.decode(new Uint8Array(this.mem.buffer, p, pl))),
      host_event: (kind, a, b, c) => (this.painting ? 0 : this.onEvent(kind, a, b, c) | 0),
      // Natives.readAssete / isAssetExist: AssetManager.open(name)
      host_asset: (p, n, dst, cap) => {
        const hit = this.game.index[this.utf.decode(new Uint8Array(this.mem.buffer, p, n))];
        if (!hit) return -1;
        if (dst) new Uint8Array(this.mem.buffer, dst, Math.min(cap, hit[1])).set(this.game.assets.subarray(hit[0], hit[0] + Math.min(cap, hit[1])));
        return hit[1];
      },
      host_sound: (op, id, vol, loop) => {
        if (this.painting) return;
        if (op === 1) audio.play(id, vol, loop);
        else audio.stopMusic();
      },
      host_text: (op, a, b, ptr, len) => this.text.op(this.mem, op, a, b, ptr, len) | 0,
    };
    // always the site's core, so its updates apply by themselves; the player's accelerated module joins it
    const resp = fetch(`z4core.wasm?v=${VERSION}`);
    const { instance } = await (WebAssembly.instantiateStreaming
      ? WebAssembly.instantiateStreaming(resp, { env })
      : WebAssembly.instantiate(await (await resp).arrayBuffer(), { env }));
    this.ex = instance.exports;
    this.mem = this.ex.memory;
    const ex = this.ex;
    if (game.fast) {
      if (!wasmExports(new Uint8Array(game.fast))?.includes("aot_side")) this.staleFast = true; // a whole core, from before
      else {
        try {
          if ((await attachSide(ex, game.fast)) !== 0) this.staleFast = "abi"; // the interpreter changed since

        } catch (e) {
          this.fastError = String(e?.message || e); // the phone could not open it: the core interprets everything
          console.warn("fast core", e);
        }
      }
    }
    const so = game.so;
    const p = ex.host_alloc(so.length);
    new Uint8Array(this.mem.buffer, p, so.length).set(so);
    ex.set_logging(window.Z4_DEBUG ? 1 : 0);
    if (ex.load_library(p, so.length) !== 0) throw new Error("게임 라이브러리를 불러오지 못했어요");
    ex.host_free(p);
    // the translations only run on the exact library they were made from; otherwise everything is interpreted
    this.fast = !!(ex.aot_active && ex.aot_active());
    for (const [path, data] of files) {
      const dp = ex.host_alloc(Math.max(1, data.length));
      new Uint8Array(this.mem.buffer, dp, data.length).set(data);
      ex.fs_put(this.cstr(path), dp, data.length);
    }
  }
  cstr(s) {
    const b = new TextEncoder().encode(s + "\0");
    const p = this.ex.host_alloc(b.length);
    new Uint8Array(this.mem.buffer, p, b.length).set(b);
    return p;
  }
  start(w) { return this.ex.app_start(w, LCD_H); }
  frame() { return this.ex.app_frame(); }
  // handleCletEvent(type, x, y, pointer): 23 down, 24 up, 25 move
  touch(type, x, y, id) { this.ex.app_event(type, x, y, id); }
  pause(on) { this.ex.app_pause(on ? 1 : 0); }
  frames() { return this.ex.frames(); }
  screen() {
    const w = this.ex.screen_w(), h = this.ex.screen_h();
    const p = this.ex.screen();
    if (!p) return null;
    if (this.view?.p !== p || this.view.w !== w || this.view.h !== h || this.view.px.buffer !== this.mem.buffer)
      this.view = { p, w, h, px: new Uint16Array(this.mem.buffer, p, w * h) };
    return this.view;
  }
  // In-between frames (core motion.c): the field drawn `f`/1024 of the way between the last two frames
  motionOn(on) { return this.ex.motion_enable(on ? 1 : 0) === 0; }
  motionState() { return this.ex.motion_state(); }
  between(f) {
    const w = this.ex.screen_w(), h = this.ex.screen_h();
    if (!w || !h) return null;
    if (!this.pbuf || this.pbuf.w !== w || this.pbuf.h !== h) {
      if (this.pbuf) this.ex.host_free(this.pbuf.p);
      const p = this.ex.host_alloc(w * h * 2);
      this.pbuf = p ? { p, w, h } : null;
      if (!p) return null;
    }
    this.painting = true;
    let r;
    try { r = this.ex.motion_paint(f, this.pbuf.p); } finally { this.painting = false; }
    if (r !== 0) return null;
    const b = this.pbuf;
    if (b.view?.buffer !== this.mem.buffer) b.view = new Uint16Array(this.mem.buffer, b.p, w * h);
    return { w, h, px: b.view };
  }
  // the camera (map pixels) of the picture `f`/1024 of the way from the frame before the last to the last
  camera(f) {
    const unpack = v => [(v >>> 16) << 16 >> 16, (v & 0xffff) << 16 >> 16];
    if (!motion.on) return unpack(this.ex.live_cam());
    const [ax, ay] = unpack(this.ex.motion_cam(1)), [bx, by] = unpack(this.ex.motion_cam(0));
    return [ax + ((bx - ax) * f) / 1024, ay + ((by - ay) * f) / 1024];
  }
}

// ---------------------------------------------------------------------------------------------
// Saves: every file the game writes is mirrored to IndexedDB. Before one of the game's save files
// (the core's save_store directory) is replaced or removed, the version it had is kept in "backup".
const saves = {
  dir: "/gameSave/", // the core's save_store()
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
      try {
        if (path.startsWith(this.dir)) {
          const old = await idbGet("files", path);
          if (old) await idbPut("backup", path, old);
        }
        data ? await idbPut("files", path, data) : await idbDel("files", path);
      } catch (e) { console.warn("save failed", e); }
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Input. Every finger is its own pointer (0, 1, 2 ...), so the d-pad can be held while the attack and
// skill buttons are pressed. Android's queue gave the game one event per frame; here each pointer gets at
// most one press or release per frame (a quick tap still spans two frames) and moves are merged.
const pointers = new Map(); // touch identifier -> { id, x, y }
const queue = []; // { type, id, x, y }
let core, audio, renderer;
let running = false;

function freePointerId() {
  const used = new Set([...pointers.values()].map(p => p.id));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}
// The game's d-pad reads a direction only while the finger is in a ring around the dial (between a small
// inner circle and the outer edge) and only in four 90° sectors. A finger that starts on or near the dial
// is steered: past a small dead centre it is placed in the middle of the ring at the nearest of the four
// directions, which it keeps until the finger turns well past the halfway line. So a thumb that drifts off
// the dial keeps walking, the direction does not flicker at the diagonals, and a quick second tap lands on
// the same direction (the game's dash is two presses of one direction within half a second).
const dpad = { buf: 0, axis: -1, upAt: 0 };
function dpadGeometry() {
  if (prefs.dpad === "original" || !core?.ex?.dpad_geom) return null;
  if (!dpad.buf) dpad.buf = core.ex.host_alloc(16);
  if (core.ex.dpad_geom(dpad.buf) !== 0) return null;
  const g = new Int32Array(core.mem.buffer, dpad.buf, 4);
  return { cx: g[0], cy: g[1], inner: g[2], outer: g[3] };
}
function steer(p, x, y, start) {
  const d = p.dpad;
  if (!d) return [x, y];
  const dx = x - d.cx, dy = y - d.cy, r = Math.hypot(dx, dy);
  const ring = (d.inner + d.outer) / 2;
  if (r < Math.max(12, d.inner * 0.8)) {
    // the dead centre stands still, except the second tap of a quick double tap, which repeats the direction
    // for as long as the finger stays there
    if (start && d.axis >= 0) d.hold = true;
    if (!d.hold) { d.axis = -1; return [d.cx, d.cy]; }
    const ang = d.axis * (Math.PI / 2);
    return [Math.round(d.cx + Math.cos(ang) * ring), Math.round(d.cy + Math.sin(ang) * ring)];
  }
  d.hold = false;
  const a = Math.atan2(dy, dx);
  const nearest = ((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4;
  if (d.axis >= 0) {
    let diff = Math.abs(a - d.axis * (Math.PI / 2)) % (2 * Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff > Math.PI / 4 + 0.2) d.axis = nearest; // about 11° past the halfway line before it turns
  } else d.axis = nearest;
  const ang = d.axis * (Math.PI / 2);
  return [Math.round(d.cx + Math.cos(ang) * ring), Math.round(d.cy + Math.sin(ang) * ring)];
}
function touchStart(key, cx, cy) {
  if (pointers.has(key)) return;
  let [x, y] = toLcd(cx, cy);
  const p = { id: freePointerId(), x, y };
  const g = dpadGeometry();
  if (g && Math.hypot(x - g.cx, y - g.cy) < g.outer * 1.25) {
    // a quick second tap keeps the direction it had unless it is clearly another one, so dash is easy to hit
    p.dpad = { ...g, axis: performance.now() - dpad.upAt < 450 ? dpad.axis : -1 };
    [x, y] = steer(p, x, y, true);
    p.x = x;
    p.y = y;
  }
  pointers.set(key, p);
  queue.push({ type: 23, id: p.id, x, y });
}
function touchMove(key, cx, cy) {
  const p = pointers.get(key);
  if (!p) return;
  const [x, y] = steer(p, ...toLcd(cx, cy));
  if (x === p.x && y === p.y) return;
  p.x = x;
  p.y = y;
  const last = queue.findLast(e => e.id === p.id);
  if (last && last.type === 25) { last.x = x; last.y = y; }
  else queue.push({ type: 25, id: p.id, x, y });
}
function touchEnd(key, cx, cy) {
  const p = pointers.get(key);
  if (!p) return;
  pointers.delete(key);
  const [x, y] = cx === undefined || p.dpad ? [p.x, p.y] : toLcd(cx, cy);
  if (p.dpad) { dpad.axis = p.dpad.axis; dpad.upAt = performance.now(); }
  queue.push({ type: 24, id: p.id, x, y });
}
function releaseAll() {
  for (const key of [...pointers.keys()]) touchEnd(key);
}
function deliverInput() {
  const pressed = new Set();
  for (let i = 0; i < queue.length; ) {
    const e = queue[i];
    if (e.type !== 25) {
      if (pressed.has(e.id)) { i++; continue; }
      pressed.add(e.id);
    } else if (pressed.has(e.id)) { i++; continue; }
    queue.splice(i, 1);
    core.touch(e.type, e.x, e.y, e.id);
  }
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
  // mouse, for trying it on a computer
  let mouseDown = false;
  document.addEventListener("mousedown", e => { if (isUi(e.target) || !running) return; mouseDown = true; audio?.unlock(); touchStart("m", e.clientX, e.clientY); });
  document.addEventListener("mousemove", e => { if (mouseDown) touchMove("m", e.clientX, e.clientY); });
  document.addEventListener("mouseup", e => { if (mouseDown) { mouseDown = false; touchEnd("m", e.clientX, e.clientY); } });
  document.addEventListener("gesturestart", e => e.preventDefault());
  document.addEventListener("dblclick", e => e.preventDefault());
}

// events from the core: 1 vibrate, 2 UI status, 3 Natives.OnEvent, 4 in-app purchase, 5 frame rate,
// 10 a blow landed (motion.c: map position x | y << 16, damage, 1 critical | 2 the hero was hit)
let frameInterval = 1000 / 23;
let hitstop = 0, lastStop = 0;
function onCoreEvent(kind, a, b, c) {
  if (kind === 4) toast("결제는 이 플레이어에서 쓸 수 없어요");
  if (kind === 5 && a > 0) frameInterval = 1000 / Math.min(60, a); // Natives.SetSpeed: the GL thread's frame rate
  if (kind === 10 && fx) {
    const x = (a << 16) >> 16, y = a >> 16;
    if (c & 2) fx.hurtHero();
    else {
      // a big blow stops the picture for a moment (not again within a short while, so a flurry keeps going)
      const big = fx.hit(x, y - 36, b, c & 1), now = performance.now();
      if (big && now - lastStop > 160) { hitstop = Math.max(hitstop, prefs.impact === "strong" ? 60 : 35); lastStop = now; }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Hit feedback drawn over the game: sparks, a glow and a slash where a blow lands, a star, a ring and a
// short shake on critical or unusually strong blows, red edges when the hero is hit. Driven by the game's own
// damage (CMvCharacter::SetDamage, motion.c); the game's damage and effects are unchanged. Positions are
// map pixels, drawn relative to the camera of the picture on screen so they stay on the target.
class Fx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.parts = []; this.rings = []; this.glows = []; this.slashes = []; this.bursts = [];
    this.hurt = 0; this.shake = 0; this.shakeT = 0; this.shakeAng = 0;
    this.cam = [0, 0];
    this.u = 2.5;
    this.drawn = false;
    this.avg = 0;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.scale = (w * dpr) / lcdW;
    this.u = lcdW / 400;
    this.drawn = true;
  }
  level() { return prefs.impact === "strong" ? 1.4 : prefs.impact === "normal" ? 1 : 0; }
  hit(x, y, dmg, crit) {
    const k = this.level();
    if (!k) return false;
    const u = this.u; // the game is drawn about 1000 pixels wide: sizes are in units of 2.5 of its pixels
    // a blow well above the recent average counts as big too (strong skills)
    const big = !!crit || (this.avg > 0 && dmg > this.avg * 1.6);
    this.avg = this.avg ? this.avg * 0.85 + dmg * 0.15 : dmg;
    // a critical is a little bigger than a plain blow, not a burst over the screen (with high stats almost
    // every blow is one)
    const n = Math.round((big ? 12 : 9) * k);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (big ? 1.9 : 1.6) * (0.7 + Math.random() * 0.6) * k * u;
      this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.7 * u, life: 1, decay: 0.04 + Math.random() * 0.035, w: (big && i % 3 === 0 ? 1.7 : 1.4) * u, hue: big ? 45 : 25 + Math.random() * 20 });
    }
    this.glows.push({ x, y, r: (big ? 12 : 10) * k * u, life: 1, decay: big ? 0.09 : 0.11, hue: big ? 48 : 32 });
    const ang = -0.6 + Math.random() * 1.2 + (Math.random() < 0.5 ? 0 : Math.PI / 2);
    this.slashes.push({ x, y, ang, len: (big ? 19 : 16) * k * u, life: 1, decay: big ? 0.11 : 0.14, hue: big ? 45 : 28 });
    if (big) {
      this.bursts.push({ x, y, len: 7 * k * u, life: 1, decay: 0.1 });
      this.rings.push({ x, y, r: 3 * u, vr: 1.2 * k * u, life: 1, decay: 0.09, hue: 45 });
      this.kick(1.1 * k * u);
    } else this.kick(0.7 * k * u);
    return big;
  }
  hurtHero() {
    const k = this.level();
    if (!k) return;
    this.hurt = Math.min(1, 0.5 * k + this.hurt * 0.5);
    this.kick(1.6 * k * this.u);
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
    for (const p of this.parts) { p.x += p.vx * f; p.y += p.vy * f; p.vy += 0.08 * this.u * f; p.vx *= 0.96; p.life -= p.decay * f; }
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
    const dot = (x, y, size) => c.fillRect((x - cx - size / 2) * s, (y - cy - size / 2) * s, size * s, size * s);
    const line = (x0, y0, x1, y1, size) => {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (size * 0.6)));
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
      line(sl.x - dx, sl.y - dy, sl.x + dx, sl.y + dy, (sl.life > 0.5 ? 3 : 2) * this.u);
      c.fillStyle = `rgba(255,255,240,${sl.life})`;
      line(sl.x - dx * 0.85, sl.y - dy * 0.85, sl.x + dx * 0.85, sl.y + dy * 0.85, this.u);
    }
    for (const b of this.bursts) {
      const len = b.len * (1.35 - b.life * 0.35);
      c.fillStyle = `rgba(255,250,215,${b.life})`;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4, l = i % 2 ? len * 0.55 : len, r0 = len * 0.18 * (1 - b.life);
        line(b.x + Math.cos(a) * r0, b.y + Math.sin(a) * r0 * 0.8, b.x + Math.cos(a) * l, b.y + Math.sin(a) * l * 0.8, this.u);
      }
      c.fillStyle = `rgba(255,220,120,${0.8 * b.life})`;
      dot(b.x, b.y, 3 * this.u);
    }
    for (const p of this.parts) {
      c.fillStyle = `hsla(${p.hue},100%,${62 + 30 * p.life}%,${p.life})`;
      dot(p.x, p.y, p.w);
      c.fillStyle = `hsla(${p.hue},100%,55%,${0.45 * p.life})`;
      dot(p.x - p.vx * 0.9, p.y - p.vy * 0.9, p.w * 0.6);
    }
    for (const r of this.rings) {
      c.fillStyle = `hsla(${r.hue},100%,70%,${0.8 * r.life})`;
      const n = Math.max(16, Math.ceil((r.r / this.u) * 4.2));
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; dot(r.x + Math.cos(a) * r.r, r.y + Math.sin(a) * r.r * 0.6, this.u); }
    }
    c.globalCompositeOperation = "source-over";
  }
}
let fx;

// ---------------------------------------------------------------------------------------------
// Game loop: the GL thread renders (and the game runs one step) at the rate the game asked for, about 23
// times a second. With 부드럽게 on, the display runs one game frame behind and shows the frames in between:
// the field drawn with the camera, the hero and the monsters part of the way between their positions in
// the last two game frames (core motion.c). Menus and anything that jumps show the game's own frames. A
// device too slow for that gets one in-between frame per game frame, or none.
const motion = { on: false, cost: 0, shown: -1, state: -1, off: 0 };
const perf = { t0: 0, rafs: 0, frames: 0, game: 0, paints: 0, paint: 0, skipped: 0 };
let acc = 0;
let lastT = 0;
let shownFrame = -1;
function frameLoop(t) {
  requestAnimationFrame(frameLoop);
  if (!running) { lastT = t; return; }
  const start = performance.now();
  const dt = lastT ? Math.min(t - lastT, 250) : 0;
  lastT = t;
  perf.rafs++;
  if (hitstop > 0) { hitstop -= dt; fxFrame(motion.shown < 0 ? 1024 : motion.shown); return; } // a short freeze on a big blow
  acc += dt;
  let ran = 0;
  while (acc >= frameInterval && ran < 2) {
    deliverInput();
    if (core.frame() !== 0) return crashed();
    skillRule();
    arenaBadge();
    acc -= frameInterval;
    ran++;
  }
  if (ran) { perf.frames += ran; perf.game += performance.now() - start; }
  if (acc > frameInterval) acc = 0; // fell behind: drop the backlog instead of rushing
  if (ran) motion.state = motion.on ? core.motionState() : -1;
  let f = 1024;
  if (motion.on && motion.state > 0 && ran < 2) {
    // where the picture should be now, as a share of the way from the frame before the last to the last
    f = Math.min(1024, Math.round((acc / frameInterval) * 1024));
    if (f > 980) f = 1024;
    // no time left in this display frame (the game step took it): keep the picture for one more frame;
    // the next one is drawn where it belongs by then, so the speed stays even
    else if (motion.shown >= 0 && performance.now() - start + motion.cost > 14) { perf.skipped++; f = motion.shown; }
  }
  if (!ran && f === motion.shown) { if (renderer.dirty) renderer.draw(); fxFrame(f); showPerf(); return; }
  let frame = null;
  if (f < 1024) {
    const t0 = performance.now();
    frame = core.between(f);
    const ms = performance.now() - t0;
    motion.cost = motion.cost * 0.9 + ms * 0.1;
    perf.paints++;
    perf.paint += ms;
    if (!frame) f = 1024;
    if (motion.cost > 25 && ++motion.off > 30) { // far too slow here: plain frames for a while
      motion.on = false;
      core.motionOn(false);
      setTimeout(() => { if (prefs.motion === "smooth") { motion.cost = 6; motion.off = 0; motion.on = core.motionOn(true); } }, 20000);
    }
  }
  if (f === 1024) {
    const n = core.frames();
    if (n === shownFrame && motion.shown === 1024) { if (renderer.dirty) renderer.draw(); fxFrame(f); return; }
    shownFrame = n;
    frame = core.screen();
  }
  motion.shown = f;
  if (frame) renderer.upload(frame.px, frame.w, frame.h);
  if (renderer.dirty) renderer.draw();
  fxFrame(f);
  showPerf();
}

// 성능 표시: display frames a second, the game's step, the in-between frames, which core runs
function showPerf() {
  const now = performance.now();
  if (now - perf.t0 < 1000) return;
  const el = $("perf"), secs = (now - perf.t0) / 1000;
  if (prefs.perf === "on" && perf.t0) {
    const g = perf.frames ? perf.game / perf.frames : 0, p = perf.paints ? perf.paint / perf.paints : 0;
    el.textContent = `${Math.round(perf.rafs / secs)}fps · 게임 ${Math.round(perf.frames / secs)}회 ${g.toFixed(1)}ms · ` +
      `중간 ${Math.round(perf.paints / secs)}장 ${p.toFixed(1)}ms` + (perf.skipped ? ` 건너뜀 ${perf.skipped}` : "") +
      ` · ${core.fast ? "가속" : "기본"} · 움직임 ${motion.on ? (motion.state > 0 ? "보간" : "정지") : "꺼짐"} · v${VERSION}`;
    el.style.display = "block";
  } else el.style.display = "none";
  Object.assign(perf, { t0: now, rafs: 0, frames: 0, game: 0, paints: 0, paint: 0, skipped: 0 });
}

// the effects follow the camera of the picture on screen; the shake moves the game and the effects together
let fxT = 0;
let stageShaken = false;
function fxFrame(f) {
  if (!fx) return;
  const now = performance.now(), dt = fxT ? Math.min(now - fxT, 100) : 16.7;
  fxT = now;
  if (!fx.busy() && !fx.drawn) {
    if (stageShaken) { $("stage").style.transform = ""; stageShaken = false; }
    return;
  }
  fx.cam = core.camera(f);
  fx.update(dt);
  fx.draw();
  const [ox, oy] = fx.shakeOffset();
  const px = layout.stage.w / lcdW;
  stageShaken = !!(ox || oy);
  $("stage").style.transform = stageShaken ? `translate(${(ox * px).toFixed(1)}px, ${(oy * px).toFixed(1)}px)` : "";
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

// pause when the app goes to the background, like NexusGLActivity.onPause (the clet is paused)
document.addEventListener("visibilitychange", () => {
  if (!core?.ex || !started) return;
  if (document.hidden) {
    if (running) { releaseAll(); deliverInput(); running = false; core.pause(true); audio.suspend(); }
    saves.flush();
  } else if (!running && !$("settings").classList.contains("show") && !$("tap").classList.contains("show")) {
    noticeUpdate();
    core.pause(false);
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
      if (key === "sound") audio?.applyVolumes();
      if (["money", "refine", "statPoints", "statStep", "damage", "skills", "sp", "critZoom"].includes(key) && started) applyRules();
      if (key === "motion" && started) { motion.on = prefs.motion === "smooth" && core.motionOn(true); if (prefs.motion !== "smooth") core.motionOn(false); motion.shown = -1; motion.cost = 0; motion.off = 0; }
      if (key === "screen" && !started) lcdW = chooseLcdWidth();
      if (key === "screen") applyLayout();
      if (renderer) renderer.dirty = true;
    });
  }
  let settingsPaused = false;
  $("btn-settings").addEventListener("click", () => {
    if (running) { releaseAll(); deliverInput(); running = false; settingsPaused = true; }
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
  $("btn-fast").addEventListener("click", () => $("fast-file").click());
  $("fast-file").addEventListener("change", async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const t = $("fast-state");
    if (t) t.textContent = "넣는 중…";
    try {
      await importFastCore(f);
      if (t) t.textContent = "넣었음 · 다시 시작하면 써요";
      if (confirm("가속 파일을 넣었어요. 게임을 다시 시작할까요?")) { await saves.flush(); location.reload(); }
      else toast("다음에 시작할 때부터 빨라져요");
    } catch (err) {
      if (t) t.textContent = "넣지 못함";
      toast(String(err?.message || err), 5000);
    }
  });
  $("btn-export").addEventListener("click", exportSaves);
  $("btn-arena-rebase").addEventListener("click", () => {
    if (!core?.ex?.arena_rebase) return toast("게임을 시작한 뒤에 할 수 있어요");
    if (!confirm("PvP 아레나 기준을 지금 캐릭터로 다시 잴까요?")) return;
    core.ex.arena_rebase();
    arenaSave();
    toast("다음 대전부터 지금 캐릭터가 기준이에요");
  });
  $("btn-undo-save").addEventListener("click", async () => {
    await saves.flush();
    const old = await idbEntries("backup");
    if (!old.length) return toast("되돌릴 이전 세이브가 없어요");
    if (!confirm("세이브를 마지막으로 바뀌거나 지워지기 바로 전으로 되돌리고 게임을 다시 시작할까요?")) return;
    running = false; // nothing the game writes from here on reaches storage
    saves.pending.clear();
    for (const [path, data] of old) await idbPut("files", path, data);
    location.reload();
  });
  $("btn-import-save").addEventListener("click", () => $("save-file").click());
  $("save-file").addEventListener("change", async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.game !== "zenonia4" || typeof data.files !== "object") throw new Error();
      if (!confirm("가져온 세이브로 바꾸고 게임을 다시 시작할까요?")) return;
      await idbClear("files");
      for (const [path, b64] of Object.entries(data.files)) await idbPut("files", path, Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)));
      location.reload();
    } catch { toast("세이브 파일을 읽지 못했어요"); }
  });
}

// game rules the player chose (core tweaks.c): unlimited Zen and gold, easier refining, stat points and
// how many one press of + puts in, damage that does not overflow, every skill at its highest level
function applyRules() {
  if (!core?.ex?.money_unlimited) return;
  core.ex.money_unlimited(prefs.money === "max" ? 1 : 0);
  core.ex.refine_easy(prefs.refine === "easy" ? 1 : 0);
  core.ex.crit_zoom?.(prefs.critZoom === "on" ? 1 : 0);
  core.ex.sp_unlimited?.(prefs.sp === "max" ? 1 : 0);
  if (!core.ex.stat_rules) return; // an accelerated core from before these
  core.ex.stat_rules(prefs.statPoints === "max" ? 1 : 0, +prefs.statStep || 1);
  core.ex.damage_uncapped(prefs.damage === "uncapped" ? 1 : 0);
  skillsTick = 0;
}
// The PvP arena's badge (the server inside the core keeps the ladder): the player's tier, points and
// record, and the fighting strength of the rival on offer next to the player's
const TIERS = [["브론즈", "#d08a4c"], ["실버", "#d6dde6"], ["골드", "#ffd24a"], ["플래티넘", "#5fe0c8"],
  ["다이아", "#8fd0ff"], ["마스터", "#d08cff"], ["그랜드마스터", "#ff6b6b"], ["챌린저", "#ffe9a8"]];
const arena = { tick: 0, buf: 0, shown: "", rev: -1 };
function korNum(n) {
  const units = [[1e16, "경"], [1e12, "조"], [1e8, "억"], [1e4, "만"]];
  for (const [v, u] of units) if (n >= v) return (n / v >= 100 ? Math.round(n / v) : Math.round(n / v * 10) / 10).toLocaleString("ko-KR") + u;
  return Math.round(n).toLocaleString("ko-KR");
}
// what the arena keeps between visits (the hero it measured, the mark, the revenge list), in this page
function arenaLoad() {
  try {
    const ex = core.ex;
    if (!ex.arena_keep) return;
    const raw = localStorage.getItem("z4.arena");
    if (!raw) return;
    const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    if (bytes.length !== ex.arena_keep_size()) return;
    new Uint8Array(ex.memory.buffer, ex.arena_keep(), bytes.length).set(bytes);
    ex.arena_keep_check();
  } catch {}
  arena.rev = core.ex.arena_keep_rev?.();
}
function arenaSave() {
  const ex = core.ex;
  if (!ex.arena_keep_rev || ex.arena_keep_rev() === arena.rev) return;
  arena.rev = ex.arena_keep_rev();
  try {
    const bytes = new Uint8Array(ex.memory.buffer, ex.arena_keep(), ex.arena_keep_size());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    localStorage.setItem("z4.arena", btoa(bin));
  } catch {}
}
function arenaBadge() {
  if (!core.ex.arena_info || --arena.tick > 0) return;
  arena.tick = 10;
  arenaSave();
  if (!arena.buf) arena.buf = (core.ex.host_alloc(128) + 7) & ~7;
  const el = $("arena");
  if (core.ex.arena_info(arena.buf) !== 0) return;
  const v = new Float64Array(core.ex.memory.buffer, arena.buf, 21);
  if (!v[0]) { if (arena.shown) { el.style.display = "none"; arena.shown = ""; } return; }
  const pts = Math.max(0, v[1]), rank = v[4], tier = Math.floor(rank / 100), [tn, tc] = TIERS[tier];
  const next = tier < 7 ? ` (다음 티어까지 ${((tier + 1) * 500 - pts).toLocaleString("ko-KR")})` : ` (${rank % 100 + 1}/100)`;
  const times = r => r >= 10 ? Math.round(r).toLocaleString("ko-KR") : r.toFixed(1);
  let html = `<span class="tier" style="color:${tc}">${tn}</span> · 승점 ${pts.toLocaleString("ko-KR")}${next} · ${v[2]}승 ${v[3]}패` +
    `<br><span class="sub">내 전투력 ${korNum(v[6])}`;
  if (v[5] >= 0) {
    const ot = TIERS[Math.floor(v[5] / 100)];
    html += ` · 상대 <span class="tier" style="color:${ot[1]}">${ot[0]}</span> ${korNum(v[7])} (${times(v[6] > 0 ? v[7] / v[6] : 0)}배)`;
  }
  const GRADES = ["D", "C", "B", "A", "S"], GCOL = ["#bbb", "#7fd17f", "#6fb0ff", "#d08cff", "#ffcc33"];
  const worn = [4, 3, 2, 1, 0].filter(g => v[16 + g]).map(g => `<span style="color:${GCOL[g]}">${GRADES[g]}${v[16 + g]}</span>`).join(" ") || "없음";
  const set = v[12] >= 1 ? ` · <span style="color:${GCOL[v[12]]}">${GRADES[v[12]]}급 ${v[13]}세트</span> ×${times(v[14])}` : "";
  html += `<br>장비 ${worn}${set} · 옵션 ${Math.round(v[15])}점 · 장비 힘 ×${times(v[8])}`;
  const notes = [];
  if (v[10]) notes.push("승급 보상: 다음 승리 최고 등급");
  else notes.push(v[11] >= 4 ? "다음 승리: 한 등급 위 보상" : `${5 - v[11]}번째 승리에 한 등급 위 보상`);
  if (v[9] >= 2) notes.push("연패 보호: 쉬운 상대");
  html += `<br>${notes.join(" · ")}</span>`;
  if (html !== arena.shown) {
    el.innerHTML = html;
    el.style.fontSize = Math.max(8, $("stage").clientHeight * 0.024) + "px";
    el.style.display = "block";
    arena.shown = html;
  }
}

// the skills are raised on the field (the keypad's dial on screen), checked about every two seconds
let skillsTick = 0;
function skillRule() {
  if (prefs.skills !== "max" || !core.ex.skills_max || --skillsTick > 0) return;
  skillsTick = 46;
  if (!dpad.buf) dpad.buf = core.ex.host_alloc(16);
  if (core.ex.dpad_geom(dpad.buf) === 0) core.ex.skills_max();
}

function syncFastRow(have, active, problem) {
  const t = $("fast-state");
  if (t) t.textContent = active ? "쓰는 중" : have ? (problem ? "못 씀" : "맞지 않음") : "없음";
}

async function exportSaves() {
  await saves.flush();
  const entries = await idbEntries("files");
  if (!entries.length) return toast("아직 세이브가 없어요");
  const files = {};
  for (const [path, data] of entries) { let s = ""; for (const b of data) s += String.fromCharCode(b); files[path] = btoa(s); }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const name = `zenonia4-save-${stamp}.json`;
  const file = new File([JSON.stringify({ game: "zenonia4", saved: Date.now(), files })], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "제노니아4 세이브" }); return; } catch (e) { if (e.name === "AbortError") return; }
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
  const [so, assets, index, sounds, fast, files] = await Promise.all(
    ["so", "assets", "index", "sounds", "fast"].map(k => idbGet("game", k)).concat(idbEntries("files")),
  );
  if (!so || !assets || !index) return null;
  return { so: new Uint8Array(so), assets: new Uint8Array(assets), index, sounds: sounds || {}, fast: fast || null, files };
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
    const dir = new Uint8Array(core.mem.buffer, core.ex.save_store(), 64);
    saves.dir = new TextDecoder().decode(dir.subarray(0, dir.indexOf(0)));
  } catch (e) {
    $("tap-text").textContent = "게임을 불러오지 못했어요";
    $("tap-err").textContent = String(e?.message || e);
    return;
  }
  $("tap-text").textContent = "화면을 터치하면 시작해요";
  $("tap-err").textContent = core.fast ? "" : core.fastError
    ? `가속 파일을 이 기기에서 열지 못해서 기본 실행기로 돌아가요. (${core.fastError})`
    : core.staleFast === "abi"
    ? "실행기가 바뀌어서 이 가속 파일은 맞지 않아요. 새로 받은 z4fast.wasm을 설정 → 가속 파일에 넣어 주세요."
    : core.staleFast
    ? "가속 파일이 예전 방식이라 쓰지 않았어요. 설정 → 가속 파일에서 새 z4fast.wasm으로 바꿔 주세요(한 번 바꾸면 이후 업데이트는 자동으로 돼요)."
    : game.fast
    ? "가속 파일이 이 게임 파일과 맞지 않아요. 설정 → 가속 파일에서 맞는 파일로 바꾸면 더 빨라져요."
    : "";
  syncFastRow(game.fast, core.fast, core.fastError || core.staleFast);
  window.__z4 = { core, audio: () => audio, lcd: () => lcdW, running: () => running, hold: v => { running = !v; }, fx: () => fx, ready: true };
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
  } catch (e) {
    $("tap-err").textContent = String(e?.message || e);
    return;
  }
  showOverlay(null);
  try { core.ex.fx_enable(1); core.ex.dpad_enable(); } catch {}
  try { core.ex.net_enable?.(1); arenaLoad(); } catch {} // the PvP arena's server, inside the core
  try { core.ex.wide_text?.(); } catch {} // text clipped to the whole wide screen, not the first 800
  applyRules();
  motion.on = prefs.motion === "smooth" && core.motionOn(true);
  running = true;
  requestAnimationFrame(frameLoop);
}

// The home-screen app can keep an old index.html for a while; version.txt is always fetched fresh, and
// when it names a newer version the page reloads once under a new address, which bypasses the cache.
// A home-screen app coming back from the background keeps running the old page: say when a new one is out
// (reloading by itself would lose the progress since the last save).
async function noticeUpdate() {
  try {
    const r = await fetch(`version.txt?t=${Date.now()}`, { cache: "no-store" });
    const v = r.ok ? (await r.text()).trim() : "";
    if (!/^\d+$/.test(v) || Number(v) <= Number(VERSION)) return;
    $("version").textContent = `버전 ${VERSION} · 새 버전 ${v} 있음 (다시 시작하면 바뀌어요)`;
    toast(`새 버전(${v})이 나왔어요. 게임에서 저장한 뒤 설정 → 다시 시작을 누르세요`, 6000);
  } catch {}
}
async function checkForUpdate() {
  try {
    const r = await fetch(`version.txt?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return false;
    const v = (await r.text()).trim();
    if (!/^\d+$/.test(v) || Number(v) <= Number(VERSION) || sessionStorage.getItem("z4.update") === v) return false;
    sessionStorage.setItem("z4.update", v);
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
    shownFrame = -1;
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
    const f = [...e.target.files];
    e.target.value = "";
    if (!f.length) return;
    $("home-err").textContent = "";
    $("btn-import").disabled = true;
    $("home-text").textContent = "게임 파일을 읽는 중이에요… (1분쯤 걸려요)";
    const bar = $("progress").firstElementChild;
    try {
      await importFiles(f, p => (bar.style.width = Math.round(p * 100) + "%"));
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
