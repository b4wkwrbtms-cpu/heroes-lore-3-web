const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

function load(name, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../src/ts", name + ".ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, ...globals });
  return exports;
}

/** Little-endian guest memory with the calls a page makes to it. */
function memory() {
  const bytes = new Map();
  const write = (address, value, width = 4) => {
    for (let i = 0; i < width; i++) bytes.set(address + i, (value >>> (8 * i)) & 255);
  };
  const read = (address, width = 4) => {
    let n = 0;
    for (let i = 0; i < width; i++) n |= (bytes.get(address + i) ?? 0) << (8 * i);
    return n >>> 0;
  };
  const api = {
    read: (address, width, bigEndian) => (assert.equal(bigEndian, false), read(address, width)),
    write: (address, width, bigEndian, value) => (assert.equal(bigEndian, false), write(address, value, width)),
    dump: (address, size) => Uint8Array.from({ length: size }, (_, i) => bytes.get(address + i) ?? 0),
    writeBytes: (address, data) => data.forEach((b, i) => bytes.set(address + i, b)),
  };
  return { api, read, write };
}

const STATE = 0x01503ab0, MAP = 0x48040000, HERO = 0x48050000, NPC = 0x48050100, FRAME = 0x49000000;

/** 영웅서기3 on a 640×640 field map: the hero and one NPC, the camera away from the map's edges. */
function hl3Field() {
  const m = memory();
  m.write(0x38620, 0x307eb500); m.write(0x17080, 0xb0a8b5f0);
  m.write(STATE + 0x50, 4); m.write(STATE + 0xa098, 3, 1); m.write(0x01503aa4, 0x3b841);
  m.write(STATE + 0x44, 240); m.write(STATE + 0x48, 320); m.write(STATE + 0x9c68, MAP);
  m.write(MAP + 0x50, 640, 2); m.write(MAP + 0x52, 640, 2);
  m.write(MAP + 0x8c, HERO); m.write(HERO + 0x40, NPC);
  m.write(STATE + 0x9e6c, -100); m.write(STATE + 0x9e70, -150);
  m.write(HERO + 0x10, 212, 2); m.write(HERO + 0x12, 309, 2);
  m.write(NPC + 0x10, 300, 2); m.write(NPC + 0x12, 280, 2);
  m.write(0x0150ec44, FRAME);
  return m;
}
const { Hl3MotionGame } = load("hl3_motion", {
  require: name => name === "./hl3" ? load("hl3") : name === "./hl3_hits" ? load("hl3_hits") : {},
});

test("영웅서기3: the field's camera and sprites are placed part of the way between two game frames", () => {
  const m = hl3Field(), game = new Hl3MotionGame();
  const prev = game.read(m.api);
  assert.deepEqual([...prev.camera], [-100, -150]);
  assert.deepEqual([...prev.sprites.keys()], [HERO, NPC]);
  assert.equal(game.place(prev, game.read(m.api), 0.5).length, 0, "nothing moved");

  // The hero walks 8 px right and the camera follows; the NPC stays.
  m.write(HERO + 0x10, 220, 2); m.write(STATE + 0x9e6c, -108);
  const cur = game.read(m.api);
  const half = Array.from(game.place(prev, cur, 0.5), w => [w.address, w.width, w.value | 0]);
  assert.deepEqual(half, [[STATE + 0x9e6c, 4, -104], [HERO + 0x10, 2, 216]]);
  // Camera and hero stay in step at every fraction: the hero does not shake against the map.
  for (const frac of [0.2, 0.33, 0.45, 0.67, 0.8]) {
    const [camera, hero] = game.place(prev, cur, frac);
    assert.equal((camera.value | 0) + hero.value, 112);
  }

  // A warp is a jump, not a movement; so is another map.
  m.write(HERO + 0x10, 500, 2);
  assert.deepEqual(Array.from(game.place(prev, game.read(m.api), 0.5), w => w.address), [STATE + 0x9e6c]);
  m.write(STATE + 0x9e6c, -300);
  assert.equal(game.place(prev, game.read(m.api), 0.5).length, 0);
});

test("영웅서기3: the camera is taken as the map shows it, and only the field itself is read", () => {
  const m = hl3Field(), game = new Hl3MotionGame();
  // Beyond the map's edge the picture stands still although the camera value keeps moving.
  m.write(STATE + 0x9e6c, -420);
  const prev = game.read(m.api);
  m.write(STATE + 0x9e6c, -440);
  assert.deepEqual([...prev.camera], [-400, -150]);
  assert.equal(game.place(prev, game.read(m.api), 0.5).length, 0);

  for (const [address, value, width] of [[STATE + 0x50, 5, 4], [STATE + 0xa098, 4, 1], [0x01503aa4, 0x2001, 4], [0x17080, 0, 4]]) {
    const other = hl3Field();
    other.write(address, value, width);
    assert.equal(new Hl3MotionGame().read(other.api), undefined);
  }
});

