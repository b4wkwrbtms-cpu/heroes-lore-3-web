const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createHash, webcrypto } = require("node:crypto");
const { zipSync, unzipSync } = require("fflate");
const ts = require("typescript");
const digest = data => createHash("sha256").update(data).digest("hex");

function load() {
  const source = fs.readFileSync(path.join(__dirname, "../src/ts/game_update.ts"), "utf8").replaceAll("import.meta.url", '"https://test.invalid/game_update.js"');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Uint8Array, atob, URL, crypto: webcrypto,
    fetch: () => { throw Error("unexpected fetch"); },
    require: dep => dep === "fflate" ? require(dep) : { isHeroesLore3: id => id === "PD119037" },
  });
  return exports.prepareGameArchive;
}

function fixture() {
  const original = Buffer.from("native binary before");
  const target = Buffer.from("native binary after with new section");
  const resource = Buffer.from("original item stats");
  const metadata = Buffer.from([0xb4,0xeb,0xc1,0xf6,0x0a,...Buffer.from("FSize:1\nPID:PD119037\n")]);
  const archive = zipSync({ app_info: metadata, "icon.png": Buffer.from("picture"), "0002865E.jar": zipSync({
    "binary.mod": original, "res/dat/items": Buffer.from("cheated stats"), "res/art/hero": Buffer.from("keep graphics"),
  }) });
  return { archive, metadata, target, update: {
    targetSha256: digest(target), targetLength: target.length,
    sources: { [digest(original)]: { length: original.length, edits: [[0,target.toString("base64")]] } },
    resources: { "res/dat/items": { sha256: digest(resource), data: resource.toString("base64") } },
  } };
}

test("updates code and balance atomically while retaining graphics, metadata bytes and repeated-launch identity", async () => {
  const prepare = load(), { archive, update, target, metadata } = fixture();
  const before = Buffer.from(archive), next = await prepare("PD119037", archive, update);
  assert.deepEqual(Buffer.from(archive), before, "input never mutated");
  const outer = unzipSync(next), jar = unzipSync(outer["0002865E.jar"]);
  assert.deepEqual(Buffer.from(jar["binary.mod"]), target);
  assert.equal(Buffer.from(jar["res/dat/items"]).toString(), "original item stats");
  assert.equal(Buffer.from(jar["res/art/hero"]).toString(), "keep graphics");
  assert.deepEqual(Buffer.from(outer.app_info.slice(0,5)),metadata.slice(0,5), "CP949 preserved");
  assert.match(Buffer.from(outer.app_info).toString("latin1"), new RegExp(`FSize:${outer["0002865E.jar"].length}\\n`));
  assert.equal(await prepare("PD119037", next, update), next, "already updated archive is reused");
});

test("other games bypass archive parsing/network, and unsupported or corrupt updates leave the source unchanged", async () => {
  const prepare = load(), { archive, update } = fixture();
  for (const id of ["PD005362","PD140249","PD005576"]) assert.equal(await prepare(id, archive), archive);
  const before = Buffer.from(archive);
  await assert.rejects(prepare("PD119037", archive, { ...update, sources: {} }), /자동 갱신 대상/);
  const broken = structuredClone(update); Object.values(broken.sources)[0].edits[0][1] = Buffer.from("bad").toString("base64");
  await assert.rejects(prepare("PD119037", archive, broken), /검증/);
  assert.deepEqual(Buffer.from(archive),before);
});

test("the four actual released archives all produce the verified native patch", { skip: !process.env.HL3_FIXTURE_DIR }, async () => {
  const dir = process.env.HL3_FIXTURE_DIR, prepare = load();
  const update = JSON.parse(fs.readFileSync(path.join(__dirname,"../assets/hl3-normal-v8.json")));
  for (const name of ["original", "v5", "v6", "v7"]) {
    const input = new Uint8Array(fs.readFileSync(path.join(dir,`${name}.zip`)));
    const output = await prepare("PD119037",input,update), jar = unzipSync(unzipSync(output)["0002865E.jar"]);
    assert.equal(digest(jar["binary.mod"]),update.targetSha256,name);
    for (const [file,resource] of Object.entries(update.resources)) assert.equal(digest(jar[file]),resource.sha256,`${name}:${file}`);
    assert.equal(await prepare("PD119037",output,update),output);
  }
});
