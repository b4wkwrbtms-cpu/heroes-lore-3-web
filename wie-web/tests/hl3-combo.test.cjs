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

const { Hl3ComboTiming } = load("hl3_combo", { require: () => load("hl3") });

const STEP = 0x01503cd7, RECOVERY = 0x01503cd9, SWING = 0x0150eb58, MAIN_LEVEL = 0x01503c30;

/** 영웅서기3 on the field, the hero one hit (of a main-weapon combo skill at level 1) into a combo. */
function field() {
  const bytes = new Map();
  const write = (address, value, width = 1) => {
    for (let i = 0; i < width; i++) bytes.set(address + i, (value >>> (8 * i)) & 255);
  };
  const read = (address, width = 1) => {
    let n = 0;
    for (let i = 0; i < width; i++) n |= (bytes.get(address + i) ?? 0) << (8 * i);
    return n >>> 0;
  };
  write(0x38620, 0x307eb500, 4); write(0x17080, 0xb0a8b5f0, 4);
  write(0x01503b00, 4, 4); write(0x01503ab0 + 0xa098, 3);
  write(MAIN_LEVEL, 1); write(STEP, 0); write(RECOVERY, 2); write(SWING, 255);
  const cheats = {
    read: (address, width, bigEndian) => (assert.equal(bigEndian, false), read(address, width)),
    write: (address, width, bigEndian, value) => (assert.equal(bigEndian, false), write(address, value, width)),
  };
  return { combo: new Hl3ComboTiming({ cheats }), read, write };
}

test("영웅서기3 combo: an attack press during the recovery count goes to the game as the next hit", () => {
  const f = field();
  f.combo.press("OK");
  assert.equal(f.read(RECOVERY), 0, "cleared, so the game takes the press");
  assert.equal(f.read(STEP), 0, "the hit itself is the game's to change");

  // Only while the game would take the next hit: its own check, combo skill level ≥ current hit.
  for (const [address, value, width] of [
    [STEP, 2, 1], [STEP, 255, 1], [RECOVERY, 255, 1], [MAIN_LEVEL, 255, 1],
    [0x01503b00, 5, 4], [0x01503ab0 + 0xa098, 4, 1], [0x17080, 0, 4],
  ]) {
    const other = field();
    other.write(address, value, width);
    other.combo.press("OK");
    assert.equal(other.read(RECOVERY), address === RECOVERY ? 255 : 2, `unchanged with ${address.toString(16)} = ${value}`);
  }
  for (const key of ["2", "LEFT", "1", "#"]) {
    const other = field();
    other.combo.press(key);
    assert.equal(other.read(RECOVERY), 2, `${key} is no attack`);
  }
});

test("영웅서기3 combo: the recovery count lasts for the real-time window of each hit, not for game frames", () => {
  const f = field();
  f.write(SWING, 17);
  f.combo.sample(1000);
  f.write(RECOVERY, 1);
  f.combo.sample(1100);
  assert.equal(f.read(RECOVERY), 3, "kept while the hit is young");
  f.write(RECOVERY, 4);
  f.combo.sample(1150);
  assert.equal(f.read(RECOVERY), 4, "a count still running is the game's");

  // The window is over: the count runs out and the game ends the combo.
  f.write(SWING, 5); f.write(RECOVERY, 1);
  f.combo.sample(1300);
  assert.equal(f.read(RECOVERY), 1);

  // A new hit (its motion starts again) opens a new window.
  f.write(SWING, 17);
  f.combo.sample(1400);
  f.write(RECOVERY, 2);
  f.combo.sample(1500);
  assert.equal(f.read(RECOVERY), 3);

  // Last hit of the combo: the game takes no more, so nothing is kept.
  f.write(STEP, 2); f.write(RECOVERY, 1);
  f.combo.sample(1550);
  assert.equal(f.read(RECOVERY), 1);
});

test("영웅서기3 combo: a skill key clears only a recovery count that is being kept", () => {
  const f = field();
  f.write(SWING, 17); f.write(RECOVERY, 4);
  f.combo.sample(0);
  f.combo.press("1");
  assert.equal(f.read(RECOVERY), 4, "the game's own count refuses skills as always");
  f.write(RECOVERY, 1);
  f.combo.sample(100);
  assert.equal(f.read(RECOVERY), 3);
  f.combo.press("3");
  assert.equal(f.read(RECOVERY), 0, "kept past its own end: the skill goes out");
});
