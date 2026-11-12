const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const native = require("./fixtures/hl3-native-hits.json");

function load(name, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../src/ts", name + ".ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, ...globals });
  return exports;
}
const { Hl3HitTracker, cameraOffset } = load("hl3_hits");
const G = 0x01503ab0, TABLE = 0x48000000, MAP = 0x48040000;

function memory(count = 1) {
  const bytes = new Map();
  const write = (address, value, width = 4) => {
    for (let i = 0; i < width; i++) bytes.set(address + i, (value >>> (8 * i)) & 255);
  };
  let reads = 0;
  const api = { read(address, width, bigEndian) {
    assert.equal(bigEndian, false);
    reads++;
    let n = 0;
    for (let i = 0; i < width; i++) n |= (bytes.get(address + i) ?? 0) << (8 * i);
    return n >>> 0;
  } };
  write(G + 0x50, 4); write(0x0150db48, 3);
  write(0x38620, 0x307eb500); write(0x17080, 0xb0a8b5f0);
  write(G + 0x9c94, TABLE); write(G + 0x9c98, count, 2); write(G + 0x9c68, MAP);
  write(G + 0x44, 240); write(G + 0x48, 320);
  write(MAP + 0x50, 640, 2); write(MAP + 0x52, 640, 2);
  write(G + 0x9e6c, -100); write(G + 0x9e70, -150);
  const record = i => TABLE + i * 344;
  const collider = i => 0x48050000 + i * 80;
  for (let i = 0; i < count; i++) {
    const entity = 0x48020000 + i * 64;
    write(record(i), entity); write(record(i) + 0x7e, 100, 2);
    write(entity + 0x18, collider(i)); write(collider(i) + 4, 5, 2);
    write(collider(i) + 0x10, 210, 2); write(collider(i) + 0x12, 230, 2);
    write(collider(i) + 0x14, 0x0403, 2);
  }
  const apply = (hit, i = 0) => {
    write(record(i) + 0x7e, hit.afterHp, 2);
    Buffer.from(hit.markerHex, "hex").forEach((b, k) => bytes.set(record(i) + 0xaa + k, b));
  };
  return { api, write, apply, record, collider, reads: () => reads };
}

test("observed native hits: damage and killing blow emit once; misses, blocks and zero damage do not", () => {
  for (const hit of native.hits) {
    const m = memory(), tracker = new Hl3HitTracker(), events = [];
    const emit = (...args) => events.push(args);
    m.write(m.record(0) + 0x7e, hit.beforeHp, 2);
    assert.equal(tracker.sample(m.api, emit), false, "first frame only establishes baseline");
    m.apply(hit);
    tracker.sample(m.api, emit);
    tracker.sample(m.api, emit);
    assert.equal(events.length, hit.afterHp < hit.beforeHp ? 1 : 0);
    if (events.length) {
      assert.equal(events[0][0] + tracker.view.x, native.anchor.nativeX);
      assert.equal(events[0][1] + tracker.view.y, native.anchor.nativeY - 12);
      assert.equal(events[0][2], hit.requestedDamage);
    }
  }
  for (const camera of native.cameras) {
    assert.equal(cameraOffset(camera.x, 240, camera.mapWidth), camera.nativeX);
    assert.equal(cameraOffset(camera.y, 320, camera.mapHeight), camera.nativeY);
  }
});

test("consecutive hits work; stale markers, offscreen enemies, menus, reload and a different edition do not flash", () => {
  const m = memory(), tracker = new Hl3HitTracker(), events = [];
  const emit = (...args) => events.push(args);
  tracker.sample(m.api, emit);
  m.apply(native.hits[0]); tracker.sample(m.api, emit);
  m.apply({ ...native.hits[0], afterHp: 40 }); tracker.sample(m.api, emit);
  assert.equal(events.length, 2);
  m.write(m.record(0) + 0xac, 20, 2);
  m.write(m.record(0) + 0x7e, 30, 2); tracker.sample(m.api, emit);
  m.write(m.collider(0) + 0x10, 600, 2);
  m.apply({ ...native.hits[0], afterHp: 20 }); tracker.sample(m.api, emit);
  m.write(G + 0x50, 5); assert.equal(tracker.sample(m.api, emit), false);
  m.write(G + 0x50, 4); m.apply(native.hits[3]); tracker.sample(m.api, emit);
  assert.equal(events.length, 2, "no false flash after reopening a field");
  tracker.reset(); tracker.sample(m.api, emit);
  m.write(G + 0x9c98, 65535, 2); assert.equal(tracker.sample(m.api, emit), false);
  const other = memory(); other.write(0x38620, 0);
  const unsupported = new Hl3HitTracker(); unsupported.sample(other.api, emit);
  other.apply(native.hits[0]); assert.equal(unsupported.sample(other.api, emit), false);
  assert.equal(events.length, 2);
});

