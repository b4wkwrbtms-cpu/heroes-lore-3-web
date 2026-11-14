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

const { Hl3MagicCircles } = load("hl3_circles", { require: () => load("hl3") });

const STATE = 0x01503ab0, SETS = 0x40000000, ANIMATIONS = 0x40010000, BASE = 0x40020000, RECORD = BASE + 0x100;

/** 영웅서기3 on the field: a hero whose frame has a ground circle, two rising copies, a see-through slash and a hand. */
function field(weapon) {
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
  write(0x01503b00, 4, 4); write(0x01503b59, weapon);
  write(STATE + 0x9c0c, SETS, 4); write(SETS + 0x18, ANIMATIONS, 4); write(SETS + 0x20, BASE, 4);
  write(STATE + 0x9b8d, 2); write(STATE + 0x9b8c, 1); write(STATE + 0x9ba0, 3, 2);
  write(ANIMATIONS + 0x4b8 * 2 + 8 + 4 * 3, 0x100, 4);
  const parts = [
    [0x85, 0, 1, 253, 25, 25, 0, 255, 20], // the circle on the ground
    [0x85, 0, 1, 236, 25, 25, 0, 120, 20], // a copy rising
    [0x7f, 0, 0, 0], // an empty part
    [0x03, 1, 254, 252], // a hand
    [0x84, 6, 3, 222, 35, 20, 45, 180, 16], // a see-through slash
    [0x85, 0, 1, 213, 25, 25, 0, 90, 20], // the highest copy
  ];
  [parts.length, ...parts.flat()].forEach((value, i) => write(RECORD + i, value));
  const cheats = { read: (address, width) => read(address, width), write: (address, width, _, value) => write(address, value, width) };
  const opacities = () => [8, 17, 34, 43].map(offset => read(RECORD + offset));
  return { cheats, opacities };
}

test("영웅서기3 소울마스터's rising magic circles are drawn clearer, once, and nothing else is touched", () => {
  const { cheats, opacities } = field(9);
  const circles = new Hl3MagicCircles();
  circles.sample(cheats);
  assert.deepEqual(opacities(), [255, 230, 180, 200]);
  new Hl3MagicCircles().sample(cheats); // the same record seen again (a new session object) is not raised further
  assert.deepEqual(opacities(), [255, 230, 180, 200]);
});

test("영웅서기3's other classes keep their records", () => {
  const { cheats, opacities } = field(6);
  new Hl3MagicCircles().sample(cheats);
  assert.deepEqual(opacities(), [255, 120, 180, 90]);
});
