// This site's additions to the 1.57 web build: the iPhone layout (the frame turned in portrait, kept clear of
// the camera and the home bar), in-between frames (core.js between) and hit effects drawn over the game.
'use strict';

// ------------------------------------------------------------------ layout
// iOS web apps cannot lock the screen to landscape. In portrait the whole frame is turned 90° clockwise,
// so the phone can be held sideways with the rotation lock on: the frame's left edge is then the side of
// the camera and the status bar, its right edge the side of the home bar, and the game stays clear of both.
// In landscape it fills the screen.
window.Layout = {
  rotated: false, cw: 0, ch: 0, ox: 0,
  insets() {
    const cs = getComputedStyle(document.getElementById('probe'));
    return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  },
  apply() {
    const vw = window.innerWidth, vh = window.innerHeight, ins = this.insets();
    const rotated = vh > vw, fw = rotated ? vh : vw, fh = rotated ? vw : vh;
    // turned in portrait the game keeps clear of the status bar, which takes touches, and of the home bar; held in
    // landscape it uses the whole screen, as the build itself does, unless the setting 가로 화면 옆 여백 leaves the
    // camera side (1) or both sides (2) free
    let l, r;
    if (rotated) { l = ins.t; r = ins.b; }
    else {
      const s = window.DWInternals && window.DWInternals.settings, sides = (s && s.sides) || 0;
      const inset = Math.max(ins.l, ins.r);
      // the camera side, from the screen angle: 90 = turned counter-clockwise, camera on the left
      const a = typeof screen.orientation?.angle === 'number' ? screen.orientation.angle : window.orientation;
      const camLeft = !(a === 270 || a === -90);
      l = sides === 2 || (sides === 1 && camLeft) ? inset : 0;
      r = sides === 2 || (sides === 1 && !camLeft) ? inset : 0;
    }
    const key = [vw, vh, l, r].join();
    if (key === this.key) return;
    this.key = key;
    const frame = document.getElementById('frame');
    frame.style.width = fw + 'px';
    frame.style.height = fh + 'px';
    // the frame's size for the boot screen and the menus inside it: vw and vh are the screen's, not the turned frame's
    frame.style.setProperty('--fw', fw + 'px');
    frame.style.setProperty('--fh', fh + 'px');
    frame.style.transform = rotated ? `translate(${vw}px, 0) rotate(90deg)` : 'none';
    frame.style.setProperty('--ml', l + 'px');
    frame.style.setProperty('--mr', r + 'px');
    // safe-area insets as seen from inside the frame (top, right, bottom, left), for the boot screen and menus
    const fi = rotated ? [ins.r, ins.b, ins.l, ins.t] : [ins.t, ins.r, ins.b, ins.l];
    ['--ft', '--fr', '--fb', '--fl'].forEach((k, i) => frame.style.setProperty(k, fi[i] + 'px'));
    const hint = document.getElementById('turn-hint');
    if (hint) hint.hidden = !rotated;
    Object.assign(this, { rotated, cw: fw - l - r, ch: fh, ox: l });
  },
  // a pointer event -> CSS pixels inside the game canvas
  toCanvas(e) {
    const rc = document.getElementById('screen').getBoundingClientRect();
    return this.rotated ? [e.clientY - rc.top, rc.right - e.clientX] : [e.clientX - rc.left, e.clientY - rc.top];
  },
};

// how long an in-between frame takes here: on a slow phone only one is drawn per game frame
window.Smooth = { cost: 0 };

