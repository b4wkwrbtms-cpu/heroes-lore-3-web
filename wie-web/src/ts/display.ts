/**
 * Optional WebGL presenter for the 240×320 game image.
 *
 * The emulator paints into its own canvas with putImageData; when "고화질" is on we treat that canvas as a
 * texture, run two Scale2x (EPX) passes (→ 4× pixels with smoothed diagonals) and finally draw it with a
 * "sharp bilinear" filter, which keeps pixels crisp at the fractional scale factors phones end up with
 * instead of the uneven columns `image-rendering: pixelated` produces.
 */

const VERTEX = `#version 300 es
precision highp float;
uniform float flipY;
out vec2 uv;
const vec2 corners[4] = vec2[4](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(1.0, 1.0));
void main() {
  vec2 pos = corners[gl_VertexID];
  float y = mix(pos.y * 0.5 + 0.5, 0.5 - pos.y * 0.5, flipY);
  uv = vec2(pos.x * 0.5 + 0.5, y);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// Scale2x / EPX: each source pixel becomes 2×2 pixels; a quadrant takes the colour of its two neighbours
// when they agree and differ from the opposite sides, which rounds off staircase edges.
const EPX_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 srcSize;
in vec2 uv;
out vec4 color;
vec4 at(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(srcSize) - ivec2(1));
  return texelFetch(tex, p, 0);
}
bool eq(vec4 a, vec4 b) { return all(lessThan(abs(a - b), vec4(0.004))); }
void main() {
  vec2 texel = uv * srcSize;
  ivec2 p = ivec2(floor(texel));
  vec2 q = fract(texel);
  vec4 P = at(p);
  vec4 U = at(p + ivec2(0, -1));
  vec4 D = at(p + ivec2(0, 1));
  vec4 L = at(p + ivec2(-1, 0));
  vec4 R = at(p + ivec2(1, 0));
  bool left = q.x < 0.5;
  bool top = q.y < 0.5;
  vec4 result = P;
  if (top && left && eq(L, U) && !eq(L, D) && !eq(U, R)) result = U;
  if (top && !left && eq(U, R) && !eq(U, L) && !eq(R, D)) result = R;
  if (!top && left && eq(D, L) && !eq(D, U) && !eq(L, R)) result = L;
  if (!top && !left && eq(R, D) && !eq(R, U) && !eq(D, L)) result = D;
  color = result;
}`;

