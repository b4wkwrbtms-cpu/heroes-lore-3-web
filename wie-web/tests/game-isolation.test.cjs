const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const HL3 = "PD119037", INOTIA = "PD005362"; // app_info / __adf__ from the actual archives
function modules(globals = {}) {
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const file = path.join(__dirname, "../src/ts", name + ".ts");
    const exports = {};
    cache.set(name, exports);
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(compiled, { exports, ...globals, require: dep => load(dep.replace(/^\.\//, "")) });
    return exports;
  }
  return load;
}

test("game identity ignores misleading titles and filenames; controls follow the archive PID", () => {
  const load = modules();
  const hl3 = load("hl3"), pad = load("pad_profile");
  const renamedHl3 = { id: HL3, title: "이노티아", filename: "inotia.zip" };
  const renamedInotia = { id: INOTIA, title: "영웅서기3", filename: "heroes-lore-3.zip" };
  assert.equal(hl3.isHeroesLore3(renamedInotia.id), false);
  assert.equal(hl3.isHeroesLore3(renamedHl3.id), true);
  assert.equal(pad.isInotia(renamedHl3), false);
  assert.equal(pad.remapKey(pad.padProfileFor(renamedHl3), "OK"), "OK");
  assert.equal(pad.remapKey(pad.padProfileFor(renamedInotia), "OK"), "5");
  assert.equal(hl3.isHeroesLore3Binary({ read: () => 0 }), false);
  assert.equal(hl3.isHeroesLore3Binary({ read: () => { throw Error("unmapped"); } }), false);
  assert.equal(hl3.isHeroesLore3Binary({ read: addr => addr === 0x38620 ? 0x307eb500 : 0xb0a8b5f0 }), true);
});

test("legacy presentation choices migrate only to their owner; switching games preserves separate values", () => {
  const data = new Map([["wie_screen_quality", "pixel"], ["wie_screen_fit", "fill"], ["wie_bgm_engine", "gm"]]);
  const storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const { loadGamePreference: get, storeGamePreference: put } = modules({ window: { localStorage: storage } })("game_preferences");
  for (const [key, initial, changed] of [["screen_quality", "hq", "pixel"], ["screen_fit", "contain", "fill"], ["bgm_engine", "fm", "gm"], ["hit_effects", "on", "off"]]) {
    const migrated = get(HL3, key, initial, `wie_${key}`);
    assert.equal(get(INOTIA, key, initial), initial);
    put(HL3, key, changed);
    assert.equal(get(INOTIA, key, initial), initial);
    put(INOTIA, key, initial);
    assert.equal(get(HL3, key, initial, `wie_${key}`), changed);
    assert.equal(get(INOTIA, key, initial), initial);
    if (key !== "hit_effects") assert.equal(migrated, changed);
  }
  const before = [...data];
  put(undefined, "screen_quality", "pixel");
  assert.deepEqual([...data], before, "library settings cannot overwrite a running game's choices");
});

test("leaving a game clears queued macros, attack state and timers before another session starts", () => {
  const timers = new Map(); let id = 0, writes = 0, presses = 0;
  const load = modules({
    window: { localStorage: { getItem: () => null, setItem() {} }, setInterval: fn => { timers.set(++id, fn); return id; }, clearInterval: key => timers.delete(key) },
    performance: { now: () => 100 },
  });
  const { automation, defaultAutoConfig } = load("automation");
  const api = { read: () => 0, write: () => writes++ };
  automation.attach({ appId: HL3, getCheats: () => api, pressKey: () => presses++ });
  const config = defaultAutoConfig();
  config.macros[0].skills = [{ weapon: "A", index: 0 }];
  config.potionOn = config.skillOn = true;
  automation.update(config);
  assert.equal(automation.runMacro(0), true);
  const staleTick = [...timers.values()][0];
  let last; const unsubscribe = automation.onChange(value => { last = value; });
  automation.detach();
  assert.equal(timers.size, 0);
  assert.equal(automation.appId, undefined);
  assert.equal(last.potionOn, false); assert.equal(last.skillOn, false);
  assert.equal(last.macros[0].skills.length, 0);
  assert.equal(automation.runMacro(0), false);
  staleTick(); automation.aim(true); automation.interceptAttack();
  assert.equal(writes, 0); assert.equal(presses, 0);
  unsubscribe();
});
