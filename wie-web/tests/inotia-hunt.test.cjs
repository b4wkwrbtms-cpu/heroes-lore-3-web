const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const CHAR = 0x171050, STRIDE = 0x424, X = 0x22c, Y = 0x230, TARGET = 0x240, HP = 0x54, STATE = 0x16f600;

// A field with the hero at (0, 0); held walk keys move it one tile per tick unless the tile is blocked.
function field({ monster, blocked = [] }) {
  const words = new Map([[STATE, 2], [CHAR + X, 0], [CHAR + Y, 0], [CHAR + TARGET, 6]]);
  const at = (i, field) => CHAR + i * STRIDE + field;
  words.set(at(6, X), monster.x).set(at(6, Y), monster.y).set(at(6, HP), 10);
  const api = { read: address => words.get(address) ?? 0 };
  let now = 0, tick;
  const window = { setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { tick = undefined; } };
  const load = name => {
    const exports = {};
    const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/ts", name + ".ts"), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(compiled, { exports, window, performance: { now: () => now }, require: () => modules });
    return exports;
  };
  const modules = load("inotia");
  const { InotiaHunt } = load("inotia_hunt");
  const steps = { 2: [0, -1], 8: [0, 1], 4: [-1, 0], 6: [1, 0] };
  const log = [];
  let walking;
  const hunt = new InotiaHunt({
    getCheats: () => api,
    steer: key => { walking = key; log.push(key ?? "-"); },
    strike: () => { log.push("strike"); words.set(at(6, HP), 0); },
    playerSteering: () => false,
    directions: { UP: "2", DOWN: "8", LEFT: "4", RIGHT: "6" },
  });
  const run = (ticks) => {
    for (let i = 0; i < ticks && tick; i++) {
      now += 30;
      tick();
      if (!walking) continue;
      const [dx, dy] = steps[walking];
      const next = [words.get(CHAR + X) + dx, words.get(CHAR + Y) + dy];
      if (blocked.some(([bx, by]) => bx === next[0] && by === next[1])) continue;
      words.set(CHAR + X, next[0]).set(CHAR + Y, next[1]).set(CHAR + TARGET, -1); // walking clears the game's target
    }
  };
  return { hunt, words, log, run, hero: () => [words.get(CHAR + X), words.get(CHAR + Y)], running: () => !!tick };
}

test("a tap walks to the game's target, strikes once next to it and stops; leaving the field stops a hold", () => {
  const tap = field({ monster: { x: 3, y: 1 } });
  tap.hunt.setHeld(true);
  tap.hunt.setHeld(false);
  tap.run(40);
  const [x, y] = tap.hero();
  assert.equal(Math.abs(3 - x) + Math.abs(1 - y), 1);
  assert.equal(tap.log.filter(entry => entry === "strike").length, 1);
  assert.equal(tap.log.at(-1), "strike");
  assert.equal(tap.running(), false);

  const hold = field({ monster: { x: 0, y: 3 } });
  hold.hunt.setHeld(true);
  hold.run(3);
  hold.words.set(STATE, 11); // a dialog opened
  hold.run(1);
  assert.equal(hold.running(), false);
  assert.equal(hold.log.at(-1), "-");
});

test("a blocked approach detours along the other axis, and gives up when that is blocked too", () => {
  const detour = field({ monster: { x: 3, y: 2 }, blocked: [[1, 0]] });
  detour.hunt.setHeld(true);
  detour.run(60);
  assert.ok(detour.log.includes("strike"));
  const [x, y] = detour.hero();
  assert.equal(Math.abs(3 - x) + Math.abs(2 - y), 1);

  const walled = field({ monster: { x: 3, y: 2 }, blocked: [[1, 0], [0, 1]] });
  walled.hunt.setHeld(true);
  walled.hunt.setHeld(false);
  walled.run(60);
  assert.deepEqual(walled.hero(), [0, 0]);
  assert.equal(walled.log.includes("strike"), false);
  assert.equal(walled.running(), false);
});
