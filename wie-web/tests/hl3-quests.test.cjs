const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
// Synthetic inputs only: no original game resource bytes, save data or native memory dumps.
const ascii = text => Array.from(Buffer.from(text, "ascii"));
const textRecord = (title, location) => {
  const b = [title, "Test description", location, "Test category"].flatMap(s => [s.length, ...ascii(s)]);
  return Buffer.from([b.length & 255, b.length >> 8, ...b]).toString("hex");
};
const groupBytes = rows => [rows.length, ...rows.map(r => r.length), ...rows.flat()];
const sceneBytes = () => {
  const triggers = [[26, 21, 0, 255, 0, 5, 0]];
  const actions = [[40, 0, 23, 1, 1], [35, 255, 1], [35, 255, 1]];
  return Buffer.from([6, 0, 0, 0, 0, 0, 0, 0, 0, ...groupBytes(triggers), ...groupBytes(actions), ...groupBytes([ascii("Test forest 1")])]).toString("hex");
};
function syntheticSnapshot(name, current, active) {
  const list = new Uint8Array(21), quest = new Uint8Array(256), local = new Uint8Array(256), counters = new Uint8Array(76);
  if (active) {
    list[20] = 1; quest[0] = quest[1] = 1;
    counters[0] = 107; counters[15] = 5; counters[30] = current; counters[45] = 3; counters[75] = 1;
    if (current >= 5) local[3] = 1;
  }
  const hex = value => Buffer.from(value).toString("hex");
  return { name, list: hex(list), quest: hex(quest), local: hex(local), counters: hex(counters) };
}
const collection = new Uint8Array(91);
collection[0] = 14; collection[15] = 5; collection[30] = 50; collection[75] = 120; collection[90] = 1;
const fixture = {
  firstText: { 0: textRecord("Quest A", "Test forest;Target"), 1: textRecord("Quest B", "Test port;Target") },
  scene8: sceneBytes(), collection: Buffer.from(collection).toString("hex"),
  snapshots: [syntheticSnapshot("beforeAccept", 0, false), syntheticSnapshot("accepted", 0, true),
    ...Array.from({ length: 5 }, (_, i) => syntheticSnapshot(`kill${i + 1}`, i + 1, true)), syntheticSnapshot("turnedIn", 0, false)],
  conditions: [
    { token: 253, params: [10, 0], level: 9, gold: 0, result: 1 },
    { token: 253, params: [10, 0], level: 10, gold: 0, result: 0 },
    { token: 253, params: [10, 1], level: 9, gold: 0, result: 0 },
    { token: 253, params: [10, 1], level: 10, gold: 0, result: 1 },
    { token: 252, params: [100, 0, 0, 0, 0], level: 1, gold: 99, result: 1 },
    { token: 252, params: [100, 0, 0, 0, 0], level: 1, gold: 100, result: 0 },
    { token: 252, params: [100, 0, 0, 0, 1], level: 1, gold: 99, result: 0 },
    { token: 252, params: [100, 0, 0, 0, 1], level: 1, gold: 100, result: 1 },
    { token: 251, params: [0, 0], level: 1, gold: 0, result: 1 },
    { token: 251, params: [1, 1], level: 1, gold: 0, result: 0 },
    { token: 250, params: [22, 0], level: 1, gold: 0, result: 1 },
  ],
};
const cache = new Map();
function load(name, globals = {}) {
  if (cache.has(name) && !Object.keys(globals).length) return cache.get(name);
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, "../src/ts", name + ".ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, TextDecoder, Uint8Array, DataView, require: n => load(n.replace("./", "")), ...globals });
  if (!Object.keys(globals).length) cache.set(name, exports);
  return exports;
}
const { Hl3QuestResources, parseQuestText, parseQuestScene, resolveQuestTrigger, readHl3Quests } = load("hl3_quests");
const G = 0x1503ab0, MENU = 0x48000000, MAP = 0x48020000, PLAYER = 0x48021000;
const bytes = hex => new Uint8Array(Buffer.from(hex, "hex"));
function archive() {
  const files = new Map();
  for (const character of [0, 1]) for (const kind of [0, 1]) files.set(`res/dat/quest_${character}${kind}_dat`, bytes(fixture.firstText[character]));
  files.set("res/event/e0008_scn", bytes(fixture.scene8));
  return files;
}
function resources() {
  const result = new Hl3QuestResources(archive());
  result.scenes.set(0, { id: 0, map: 0, name: "Test town", triggers: [
    new Uint8Array([23, 0, 0, 255, 0, 5, 255, 2, 4, 1, 250, 22, 1, 0, 1]),
  ], actions: [{ choice: false, commands: [[40, 8, 26, 20, 0]] }, { choice: false, commands: [[52, 1]] }] });
  // A conditional NPC finish action, to exercise returning after the counter reaches five.
  result.scenes.get(8).triggers.push(new Uint8Array([10, 12, 0, 0, 0, 4, 250, 3, 1, 3]));
  result.scenes.get(8).actions.push({ choice: false, commands: [[34, 0, 0]] });
  return result;
}
function memory() {
  const data = new Map(); let reads = 0;
  const put = (a, b) => b.forEach((value, i) => data.set(a + i, value));
  const write = (a, value, width = 4) => { for (let i = 0; i < width; i++) data.set(a + i, (value >>> (i * 8)) & 255); };
  const api = {
    read(a, width, bigEndian) { assert.equal(bigEndian, false); reads++; let v = 0; for (let i = 0; i < width; i++) v |= (data.get(a + i) ?? 0) << (8 * i); return v >>> 0; },
    dump(a, size) { reads++; return Uint8Array.from({ length: size }, (_, i) => data.get(a + i) ?? 0); },
    write() { assert.fail("quest guide must never write memory"); }, writeBytes() { assert.fail("quest guide must never write memory"); },
  };
  write(0x38620, 0x307eb500); write(0x17080, 0xb0a8b5f0);
  write(G + 0x50, 4); write(0x150db48, 3); write(G + 0x9e00, MENU); write(G + 0x9c68, MAP); write(G + 0x9ba4, PLAYER);
  write(0x5e46c, 108); write(0x5e470, 84); write(MAP + 0x50, 640, 2); write(MAP + 0x52, 640, 2);
  write(G + 0x44, 240); write(G + 0x48, 320);
  write(PLAYER + 0x10, 200, 2); write(PLAYER + 0x12, 200, 2);
  const apply = snapshot => {
    put(MENU + 0x48, bytes(snapshot.list)); put(G + 0x9f98, bytes(snapshot.quest));
    put(G + 0x9e98, bytes(snapshot.local)); put(G + 0xa266, bytes(snapshot.counters));
  };
  return { api, write, apply, put, reads: () => reads };
}