// ------------------------------------------------------------------ hit effects
// Sparks, a glow and a slash where a monster is struck, a pixel star, a ring and a short shake on big hits,
// red edges when the hero is hit. Driven by the game's own damage numbers (core event 10); the game's hits,
// damage and effects are unchanged. Positions are map pixels, drawn relative to the camera of the picture on
// screen so they stay on the monster, as squares on the game's pixel grid.
window.Fx = {
  parts: [], rings: [], glows: [], slashes: [], bursts: [], hurt: 0, shake: 0, shakeT: 0, shakeAng: 0, avg: 0, t: 0,
  reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
  level() { const s = window.DWInternals && window.DWInternals.settings; const v = s && s.impact !== undefined ? s.impact : 1; return v === 2 ? 1.4 : v === 1 ? 1 : 0; },
  hit(x, y, dmg, crit) {
    const k = this.level();
    if (!k) return;
    const big = crit || (this.avg > 0 && dmg > this.avg * 1.35); // a blow well above the recent ones counts as big
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
  },
  hurtHero() {
    const k = this.level();
    if (!k) return;
    this.hurt = Math.min(1, 0.55 * k + this.hurt * 0.5);
    this.kick(1.8 * k);
  },
  kick(px) { // a short damped sway in one direction
    if (this.reduced || px <= this.shake) return;
    this.shake = px; this.shakeT = 0; this.shakeAng = Math.random() * Math.PI * 2;
  },
  shakeOffset(view) {
    if (!this.shake) return [0, 0];
    const v = Math.sin(this.shakeT * 0.09) * this.shake, s = view.w / 480;
    return [Math.round(Math.cos(this.shakeAng) * v * s), Math.round(Math.sin(this.shakeAng) * v * 0.7 * s)];
  },
  busy() { return this.parts.length || this.rings.length || this.glows.length || this.slashes.length || this.bursts.length || this.hurt > 0 || this.shake > 0; },
  update(dt) {
    const f = Math.min(dt / 16.7, 3);
    for (const p of this.parts) { p.x += p.vx * f; p.y += p.vy * f; p.vy += 0.08 * f; p.vx *= 0.96; p.life -= p.decay * f; }
    for (const r of this.rings) { r.r += r.vr * f; r.vr *= 0.93; r.life -= r.decay * f; }
    for (const g of this.glows) g.life -= g.decay * f;
    for (const sl of this.slashes) sl.life -= sl.decay * f;
    for (const b of this.bursts) b.life -= b.decay * f;
    this.parts = this.parts.filter((p) => p.life > 0);
    this.rings = this.rings.filter((r) => r.life > 0);
    this.glows = this.glows.filter((g) => g.life > 0);
    this.slashes = this.slashes.filter((sl) => sl.life > 0);
    this.bursts = this.bursts.filter((b) => b.life > 0);
    this.hurt = Math.max(0, this.hurt - 0.035 * f);
    this.shakeT += dt;
    this.shake = this.shake < 0.15 ? 0 : this.shake * Math.pow(0.84, f);
  },
  // called by the page's renderer after the game picture, f = the in-between fraction shown (256 = last frame)
  frame(c, view, f) {
    const now = performance.now(), dt = this.t ? Math.min(now - this.t, 100) : 16.7;
    this.t = now;
    if (!this.busy()) return;
    this.update(dt);
    const M = window.DWInternals.M, k = Math.min(f, 256) / 256;
    const cx = M.camera(0) + (M.camera(2) - M.camera(0)) * k, cy = M.camera(1) + (M.camera(3) - M.camera(1)) * k;
    const sx = view.w / 480, sy = view.h / 320;
    c.save();
    c.beginPath(); c.rect(view.x, view.y, view.w, view.h); c.clip();
    const dot = (x, y, size) => c.fillRect(view.x + Math.round(x - cx - size / 2) * sx, view.y + Math.round(y - cy - size / 2) * sy, size * sx, size * sy);
    const line = (x0, y0, x1, y1, size) => {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let i = 0; i <= n; i++) dot(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, size);
    };
    if (this.hurt > 0) { // red edges
      const W = view.w, H = view.h, mx = view.x + W / 2, my = view.y + H / 2;
      const g = c.createRadialGradient(mx, my, Math.min(W, H) * 0.35, mx, my, Math.max(W, H) * 0.62);
      g.addColorStop(0, 'rgba(200,0,0,0)');
      g.addColorStop(1, `rgba(200,0,0,${0.45 * this.hurt})`);
      c.fillStyle = g;
      c.fillRect(view.x, view.y, W, H);
    }
    c.globalCompositeOperation = 'lighter';
    for (const g of this.glows) {
      const r = g.r * sx * (1.2 - g.life * 0.4), gx = view.x + (g.x - cx) * sx, gy = view.y + (g.y - cy) * sy;
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
    c.restore();
  },
};

// events from the core: 10 = a damage number appears (who | critical << 8 | the monster's feet y << 16,
// damage, x | y << 16 in map pixels); the blow lands between the number and the feet
window.coreEvent = function coreEvent(kind, a, b, c) {
  if (kind !== 10) return;
  const x = (c << 16) >> 16, y = c >> 16, feet = a >> 16;
  if ((a & 255) === 1) Fx.hit(x, feet > y ? Math.round((y + 10 + feet) / 2) : y + 14, b, (a >> 8) & 1);
  else if ((a & 255) === 2 && b > 0) Fx.hurtHero();
};

