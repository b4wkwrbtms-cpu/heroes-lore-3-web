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

const { HL4_FIELD: F, Hl4HitTracker } = load("hl4_hits");

/** The supported build's literals, the hero's record and a field list in drawing order. */
const fieldMemory = () => {
  const words = new Map([[0x4e328, F.HERO], [0x4c34, 0x0151b3e8], [F.MAP_WIDTH, 800], [F.MAP_HEIGHT, 800]]);
  const set = (address, value) => words.set(address, value >>> 0);
  const place = (address, kind, x, y, hp = 0, max = 0) => {
    set(address + F.SELF, address); set(address + F.KIND, kind);
    set(address + F.X, x); set(address + F.Y, y); set(address + F.HP, hp); set(address + F.MAX_HP, max);
    return address;
  };
  const link = records => records.forEach((record, i) => {
    set(record + F.PREVIOUS, records[i - 1] ?? 0);
    set(record + F.NEXT, records[i + 1] ?? 0);
  });
  place(F.HERO, 0x102, 232, 208, 293, 293);
  return { api: { read: address => words.get(address) ?? 0 }, set, place, link };
};

test("hits are read from monsters on the field list that lose HP, and the hero's lost HP from its own record", () => {
  const memory = fieldMemory();
  const tree = memory.place(0x01520ebc, 0x011e0007, 264, 128);
  const spirit = memory.place(0x0152a9cc, 0x00020003, 219, 242, 137, 137);
  const soldier = memory.place(0x0152e008, 0x000f0003, 300, 180, 237, 237);
  memory.link([tree, soldier, F.HERO, spirit]);
  memory.set(F.CAMERA_X, 144);
  memory.set(F.CAMERA_Y, 90);
  const tracker = new Hl4HitTracker(), hits = [], hurts = [];
  const sample = () => tracker.sample(memory.api, hit => hits.push({ ...hit }), share => hurts.push(share));
  assert.equal(sample(), false, "a new map is only a baseline");
  assert.deepEqual({ ...tracker.view }, { x: -144, y: -90, width: 240, height: 320 });
  memory.set(spirit + F.HP, 100);
  memory.set(soldier + F.HP, 201);
  memory.set(F.HERO + F.HP, 284);
  assert.equal(sample(), true);
  assert.deepEqual(hits, [
    { x: 300, y: 180, damage: 36, share: 36 / 237, killed: false },
    { x: 219, y: 242, damage: 37, share: 37 / 137, killed: false },
  ]);
  assert.deepEqual(hurts, [9 / 293]);
  // Regeneration, healing and scenery are not hits; the last blow is a kill.
  memory.set(spirit + F.HP, 102);
  memory.set(F.HERO + F.HP, 293);
  sample();
  memory.set(spirit + F.HP, 0);
  sample();
  assert.equal(hits.length, 3);
  assert.equal(hits[2].killed, true);
  assert.equal(hurts.length, 1);
  // A record reused for another monster with fewer HP is not a hit.
  memory.set(soldier + F.MAX_HP, 137);
  memory.set(soldier + F.HP, 137);
  sample();
  assert.equal(hits.length, 3);
  // Off screen: HP taken by a monster outside the camera is not drawn.
  memory.set(F.CAMERA_X, 400);
  memory.set(soldier + F.HP, 100);
  sample();
  assert.equal(hits.length, 3);
});

test("the HL4 tracker stays silent off the field, on a new map, on broken links and on another build", () => {
  const memory = fieldMemory();
  const spirit = memory.place(0x0152a9cc, 0x00020003, 219, 242, 137, 137);
  memory.link([F.HERO, spirit]);
  const tracker = new Hl4HitTracker(), hits = [];
  const sample = (api = memory.api) => tracker.sample(api, hit => hits.push(hit), () => {});
  sample();
  // A new map (another size) starts over without effects.
  memory.set(F.MAP_WIDTH, 400);
  memory.set(spirit + F.HP, 50);
  assert.equal(sample(), false);
  // The hero's record off the list (title, loading) is not the field.
  memory.set(F.HERO + F.SELF, 0);
  memory.set(spirit + F.HP, 10);
  assert.equal(sample(), false);
  memory.set(F.HERO + F.SELF, F.HERO);
  sample();
  // A link that leaves the binary's segments ends the walk.
  memory.set(F.HERO + F.NEXT, 0x12345678);
  memory.set(spirit + F.HP, 5);
  sample();
  assert.deepEqual(hits, []);
  const otherBuild = new Hl4HitTracker();
  assert.equal(otherBuild.sample({ read: address => (address === 0x4e328 ? 0 : memory.api.read(address)) }, () => hits.push(1), () => {}), false);
  assert.deepEqual(hits, []);
});

test("the HL4 pad copies slot icons only from frames that show the slot bar, and knows an empty slot", () => {
  const { HL4_SLOT_ICONS, showsSlotBar, isEmptySlot } = load("hl4_slots");
  // The slot bar strip (x 50..190, y 293..311) of a field frame: black slot insides, frame colour beside them.
  const strip = new Uint8ClampedArray(140 * 19 * 4);
  const put = (x, y, rgb) => strip.set([...rgb, 255], ((y - 293) * 140 + (x - 50)) * 4);
  for (const left of Object.values(HL4_SLOT_ICONS)) put(left + 16, 300, [74, 73, 58]);
  for (const x of [60, 100, 140, 180]) put(x, 311, [8, 8, 8]);
  assert.equal(showsSlotBar(strip), true);
  assert.equal(isEmptySlot(strip, HL4_SLOT_ICONS["1"]), true);
  put(HL4_SLOT_ICONS.OK + 7, 303, [90, 200, 60]); // the sword on 5
  assert.equal(isEmptySlot(strip, HL4_SLOT_ICONS.OK), false);
  assert.equal(isEmptySlot(strip, HL4_SLOT_ICONS["3"]), true);
  // A scene or menu drawn over the bottom of the screen is not the slot bar.
  put(HL4_SLOT_ICONS["9"] + 16, 300, [200, 180, 150]);
  assert.equal(showsSlotBar(strip), false);
});