function presentation(count = 1) {
  const m = memory(count), callbacks = new Map(), storage = new Map(), ellipses = [];
  let serial = 0, now = 0, resize, disconnects = 0;
  class Element extends EventTarget { hidden = false; value = ""; }
  const ctx = {
    setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
    ellipse: (...args) => ellipses.push(args), stroke() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {},
  };
  const canvas = new Element();
  canvas.setAttribute = () => {};
  canvas.getContext = () => ctx;
  canvas.remove = () => { canvas.removed = true; };
  const setting = new Element(), select = new Element(), fitSelect = new Element(), reduced = new Element();
  reduced.matches = false;
  const document = new Element();
  document.hidden = false;
  document.documentElement = { dataset: { screenFit: "contain" } };
  document.createElement = () => canvas;
  document.getElementById = id => ({ "hit-effects-setting": setting, "hit-effects": select, "screen-fit": fitSelect })[id];
  document.querySelector = () => document.modal ? {} : null;
  const { Hl3Feedback } = load("hl3_feedback", {
    require: () => ({ Hl3HitTracker }), document, AbortController,
    window: { devicePixelRatio: 3, matchMedia: () => reduced },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    ResizeObserver: class {
      constructor(cb) { resize = cb; }
      observe() { resize([{ contentRect: { width: 600, height: 640 } }]); }
      disconnect() { disconnects++; }
    },
    performance: { now: () => now },
    requestAnimationFrame: cb => { const id = ++serial; callbacks.set(id, cb); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
  });
  const feedback = new Hl3Feedback({ width: 240, height: 320, parentElement: { append() {} } });
  const step = time => {
    now = time;
    const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(cb => cb(now));
  };
  return { ...m, feedback, canvas, select, setting, fitSelect, reduced, document, callbacks, step, ellipses, disconnects: () => disconnects };
}

test("presentation uses a bounded pool, DPR cap and animation time; idle has no animation loop", () => {
  const h = presentation(30);
  h.feedback.sample(h.api);
  for (let i = 0; i < 30; i++) h.apply(native.hits[0], i);
  h.feedback.sample(h.api);
  assert.equal(h.callbacks.size, 1);
  assert.equal(h.canvas.width, 1200, "DPR capped at two");
  h.step(16);
  assert.equal(h.ellipses.length, 12, "crowded hits cannot exceed the pool");
  h.step(240);
  assert.equal(h.callbacks.size, 0);
  assert.equal(h.canvas.hidden, true);
  const reads = h.reads();
  h.step(1000);
  assert.equal(h.reads(), reads, "animation never scans guest memory");
  h.feedback.dispose();
});

test("pause, disable, reduced motion and dispose clear effects and resume without a stale hit", () => {
  const h = presentation();
  h.feedback.sample(h.api); h.apply(native.hits[0]); h.feedback.sample(h.api);
  h.feedback.clear();
  assert.equal(h.callbacks.size, 0); assert.equal(h.canvas.hidden, true);
  h.feedback.sample(h.api); assert.equal(h.callbacks.size, 0);
  h.select.value = "off"; h.select.dispatchEvent(new Event("change"));
  const reads = h.reads(); h.feedback.sample(h.api); assert.equal(h.reads(), reads);
  h.select.value = "on"; h.select.dispatchEvent(new Event("change"));
  h.reduced.matches = true; h.feedback.sample(h.api); assert.equal(h.reads(), reads);
  h.reduced.matches = false; h.feedback.sample(h.api);
  h.apply({ ...native.hits[0], afterHp: 40 }); h.feedback.sample(h.api);
  assert.equal(h.callbacks.size, 1);
  h.document.hidden = true; h.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(h.callbacks.size, 0);
  h.feedback.dispose();
  assert.equal(h.canvas.removed, true); assert.equal(h.setting.hidden, true); assert.equal(h.disconnects(), 1);
  h.feedback.sample(h.api); assert.equal(h.callbacks.size, 0);
});