test("acceptance → five kills → turn-in updates the read-only tracker", () => {
  const r = resources(), m = memory();
  for (const snapshot of fixture.snapshots) {
    m.apply(snapshot);
    const state = readHl3Quests("PD119037", m.api, r);
    if (["beforeAccept", "turnedIn"].includes(snapshot.name)) assert.equal(state.quests.length, 0);
    else {
      assert.equal(state.selected.title, "Quest A");
      assert.equal(state.selected.progress[0].required, 5);
      assert.equal(state.selected.progress[0].current, snapshot.name === "accepted" ? 0 : Number(snapshot.name.slice(4)));
    }
  }
});

test("comparison boundary cases and nested first-match branch selection", () => {
  const state = { quest: new Uint8Array(256), local: new Uint8Array(256), itemCount: () => 0 };
  for (const c of fixture.conditions) {
    const result = resolveQuestTrigger(new Uint8Array([c.token, ...c.params, 9]), { ...state, level: c.level, gold: c.gold });
    assert.equal(result.length, c.result);
  }
  const trigger = new Uint8Array([255, 2, 4, 1, 250, 22, 1, 11, 15]);
  assert.equal(resolveQuestTrigger(trigger, state).join(), "15");
  state.local[22] = 1;
  assert.equal(resolveQuestTrigger(trigger, state).join(), "11");
  assert.equal(resolveQuestTrigger(new Uint8Array([249, 0]), state), undefined);
  assert.equal(resolveQuestTrigger(new Uint8Array([255, 2, 99]), state), undefined);
});

test("locked exits have no arrow; open exits route by scene ID; eligible turn-in points to the NPC", () => {
  const r = resources(), m = memory(); m.apply(fixture.snapshots[1]);
  assert.equal(readHl3Quests("PD119037", m.api, r).point, undefined);
  m.write(G + 0x9e98 + 22, 1, 1);
  const route = readHl3Quests("PD119037", m.api, r);
  assert.equal(route.point.kind, "exit"); assert.equal(route.point.x, 376); assert.match(route.guidance, /Test forest 1/);
  m.apply(fixture.snapshots.find(s => s.name === "kill5")); m.write(G + 0x9e08, 8, 2); m.write(G + 0x9e1c, 6);
  const returned = readHl3Quests("PD119037", m.api, r);
  assert.equal(returned.point.kind, "target"); assert.equal(returned.point.x, 168); assert.equal(returned.point.y, 208);
});

test("same-map marker follows a living quest monster, never an unrelated or dead enemy", () => {
  const r = resources(), m = memory(); m.apply(fixture.snapshots[1]);
  const table = 0x48030000, entity = 0x48031000, collider = 0x48032000;
  m.write(G + 0x9c94, table); m.write(G + 0x9c98, 1, 2); m.write(table, entity); m.write(table + 0x7e, 10, 2);
  m.write(entity + 0x18, collider); m.write(collider + 4, 5, 1); m.write(collider + 0xe, 107, 1); m.write(collider + 0x10, 250, 2); m.write(collider + 0x12, 260, 2);
  assert.equal(readHl3Quests("PD119037", m.api, r).point.x, 250);
  m.write(collider + 0xe, 108, 1); assert.equal(readHl3Quests("PD119037", m.api, r).point, undefined);
  m.write(collider + 0xe, 107, 1); m.write(table + 0x7e, 0, 2); assert.equal(readHl3Quests("PD119037", m.api, r).point, undefined);
});