// ------------------------------------------------------------------ saves from /darkworld/
// The site's other Dark World page keeps its saves in IndexedDB 'darkworld-player', store 'files', keyed by the
// game's full file path. The same origin can read them (in the same browser or home screen app): they are
// only read, never changed, and the database is never created here. Its export file (darkworld-save-….json,
// 설정 → 내보내기) carries the same files, for a phone where the two pages keep separate storage.
window.OldSaves = {
  PREFIX: '/data/data/com.gamedoli.DarkWorldGoogle/',
  pick(files) {
    const out = {};
    for (const [k, v] of Object.entries(files)) {
      const n = k.startsWith(this.PREFIX) ? k.slice(this.PREFIX.length) : k;
      if (n && !n.includes('/') && n.endsWith('.sav')) out[n] = v instanceof Uint8Array ? v : new Uint8Array(v);
    }
    return out['_characterInfo.sav'] ? out : null;
  },
  async read() {
    try {
      if (indexedDB.databases && !(await indexedDB.databases()).some((d) => d.name === 'darkworld-player')) return null;
      const db = await new Promise((res) => {
        const r = indexedDB.open('darkworld-player');
        r.onupgradeneeded = () => r.transaction.abort(); // it was not there: leave it so
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
      });
      if (!db) return null;
      if (!db.objectStoreNames.contains('files')) { db.close(); return null; }
      const files = await new Promise((res) => {
        const out = {}, c = db.transaction('files', 'readonly').objectStore('files').openCursor();
        c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } else res(out); };
        c.onerror = () => res({});
      });
      db.close();
      return this.pick(files);
    } catch (e) { return null; }
  },
  fromJson(text) {
    const d = JSON.parse(text);
    if (!d || d.game !== 'darkworld' || !d.files) return null;
    const f = {};
    for (const [k, b64] of Object.entries(d.files)) f[k] = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    return this.pick(f);
  },
};

// ------------------------------------------------------------------ the game's own touch buttons
// The 1.57 build changed the game's button pictures (res/UI_Touch.GMF, res/touch.GBM) for its skins. The
// original two files come from the player's own Dark World APK: from /darkworld/'s storage when it is
// reachable (read only), or from an APK (or a zip holding it) the player picks. They are kept with the game data.
window.ClassicArt = {
  NAMES: ['res/UI_Touch.GMF.png', 'res/touch.GBM.png'],
  async load() {
    try {
      const got = await Promise.all(this.NAMES.map((n) => DWDATA.get('classic/' + n)));
      if (got.every((r) => r.ok)) return { gmf: new Uint8Array(await got[0].arrayBuffer()), gbm: new Uint8Array(await got[1].arrayBuffer()) };
      const old = await this.fromOldPage();
      if (old) { await this.keep(old); return old; }
    } catch (e) {}
    return null;
  },
  async keep(a) { await DWDATA.put('classic/' + this.NAMES[0], a.gmf); await DWDATA.put('classic/' + this.NAMES[1], a.gbm); },
  // /darkworld/: IndexedDB 'darkworld-player', store 'game': 'index' (asset name -> [offset, size]) and 'assets'
  async fromOldPage() {
    if (indexedDB.databases && !(await indexedDB.databases()).some((d) => d.name === 'darkworld-player')) return null;
    const db = await new Promise((res) => {
      const r = indexedDB.open('darkworld-player');
      r.onupgradeneeded = () => r.transaction.abort();
      r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
    });
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains('game')) return null;
      const get = (k) => new Promise((res) => { const q = db.transaction('game', 'readonly').objectStore('game').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
      const index = await get('index'), assets = await get('assets');
      if (!index || !assets) return null;
      const part = (n) => { const e = index[n]; return e ? new Uint8Array(assets, e[0], e[1]).slice() : null; };
      const gmf = part(this.NAMES[0]), gbm = part(this.NAMES[1]);
      return gmf && gbm ? { gmf, gbm } : null;
    } finally { db.close(); }
  },
  async fromFile(file) {
    let buf = new Uint8Array(await file.arrayBuffer()), ents = DWDATA.zipEntries(buf);
    if (!ents) throw new Error('APK(zip) 파일이 아니에요');
    const has = (n) => (e) => e.name === n || e.name.endsWith('/' + n);
    if (!ents.some(has(this.NAMES[0]))) { // a zip holding the APK
      const apk = ents.find((e) => /\.apk$/i.test(e.name));
      if (!apk) throw new Error(ents.some((e) => /(^|\/)dw\.pack$/.test(e.name))
        ? '이건 1.57 웹판 압축 파일이에요. 원본 다크월드 APK(또는 원래 버튼 그림 zip)를 골라 주세요.'
        : '다크월드 APK가 아니에요');
      buf = await DWDATA.zipData(buf, apk);
      ents = DWDATA.zipEntries(buf);
    }
    const pick = async (n) => { const e = ents && ents.find(has(n)); return e ? DWDATA.zipData(buf, e) : null; };
    const gmf = await pick(this.NAMES[0]), gbm = await pick(this.NAMES[1]);
    if (!gmf || !gbm) throw new Error('다크월드 APK가 아니에요');
    const a = { gmf, gbm };
    await this.keep(a);
    return a;
  },
};

