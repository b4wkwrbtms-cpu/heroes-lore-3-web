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

/** Guest memory with a field map, its occupancy grid, monsters and the hero, laid out like v1.0.2 keeps them. */
const fieldMemory = () => {
  const words = new Map();
  const set = (address, value) => words.set(address, value >>> 0);
  let next = 0x48000000;
  const object = (cls, fields = {}) => {
    const handle = next, data = next + 0x02000000;
    next += 0x1000;
    set(handle, data); set(handle + 4, cls);
    for (const [offset, value] of Object.entries(fields)) set(data + Number(offset), value);
    return { handle, data };
  };
  const array = (values) => {
    const { handle, data } = object(0x00490000);
    set(data, 0x2a80); set(data + 4, values.length);
    values.forEach((value, i) => set(data + 8 + i * 4, value));
    return { handle, data };
  };
  for (const [address, word] of Object.entries(BINARY)) set(Number(address), word);
  set(zero.ZERO.STATE, zero.ZERO.FIELD);
  const field = load("zero_hits").ZERO_FIELD;
  const monster = (x, y, hp, max) => object(field.MONSTER_CLASS, { [field.X]: x, [field.Y]: y, [field.MAX_HP]: max, [field.HP]: hp });
  const placeMap = (width, height, cells) => {
    const rows = [];
    for (let row = 0; row < height; row++) rows.push(array(Array.from({ length: width }, (_, column) => cells[`${column},${row}`]?.handle ?? 0)).handle);
    const grid = array(rows);
    const map = object(0x001bc9ec, { [field.GRID]: grid.handle, [field.MAP_WIDTH]: width * 16, [field.MAP_HEIGHT]: height * 16 });
    set(field.MAP, map.handle);
    return map;
  };
  const stats = array([140, 105]), limits = array([140, 105]);
  const hero = object(0x001bca14, { [field.HERO_STATS]: stats.handle, [field.HERO_LIMITS]: limits.handle });
  set(field.HERO, hero.handle);
  const api = {
    read: address => words.get(address) ?? 0,
    dump: (address, size) => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 4) new DataView(bytes.buffer).setUint32(i, words.get(address + i) ?? 0, true);
      return bytes;
    },
  };
  return { api, set, monster, placeMap, heroHp: hp => set(stats.data + 8, hp), field };
};

test("hits are read from monsters that lose HP on the field, and the hero's lost HP from its stats", () => {
  const { ZeroHitTracker } = load("zero_hits");
  const memory = fieldMemory();
  const wolf = memory.monster(160, 96, 72, 92), soldier = memory.monster(144, 80, 112, 112);
  memory.placeMap(20, 25, { "10,6": wolf, "9,5": soldier });
  memory.set(memory.field.CAMERA_X, -50);
  memory.set(memory.field.CAMERA_Y, 33);
  const tracker = new ZeroHitTracker(), hits = [], hurts = [];
  const sample = () => tracker.sample(memory.api, hit => hits.push(hit), share => hurts.push(share));
  assert.equal(sample(), false, "a new map is only a baseline");
  assert.deepEqual(hits, []);
  // The renderer keeps the camera on the map: an unclamped 33 draws at 0.
  assert.deepEqual({ ...tracker.view }, { x: -50, y: 0, width: 240, height: 320 });
  memory.set(wolf.data + memory.field.HP, 41);
  memory.heroHp(126);
  assert.equal(sample(), true);
  assert.deepEqual(hits.map(hit => ({ ...hit })), [{ x: 160, y: 96, damage: 31, share: 31 / 92, killed: false }]);
  assert.deepEqual(hurts, [14 / 140]);
  memory.set(wolf.data + memory.field.HP, 0);
  sample();
  assert.equal(hits[1].killed, true);
  // Healing and an unchanged monster are not hits.
  memory.heroHp(140);
  sample();
  assert.equal(hits.length, 2);
  assert.equal(hurts.length, 1);
  // A new map (with different monsters' HP) starts over without effects.
  const other = memory.monster(32, 32, 10, 50);
  memory.placeMap(30, 40, { "2,2": other });
  memory.set(soldier.data + memory.field.HP, 1);
  assert.equal(sample(), false);
  assert.equal(hits.length, 2);
});

test("the hit tracker stays silent off the field, on broken pointers and on another build", () => {
  const { ZeroHitTracker, clampCamera } = load("zero_hits");
  const memory = fieldMemory();
  const wolf = memory.monster(160, 96, 72, 92);
  memory.placeMap(20, 25, { "10,6": wolf });
  const tracker = new ZeroHitTracker(), hits = [];
  const sample = () => tracker.sample(memory.api, hit => hits.push(hit), () => {});
  sample();
  memory.set(zero.ZERO.STATE, zero.ZERO.MENU);
  memory.set(wolf.data + memory.field.HP, 10);
  assert.equal(sample(), false);
  memory.set(zero.ZERO.STATE, zero.ZERO.FIELD);
  assert.equal(sample(), false, "back from the menu is a new baseline");
  assert.deepEqual(hits, []);
  memory.set(memory.field.MAP, 0x12345678);
  assert.equal(sample(), false);
  const otherBuild = new ZeroHitTracker();
  assert.equal(otherBuild.sample({ ...memory.api, read: address => (address === 0x00101000 ? 0 : memory.api.read(address)) }, () => hits.push(1), () => {}), false);
  assert.deepEqual(hits, []);
  // Maps smaller than the 240×288 field are centred.
  assert.equal(clampCamera(-40, 288, 160), 64);
  assert.equal(clampCamera(-400, 288, 640), -352);
});

