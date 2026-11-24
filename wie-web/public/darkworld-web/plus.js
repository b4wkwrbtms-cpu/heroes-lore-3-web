// This site's additions to the 1.57 web build: the iPhone layout (the frame turned in portrait, kept clear of
// the camera and the home bar), in-between frames (core.js between) and hit effects drawn over the game.
'use strict';

// ------------------------------------------------------------------ layout
// iOS web apps cannot lock the screen to landscape. In portrait the whole frame is turned 90° clockwise,
// so the phone can be held sideways with the rotation lock on: the frame's left edge is then the side of
// the camera and the status bar, its right edge the side of the home bar, and the game stays clear of both.
window.Layout = {
  rotated: false, cw: 0, ch: 0, ox: 0,
  insets() {
    const cs = getComputedStyle(document.getElementById('probe'));
    return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  },
  apply() {
    const vw = window.innerWidth, vh = window.innerHeight, ins = this.insets();
    const rotated = vh > vw, fw = rotated ? vh : vw, fh = rotated ? vw : vh;
    let l, r;
    if (rotated) { l = ins.t; r = ins.b; }
    else {
      // the camera (Dynamic Island) side, from the screen angle: 90 = turned counter-clockwise, camera on the left
      const a = typeof screen.orientation?.angle === 'number' ? screen.orientation.angle : window.orientation;
      const inset = Math.max(ins.l, ins.r);
      const camLeft = !(a === 270 || a === -90);
      l = camLeft ? inset : 0; r = camLeft ? 0 : inset;
    }
    const key = [vw, vh, l, r].join();
    if (key === this.key) return;
    this.key = key;
    const frame = document.getElementById('frame');
    frame.style.width = fw + 'px';
    frame.style.height = fh + 'px';
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