// the DASH button in the style of the game's own attack button, laid into the game frame so it is scaled with it
// (xBR or plain pixels) and keeps its pixel edges. Built pixel by pixel with the attack button's recipe, measured
// from the game's frames: a see-through black disc, a white ring two pixels in from its edge, a glossy upper half
// and, in place of the attack button's inner ring, « drawn like that ring (light over the gloss, grey below it).
// Held, it glows yellow-green around the ring as the game's buttons do under a finger.
window.ClassicDash = {
  sprites: [],
  sprite(pressed) {
    if (this.sprites[pressed]) return this.sprites[pressed];
    const R = 18.6, RING = 16.3, GLOSS = 14.2, h = Math.ceil(RING + 3.5), n = 2 * h + 1;
    // «: two chevrons pointing left, their strokes two pixels wide
    const segs = [];
    for (const ax of [-5.5, 0.5]) for (const sy of [-1, 1]) segs.push([ax, 0, ax + 5, sy * 5.5]);
    const seg = (x, y, [x0, y0, x1, y1]) => {
      const dx = x1 - x0, dy = y1 - y0, t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(x - x0 - t * dx, y - y0 - t * dy);
    };
    const out = new Float32Array(n * n * 4), S = 4;
    for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
      let disc = 0, gloss = 0, mark = 0, ring = 0, glow = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        const x = px - h + (i + 0.5) / S - 0.5, y = py - h + (j + 0.5) / S - 0.5, d = Math.hypot(x, y);
        if (d < R) disc++;
        if (d < GLOSS && y < 1.5) gloss++;
        if (segs.some((g) => seg(x, y, g) < 1)) mark++;
        if (Math.abs(d - RING) < 0.6) ring++;
        glow += Math.max(0, 1 - Math.abs(d - RING - 0.5) / 2.5);
      }
      const k = S * S;
      if (!disc && !(pressed && glow)) continue;
      let a = 0.424 * disc / k, c = [0, 0, 0]; // black, see-through
      const over = (p, col) => {
        const na = a + p * (1 - a);
        c = c.map((v, ch) => (na ? (v * a * (1 - p) + col[ch] * p) / na : 0));
        a = na;
      };
      const white = [255, 255, 255];
      over(0.352 * gloss / k, white);
      over(0.352 * mark / k, white);
      over(0.9 * ring / k, white);
      if (pressed) over(0.55 * glow / k, [200, 235, 40]);
      out.set([c[0], c[1], c[2], a], (py * n + px) * 4);
    }
    return (this.sprites[pressed] = { n, h, px: out });
  },
  // over the RGBA frame (480 wide) at heap offset p, centred on the game point (x, y)
  into(heap, p, [x, y], pressed) {
    const { n, h, px } = this.sprite(pressed ? 1 : 0);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const s = (j * n + i) * 4, a = px[s + 3], gx = x - h + i, gy = y - h + j;
      if (!a || gx < 0 || gx >= 480 || gy < 0 || gy >= 320) continue;
      const o = p + (gy * 480 + gx) * 4;
      for (let ch = 0; ch < 3; ch++) heap[o + ch] = heap[o + ch] * (1 - a) + px[s + ch] * a;
    }
  },
};
