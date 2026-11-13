const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const ts = require("typescript");

function load(indexedDB, data, blocked = false) {
  const source = fs.readFileSync(path.join(__dirname,"../src/ts/game_reset.ts"),"utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const localStorage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => { if (blocked) throw Error("storage blocked"); data.set(k,v); } };
  vm.runInNewContext(compiled, { exports, indexedDB, IDBKeyRange, window: { localStorage },
    navigator: { locks: { request: async (_name,fn) => fn() } },
    require: dep => dep === "./hl3" ? { isHeroesLore3: id => id === "PD119037" }
      : { clearRetiredCheats: id => { data.delete(`wie_cheats_${id}`); data.delete(`wie_auto_${id}`); } },
  });
  return exports.resetGameProgress;
}
function open(indexedDB,name,version,store) {
  return new Promise((resolve,reject) => {
    const r = indexedDB.open(name,version);
    r.onupgradeneeded = () => r.result.createObjectStore(store);
    r.onerror = () => reject(r.error); r.onsuccess = () => resolve(r.result);
  });
}
function transaction(db,store,run) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction(store,"readwrite"); run(tx.objectStore(store));
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
}
function rows(db) {
  return new Promise(resolve => {
    const r = db.transaction("files").objectStore("files").getAllKeys(); r.onsuccess = () => resolve(r.result);
  });
}

test("fresh recipient edition deletes only HL3 progress, once, preserving later saves and every other game", async () => {
  const idb = new IDBFactory(), data = new Map([["wie_cheats_PD119037","old"],["wie_auto_PD119037","old"],
    ["wie_cheats_PD005362","keep"],["wie_game_PD119037_screen_quality","hq"]]);
  const db = await open(idb,"wie_filesystem",2,"files");
  const keys = [["PD119037","save"],["PD119037","config"],["PD005362","save"],["PD140249","save"],
    ["PD119037_other","save"],["migrated_aid_0002865E","unrelated"]];
  await transaction(db,"files",store => keys.forEach(key => store.put(new Uint8Array([1,2,3]),key)));
  for (const id of ["PD119037","PD005362"]) {
    const records = await open(idb,`wie_${id}`,1,"records");
    await transaction(records,"records",store => store.put("keep or reset","save1")); records.close();
  }
  const reset = load(idb,data);
  assert.equal(await reset("PD119037"),true);
  assert.deepEqual(await rows(db),keys.slice(2).sort((a,b) => idb.cmp(a,b)));
  assert.equal((await idb.databases()).some(x => x.name === "wie_PD119037"),false);
  assert.equal((await idb.databases()).some(x => x.name === "wie_PD005362"),true);
  assert.equal(data.get("wie_hl3_fresh_v8"),"done");
  assert.equal(data.has("wie_cheats_PD119037"),false);
  assert.equal(data.get("wie_cheats_PD005362"),"keep");
  assert.equal(data.get("wie_game_PD119037_screen_quality"),"hq");
  await transaction(db,"files",store => store.put("new progress",["PD119037","save"]));
  assert.equal(await reset("PD119037"),false);
  assert.ok((await rows(db)).some(key => key[0] === "PD119037"),"new progress survives every later launch");
  for (const id of ["PD005362","PD140249","PD005576"]) assert.equal(await reset(id),false);
  db.close();
});

test("unable to persist completion means no progress is deleted and no repeat-reset loop starts", async () => {
  const idb = new IDBFactory(), data = new Map(), db = await open(idb,"wie_filesystem",2,"files");
  await transaction(db,"files",store => store.put("old progress",["PD119037","save"]));
  await assert.rejects(load(idb,data,true)("PD119037"),/storage blocked/);
  assert.deepEqual(await rows(db),[["PD119037","save"]]);
  assert.equal(data.size,0); db.close();
});
