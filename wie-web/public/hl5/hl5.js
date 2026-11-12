// 영웅서기5 player: runs the game's ARM library in hl5core.wasm and presents it on an iPhone in landscape.
const VERSION = "2";
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Preferences (prefixed: the origin is shared with the other games of this site)
const PREF_KEY = "hl5.prefs";
const prefs = Object.assign(
  { quality: "sharp", color: "vivid", impact: "normal", screen: "notch", sound: "on" },
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
const DB_NAME = "hl5-player";
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
// Zip reading (the game arrives as a zip holding the apk, or as the apk itself)
async function readZip(blob) {
  const tailLen = Math.min(blob.size, 66000);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip 파일이 아니에요");
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

const SO_NAME = "lib/armeabi/libHeroesLore5.so";
const VFS_NAME = "assets/data.vfs.mp3";

async function importGame(file, progress) {
  progress(0.05);
  let apk = file;
  let entries = await readZip(file);
  if (!entries.some(e => e.name === SO_NAME)) {
    const inner = entries.find(e => /\.apk$/i.test(e.name));
    if (!inner) throw new Error("zip 안에서 영웅서기5 apk를 찾지 못했어요");
    progress(0.15);
    apk = await zipData(file, inner);
    entries = await readZip(apk);
  }
  progress(0.5);
  const soEntry = entries.find(e => e.name === SO_NAME);
  const vfsEntry = entries.find(e => e.name === VFS_NAME);
  if (!soEntry || !vfsEntry) throw new Error("영웅서기5 게임 파일이 아니에요");
  const so = new Uint8Array(await (await zipData(apk, soEntry)).arrayBuffer());
  progress(0.7);
  const marker = new TextEncoder().encode("Java_co_kr_eamobile_CletEntry_nativeLoop");
  if (so[0] !== 0x7f || so[1] !== 0x45 || !findBytes(so, marker)) throw new Error("게임 라이브러리를 읽지 못했어요");
  const vfs = await (await zipData(apk, vfsEntry)).arrayBuffer();
  progress(0.85);
  await idbPut("game", "so", so.buffer);
  await idbPut("game", "vfs", vfs);
  await idbPut("game", "meta", { version: VERSION, imported: Date.now(), vfsSize: vfs.byteLength });
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
// sideways even with the rotation lock on.
const layout = { rotated: false, lw: 0, lh: 0, stage: { x: 0, y: 0, w: 0, h: 0 }, insets: { l: 0, r: 0 } };
let lcdW = 448;
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
  const otherMargin = mode === "safe" ? (rotated ? ins.b : inset) : 0;
  const l = camLeft ? camMargin : otherMargin, r = camLeft ? otherMargin : camMargin;
  return { vw, vh, rotated, lw, lh, l, r, inset, camLeft, bottom: rotated ? ins.r : ins.b };
}

function chooseLcdWidth() {
  const m = landscapeMetrics();
  const w = Math.round((LCD_H * (m.lw - m.l - m.r)) / m.lh / 2) * 2;
  return Math.max(400, Math.min(520, w || 448));
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
  Object.assign(layout, { rotated: m.rotated, lw: m.lw, lh: m.lh, stage: { x: sx, y: sy, w: sw, h: sh }, insets: { l: m.l, r: m.r } });
  const st = $("stage");
  st.style.left = sx + "px";
  st.style.top = sy + "px";
  st.style.width = sw + "px";
  st.style.height = sh + "px";
  // buttons: in the margin beside the camera, above and below it; without a margin, over the game's edge
  const side = $("side");
  const margin = m.camLeft ? sx : m.lw - sx - sw;
  const split = margin >= 44;
  const cx = split ? margin / 2 : 26;
  side.classList.toggle("split", split);
  side.style.left = (m.camLeft ? cx - 20 : m.lw - cx - 20) + "px";
  side.style.top = split ? "0px" : Math.round(m.lh * 0.36) + "px";
  side.style.height = split ? m.lh + "px" : "auto";
  side.style.paddingBottom = split ? Math.max(10, m.bottom) + "px" : "0px";
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
// Renderer: RGB565 frame -> optional Scale2x x2 -> sharp bilinear to the screen, plus color and hit tint.
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
const FS_OUT = `precision highp float; varying vec2 vUv; uniform sampler2D uTex; uniform vec2 uTexSize; uniform vec2 uReg; uniform vec2 uOut;
uniform float uSharp; uniform float uVivid; uniform vec4 uFlash; uniform float uHurt;
void main(){
  vec2 p = vUv * uReg; vec2 uv;
  if (uSharp > 0.5) {
    vec2 scale = max(floor(uOut / uReg + 0.001), vec2(1.0)) + fract(uOut / uReg);
    vec2 ip = floor(p); vec2 cd = p - ip - 0.5; vec2 rr = 0.5 - 0.5 / scale;
    vec2 f = (cd - clamp(cd, -rr, rr)) * scale + 0.5;
    uv = (ip + f) / uTexSize;
  } else uv = p / uTexSize;
  vec3 c = texture2D(uTex, uv).rgb;
  if (uVivid > 0.0) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.0 + 0.16 * uVivid);
    c = (c - 0.5) * (1.0 + 0.07 * uVivid) + 0.5;
  }
  c += uFlash.rgb * uFlash.a;
  if (uHurt > 0.0) {
    vec2 d = vUv - 0.5; float v = smoothstep(0.3, 0.78, length(d * vec2(1.0, 1.25)));
    c = mix(c, vec3(0.75, 0.02, 0.0), clamp(v * uHurt * 0.75, 0.0, 1.0));
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
    this.out = this.program(FS_OUT);
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
    for (const n of ["uTex", "uTexSize", "uReg", "uOut", "uSharp", "uVivid", "uFlash", "uHurt", "uFlip", "uEq"]) u[n] = gl.getUniformLocation(p, n);
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
  draw(fxState) {
    const gl = this.gl;
    const W = lcdW, H = LCD_H;
    let tex = this.src, tw = this.srcW, th = this.srcH, rw = W, rh = H;
    if (prefs.quality !== "pixel") {
      const a = this.fbo(0, W * 2, H * 2), b = this.fbo(1, W * 4, H * 4);
      if (this.dirty) {
        const tol = (gl, u) => gl.uniform1f(u.uEq, window.HL5_EQ ?? 0.08);
        this.pass(this.epx, this.src, this.srcW, this.srcH, W, H, a, W * 2, H * 2, tol);
        this.pass(this.epx, a.tex, W * 2, H * 2, W * 2, H * 2, b, W * 4, H * 4, tol);
      }
      tex = b.tex; tw = rw = W * 4; th = rh = H * 4;
    }
    this.dirty = false;
    const ow = this.canvas.width, oh = this.canvas.height;
    this.pass(this.out, tex, tw, th, rw, rh, null, ow, oh, (gl, u) => {
      gl.uniform2f(u.uOut, ow, oh);
      gl.uniform1f(u.uSharp, prefs.quality === "smooth" ? 0 : 1);
      gl.uniform1f(u.uVivid, prefs.color === "vivid" ? 1 : 0);
      gl.uniform4f(u.uFlash, fxState.flash[0], fxState.flash[1], fxState.flash[2], fxState.flash[3]);
      gl.uniform1f(u.uHurt, fxState.hurt);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Hit feedback drawn over the game: sparks, glow and rings at the struck monster, screen shake,
// a short freeze on strong hits, red edges when the hero is hit. Driven by the game's own calls.
class Fx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.parts = [];
    this.rings = [];
    this.glows = [];
    this.slashes = [];
    this.flash = [0, 0, 0, 0];
    this.hurt = 0;
    this.shake = 0;
    this.drawn = false;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  resize(w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.scale = (w * dpr) / lcdW;
  }
  level() { return prefs.impact === "strong" ? 1.4 : prefs.impact === "normal" ? 1 : 0; }
  hit(x, y, crit) {
    const k = this.level();
    if (!k) return;
    const n = Math.round((crit ? 22 : 12) * k);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (crit ? 2.8 : 2.2) * (0.5 + Math.random()) * k;
      this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.6, life: 1, decay: 0.045 + Math.random() * 0.04, w: crit ? 1.6 : 1.2, hue: crit ? 45 : 30 + Math.random() * 20 });
    }
    this.glows.push({ x, y, r: (crit ? 26 : 18) * k, life: 1, decay: crit ? 0.07 : 0.1, hue: crit ? 48 : 35 });
    const ang = -0.6 + Math.random() * 1.2 + (Math.random() < 0.5 ? 0 : Math.PI / 2);
    this.slashes.push({ x, y, ang, len: (crit ? 30 : 22) * k, life: 1, decay: crit ? 0.11 : 0.14, hue: crit ? 45 : 30 });
    if (crit) {
      this.rings.push({ x, y, r: 6, vr: 3.2 * k, life: 1, decay: 0.06, hue: 45 });
      this.flash = [1, 0.85, 0.5, 0.22 * k];
      this.kick(3 * k);
    } else this.kick(1.2 * k);
  }
  kill(x, y) {
    const k = this.level();
    if (!k) return;
    this.rings.push({ x, y, r: 4, vr: 2.6 * k, life: 1, decay: 0.05, hue: 20 });
    this.rings.push({ x, y, r: 2, vr: 1.7 * k, life: 1, decay: 0.045, hue: 40 });
    for (let i = 0; i < 16 * k; i++) {
      const a = Math.random() * Math.PI * 2, s = 1.2 * (0.4 + Math.random()) * k;
      this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.9, life: 1, decay: 0.03 + Math.random() * 0.03, w: 1.4, hue: 15 + Math.random() * 30 });
    }
    this.kick(2 * k);
  }
  hurtHero() {
    const k = this.level();
    if (!k) return;
    this.hurt = Math.min(1, 0.55 * k + this.hurt * 0.5);
    this.kick(2.2 * k);
  }
  kick(px) {
    if (this.reduced) px *= 0.3;
    this.shake = Math.max(this.shake, px);
  }
  update(dt) {
    const f = Math.min(dt / 16.7, 3);
    for (const p of this.parts) { p.x += p.vx * f; p.y += p.vy * f; p.vy += 0.08 * f; p.vx *= 0.96; p.life -= p.decay * f; }
    for (const r of this.rings) { r.r += r.vr * f; r.vr *= 0.93; r.life -= r.decay * f; }
    for (const g of this.glows) g.life -= g.decay * f;
    for (const sl of this.slashes) sl.life -= sl.decay * f;
    this.slashes = this.slashes.filter(sl => sl.life > 0);
    this.parts = this.parts.filter(p => p.life > 0);
    this.rings = this.rings.filter(r => r.life > 0);
    this.glows = this.glows.filter(g => g.life > 0);
    this.flash[3] = Math.max(0, this.flash[3] - 0.03 * f);
    this.hurt = Math.max(0, this.hurt - 0.035 * f);
    this.shake = this.shake < 0.2 ? 0 : this.shake * Math.pow(0.82, f);
  }
  draw() {
    const c = this.ctx, s = this.scale;
    const busy = this.parts.length || this.rings.length || this.glows.length || this.slashes.length;
    if (!busy && !this.drawn) return;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawn = !!busy;
    if (!busy) return;
    c.globalCompositeOperation = "lighter";
    for (const g of this.glows) {
      const r = g.r * s * (1.2 - g.life * 0.4);
      const grd = c.createRadialGradient(g.x * s, g.y * s, 0, g.x * s, g.y * s, r);
      grd.addColorStop(0, `hsla(${g.hue},100%,85%,${0.85 * g.life})`);
      grd.addColorStop(0.35, `hsla(${g.hue},100%,60%,${0.45 * g.life})`);
      grd.addColorStop(1, `hsla(${g.hue},100%,50%,0)`);
      c.fillStyle = grd;
      c.fillRect(g.x * s - r, g.y * s - r, r * 2, r * 2);
    }
    c.lineCap = "round";
    for (const sl of this.slashes) {
      const grow = 1.25 - sl.life * 0.25, half = (sl.len * s * grow) / 2;
      const dx = Math.cos(sl.ang) * half, dy = Math.sin(sl.ang) * half * 0.8;
      const x0 = sl.x * s - dx, y0 = sl.y * s - dy, x1 = sl.x * s + dx, y1 = sl.y * s + dy;
      c.strokeStyle = `hsla(${sl.hue},100%,60%,${0.55 * sl.life})`;
      c.lineWidth = 5 * s * sl.life;
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
      c.strokeStyle = `rgba(255,255,245,${sl.life})`;
      c.lineWidth = 1.6 * s * sl.life;
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    }
    for (const p of this.parts) {
      c.strokeStyle = `hsla(${p.hue},100%,${60 + 30 * p.life}%,${p.life})`;
      c.lineWidth = p.w * s * 0.6;
      c.beginPath();
      c.moveTo(p.x * s, p.y * s);
      c.lineTo((p.x - p.vx * 2.2) * s, (p.y - p.vy * 2.2) * s);
      c.stroke();
    }
    for (const r of this.rings) {
      c.strokeStyle = `hsla(${r.hue},100%,70%,${0.8 * r.life})`;
      c.lineWidth = 1.6 * s * r.life;
      c.beginPath();
      c.ellipse(r.x * s, r.y * s, r.r * s, r.r * s * 0.6, 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalCompositeOperation = "source-over";
  }
}

// ---------------------------------------------------------------------------------------------
// Audio: sound effects and music are Ogg Vorbis clips inside data.vfs, decoded and played through
// Web Audio. Only the current music track stays decoded.
const KIND_MEDIA = 0, KIND_MUSIC = 1, KIND_SOUND = 2;
class AudioEngine {
  constructor(vfs) {
    this.vfs = vfs;
    this.ctx = null;
    this.clips = new Map();
    this.vol = [100, 100, 100];
    this.musicKey = null;
    this.musicSrc = null;
    this.decodeQueue = Promise.resolve();
  }
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.gains = [0, 1, 2].map(() => { const g = this.ctx.createGain(); g.connect(this.master); return g; });
      this.applyVolumes();
      // a silent buffer started inside the gesture unlocks output on iOS
      const b = this.ctx.createBuffer(1, 1, 22050), s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
    }
    if (this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }
  applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = prefs.sound === "on" ? 1 : 0;
    this.gains.forEach((g, i) => (g.gain.value = this.vol[i] / 100));
  }
  suspend() { this.ctx?.suspend().catch(() => {}); }
  resume() { this.ctx?.resume().catch(() => {}); }
  decode(clip) {
    if (clip.buf || clip.decoding) return clip.decoding || Promise.resolve(clip.buf);
    const bytes = this.vfs.slice(clip.off, clip.off + clip.len);
    clip.decoding = this.decodeQueue = this.decodeQueue.then(() =>
      new Promise(resolve => {
        if (!this.ctx) return resolve(null);
        this.ctx.decodeAudioData(bytes.buffer, b => { clip.buf = b; resolve(b); }, () => { clip.failed = true; resolve(null); });
      }),
    );
    return clip.decoding;
  }
  call(verb, kind, key, a, b, c) {
    switch (verb) {
      case 1: { // put(offset, length)
        this.free(key);
        const clip = { kind, off: a, len: b, buf: null, sources: new Set() };
        this.clips.set(key, clip);
        if (kind !== KIND_MUSIC && this.ctx) this.decode(clip);
        return 0;
      }
      case 2: return this.play(key, !!a);
      case 3: this.stop(key); return 0;
      case 4: this.pause(key); return 0;
      case 5: this.resumeClip(key); return 0;
      case 6: this.free(key); return 0;
      case 7: { const clip = this.clips.get(key); if (!clip) return -1; return this.isPlaying(key) ? 2 : clip.pausedAt !== undefined ? 1 : 0; }
      case 8: this.vol[kind] = Math.max(0, Math.min(100, a)); this.applyVolumes(); return 0;
      case 9: return this.vol[kind];
      default: return 0;
    }
  }
  isPlaying(key) {
    const clip = this.clips.get(key);
    if (!clip) return false;
    if (clip.kind === KIND_MUSIC) return this.musicKey === key && (this.musicSrc !== null || !!clip.decoding && !clip.buf);
    return clip.sources.size > 0;
  }
  startSource(clip, loop, offset = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = clip.buf;
    src.loop = loop;
    src.connect(this.gains[clip.kind]);
    src.onended = () => {
      clip.sources.delete(src);
      if (this.musicSrc === src) this.musicSrc = null;
    };
    clip.sources.add(src);
    clip.loop = loop;
    clip.startedAt = this.ctx.currentTime - offset;
    src.start(0, offset);
    return src;
  }
  play(key, loop) {
    const clip = this.clips.get(key);
    if (!clip || !this.ctx) return -1;
    clip.pausedAt = undefined;
    if (clip.kind === KIND_MUSIC) {
      if (this.musicKey !== null && this.musicKey !== key) this.stop(this.musicKey);
      this.stopSources(clip);
      this.musicKey = key;
      for (const [k, other] of this.clips) if (other.kind === KIND_MUSIC && k !== key) other.buf = null;
      const ticket = (clip.ticket = (clip.ticket || 0) + 1);
      this.decode(clip).then(buf => {
        if (!buf || this.musicKey !== key || clip.ticket !== ticket || clip.pausedAt !== undefined) return;
        this.musicSrc = this.startSource(clip, loop);
      });
      return 0;
    }
    if (clip.buf) this.startSource(clip, loop);
    else if (!clip.failed) {
      const asked = performance.now();
      this.decode(clip).then(buf => { if (buf && (performance.now() - asked < 600 || loop)) this.startSource(clip, loop); });
    }
    return 0;
  }
  stopSources(clip) {
    for (const s of clip.sources) try { s.onended = null; s.stop(); } catch {}
    clip.sources.clear();
  }
  stop(key) {
    const clip = this.clips.get(key);
    if (!clip) return;
    clip.pausedAt = undefined;
    clip.ticket = (clip.ticket || 0) + 1;
    this.stopSources(clip);
    if (this.musicKey === key) { this.musicKey = null; this.musicSrc = null; }
  }
  pause(key) {
    const clip = this.clips.get(key);
    if (!clip || !this.ctx) return;
    const playing = clip.sources.size > 0 && clip.buf;
    const at = playing ? (this.ctx.currentTime - clip.startedAt) % clip.buf.duration : 0;
    this.stopSources(clip);
    if (this.musicKey === key) this.musicSrc = null;
    clip.pausedAt = at;
  }
  resumeClip(key) {
    const clip = this.clips.get(key);
    if (!clip || clip.pausedAt === undefined || !clip.buf) return;
    const at = clip.pausedAt;
    clip.pausedAt = undefined;
    const src = this.startSource(clip, clip.loop, at);
    if (clip.kind === KIND_MUSIC) { this.musicKey = key; this.musicSrc = src; }
  }
  free(key) {
    if (!this.clips.has(key)) return;
    this.stop(key);
    this.clips.delete(key);
  }
  decodeAll() {
    for (const clip of this.clips.values()) if (clip.kind !== KIND_MUSIC) this.decode(clip);
  }
}

// ---------------------------------------------------------------------------------------------
// The emulator core
const WATCHES = [
  ["_ZN7Monster4DrawEiii", "draw"],
  ["_ZN4HERO12NewHitEffectEP13HeroSkillInfoP7BATTLER", "hit"],
  ["_ZN4HERO20CheckEffSound_HitCriEa", "crit"],
  ["_ZN7Monster12SetDieMotionEv", "die"],
  ["_ZN4HERO17SetAttackedMotionEaa", "hurt"],
  ["_ZN9BaseState14CallPopupStateEaiPcPS0_iPA48_caPa", "popup"],
  ["_ZN13StateMainMenu8SetStateEa", "menuState"],
  ["_ZN13StateMainMenu11SetSubStateEa", "menuSubState"],
];

class Core {
  async init(so, vfs, files, onEvent) {
    this.vfs = vfs;
    this.onEvent = onEvent;
    this.utf = new TextDecoder();
    this.euc = new TextDecoder("euc-kr");
    this.logs = [];
    const env = {
      host_log: (p, n) => {
        const s = this.euc.decode(new Uint8Array(this.mem.buffer, p, n).slice());
        this.logs.push(s);
        if (this.logs.length > 200) this.logs.shift();
        if (window.HL5_DEBUG) console.debug("[game]", s);
      },
      host_now: () => Date.now(),
      host_pow: Math.pow,
      host_vfs_read: (off, dst, len) => {
        const src = this.vfs.subarray(off, off + len);
        new Uint8Array(this.mem.buffer, dst, src.length).set(src);
        return src.length;
      },
      host_audio: (op, key, a, b, c) => audio.call(op >> 2, op & 3, key, a, b, c),
      host_file_saved: (p, pl, d, n) => saves.write(this.utf.decode(new Uint8Array(this.mem.buffer, p, pl)), new Uint8Array(this.mem.buffer, d, n).slice()),
      host_file_deleted: (p, pl) => saves.remove(this.utf.decode(new Uint8Array(this.mem.buffer, p, pl))),
      host_event: (kind, a, b, c) => this.onEvent(kind, a, b, c) | 0,
    };
    const resp = fetch(`hl5core.wasm?v=${VERSION}`);
    const { instance } = await (WebAssembly.instantiateStreaming
      ? WebAssembly.instantiateStreaming(resp, { env })
      : WebAssembly.instantiate(await (await resp).arrayBuffer(), { env }));
    this.ex = instance.exports;
    this.mem = this.ex.memory;
    const ex = this.ex;
    const p = ex.host_alloc(so.length);
    new Uint8Array(this.mem.buffer, p, so.length).set(so);
    if (ex.load_library(p, so.length) !== 0) throw new Error("게임 라이브러리를 불러오지 못했어요");
    ex.host_free(p);
    ex.set_logging(window.HL5_DEBUG ? 1 : 0);
    ex.set_native_hooks(1);
    WATCHES.forEach(([sym], i) => ex.watch_symbol(this.cstr(sym), i));
    ex.set_vfs_size(vfs.length);
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
  start(w) { return this.ex.app_start(w * 2, 480, w, LCD_H, 2.0, 1); }
  loop() { return this.ex.app_loop(); }
  touch(type, x, y, id) { this.ex.app_touch(type, x, y, id); }
  key(type, code) { this.ex.app_key(type, code); }
  call(name) { return this.ex.app_call(this.cstr(name)); }
  regs() { return new Int32Array(this.mem.buffer, this.ex.cpu_state(), 4); }
  rd32(a) { return new Int32Array(this.mem.buffer)[(this.ex.guest_base() + (a & 0x3ffffff)) >> 2]; }
  frame() {
    const fi = this.ex.frame_info() >> 2;
    const u = new Uint32Array(this.mem.buffer);
    return { data: u[fi], w: u[fi + 1], h: u[fi + 2], uploads: u[fi + 16], counter: u[fi + 6] };
  }
}

// ---------------------------------------------------------------------------------------------
// Saves: every file the game writes is mirrored to IndexedDB
const saves = {
  files: new Map(),
  pending: new Map(),
  timer: 0,
  write(path, data) {
    this.files.set(path, data);
    this.pending.set(path, data);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  },
  remove(path) {
    this.files.delete(path);
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
// Input: up to two fingers, numbered like Android pointer ids (lowest free id first)
const slots = [null, null];
const lastPos = [null, null];
const pendingMove = [null, null];
let core, audio, renderer, fx;
let running = false;

function sendMove(slot) {
  const m = pendingMove[slot];
  if (!m) return;
  pendingMove[slot] = null;
  core.touch(21, m[0], m[1], slot);
}
function touchStart(id, cx, cy) {
  const slot = slots.indexOf(null);
  if (slot < 0) return;
  slots[slot] = id;
  const p = toLcd(cx, cy);
  lastPos[slot] = p;
  core.touch(19, p[0], p[1], slot);
}
function touchMove(id, cx, cy) {
  const slot = slots.indexOf(id);
  if (slot < 0) return;
  const p = toLcd(cx, cy);
  if (p[0] === lastPos[slot][0] && p[1] === lastPos[slot][1]) return;
  lastPos[slot] = p;
  pendingMove[slot] = p;
}
function touchEnd(id, cx, cy) {
  const slot = slots.indexOf(id);
  if (slot < 0) return;
  sendMove(slot);
  const p = cx === undefined ? lastPos[slot] : toLcd(cx, cy);
  slots[slot] = null;
  core.touch(20, p[0], p[1], slot);
}
function releaseAll() {
  for (let s = 0; s < 2; s++) if (slots[s] !== null) touchEnd(slots[s]);
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
  // mouse, for testing on a computer
  let mouseDown = false;
  document.addEventListener("mousedown", e => { if (isUi(e.target) || !running) return; mouseDown = true; touchStart("m", e.clientX, e.clientY); });
  document.addEventListener("mousemove", e => { if (mouseDown) touchMove("m", e.clientX, e.clientY); });
  document.addEventListener("mouseup", e => { if (mouseDown) { mouseDown = false; touchEnd("m", e.clientX, e.clientY); } });
  const keys = { ArrowUp: -1, ArrowDown: -2, ArrowLeft: -3, ArrowRight: -4, Enter: -5, Escape: -16, Backspace: -16, "#": 35, "*": 42 };
  document.addEventListener("keydown", e => { const k = keys[e.key] ?? (/^[0-9]$/.test(e.key) ? e.key.charCodeAt(0) : null); if (k !== null && running && !e.repeat) { core.key(2, k); e.preventDefault(); } });
  document.addEventListener("keyup", e => { const k = keys[e.key] ?? (/^[0-9]$/.test(e.key) ? e.key.charCodeAt(0) : null); if (k !== null && running) core.key(3, k); });
  document.addEventListener("gesturestart", e => e.preventDefault());
  document.addEventListener("dblclick", e => e.preventDefault());
}

function pressKey(code) {
  if (!running) return;
  core.key(2, code);
  setTimeout(() => running && core.key(3, code), 90);
}

// ---------------------------------------------------------------------------------------------
// Game events from the core
const monsters = new Map(); // battler pointer -> {x, y, tick}
const counters = { hits: 0, kills: 0, crits: 0, hurts: 0, vib: 0 };
const dying = new Map();
const lastHit = new Map();
let tickNo = 0;
let freezeUntil = 0;
let critPending = 0;
// Boot assistant: EA's servers are gone, so the start-up connection checks only produce error popups.
// Until the main menu they are confirmed automatically, and the SMS-consent question is answered "아니오".
const keyQueue = [];
let menuState = -1;
let pastBoot = false;
function queueKey(code, delayTicks, hold = 3) {
  keyQueue.push({ tick: tickNo + delayTicks, type: 2, code });
  keyQueue.push({ tick: tickNo + delayTicks + hold, type: 3, code });
}
function runKeyQueue() {
  for (let i = 0; i < keyQueue.length; ) {
    const k = keyQueue[i];
    if (k.tick <= tickNo) { core.key(k.type, k.code); keyQueue.splice(i, 1); } else i++;
  }
}

function freeze(ms) {
  if (prefs.impact === "off") return;
  const k = prefs.impact === "strong" ? 1.5 : 1;
  freezeUntil = Math.max(freezeUntil, performance.now() + ms * k);
}

function onCoreEvent(kind, a, b, c) {
  switch (kind) {
    case 1: // vibration(ms, ?) requested by the game
      counters.vib++;
      if (a > 0) fx.kick(Math.min(4, 1 + a / 120) * (prefs.impact === "off" ? 0 : 1));
      return 0;
    case 2: // exit
      setTimeout(showExited, 0);
      return 0;
    case 3: // in-app purchase: no store to reach
      setTimeout(() => toast("상점 결제는 지원하지 않아요"), 0);
      return -1;
    case 4: // network: report it available so the game's connection attempts fail at once
      return 1;
    case 100: { // Monster::Draw(this, fb, camX, camY)
      const r = core.regs();
      const obj = r[0] >>> 0;
      monsters.set(obj, { x: core.rd32(obj + 4) + r[2], y: core.rd32(obj + 8) + r[3], tick: tickNo });
      return 0;
    }
    case 101: { // HERO::NewHitEffect(this, skill, target)
      const target = core.regs()[2] >>> 0;
      lastHit.set(target, tickNo);
      const m = monsters.get(target);
      if (m && tickNo - m.tick < 4) {
        const crit = critPending > tickNo - 2;
        fx.hit(m.x, m.y - 18, crit);
        counters.hits++;
        if (crit) counters.crits++;
        freeze(crit ? 70 : 28);
      }
      return 0;
    }
    case 102: critPending = tickNo; return 0;
    case 103: { // Monster::SetDieMotion: called every tick while dying; react once
      const obj = core.regs()[0] >>> 0;
      const seen = dying.get(obj);
      dying.set(obj, tickNo);
      const hitAt = lastHit.get(obj);
      if ((seen === undefined || tickNo - seen > 40) && hitAt !== undefined && tickNo - hitAt < 90) {
        const m = monsters.get(obj);
        if (m) { fx.kill(m.x, m.y - 14); freeze(55); counters.kills++; }
      }
      return 0;
    }
    case 104: fx.hurtHero(); counters.hurts++; return 0;
    case 105: // BaseState::CallPopupState(type, ...): type 2 is a message with one OK button
      if (!pastBoot && core.regs()[1] === 2) queueKey(-5, 3);
      return 0;
    case 106: // StateMainMenu::SetState(state): 2 logo, 3 title, 4 main menu
      menuState = core.regs()[1];
      if (menuState >= 4) pastBoot = true;
      return 0;
    case 107: // StateMainMenu::SetSubState(sub) on the logo screen: 1 asks for SMS consent, 4 waits for a key
      if (!pastBoot && menuState === 2) {
        const sub = core.regs()[1];
        if (sub === 1) { queueKey(-4, 4); queueKey(-5, 12); }
        else if (sub === 4) queueKey(-5, 3); // the logo screen then waits for any key
      }
      return 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Main loop
let lastUploads = -1;
let lastT = 0;
const stats = { frames: 0, loopMs: 0, drawMs: 0 };
function frameLoop(t) {
  requestAnimationFrame(frameLoop);
  if (!running) return;
  const dt = lastT ? t - lastT : 16.7;
  lastT = t;
  if (t >= freezeUntil) {
    sendMove(0);
    sendMove(1);
    tickNo++;
    if (keyQueue.length) runKeyQueue();
    const l0 = performance.now();
    if (core.loop() !== 0) return crashed();
    stats.loopMs += performance.now() - l0;
    if (tickNo % 300 === 0) { for (const [k, v] of monsters) if (tickNo - v.tick > 300) monsters.delete(k); for (const [k, v] of dying) if (tickNo - v > 300) dying.delete(k); for (const [k, v] of lastHit) if (tickNo - v > 300) lastHit.delete(k); }
  }
  const f = core.frame();
  if (f.data && f.uploads !== lastUploads) {
    lastUploads = f.uploads;
    renderer.upload(new Uint16Array(core.mem.buffer, f.data, f.w * f.h), f.w, f.h);
  }
  fx.update(dt);
  const sh = fx.shake;
  $("stage").style.transform = sh ? `translate(${((Math.random() * 2 - 1) * sh).toFixed(1)}px, ${((Math.random() * 2 - 1) * sh).toFixed(1)}px)` : "";
  const d0 = performance.now();
  if (f.data && !window.HL5_NODRAW) renderer.draw(fx);
  fx.draw();
  stats.drawMs += performance.now() - d0;
  stats.frames++;
}

function crashed() {
  running = false;
  const logs = core?.logs.slice(-12).join("\n") || "";
  showOverlay("tap");
  $("tap-text").innerHTML = "게임이 멈췄어요.<br>화면을 터치하면 다시 시작해요.";
  $("tap-err").textContent = logs;
  $("tap").onclick = () => location.reload();
}
function showExited() {
  running = false;
  audio?.suspend();
  saves.flush();
  showOverlay("tap");
  $("tap-text").textContent = "게임을 종료했어요. 화면을 터치하면 다시 시작해요.";
  $("tap-err").textContent = "";
  $("tap").onclick = () => location.reload();
}

function showOverlay(id) {
  for (const o of document.querySelectorAll(".overlay")) o.classList.toggle("show", o.id === id);
}

// pause when the app goes to the background
document.addEventListener("visibilitychange", () => {
  if (!core?.ex || !started) return;
  if (document.hidden) {
    releaseAll();
    if (running) { running = false; core.call("nativePauseApp"); audio.suspend(); }
    saves.flush();
  } else if (!running && !$("settings").classList.contains("show") && !exitedOrCrashed()) {
    core.call("nativeResumeApp");
    audio.resume();
    running = true;
  }
});
window.addEventListener("pagehide", () => saves.flush());
const exitedOrCrashed = () => $("tap").classList.contains("show");

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
  const openSettings = () => {
    if (running) { releaseAll(); running = false; settingsPaused = true; }
    syncSettings();
    $("settings").classList.add("show");
  };
  let settingsPaused = false;
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-close").addEventListener("click", () => {
    $("settings").classList.remove("show");
    if (settingsPaused) { settingsPaused = false; running = true; }
  });
  $("btn-back").addEventListener("click", () => pressKey(-16));
  $("btn-skip").addEventListener("click", () => pressKey(35));
  for (const id of ["btn-settings", "btn-back", "btn-skip"]) $(id).addEventListener("touchstart", e => { e.stopPropagation(); audio?.unlock(); }, { passive: true });
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
      if (data.game !== "hl5" || typeof data.files !== "object") throw new Error();
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
  const name = `hl5-save-${stamp}.json`;
  const file = new File([JSON.stringify({ game: "hl5", saved: Date.now(), files })], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "영웅서기5 세이브" }); return; } catch (e) { if (e.name === "AbortError") return; }
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
  const [so, vfs, files] = await Promise.all([idbGet("game", "so"), idbGet("game", "vfs"), idbEntries("files")]);
  if (!so || !vfs) return null;
  for (const [p, d] of files) saves.files.set(p, d);
  return { so: new Uint8Array(so), vfs: new Uint8Array(vfs), files };
}

async function prepareAndWait(game) {
  showOverlay("tap");
  $("tap-text").textContent = "불러오는 중…";
  lcdW = chooseLcdWidth();
  applyLayout();
  audio = new AudioEngine(game.vfs);
  core = new Core();
  try {
    await core.init(game.so, game.vfs, game.files, onCoreEvent);
  } catch (e) {
    $("tap-text").textContent = "게임을 불러오지 못했어요";
    $("tap-err").textContent = String(e?.message || e);
    return;
  }
  $("tap-text").textContent = "화면을 터치하면 시작해요";
  window.__hl5 = { core, stats, counters, audio: () => audio, menuState: () => menuState, ready: true, lcd: () => lcdW, running: () => running, fx: () => fx };
  $("tap").onclick = () => {
    if (started) return;
    started = true;
    audio.unlock();
    startGame();
  };
}

function startGame() {
  try {
    if (core.start(lcdW) !== 0) return crashed();
  } catch (e) {
    $("tap-err").textContent = String(e?.message || e);
    return;
  }
  audio.decodeAll();
  showOverlay(null);
  running = true;
  requestAnimationFrame(frameLoop);
}

async function boot() {
  bindInput();
  bindSettings();
  syncSettings();
  renderer = new Renderer($("screen"));
  fx = new Fx($("fx"));
  // iOS may drop the GL context while the app is in the background
  $("screen").addEventListener("webglcontextlost", e => e.preventDefault());
  $("screen").addEventListener("webglcontextrestored", () => {
    renderer = new Renderer($("screen"));
    lastUploads = -1;
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