test("collection goals read the current bag instead of a stale event counter", () => {
  const r = resources(), m = memory(); m.apply(fixture.snapshots[1]);
  r.texts.set("01", Array.from({ length: 7 }, () => ({ title: "수집", description: "", location: "Test forest;Material", category: "서브" })));
  m.write(MENU + 0x48, 120, 1); m.write(G + 0x9f98 + 120, 1, 1); m.write(G + 0x9f98 + 121, 1, 1);
  m.put(G + 0xa2b3, bytes(fixture.collection));
  const item = MENU + 0x394;
  m.write(item + 0x1f, 1, 1); m.write(item + 0x22, 14, 2); m.write(item + 0x24, 5, 2); m.write(item + 0x26, 23, 2);
  let state = readHl3Quests("PD119037", m.api, r);
  assert.equal(state.selected.progress[0].current, 23); assert.equal(state.selected.progress[0].required, 50);
  m.write(item + 0x26, 50, 2); state = readHl3Quests("PD119037", m.api, r);
  assert.equal(state.selected.progress[0].current, 50);
});

test("character text, boundaries, title/menu/loading and Inotia/Zero isolation", () => {
  const r = resources(), m = memory(); m.apply(fixture.snapshots[1]);
  m.write(G + 0xa314, 1); assert.equal(readHl3Quests("PD119037", m.api, r).selected.title, "Quest B");
  const reads = m.reads();
  for (const id of ["PD005362", "Heroes Lore Zero", "PD119037-copy"]) assert.equal(readHl3Quests(id, m.api, r), undefined);
  assert.equal(m.reads(), reads, "foreign games never have memory inspected");
  for (const mode of [2, 3, 5]) { m.write(G + 0x50, mode); assert.equal(readHl3Quests("PD119037", m.api, r), undefined); }
  m.write(G + 0x50, 4); m.write(0x150db48, 4); assert.equal(readHl3Quests("PD119037", m.api, r), undefined);
  m.write(0x150db48, 3); m.write(MENU + 0x5c, 255, 1); assert.equal(readHl3Quests("PD119037", m.api, r), undefined);
  m.write(MENU + 0x5c, 1, 1); m.write(0x38620, 0); assert.equal(readHl3Quests("PD119037", m.api, r), undefined);
  assert.throws(() => parseQuestText(new Uint8Array([200, 0])));
  assert.throws(() => parseQuestScene(8, bytes(fixture.scene8).slice(0, -1)));
});

test("HUD updates from guest state, throttles reads, supports folding and tears down before another game", () => {
  class Element extends EventTarget {
    hidden = false; textContent = ""; value = ""; dataset = {}; style = {}; children = []; attributes = {};
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    remove() { this.removed = true; }
  }
  const document = new Element(), parent = new Element(), storage = new Map();
  document.documentElement = { dataset: { screenFit: "contain" } };
  document.createElement = () => new Element();
  document.getElementById = () => undefined;
  document.querySelector = () => document.modal ? {} : null;
  let disconnected = false;
  const preferences = load("game_preferences", { window: { localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } } });
  const { Hl3QuestGuide } = load("hl3_quest_guide", {
    document, console, AbortController, performance: { now: () => 0 },
    require: n => n === "./game_preferences" ? preferences : load(n.replace("./", "")),
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { this.cb([{ contentRect: { width: 390, height: 520 } }]); }
      disconnect() { disconnected = true; }
    },
  });
  const m = memory(), guide = new Hl3QuestGuide({ parentElement: parent }, "PD119037");
  const session = { cheats: m.api, readResources: () => archive() };
  guide.attach(session); m.apply(fixture.snapshots[1]); m.write(G + 0x9e08, 8, 2); m.write(G + 0x9e1c, 6);
  guide.sample(session, 0);
  const [marker, root] = parent.children, [toggle, title, objective, direction, details] = root.children;
  assert.equal(root.hidden, false); assert.equal(title.textContent, "Quest A"); assert.match(objective.textContent, /0\/5/);
  const reads = m.reads(); guide.sample(session, 100); assert.equal(m.reads(), reads);
  m.apply(fixture.snapshots.find(s => s.name === "kill3")); guide.sample(session, 250); assert.match(objective.textContent, /3\/5/);
  toggle.dispatchEvent(new Event("click")); assert.equal(details.hidden, false); assert.equal(toggle.attributes["aria-expanded"], "true");
  toggle.dispatchEvent(new Event("click")); assert.equal(details.hidden, true); assert.equal(root.dataset.compact, "true");
  assert.equal(storage.get("wie_game_PD119037_quest_compact"), "true");
  document.modal = true; guide.sample(session, 251); assert.equal(root.hidden, true); assert.equal(marker.hidden, true);
  document.modal = false; guide.sample(session, 500); assert.equal(root.hidden, false);
  document.hidden = true; document.dispatchEvent(new Event("visibilitychange")); assert.equal(root.hidden, true);
  guide.dispose(); assert.equal(root.removed, true); assert.equal(marker.removed, true); assert.equal(disconnected, true);
  const finalReads = m.reads(); guide.sample(session, 1000); assert.equal(m.reads(), finalReads);
});