test("the new-game style screen also offers 검총사 and 정령사, writing only its count and the two flags", () => {
  const styles = load("zero_styles");
  const S = styles.ZERO_STYLES;
  const bytes = new Map();
  const put = (address, value) => { for (let i = 0; i < 4; i++) bytes.set(address + i, (value >>> (i * 8)) & 0xff); };
  const api = {
    read: address => [0, 1, 2, 3].reduce((value, i) => value | ((bytes.get(address + i) ?? 0) << (i * 8)), 0) >>> 0,
    dump: (address, size) => Uint8Array.from({ length: size }, (_, i) => bytes.get(address + i) ?? 0),
    write: (address, width, bigEndian, value) => { assert.equal(width, 4); put(address, value); },
    writeBytes: (address, data) => data.forEach((value, i) => bytes.set(address + i, value)),
  };
  for (const [address, word] of Object.entries(BINARY)) put(Number(address), word);
  put(zero.ZERO.STATE, S.TITLE);
  const screen = 0x4a858980, flagsHandle = 0x484354a0, flags = 0x48845040;
  put(S.HANDLES + 0x400, screen); put(S.HANDLES + 0x404, S.SCREEN_CLASS);
  put(screen + S.SELECTED, 0); put(screen + S.COUNT, 4); put(screen + S.OPEN, flagsHandle);
  put(flagsHandle, flags); put(flags, 0x1e00); put(flags + 4, 6);
  [1, 1, 1, 1, 0, 0].forEach((flag, i) => bytes.set(flags + 8 + i, flag));
  bytes.set(flags + 14, 0xaa); bytes.set(flags + 16, 0xbb); // whatever follows the array must stay as it is
  const before = new Map(bytes);
  assert.equal(styles.openHiddenStyles(api), true);
  assert.equal(api.read(screen + S.COUNT), 6);
  assert.deepEqual(Array.from(api.dump(flags + 8, 6)), [1, 1, 1, 1, 1, 1]);
  const changed = [...bytes].filter(([address, value]) => before.get(address) !== value).map(([address]) => address - flags);
  assert.deepEqual(changed.filter(offset => offset >= 0 && offset < 32), [12, 13], "only the two hidden flags change in the array");
  assert.equal(bytes.get(flags + 14), 0xaa); assert.equal(bytes.get(flags + 16), 0xbb);
  // Off the title screens, on another build or on a different object of that class nothing is written.
  put(screen + S.COUNT, 4);
  put(zero.ZERO.STATE, zero.ZERO.FIELD);
  assert.equal(styles.openHiddenStyles(api), false);
  assert.equal(api.read(screen + S.COUNT), 4);
  put(zero.ZERO.STATE, S.TITLE);
  bytes.set(flags + 8, 0);
  assert.equal(styles.openHiddenStyles(api), false);
  assert.equal(api.read(screen + S.COUNT), 4);
  bytes.set(flags + 8, 1);
  put(0x00101000, 0);
  assert.equal(styles.openHiddenStyles(api), false);
  assert.equal(api.read(screen + S.COUNT), 4);
});

test("a 정령사's menu opens the spirit entry; other styles, other screens and other builds keep the game's own check", () => {
  const styles = load("zero_styles");
  const P = styles.ZERO_SPIRIT;
  const words = new Map(Object.entries(BINARY).map(([address, word]) => [Number(address), word]));
  const writes = [];
  const api = {
    read: address => words.get(address) ?? 0,
    write: (address, width, bigEndian, value) => { writes.push([address, width, bigEndian, value]); words.set(address, value); },
  };
  words.set(zero.ZERO.STATE, zero.ZERO.MENU);
  words.set(P.JOB, P.SPIRITUALIST);
  assert.equal(styles.openSpirit(api), true);
  assert.deepEqual(writes, [[P.OPEN, 4, false, 1]]);
  assert.equal(styles.openSpirit(api), true);
  assert.equal(writes.length, 1, "an open entry is not written again");
  words.set(P.OPEN, 0);
  for (const [address, value] of [[P.JOB, 0], [zero.ZERO.STATE, zero.ZERO.FIELD], [0x00101000, 0]]) {
    const previous = words.get(address);
    words.set(address, value);
    assert.equal(styles.openSpirit(api), false);
    words.set(address, previous);
  }
  assert.equal(writes.length, 1);
  assert.equal(words.get(P.OPEN), 0);
});