test("영웅서기3: an in-between drawing runs the field's drawing steps without the camera's own step", () => {
  const m = hl3Field(), game = new Hl3MotionGame(), calls = [];
  const guest = { idle: () => true, call: (address, params) => (calls.push([address, ...params]), address === 0x2ad65 ? 0x0150ec44 : 0) };
  const cur = game.read(m.api);
  game.draw(guest, m.api, cur);
  assert.deepEqual(calls, [[0x17081], [0x16e19], [0x22a5], [0x2ad65], [0x01400484, 0, FRAME, 0, 0, 240, 320]]);
  m.write(STATE + 0x9e38, 1, 1);
  calls.length = 0;
  game.draw(guest, m.api, cur);
  assert.deepEqual(calls.map(c => c[0]), [0x17081, 0x16e19, 0x22a5, 0x54d29, 0x2ad65, 0x01400484]);
  m.write(STATE + 0x9c44, 1, 1);
  calls.length = 0;
  game.draw(guest, m.api, cur);
  assert.equal(calls.some(c => c[0] === 0x54d29), false, "no quick slots under a dialog");

  // The map's drawing notes which sprites were on the screen; the game's targeting must not see an in-between's.
  m.write(HERO + 0x22, 1, 1);
  guest.call = address => (address === 0x17081 && (m.write(HERO + 0x22, 0, 1), m.write(NPC + 0x22, 1, 1)), address === 0x2ad65 ? 0x0150ec44 : 0);
  game.draw(guest, m.api, cur);
  assert.deepEqual([m.read(HERO + 0x22, 1), m.read(NPC + 0x22, 1)], [1, 0]);
});

/** A page with a game canvas; `pictures` lists what was put on the screen: a held game frame or an in-between drawing. */
function player(stored) {
  const pictures = [];
  const canvas = () => {
    const self = { width: 240, height: 320, label: "", getContext: () => ({
      save() {}, restore() {}, setTransform() {},
      drawImage(source) { self.label = source.label; },
    }) };
    return self;
  };
  const screen = canvas();
  const select = { value: "", listeners: [], addEventListener(_type, listener) { this.listeners.push(listener); } };
  const setting = { hidden: true };
  const storage = new Map(stored);
  const window = { localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } };
  const preferences = load("game_preferences", { window });
  const { InBetweenFrames } = load("motion", {
    document: { getElementById: id => id === "motion" ? select : id === "motion-setting" ? setting : null, createElement: canvas },
    performance: { now: () => 0 }, console: { warn() {} }, AbortController,
    require: name => name === "./game_preferences" ? preferences : { presentFrame: () => pictures.push(screen.label) },
  });
  return { InBetweenFrames, screen, pictures, select, setting, storage };
}

/** A game with one thing that moves: the byte at 0x100, drawn as "x=<value>"; drawing also counts at 0x200. */
function mover(m, screen) {
  return {
    scratch: [[0x200, 4]],
    read: api => api.read(0x100, 1, false),
    place: (prev, cur, frac) => prev === cur ? [] : [{ address: 0x100, width: 1, value: Math.round(prev + (cur - prev) * frac) }],
    draw(_guest, api) {
      api.write(0x200, 4, false, api.read(0x200, 4, false) + 1);
      screen.label = "x=" + api.read(0x100, 1, false);
    },
  };
}

test("in-between frames: the picture runs one game frame behind and moves on every display frame", () => {
  const p = player(), m = memory();
  const session = { cheats: m.api, guest: { idle: () => true, call: () => 0 } };
  const motion = new p.InBetweenFrames(session, p.screen, mover(m, p.screen), "PD119037");
  assert.equal(p.setting.hidden, false);
  assert.equal(p.select.value, "smooth");
  // The game paints every third display frame (16 ms apart); x moves 0 → 0 → 30 → 60.
  const gameFrame = (time, x) => {
    m.write(0x100, x, 1);
    p.screen.label = "game x=" + x;
    return session.display(true, time);
  };
  assert.equal(gameFrame(0, 0), false, "the first frame is the game's own");
  assert.equal(gameFrame(48, 0), false, "nothing moved: shown at once");
  assert.equal(gameFrame(96, 30), true);
  assert.equal(session.display(false, 112), true);
  assert.equal(session.display(false, 128), true);
  assert.equal(gameFrame(144, 60), true);
  assert.equal(session.display(false, 160), true);
  assert.equal(session.display(false, 176), true);
  // A late game frame: the last one's own picture is shown rather than a position past it.
  assert.equal(session.display(false, 192), true);
  assert.equal(session.display(false, 208), false, "nothing more to show until the game paints");
  assert.deepEqual(p.pictures, ["game x=0", "x=10", "x=20", "game x=30", "x=40", "x=50", "game x=60"]);
  // The game never sees a drawing: what moved and what drawing changed are back as they were.
  assert.equal(m.read(0x100, 1), 60);
  assert.equal(m.read(0x200), 0);

  motion.dispose();
  assert.equal(session.display, undefined);
  assert.equal(p.setting.hidden, true);
});

test("in-between frames: off with the setting, while the guest is busy, and for good after a failed drawing", () => {
  const p = player([["wie_game_PD119037_motion", "original"]]), m = memory();
  let idle = true;
  const session = { cheats: m.api, guest: { idle: () => idle, call: () => 0 } };
  const game = mover(m, p.screen);
  new p.InBetweenFrames(session, p.screen, game, "PD119037");
  const gameFrame = (time, x) => (m.write(0x100, x, 1), session.display(true, time));
  assert.equal(p.select.value, "original");
  assert.equal(gameFrame(0, 0), false);
  assert.equal(gameFrame(48, 30), false, "original frames only");

  p.select.value = "smooth";
  p.select.listeners.forEach(listener => listener());
  assert.equal(p.storage.get("wie_game_PD119037_motion"), "smooth");
  gameFrame(96, 0);
  assert.equal(gameFrame(144, 30), true);
  idle = false;
  assert.equal(session.display(false, 160), true);
  assert.deepEqual(p.pictures.slice(1), [], "no drawing while the guest is in the middle of its own work");
  idle = true;
  game.draw = () => { throw new Error("guest call failed"); };
  assert.equal(session.display(false, 176), false);
  assert.equal(m.read(0x100, 1), 30, "memory is put back even then");
  assert.equal(gameFrame(192, 60), false, "the game's own frames from here on");
});
