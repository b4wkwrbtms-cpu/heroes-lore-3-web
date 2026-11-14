const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

// Exercise the presenter lifecycle through the same canvas/WebGL contract as the browser.
// Actual shader compilation and appearance are checked in the deployed browser as well.
const source = fs.readFileSync(path.join(__dirname, "../src/ts/display.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ available = true, compileOk = true } = {}) {
  let texture, framebuffer, program, resize;
  const images = new Map(), attachments = new Map();
  const draws = [], uploads = [], deleted = [];
  const gl = {
    TEXTURE0: 0, TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, FRAMEBUFFER: 4,
    COLOR_ATTACHMENT0: 5, COLOR_BUFFER_BIT: 6, TRIANGLE_STRIP: 7,
    TEXTURE_MIN_FILTER: 8, TEXTURE_MAG_FILTER: 9, LINEAR: 10, NEAREST: 11,
    TEXTURE_WRAP_S: 12, TEXTURE_WRAP_T: 13, CLAMP_TO_EDGE: 14,
    VERTEX_SHADER: 15, FRAGMENT_SHADER: 16, COMPILE_STATUS: 17, LINK_STATUS: 18,
    createTexture: () => ({}),
    createFramebuffer: () => ({}),
    createProgram: () => ({}),
    createShader: () => ({}),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {},
    getShaderParameter: () => compileOk, getProgramParameter: () => true,
    getShaderInfoLog: () => "test compile failure", getProgramInfoLog: () => "",
    getUniformLocation: (p, name) => ({ p, name }),
    deleteShader() {},
    deleteProgram: p => deleted.push(p),
    deleteTexture: t => deleted.push(t),
    deleteFramebuffer: f => deleted.push(f),
    bindTexture: (_, t) => { texture = t; },
    bindFramebuffer: (_, f) => { framebuffer = f; },
    framebufferTexture2D: (_, __, ___, t) => attachments.set(framebuffer, t),
    texImage2D(...args) {
      const size = args.length === 6 ? [args[5].width, args[5].height] : [args[3], args[4]];
      images.set(texture, size);
      uploads.push({ kind: "allocate", size, texture });
    },
    texSubImage2D(...args) {
      assert.deepEqual(images.get(texture), [args[6].width, args[6].height]);
      uploads.push({ kind: "update", texture });
    },
    activeTexture() {}, pixelStorei() {}, texParameteri() {}, clearColor() {}, clear() {},
    viewport: (...v) => { gl.view = v; },
    useProgram: p => { program = p; },
    uniform1i() {}, uniform2f() {},
    uniform1f: (location, value) => { program[location.name] = value; },
    drawArrays() {
      assert.ok(images.has(texture), "sampling allocated texture");
      if (framebuffer) assert.notEqual(texture, attachments.get(framebuffer), "no feedback loop");
      draws.push({ intermediate: Boolean(framebuffer), view: gl.view, flipY: program.flipY });
    },
  };
  class Canvas extends EventTarget {
    width = 240;
    height = 320;
    hidden = true;
    classes = new Set();
    classList = {
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
      remove: name => this.classes.delete(name),
    };
    getContext = () => available ? gl : null;
  }
  const game = new Canvas(), screen = new Canvas();
  const exports = {};
  const document = { documentElement: { dataset: { screenFit: "contain" } } };
  vm.runInNewContext(compiled, {
    exports, console: { warn() {} }, document,
    window: { devicePixelRatio: 1 },
    ResizeObserver: class {
      constructor(callback) { resize = callback; }
      observe() {} disconnect() {}
    },
  });
  const display = new exports.HqDisplay(game, screen);
  const fit = (width, height) => resize([{ contentRect: { width, height } }]);
  return { display, game, screen, gl, draws, uploads, deleted, fit, document };
}

test("animation frames reuse textures; viewport selects 0, 1 or 2 EPX passes", () => {
  const h = harness();
  h.fit(240, 320);
  h.display.setEnabled(true);
  assert.equal(h.draws.length, 1);
  h.fit(463, 618); // Desktop game viewport used in the live test.
  assert.equal(h.draws.slice(-2).filter(d => d.intermediate).length, 1);
  h.fit(786, 1048); // iPhone portrait at the capped 2× backing resolution.
  assert.equal(h.draws.slice(-3).filter(d => d.intermediate).length, 2);
  const allocations = h.uploads.filter(u => u.kind === "allocate").length;
  for (let i = 0; i < 120; i++) h.display.present();
  assert.equal(h.uploads.filter(u => u.kind === "allocate").length, allocations);
  assert.equal(h.draws.at(-1).flipY, 1);
  assert.equal(h.draws.at(-2).flipY, 0);
});

test("native-resolution switch reallocates once and keeps aspect ratio", () => {
  const h = harness();
  h.fit(800, 600);
  h.display.setEnabled(true);
  assert.deepEqual(h.draws.at(-1).view, [175, 0, 450, 600]);
  h.game.width = 176;
  h.game.height = 220;
  h.display.present();
  assert.deepEqual(h.draws.at(-1).view, [160, 0, 480, 600]);
  const allocations = h.uploads.filter(u => u.kind === "allocate").length;
  h.display.present();
  assert.equal(h.uploads.filter(u => u.kind === "allocate").length, allocations);
  h.document.documentElement.dataset.screenFit = "fill";
  h.display.present();
  assert.deepEqual(h.draws.at(-1).view, [0, 0, 800, 600]);
});

test("GPU loss shows native canvas, restore reuploads and resumes HQ", () => {
  const h = harness();
  h.fit(480, 640);
  h.display.setEnabled(true);
  const loss = new Event("webglcontextlost", { cancelable: true });
  h.screen.dispatchEvent(loss);
  assert.ok(loss.defaultPrevented);
  assert.equal(h.display.active, false);
  assert.equal(h.screen.hidden, true);
  assert.equal(h.game.classes.has("hq-source"), false);
  const frames = h.draws.length;
  h.display.present();
  assert.equal(h.draws.length, frames);
  h.screen.dispatchEvent(new Event("webglcontextrestored"));
  assert.equal(h.display.active, true);
  assert.equal(h.game.classes.has("hq-source"), true);
  assert.ok(h.draws.length > frames);
});

test("pixel preference during GPU loss survives restoration; disposal releases resources", () => {
  const h = harness();
  h.fit(960, 1280);
  h.display.setEnabled(true);
  h.display.dispose();
  assert.equal(h.deleted.length, 7); // Source, two textures/FBOs, two programs.
  h.screen.dispatchEvent(new Event("webglcontextrestored"));
  assert.equal(h.display.active, false);
  const k = harness();
  k.display.setEnabled(true);
  k.screen.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  k.display.setEnabled(false);
  k.screen.dispatchEvent(new Event("webglcontextrestored"));
  assert.equal(k.display.active, false);
});

test("a style with the edge upscaler and glow decides edges, blurs the bright parts and draws at the display size", () => {
  const h = harness();
  h.fit(786, 1048);
  h.display.setStyle({ upscaler: "xbr", glow: 0.6, vivid: 1 });
  h.display.setEnabled(true);
  const frame = h.draws.length;
  h.display.present();
  const draws = h.draws.slice(frame);
  // bright parts, four blurs, edge decisions, then the picture straight onto the screen
  assert.deepEqual(draws.map(d => d.intermediate), [true, true, true, true, true, true, false]);
  assert.deepEqual(draws.at(-1).view, [0, 0, 786, 1048]);
  h.display.setStyle({ upscaler: "epx", glow: 0, vivid: 0 });
  const epx = h.draws.length;
  h.display.present();
  assert.equal(h.draws.slice(epx).filter(d => d.intermediate).length, 2);
});

test("missing WebGL or shader errors leave the game visible", () => {
  for (const options of [{ available: false }, { compileOk: false }]) {
    const h = harness(options);
    h.display.setEnabled(true);
    h.display.present();
    assert.equal(h.display.active, false);
    assert.equal(h.screen.hidden, true);
    assert.equal(h.game.classes.has("hq-source"), false);
  }
});