// Sharp bilinear: interpolate only across texel boundaries, within one output pixel.
const SHARP_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 srcSize;
uniform vec2 outSize;
in vec2 uv;
out vec4 color;
void main() {
  vec2 scale = max(outSize / srcSize, vec2(1.0));
  vec2 texel = uv * srcSize;
  vec2 f = fract(texel) - 0.5;
  vec2 sharp = clamp(f * scale, vec2(-0.5), vec2(0.5)) + 0.5;
  vec2 st = (floor(texel) + sharp) / srcSize;
  color = texture(tex, st);
}`;

interface Pass {
  program: WebGLProgram;
  tex: WebGLUniformLocation | null;
  srcSize: WebGLUniformLocation | null;
  outSize: WebGLUniformLocation | null;
  flipY: WebGLUniformLocation | null;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

const EPX_PASSES = 2;

export class HqDisplay {
  private gl: WebGL2RenderingContext | undefined;
  private epx: Pass | undefined;
  private sharp: Pass | undefined;
  private source: WebGLTexture | undefined;
  private targets: Target[] = [];
  private enabled = false;
  private readonly observer: ResizeObserver | undefined;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(
    private readonly game: HTMLCanvasElement,
    private readonly screen: HTMLCanvasElement,
  ) {
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(entries => {
        for (const entry of entries) {
          this.cssWidth = entry.contentRect.width;
          this.cssHeight = entry.contentRect.height;
        }
        this.fitScreen();
      });
      this.observer.observe(screen);
    }
  }

  get active(): boolean {
    return this.enabled && this.gl !== undefined;
  }

  setEnabled(on: boolean): void {
    if (on && !this.gl) this.init();
    this.enabled = on && this.gl !== undefined;
    this.screen.hidden = !this.enabled;
    this.game.classList.toggle("hq-source", this.enabled);
    if (this.enabled) this.fitScreen();
  }

  /** Copy the current game frame to the screen canvas through the upscaling shaders. */
  present(): void {
    const gl = this.gl;
    if (!this.enabled || !gl || !this.epx || !this.sharp || !this.source) return;
    const srcWidth = this.game.width;
    const srcHeight = this.game.height;
    if (srcWidth === 0 || srcHeight === 0 || this.screen.width === 0 || this.screen.height === 0) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.game);

    let texture = this.source;
    let width = srcWidth;
    let height = srcHeight;
    for (let pass = 0; pass < EPX_PASSES; pass += 1) {
      const target = this.target(pass, width * 2, height * 2);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.useProgram(this.epx.program);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(this.epx.tex, 0);
      gl.uniform2f(this.epx.srcSize, width, height);
      gl.uniform1f(this.epx.flipY, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      texture = target.texture;
      width = target.width;
      height = target.height;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const view = this.viewport(srcWidth, srcHeight);
    gl.viewport(0, 0, this.screen.width, this.screen.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(view.x, view.y, view.width, view.height);
    gl.useProgram(this.sharp.program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.sharp.tex, 0);
    gl.uniform2f(this.sharp.srcSize, width, height);
    gl.uniform2f(this.sharp.outSize, view.width, view.height);
    gl.uniform1f(this.sharp.flipY, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.enabled = false;
    this.screen.hidden = true;
    this.game.classList.remove("hq-source");
  }

  private viewport(srcWidth: number, srcHeight: number): { x: number; y: number; width: number; height: number } {
    const full = { x: 0, y: 0, width: this.screen.width, height: this.screen.height };
    if (document.documentElement.dataset.screenFit !== "contain") return full;
    const scale = Math.min(full.width / srcWidth, full.height / srcHeight);
    const width = Math.round(srcWidth * scale);
    const height = Math.round(srcHeight * scale);
    return { x: Math.floor((full.width - width) / 2), y: Math.floor((full.height - height) / 2), width, height };
  }

  private fitScreen(): void {
    if (!this.enabled) return;
    // Twice the CSS size is already several times the game's own pixels; a 3× phone screen would make every frame
    // run the upscaling passes over more than twice as many pixels for no visible gain.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.cssWidth * ratio));
    const height = Math.max(1, Math.round(this.cssHeight * ratio));
    if (this.screen.width !== width) this.screen.width = width;
    if (this.screen.height !== height) this.screen.height = height;
    this.present();
  }

  private init(): void {
    const gl = this.screen.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return;
    try {
      this.epx = this.compile(gl, EPX_FRAGMENT);
      this.sharp = this.compile(gl, SHARP_FRAGMENT);
    } catch (error) {
      console.warn("HQ display unavailable:", error);
      return;
    }
    const source = gl.createTexture();
    if (!source) return;
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.source = source;
    this.gl = gl;
  }

  private target(index: number, width: number, height: number): Target {
    const gl = this.gl!;
    const existing = this.targets[index];
    if (existing && existing.width === width && existing.height === height) return existing;
    if (existing) {
      gl.deleteTexture(existing.texture);
      gl.deleteFramebuffer(existing.framebuffer);
    }
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // The last pass is sampled with linear filtering by the sharp-bilinear shader; earlier ones use texelFetch.
    const filter = index === EPX_PASSES - 1 ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const target = { texture, framebuffer, width, height };
    this.targets[index] = target;
    return target;
  }

  private compile(gl: WebGL2RenderingContext, fragmentSource: string): Pass {
    const program = gl.createProgram();
    if (!program) throw new Error("createProgram failed");
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("createShader failed");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
    return {
      program,
      tex: gl.getUniformLocation(program, "tex"),
      srcSize: gl.getUniformLocation(program, "srcSize"),
      outSize: gl.getUniformLocation(program, "outSize"),
      flipY: gl.getUniformLocation(program, "flipY"),
    };
  }
}

let current: HqDisplay | undefined;

/** The display the emulator's frame loop presents through (when HQ is on). */
export const setCurrentDisplay = (display: HqDisplay | undefined): void => {
  current = display;
};

export const presentFrame = (): void => {
  current?.present();
};

const QUALITY_KEY = "wie_screen_quality";

export const loadScreenQuality = (): "hq" | "pixel" => {
  try {
    return window.localStorage.getItem(QUALITY_KEY) === "pixel" ? "pixel" : "hq";
  } catch {
    return "hq";
  }
};

export const storeScreenQuality = (value: "hq" | "pixel"): void => {
  try {
    window.localStorage.setItem(QUALITY_KEY, value);
  } catch {
    // storage unavailable
  }
};
