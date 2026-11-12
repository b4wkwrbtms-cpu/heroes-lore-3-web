const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

function load(name, cache = new Map()) {
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const source = fs.readFileSync(path.join(__dirname, "../src/ts", name + ".ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, { exports, require: dep => load(dep.replace(/^\.\//, ""), cache) });
  return exports;
}

const zero = load("zero");
const stick = load("stick");
const BINARY = { 0x00101000: 0x0009212c, 0x00140000: 0x99001c22, 0x00180000: 0x1c396818 };
const memory = state => ({ read: address => address === zero.ZERO.STATE ? state : BINARY[address] ?? 0 });

test("the stick keeps straight walking wide and needs a clear push for a diagonal", () => {
  const names = octant => stick.OCTANT_DIRECTIONS[octant].join("+");
  assert.equal(names(stick.pickOctant(0)), "RIGHT");
  assert.equal(names(stick.pickOctant(25)), "RIGHT");
  assert.equal(names(stick.pickOctant(30)), "DOWN+RIGHT");
  assert.equal(names(stick.pickOctant(315)), "UP+RIGHT");
  assert.equal(names(stick.pickOctant(250)), "UP");
  assert.equal(names(stick.pickOctant(200)), "LEFT");
  // A held sector survives small wobbles across its edge.
  assert.equal(names(stick.pickOctant(20, 1)), "DOWN+RIGHT");
  assert.equal(names(stick.pickOctant(15, 1)), "RIGHT");
  assert.equal(names(stick.pickOctant(34, 0)), "RIGHT");
  assert.equal(names(stick.pickOctant(36, 0)), "DOWN+RIGHT");
  // Cursor windows: straight directions only, with the same stickiness.
  assert.equal(names(stick.pickStraight(40)), "RIGHT");
  assert.equal(names(stick.pickStraight(50)), "DOWN");
  assert.equal(names(stick.pickStraight(50, 0)), "RIGHT");
  assert.equal(names(stick.pickStraight(60, 0)), "DOWN");
  assert.equal(names(stick.pickStraight(44, 1)), "RIGHT");
  assert.equal(names(stick.pickStraight(350)), "RIGHT");
});

test("cursor windows are read from the supported binary only", () => {
  assert.equal(zero.inZeroWindow(memory(zero.ZERO.FIELD)), false);
  for (const state of [zero.ZERO.TALK, zero.ZERO.MENU, zero.ZERO.MAP]) assert.equal(zero.inZeroWindow(memory(state)), true);
  assert.equal(zero.inZeroWindow({ read: address => (address === zero.ZERO.STATE ? zero.ZERO.MENU : 0) }), false);
  assert.equal(zero.inZeroWindow({ read: () => { throw Error("unmapped"); } }), false);
  assert.equal(zero.inZeroWindow(undefined), false);
  assert.equal(zero.readZeroState(memory(7)), 7);
});

/** A 240×320 frame of the given windows, painted from their signatures over a plain field. */
const paint = (...screens) => {
  const data = new Uint8Array(240 * 320 * 4).fill(90);
  for (const screen of screens) {
    const { box: [x0, y0, x1, y1], step: [sx, sy], palette, pixels } = zero.ZERO_SCREENS[screen];
    let index = 0;
    for (let y = y0; y < y1; y += sy) {
      for (let x = x0; x < x1; x += sx) {
        const color = palette[parseInt(pixels[index++], 16)], offset = (y * 240 + x) * 4;
        data[offset] = (color >> 11) << 3; data[offset + 1] = ((color >> 5) & 63) << 2; data[offset + 2] = (color & 31) << 3;
      }
    }
  }
  return { width: 240, height: 320, data };
};

/** The game's save flow as windows that follow key presses; `broken` names a step whose window never appears. */
const fakeGame = ({ state = zero.ZERO.FIELD, start = [], broken } = {}) => {
  let windows = start;
  const pressed = [];
  const next = {
    "|CLR": ["menu"], "menu|7": ["system"], "system|OK": ["system", "prompt"], "system,prompt|OK": ["system", "saved"],
    "system,saved|OK": ["system"], "system|CLR": ["menu"], "menu|CLR": [],
  };
  return {
    pressed,
    host: {
      async press(key) {
        pressed.push(key);
        const after = next[`${windows.join(",")}|${key}`];
        if (after && after.join(",") !== broken) windows = after;
      },
      frame: () => paint(...windows),
      sleep: async () => {},
      alive: () => true,
      state: () => (windows.length ? zero.ZERO.MENU : state),
    },
  };
};

test("the save walks the game's own menu and backs out to the field", async () => {
  const game = fakeGame();
  assert.equal(await zero.saveZero(game.host), "saved");
  assert.deepEqual(game.pressed, ["CLR", "7", "OK", "OK", "OK", "CLR", "CLR"]);
});

test("the save presses nothing outside the field and stops before 7 or OK can land elsewhere", async () => {
  for (const state of [zero.ZERO.TALK, zero.ZERO.MENU, zero.ZERO.MAP]) {
    const game = fakeGame({ state });
    assert.equal(await zero.saveZero(game.host), "not-field");
    assert.deepEqual(game.pressed, []);
  }
  const fromMenu = fakeGame({ state: undefined, start: ["menu"] });
  assert.equal(await zero.saveZero(fromMenu.host), "not-field");
  assert.deepEqual(fromMenu.pressed, []);
  // CLR did not bring up the menu (a conversation took it): nothing more is pressed.
  const noMenu = fakeGame({ broken: "menu" });
  assert.equal(await zero.saveZero(noMenu.host), "not-field");
  assert.deepEqual(noMenu.pressed, ["CLR"]);
  // 7 did not open 시스템: close the menu instead of pressing OK.
  const noSystem = fakeGame({ broken: "system" });
  assert.equal(await zero.saveZero(noSystem.host), "failed");
  assert.deepEqual(noSystem.pressed, ["CLR", "7", "CLR"]);
  const unreadable = fakeGame();
  unreadable.host.frame = () => undefined;
  assert.equal(await zero.saveZero(unreadable.host), "unreadable");
  assert.deepEqual(unreadable.pressed, []);
});
