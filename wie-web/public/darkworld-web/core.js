// The 1.57 web build's page talks to its own runtime through a few functions (createDW's module: dw_tick,
// dw_event, dw_read32 and so on). This gives the page the same functions on top of this site's runtime
// (core.wasm, built from wie-web/dw-core), which adds the native drawing fast paths and the in-between frames.
// Guest addresses: the core maps the library at 0x10000000, as the build's own runtime does.
'use strict';
window.createDW = async function createDW() {
  const THEIRS = 0x10000000, LOAD = 0x10000000, W = 480, H = 320;
  const PREFIX = '/data/data/com.gamedoli.DarkWorldGoogle/';
  const utf = new TextDecoder(), euc = new TextDecoder('euc-kr'), enc = new TextEncoder();
  let ex = null, memory = null, pack = null, index = null, title1 = null;
  let sounds = [], editbox = 0, error = '', scratch = 0, rgba = 0, icons = 0, mid = 0;
  const logs = [];
  const u8 = () => new Uint8Array(memory.buffer);
  const str = (p, n) => utf.decode(new Uint8Array(memory.buffer, p, n));
  const g = (a) => (((a >>> 0) - THEIRS + LOAD) >>> 0) & 0x3ffffff; // a guest address of the page -> the core's
  const guest = () => new DataView(memory.buffer, ex.guest_base());
  const entry = (name) => index && index.get(name);
  // RGB565 -> RGBA (little endian 0xAABBGGRR), as the page draws it
  const lut = new Uint32Array(65536);
  for (let v = 0; v < 65536; v++) {
    const r = v >> 11, gg = (v >> 5) & 63, b = v & 31;
    lut[v] = 0xff000000 | (((b << 3) | (b >> 2)) << 16) | (((gg << 2) | (gg >> 4)) << 8) | ((r << 3) | (r >> 2));
  }
  const env = {
    host_log: (p, n) => { logs.push(euc.decode(new Uint8Array(memory.buffer, p, n).slice())); if (logs.length > 100) logs.shift(); },
    host_now: () => Date.now(),
    host_file_saved: (p, pl, d, n) => {
      const path = str(p, pl);
      if (path.startsWith(PREFIX)) window.DW.onSave(path.slice(PREFIX.length), new Uint8Array(memory.buffer, d, n).slice());
    },
    host_file_deleted: (p, pl) => { const path = str(p, pl); if (path.startsWith(PREFIX)) window.DW.onRemove(path.slice(PREFIX.length)); },
    host_event: (kind, a, b, c) => {
      if (kind === 11) editbox = 1; // the game asks for a number
      else if (M.onEvent) M.onEvent(kind, a, b, c);
      return 0;
    },
    // Native.getResource: the APK's assets/<name>.png, kept in dw.pack under game/
    host_asset: (p, n, dst, cap) => {
      const e = entry('game/' + str(p, n) + '.png');
      if (!e) return -1;
      if (dst) u8().set(pack.subarray(e[0], e[0] + Math.min(cap, e[1])), dst);
      return e[1];
    },
    host_sound: (op, p, n, loop, vol) => {
      if (op === 1) sounds.push('\t' + str(p, n) + '\t' + (loop ? 1 : 0) + '\t' + (vol | 0));
      else sounds.push('X');
    },
  };
  const resp = fetch('core.wasm?v=2');
  const { instance } = await (WebAssembly.instantiateStreaming
    ? WebAssembly.instantiateStreaming(resp, { env })
    : WebAssembly.instantiate(await (await resp).arrayBuffer(), { env }));
  ex = instance.exports;
  memory = ex.memory;
  const cstr = (s) => { const b = enc.encode(s + '\0'); const p = ex.host_alloc(b.length); u8().set(b, p); return p; };
  const reply = (s) => { const b = enc.encode(s + '\0'); if (scratch) ex.host_free(scratch); scratch = ex.host_alloc(b.length); u8().set(b, scratch); return scratch; };
  const toRGBA = (src, dst, n, key) => {
    const s = new Uint16Array(memory.buffer, src, n), d = new Uint32Array(memory.buffer, dst, n);
    if (key === undefined) for (let i = 0; i < n; i++) d[i] = lut[s[i]];
    else for (let i = 0; i < n; i++) { const v = s[i]; d[i] = v === key ? 0 : lut[v]; }
  };
  const M = {
    ex, logs,
    get HEAPU8() { return u8(); },
    UTF8ToString(p) { const m = u8(); let e = p; while (m[e]) e++; return utf.decode(m.subarray(p, e)); },
    stringToNewUTF8: cstr,
    _free: (p) => ex.host_free(p),
    _dw_alloc: (n) => ex.host_alloc(Math.max(1, n)),
    _dw_free: (p) => ex.host_free(p),
    _dw_error: () => reply(error || (ex.is_halted() ? logs.slice(-3).join(' / ') : '')),
    // dw.pack: u32 count, then per file u32 name length, name, u32 offset, u32 size
    // The 1.57 build moves the game's touch buttons inward to make room for its DASH button and larger button
    // skins: SetTouchInfo (which writes each button's place) starts with a jump to code of its own that shifts
    // them. With opts.classicUi the function's first two instructions are put back (push {r4, lr}; sub sp, #8),
    // so the buttons are where the game itself puts them; the build still draws them, at those places. Only
    // when the build's words are there.
    classicUi() {
      const d = guest(), at = 0x233dc;
      if (d.getUint16(at, true) !== 0xf15d || d.getUint16(at + 2, true) !== 0xba10) return false;
      d.setUint16(at, 0xb510, true);
      d.setUint16(at + 2, 0xb082, true);
      return true;
    },
    setPack(bytes, opts = {}) {
      pack = bytes;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      index = new Map();
      let p = 4;
      for (let i = dv.getUint32(0, true); i > 0; i--) {
        const l = dv.getUint32(p, true);
        const name = utf.decode(bytes.subarray(p + 4, p + 4 + l));
        p += 4 + l;
        index.set(name, [dv.getUint32(p, true), dv.getUint32(p + 4, true)]);
        p += 8;
      }
      const so = entry('libDarkWorld.so');
      if (!so) { error = '게임 라이브러리가 없어요'; return 0; }
      const sp = ex.host_alloc(so[1]);
      u8().set(pack.subarray(so[0], so[0] + so[1]), sp);
      const ok = ex.load_library(sp, so[1]) === 0;
      ex.host_free(sp);
      if (!ok) { error = '게임 라이브러리를 불러오지 못했어요'; return 0; }
      M.classic = !!opts.classicUi && M.classicUi();
      M.fastPaths = ex.install_fast_paths();
      const t1 = entry('runner/title1.rgb565');
      if (t1) title1 = new Uint16Array(pack.slice(t1[0], t1[0] + t1[1]).buffer);
      return 1;
    },
    _dw_set_pack(p, n) { return M.setPack(u8().slice(p, p + n)); },
    _dw_add_save(np, p, n) { const path = cstr(PREFIX + M.UTF8ToString(np)); ex.fs_put(path, p, n); ex.host_free(path); },
    _dw_create() {
      if (ex.app_start(W, H) !== 0) { error = '시작하지 못했어요'; return 0; }
      // the title's backgrounds, 480x320 RGB565 in the pack
      for (let i = 0; i < 2; i++) {
        const e = entry('runner/title' + (i + 1) + '.rgb565');
        if (e && e[1] === W * H * 2) u8().set(pack.subarray(e[0], e[0] + e[1]), ex.set_title_bg(i));
      }
      rgba = ex.host_alloc(W * H * 4);
      icons = ex.host_alloc(W * H * 4);
      return 1;
    },
    // one game frame; returns the milliseconds until the next, or -1 when the game stopped
    _dw_tick() {
      ex.interp_tick(0);
      const r = ex.app_tick();
      ex.interp_tick(1);
      return r !== 0 ? -1 : Math.max(16, ex.interval());
    },
    // kind 0: touch (0x17 down, 0x18 up, 0x19 move) at x, y; kind 1: key (2 down, 3 up) with a phone key code
    _dw_event(kind, type, a, b) { ex.app_touch(type, a, kind === 1 ? 0 : b); },
    _dw_take_sounds() { const s = sounds.join('\n'); sounds = []; return reply(s); },
    _dw_take_quantity_request() { const r = editbox; editbox = 0; return r; },
    // the page's messages to the game, as the build's runtime takes them: settings written into the game's
    // memory, or a number for the edit box, passed to Native.charge
    _dw_quantity(v) {
      v >>>= 0;
      const d = guest(), w32 = (a, x) => d.setUint32(g(a), x >>> 0, true), w8 = (a, x) => d.setUint8(g(a), x & 0xff);
      if ((v & ~1) === 0x72000000) return;
      if ((v & 0xfe000000) === 0x70000000) { w32(0x102fffe0, v & 0x1ffffff); return; }
      if (v >>> 24 === 0x6e) {
        w32(0x102d9f00, v & 0x7ff);
        if ((v & 1) && d.getUint32(g(0x1031f000), true) === 0x32333744 && d.getUint32(g(0x1031f00c), true) !== 1) {
          w32(0x1031f008, 1); w32(0x1031f00c, 0); w32(0x1031f014, 1);
        }
        return;
      }
      if (v >>> 24 === 0x6f) { w32(0x102d9f04, v); return; }
      if ((v & ~1) === 0x5c00) { w8(0x102d2f00, v); return; }
      if ((v & ~1) === 0x5d00) { w8(0x102d7f00, v); return; }
      if (v - 0x5b00 <= 2) { w8(0x102c8f00, v); return; }
      if ((v & ~1) === 0x5a00) { w8(0x1012476b, v); return; }
      if (v >= 1 && v <= 99) ex.app_charge(v);
    },
    _dw_read32: (a) => guest().getInt32(g(a), true),
    _dw_write32: (a, v) => guest().setUint32(g(a), v >>> 0, true),
    _dw_host: (a) => ex.guest_base() + g(a),
    _dw_symbol(np) { const r = ex.find_symbol(np); return r ? (r - LOAD + THEIRS) >>> 0 : 0; },
    _dw_frame_rgba() { toRGBA(ex.screen(), rgba, W * H); return rgba; },
    // the HUD the build draws into its own layer at 0x10200000 (RGB565, 0x0101 see-through)
    _dw_icons_rgba() { toRGBA(ex.guest_base() + g(0x10200000), icons, W * H, 0x0101); return icons; },
    // the title screen as the game draws it (to put the HD artwork over it): within 1024 pixels of title1
    _dw_title_match() {
      if (!title1) return 0;
      const s = new Uint16Array(memory.buffer, ex.screen(), W * H);
      let diff = 0;
      for (let i = 0; i < 141600; i++) if (s[i] !== title1[i] && ++diff > 1024) return 0;
      return 1;
    },
    _dw_native_id: () => reply(BigInt.asUintN(64, -4557274149761253931n).toString(16)),
    _dw_take_vibration: () => 0,
    // in-between frame at f/256 from the previous game frame to the last, as RGBA, or 0 when there is none
    between(f) {
      if (!mid) mid = ex.host_alloc(W * H * 2);
      new Uint16Array(memory.buffer, mid, W * H).set(new Uint16Array(memory.buffer, ex.screen(), W * H));
      if (ex.interp_draw(f, mid, W, H) !== 0) return 0;
      toRGBA(mid, rgba, W * H);
      return rgba;
    },
    camera: (k) => ex.interp_camera(k),
  };
  return M;
};
