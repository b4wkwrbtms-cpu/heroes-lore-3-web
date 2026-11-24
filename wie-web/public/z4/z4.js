// 제노니아4 player: runs the game's ARM library (Thumb-2, VFP) in z4core.wasm and presents it on an
// iPhone in landscape. The game draws its own touch controls (d-pad, attack and skill buttons); the page
// hands it the fingers with their pointer ids, like Android's multi-touch view did.
const VERSION = "1";
const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// Preferences (prefixed: the origin is shared with the other games of this site)
const PREF_KEY = "z4.prefs";
const prefs = Object.assign(
  { quality: "smooth", color: "vivid", glow: "soft", screen: "notch", sound: "on" },
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
async function checkFastCore(bytes) {
  try {
    const m = await WebAssembly.compile(bytes);
    const names = WebAssembly.Module.exports(m).map(e => e.name);
    // the interpreter-only core of this site has the same exports but is far smaller
    return names.includes("aot_build") && names.includes("app_frame") && bytes.length > 1000000;
  } catch { return false; }
}
async function importFastCore(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(await checkFastCore(bytes))) throw new Error("가속 파일(z4fast.wasm)이 아니에요");
  await idbPut("game", "fast", bytes.buffer);
}
async function importFiles(files, progress) {
  const list = [...files];
  const fast = list.filter(f => /\.wasm$/i.test(f.name));
  const games = list.filter(f => !/\.wasm$/i.test(f.name));
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
    for (const n of ["uTex", "uTexSize", "uReg", "uOut", "uMode", "uVivid", "uFlip", "uBloom", "uGlow", "uDir"]) u[n] = gl.getUniformLocation(p, n);
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
    this.dirty = false;
    const ow = this.canvas.width, oh = this.canvas.height;
    this.pass(this.out, this.src, W, H, W, H, null, ow, oh, (gl, u) => {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloom || this.src);
      gl.uniform1i(u.uBloom, 1);
      gl.uniform1f(u.uGlow, glow);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(u.uOut, ow, oh);
      gl.uniform1f(u.uMode, prefs.quality === "pixel" ? 2 : prefs.quality === "sharp" ? 1 : 0);
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
  decode(mode, bytes) {
    if (mode === 2) return this.euc.decode(bytes);
    if (mode === 3) return this.u16.decode(bytes);
    return this.utf8.decode(bytes);
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
  op(mem, op, a, b, ptr, len) {
    const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer);
    const fromBits = v => { i32[0] = v; return f32[0]; };
    const toBits = v => { f32[0] = v; return i32[0]; };
    switch (op) {
      case 1: { // set the string: a = 0 UTF-8 (b = character count to keep, 0 for all), 2 KSC5601, 3 UTF-16
        let s = ptr ? this.decode(a, new Uint8Array(mem.buffer, ptr, len)) : "";
        if (a === 0 && b > 0 && b < s.length) s = s.slice(0, b);
        this.str = s;
        return 0;
      }
      case 2: this.size = fromBits(a) || 12; return 0;
      case 3: this.color = a; return 0;
      case 4: { // GFA_DrawFont: the string at the left edge, baseline one line down
        const m = this.metrics();
        this.draw(mem, ptr, 0, this.charHeight() - m.descent + 1);
        this.rect = [0, 0, this.width(this.str), this.charHeight() + 1];
        return 0;
      }
      case 5: return toBits(this.width(this.str));
      case 6: this.bpp = len & 0xff; this.aa = !!(len & 0x100); this.setBitmap(a, b); return 0;
      case 7: { const m = this.metrics(); return (m.ascent << 16) | (m.descent & 0xffff); }
      case 9: { // GFA_GetWordwrapPositionEx(maxWidth, int[] out)
        const maxW = fromBits(a);
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
      case 12: return toBits(this.size);
      case 13: return this.charHeight();
      case 14: return Math.trunc(this.width("뷁"));
      case 15: { const r = new Float32Array(mem.buffer, ptr, 4); r.set(this.rect); return 0; }
      case 16: { // GFA_MeasureText(?, maxWidth): widest wrapped line and the height of the lines
        const maxW = fromBits(b) || 1e9;
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
        const x = fromBits(a), y = fromBits(b);
        this.draw(mem, ptr, x, y + this.charHeight());
        this.rect = [x, y, this.width(this.str), this.charHeight() + this.metrics().descent];
        return 0;
      }
      case 22: { // GFA_GetWordwrapPosition(line, maxWidth): start of the given line
        const maxW = fromBits(b);
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
      host_file_saved: (p, pl, d, n) => saves.write(this.utf.decode(new Uint8Array(this.mem.buffer, p, pl)), new Uint8Array(this.mem.buffer, d, n).slice()),
      host_file_deleted: (p, pl) => saves.remove(this.utf.decode(new Uint8Array(this.mem.buffer, p, pl))),
      host_event: (kind, a, b, c) => this.onEvent(kind, a, b, c) | 0,
      // Natives.readAssete / isAssetExist: AssetManager.open(name)
      host_asset: (p, n, dst, cap) => {
        const hit = this.game.index[this.utf.decode(new Uint8Array(this.mem.buffer, p, n))];
        if (!hit) return -1;
        if (dst) new Uint8Array(this.mem.buffer, dst, Math.min(cap, hit[1])).set(this.game.assets.subarray(hit[0], hit[0] + Math.min(cap, hit[1])));
        return hit[1];
      },
      host_sound: (op, id, vol, loop) => {
        if (op === 1) audio.play(id, vol, loop);
        else audio.stopMusic();
      },
      host_text: (op, a, b, ptr, len) => this.text.op(this.mem, op, a, b, ptr, len) | 0,
    };
    let instance;
    if (game.fast) ({ instance } = await WebAssembly.instantiate(game.fast, { env }));
    else {
      const resp = fetch(`z4core.wasm?v=${VERSION}`);
      ({ instance } = await (WebAssembly.instantiateStreaming
        ? WebAssembly.instantiateStreaming(resp, { env })
        : WebAssembly.instantiate(await (await resp).arrayBuffer(), { env })));
    }
    this.ex = instance.exports;
    this.mem = this.ex.memory;
    const ex = this.ex;
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
    return p ? { w, h, px: new Uint16Array(this.mem.buffer, p, w * h) } : null;
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
function touchStart(key, cx, cy) {
  if (pointers.has(key)) return;
  const [x, y] = toLcd(cx, cy);
  const p = { id: freePointerId(), x, y };
  pointers.set(key, p);
  queue.push({ type: 23, id: p.id, x, y });
}
function touchMove(key, cx, cy) {
  const p = pointers.get(key);
  if (!p) return;
  const [x, y] = toLcd(cx, cy);
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
  const [x, y] = cx === undefined ? [p.x, p.y] : toLcd(cx, cy);
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

// events from the core: 1 vibrate, 2 UI status, 3 Natives.OnEvent, 4 in-app purchase, 5 frame rate
let frameInterval = 1000 / 23;
function onCoreEvent(kind, a) {
  if (kind === 4) toast("결제는 이 플레이어에서 쓸 수 없어요");
  if (kind === 5 && a > 0) frameInterval = 1000 / Math.min(60, a); // Natives.SetSpeed: the GL thread's frame rate
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Game loop: the GL thread renders (and the game runs one step) at the rate the game asked for.
let acc = 0;
let lastT = 0;
let shownFrame = -1;
function frameLoop(t) {
  requestAnimationFrame(frameLoop);
  if (!running) { lastT = t; return; }
  const dt = lastT ? Math.min(t - lastT, 250) : 0;
  lastT = t;
  acc += dt;
  let ran = 0;
  while (acc >= frameInterval && ran < 2) {
    deliverInput();
    if (core.frame() !== 0) return crashed();
    acc -= frameInterval;
    ran++;
  }
  if (acc > frameInterval) acc = 0; // fell behind: drop the backlog instead of rushing
  if (ran) {
    const n = core.frames();
    if (n !== shownFrame) {
      shownFrame = n;
      const f = core.screen();
      if (f) renderer.upload(f.px, f.w, f.h);
    }
  }
  if (renderer.dirty) renderer.draw();
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
    try {
      await importFastCore(f);
      if (confirm("가속 파일을 넣었어요. 게임을 다시 시작할까요?")) { await saves.flush(); location.reload(); }
      else toast("다음에 시작할 때부터 빨라져요");
    } catch (err) { toast(String(err?.message || err)); }
  });
  $("btn-export").addEventListener("click", exportSaves);
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

function syncFastRow(have, active) {
  const t = $("fast-state");
  if (t) t.textContent = active ? "쓰는 중" : have ? "맞지 않음" : "없음";
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
  } catch (e) {
    $("tap-text").textContent = "게임을 불러오지 못했어요";
    $("tap-err").textContent = String(e?.message || e);
    return;
  }
  $("tap-text").textContent = "화면을 터치하면 시작해요";
  $("tap-err").textContent = core.fast ? "" : game.fast
    ? "가속 파일이 이 게임 파일과 맞지 않아서 느리게 돌아가요. 설정에서 맞는 가속 파일로 바꿔 주세요."
    : "가속 파일(z4fast.wasm)이 없어서 느리게 돌아가요. 설정 → 가속 파일에서 넣을 수 있어요.";
  syncFastRow(game.fast, core.fast);
  window.__z4 = { core, audio: () => audio, lcd: () => lcdW, running: () => running, hold: v => { running = !v; }, ready: true };
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
