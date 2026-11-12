const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const CHAR = 0x171050, STRIDE = 0x424, EXP = -0x10, LEVEL = 0x18, STATE = 0x16f600, ON_FIELD = 2;

const { expToNextLevel, multiplyExp } = (() => {
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/ts/inotia.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports });
  return exports;
})();

// The hero alone, at `level` with `exp`; `kill` plays the game's own gain and level up.
function party(level, exp) {
  const words = new Map([[STATE, ON_FIELD], [CHAR + LEVEL, level], [CHAR + EXP, exp]]);
  const api = { read: address => words.get(address) ?? 0, write: (address, _width, _bigEndian, value) => words.set(address, value) };
  const watch = [];
  const hero = () => [words.get(CHAR + LEVEL), words.get(CHAR + EXP)];
  const kill = gain => {
    const [lv, ex] = hero();
    const total = ex + gain;
    if (total >= expToNextLevel(lv)) words.set(CHAR + LEVEL, lv + 1).set(CHAR + EXP, total - expToNextLevel(lv));
    else words.set(CHAR + EXP, total);
  };
  return { words, hero, kill, tick: () => multiplyExp(api, watch, 3) };
}

test("the EXP to the next level matches the status screen", () => {
  assert.deepEqual([1, 2, 3, 10, 20, 99].map(expToNextLevel), [470, 1082, 1839, 11333, 38666, 1049103]);
});

test("field gains are tripled; the extra stops one short of a level up and is paid after the game's own", () => {
  const p = party(1, 0);
  p.tick();
  p.kill(54);
  p.tick();
  assert.deepEqual(p.hero(), [1, 162]);

  const full = party(1, 400);
  full.tick();
  full.kill(54);
  full.tick();
  assert.deepEqual(full.hero(), [1, 469]);

  full.kill(54);
  full.tick();
  assert.deepEqual(full.hero(), [2, 53 + 93 + 108]);
});

test("off the field, or across a jump of levels, nothing extra is paid", () => {
  const p = party(3, 100);
  p.tick();
  p.words.set(STATE, 6);
  p.kill(48);
  p.tick();
  assert.deepEqual(p.hero(), [3, 148]);

  p.words.set(STATE, ON_FIELD).set(CHAR + LEVEL, 7).set(CHAR + EXP, 10);
  p.tick();
  assert.deepEqual(p.hero(), [7, 10]);
});
