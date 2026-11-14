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

const { Hl3DamageNumbers } = load("hl3_numbers", { require: () => load("hl3") });

const HERO_AGE = 0x01503cc2, MONSTERS = 0x01503ab0 + 0x9c94, TABLE = 0x40000000;
const MONSTER_AGE = TABLE + 344 + 0xac; // the second monster

/** 영웅서기3 on the field with two monsters and no damage numbers up. */
function field() {
  const bytes = new Map();
  const write = (address, value, width = 2) => {
    for (let i = 0; i < width; i++) bytes.set(address + i, (value >>> (8 * i)) & 255);
  };
  const read = (address, width = 2) => {
    let n = 0;
    for (let i = 0; i < width; i++) n |= (bytes.get(address + i) ?? 0) << (8 * i);
    return n >>> 0;
  };
  write(0x38620, 0x307eb500, 4); write(0x17080, 0xb0a8b5f0, 4);
  write(0x01503b00, 4, 4); write(MONSTERS, TABLE, 4); write(MONSTERS + 4, 2);
  for (const age of [HERO_AGE, TABLE + 0xac, MONSTER_AGE]) write(age, -1);
  const cheats = { read: (address, width) => read(address, width), write: (address, width, _, value) => write(address, value, width) };
  const age = address => (read(address) << 16) >> 16;
  /** A game frame: every number up gets one older, and goes after age 4. */
  const frame = () => { for (const a of [HERO_AGE, TABLE + 0xac, MONSTER_AGE]) if (age(a) >= 0) write(a, age(a) < 4 ? age(a) + 1 : -1); };
  return { numbers: new Hl3DamageNumbers(), cheats, write, age, frame };
}

test("영웅서기3 damage numbers step in real time and a new hit starts over", () => {
  const { numbers, cheats, write, age, frame } = field();
  write(MONSTER_AGE - 2, 31); write(MONSTER_AGE, 0); // hit for 31
  let now = 0;
  const shown = [];
  for (let i = 0; i < 30; i++) {
    numbers.sample(cheats, now);
    frame();
    shown.push(age(MONSTER_AGE));
    now += 33;
  }
  // The rising steps take 140 ms each instead of a frame, the fading step goes at the game's own pace.
  assert.deepEqual(shown.slice(0, 16), [1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, -1, -1]);
  assert.equal(age(HERO_AGE), -1); // nothing up stays untouched

  write(HERO_AGE, 0); // the hero is hit: that number keeps the game's own pace
  numbers.sample(cheats, now); frame();
  numbers.sample(cheats, now + 33); frame();
  assert.equal(age(HERO_AGE), 2);

  write(MONSTER_AGE - 2, 31); write(MONSTER_AGE, 0);
  numbers.sample(cheats, now); frame(); now += 33;
  numbers.sample(cheats, now); frame(); now += 33;
  write(MONSTER_AGE, 0); // hit again for the same damage while the first is held
  numbers.sample(cheats, now); frame();
  assert.equal(age(MONSTER_AGE), 1);
});

test("영웅서기3 damage numbers are left alone off the field", () => {
  const { numbers, cheats, write, age } = field();
  write(0x01503b00, 5, 4); write(HERO_AGE, 3);
  numbers.sample(cheats, 1000);
  assert.equal(age(HERO_AGE), 3);
});
