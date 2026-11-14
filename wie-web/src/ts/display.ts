/**
 * Optional WebGL presenter for the 240×320 game image.
 *
 * The emulator paints into its own canvas with putImageData; when "고화질" is on we treat that canvas as a
 * texture, run only the Scale2x (EPX) passes needed for the display size and finally draw it with a
 * "sharp bilinear" filter, which keeps pixels crisp at the fractional scale factors phones end up with
 * instead of the uneven columns `image-rendering: pixelated` produces.
 *
 * A game's DisplayStyle can instead ask for the edge-directed upscaler (smooth diagonals and the 2:1 slopes of
 * isometric tiles, drawn straight at the display size) and a glow around bright, coloured light.
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

// Finishing a picture: the blurred bright parts are screen-blended in, `glow` strong, and `vivid` lifts the
// saturation and contrast of a muted palette a little.
const GLOW = `
uniform sampler2D bloom;
uniform float glow;
uniform float vivid;
vec3 withGlow(vec3 c) {
  if (glow > 0.0) c = 1.0 - (1.0 - c) * (1.0 - clamp(texture(bloom, uv).rgb * glow, 0.0, 1.0));
  if (vivid > 0.0) {
    c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, 1.0 + 0.16 * vivid);
    c = (c - 0.5) * (1.0 + 0.07 * vivid) + 0.5;
  }
  return clamp(c, 0.0, 1.0);
}`;

// Sharp bilinear: interpolate only across texel boundaries, within one output pixel.
const SHARP_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 srcSize;
uniform vec2 outSize;
in vec2 uv;
out vec4 color;
${GLOW}
void main() {
  vec2 scale = max(outSize / srcSize, vec2(1.0));
  vec2 texel = uv * srcSize;
  vec2 f = fract(texel) - 0.5;
  vec2 sharp = clamp(f * scale, vec2(-0.5), vec2(0.5)) + 0.5;
  vec2 st = (floor(texel) + sharp) / srcSize;
  color = vec4(withGlow(texture(tex, st).rgb), 1.0);
}`;

// Edge-directed upscaling, first pass (one fragment per game pixel): for each corner of the pixel, whether it sits on
// the far side of an edge, comparing how well the neighbourhood lines up along the two diagonals, and whether that
// edge is 45° or one of the 2:1 slopes isometric tiles are made of. Each corner is a code in one channel: 0 none,
// else 1 + 2 shallow + 4 steep + 8 when it takes the colour below rather than beside (as if it were bottom-right).
const XBR_DECIDE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 srcSize;
in vec2 uv;
out vec4 color;
vec3 px(ivec2 p, ivec2 o) { return texelFetch(tex, clamp(p + o, ivec2(0), ivec2(srcSize) - 1), 0).rgb; }
float wd(vec3 a, vec3 b) {
  vec3 d = a - b;
  return 48.0 * abs(dot(d, vec3(0.299, 0.587, 0.114))) + 7.0 * abs(dot(d, vec3(-0.169, -0.331, 0.5)))
    + 6.0 * abs(dot(d, vec3(0.5, -0.419, -0.081)));
}
bool eq(vec3 a, vec3 b) { return wd(a, b) < 2.4; }
float corner(vec3 E, vec3 B, vec3 D, vec3 F, vec3 H, vec3 C, vec3 G, vec3 I, vec3 F4, vec3 H5, vec3 I4, vec3 I5) {
  if (eq(E, F) || eq(E, H)) return 0.0;
  bool keep = (!eq(F, B) && !eq(H, D)) || (eq(E, I) && !eq(F, I4) && !eq(H, I5)) || eq(E, G) || eq(E, C);
  if (!keep) return 0.0;
  float slash = wd(E, C) + wd(E, G) + wd(I, F4) + wd(I, H5) + 4.0 * wd(H, F);
  float back = wd(H, D) + wd(H, I5) + wd(F, I4) + wd(F, B) + 4.0 * wd(E, I);
  if (slash >= back) return 0.0;
  float v = 1.0, fg = wd(F, G), hc = wd(H, C);
  if (2.0 * fg <= hc && !eq(E, G) && !eq(D, G)) v += 2.0;
  if (fg >= 2.0 * hc && !eq(E, C) && !eq(B, C)) v += 4.0;
  if (wd(E, F) > wd(E, H)) v += 8.0;
  return v;
}
void main() {
  ivec2 p = ivec2(floor(uv * srcSize));
  vec3 A1 = px(p, ivec2(-1, -2)), B1 = px(p, ivec2(0, -2)), C1 = px(p, ivec2(1, -2));
  vec3 A0 = px(p, ivec2(-2, -1)), A = px(p, ivec2(-1, -1)), B = px(p, ivec2(0, -1)), C = px(p, ivec2(1, -1)), C4 = px(p, ivec2(2, -1));
  vec3 D0 = px(p, ivec2(-2, 0)), D = px(p, ivec2(-1, 0)), E = px(p, ivec2(0)), F = px(p, ivec2(1, 0)), F4 = px(p, ivec2(2, 0));
  vec3 G0 = px(p, ivec2(-2, 1)), G = px(p, ivec2(-1, 1)), H = px(p, ivec2(0, 1)), I = px(p, ivec2(1, 1)), I4 = px(p, ivec2(2, 1));
  vec3 G5 = px(p, ivec2(-1, 2)), H5 = px(p, ivec2(0, 2)), I5 = px(p, ivec2(1, 2));
  // bottom-right, top-right, top-left, bottom-left: the neighbourhood turned so each is bottom-right
  color = vec4(corner(E, B, D, F, H, C, G, I, F4, H5, I4, I5), corner(E, D, H, B, F, A, I, C, B1, F4, C1, C4),
               corner(E, H, F, D, B, G, C, A, D0, B1, A0, A1), corner(E, F, B, H, D, I, A, G, H5, D0, G5, G0)) / 255.0;
}`;

// Edge-directed upscaling, second pass at the display size: the decided part of each pixel takes the neighbour's
// colour, with a step across the edge line one display pixel wide.
const XBR_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform sampler2D decisions;
uniform vec2 srcSize;
uniform vec2 outSize;
in vec2 uv;
out vec4 color;
${GLOW}
vec3 px(ivec2 p, ivec2 o) { return texelFetch(tex, clamp(p + o, ivec2(0), ivec2(srcSize) - 1), 0).rgb; }
void apply(float v, float s, float t, vec3 F, vec3 H, float d, inout float best, inout vec3 col) {
  if (v < 0.5) return;
  float m = smoothstep(0.5 - d * 1.414, 0.5 + d * 1.414, s + t);
  if (mod(floor(v / 2.0), 2.0) > 0.5) m = max(m, smoothstep(0.25 - d * 1.118, 0.25 + d * 1.118, t + 0.5 * s));
  if (mod(floor(v / 4.0), 2.0) > 0.5) m = max(m, smoothstep(0.25 - d * 1.118, 0.25 + d * 1.118, s + 0.5 * t));
  if (m > best) { best = m; col = v >= 8.0 ? H : F; }
}
void main() {
  vec2 q = uv * srcSize;
  ivec2 p = ivec2(floor(q));
  vec2 f = q - floor(q) - 0.5;
  vec3 E = px(p, ivec2(0));
  vec4 code = floor(texelFetch(decisions, p, 0) * 255.0 + 0.5);
  vec3 c = E;
  if (code.r + code.g + code.b + code.a > 0.5) {
    vec3 R = px(p, ivec2(1, 0)), Dn = px(p, ivec2(0, 1)), U = px(p, ivec2(0, -1)), L = px(p, ivec2(-1, 0));
    float d = 0.5 * srcSize.x / outSize.x, best = 0.0;
    vec3 col = E;
    apply(code.r, f.x, f.y, R, Dn, d, best, col);
    apply(code.g, -f.y, f.x, U, R, d, best, col);
    apply(code.b, -f.x, -f.y, L, U, d, best, col);
    apply(code.a, f.y, -f.x, Dn, L, d, best, col);
    c = mix(E, col, best);
  }
  color = vec4(withGlow(c), 1.0);
}`;

// Glow source: the bright, coloured parts (fire, magic, sparks) at half size; white and grey panels stay out.
const BRIGHT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 srcSize;
in vec2 uv;
out vec4 color;
void main() {
  vec3 c = texture(tex, uv).rgb; // between four game pixels: their average
  float m = max(c.r, max(c.g, c.b)), n = min(c.r, min(c.g, c.b));
  float sat = (m - n) / max(m, 0.001);
  color = vec4(c * smoothstep(0.5, 0.9, m) * smoothstep(0.3, 0.7, sat), 1.0);
}`;

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D tex;
uniform vec2 srcSize;
uniform vec2 direction;
in vec2 uv;
out vec4 color;
void main() {
  vec2 d = direction / srcSize;
  vec3 c = texture(tex, uv).rgb * 0.227;
  c += (texture(tex, uv + d * 1.385).rgb + texture(tex, uv - d * 1.385).rgb) * 0.316;
  c += (texture(tex, uv + d * 3.231).rgb + texture(tex, uv - d * 3.231).rgb) * 0.070;
  color = vec4(c, 1.0);
}`;

/**
 * How the HQ display draws a game: which upscaler, how strong the glow of bright light is (0: none) and how much
 * the colours are lifted (0: as the game draws them).
 */
export interface DisplayStyle {
  upscaler: "epx" | "xbr";
  glow: number;
  vivid: number;
}

export const DEFAULT_DISPLAY_STYLE: DisplayStyle = { upscaler: "epx", glow: 0, vivid: 0 };
/** The look of the 영웅서기5 player: smooth edges, a soft glow around fire and magic, slightly richer colours. */
export const HD_DISPLAY_STYLE: DisplayStyle = { upscaler: "xbr", glow: 0.6, vivid: 1 };

interface Pass {
  program: WebGLProgram;
  tex: WebGLUniformLocation | null;
  srcSize: WebGLUniformLocation | null;
  outSize: WebGLUniformLocation | null;
  flipY: WebGLUniformLocation | null;
  decisions: WebGLUniformLocation | null;
  bloom: WebGLUniformLocation | null;
  glow: WebGLUniformLocation | null;
  vivid: WebGLUniformLocation | null;
  direction: WebGLUniformLocation | null;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

const MAX_EPX_PASSES = 2;

export class HqDisplay {
  private gl: WebGL2RenderingContext | undefined;
  private epx: Pass | undefined;
  private sharp: Pass | undefined;
  private xbrDecide: Pass | undefined;
  private xbr: Pass | undefined;
  private bright: Pass | undefined;
  private blur: Pass | undefined;
  private style: DisplayStyle = DEFAULT_DISPLAY_STYLE;
  private source: WebGLTexture | undefined;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private targets: Target[] = [];
  private enabled = false;
  private requested = false;
  private contextLost = false;
  private readonly observer: ResizeObserver | undefined;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(
    private readonly game: HTMLCanvasElement,
    private readonly screen: HTMLCanvasElement,
  ) {
    screen.addEventListener("webglcontextlost", this.onContextLost);
    screen.addEventListener("webglcontextrestored", this.onContextRestored);
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
    this.requested = on;
    if (on && !this.contextLost && !this.gl) this.init();
    this.enabled = on && this.gl !== undefined;
    this.screen.hidden = !this.enabled;
    this.game.classList.toggle("hq-source", this.enabled);
    if (this.enabled) this.fitScreen();
  }

  setStyle(style: DisplayStyle): void {
    this.style = style;
    this.compileStyle();
    this.present();
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
    if (this.sourceWidth !== srcWidth || this.sourceHeight !== srcHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.game);
      this.sourceWidth = srcWidth;
      this.sourceHeight = srcHeight;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.game);
    }

    const view = this.viewport(srcWidth, srcHeight);
    const bloom = this.style.glow > 0 ? this.bloom(srcWidth, srcHeight) : undefined;
    if (this.style.upscaler === "xbr" && this.xbrDecide && this.xbr) {
      const decisions = this.target(2, srcWidth, srcHeight);
      this.pass(this.xbrDecide, this.source, srcWidth, srcHeight, decisions);
      this.clearScreen(view);
      this.pass(this.xbr, this.source, srcWidth, srcHeight, undefined, () => {
        gl.uniform2f(this.xbr!.outSize, view.width, view.height);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, decisions.texture);
        gl.uniform1i(this.xbr!.decisions, 1);
        this.useGlow(this.xbr!, bloom);
      });
      return;
    }
    // A small viewport needs only 0–1 passes; always expanding to 4× softens it again on downsampling.
    const scale = Math.max(view.width / srcWidth, view.height / srcHeight);
    const passes = Math.min(MAX_EPX_PASSES, Math.max(0, Math.ceil(Math.log2(scale))));
    let texture = this.source;
    let width = srcWidth;
    let height = srcHeight;
    for (let pass = 0; pass < passes; pass += 1) {
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

    this.clearScreen(view);
    gl.useProgram(this.sharp.program);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.sharp.tex, 0);
    gl.uniform2f(this.sharp.srcSize, width, height);
    gl.uniform2f(this.sharp.outSize, view.width, view.height);
    gl.uniform1f(this.sharp.flipY, 1);
    this.useGlow(this.sharp, bloom);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Clears the screen canvas and leaves the viewport on the picture's place in it. */
  private clearScreen(view: { x: number; y: number; width: number; height: number }): void {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.screen.width, this.screen.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(view.x, view.y, view.width, view.height);
  }

  /**
   * Runs one pass over `texture` (`width`×`height`): into `target` at its size, or onto the screen in the current
   * viewport, flipped right side up. `uniforms` sets the pass's own uniforms, with the program in use.
   */
  private pass(pass: Pass, texture: WebGLTexture, width: number, height: number, target: Target | undefined, uniforms?: () => void): void {
    const gl = this.gl!;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
    }
    gl.useProgram(pass.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(pass.tex, 0);
    gl.uniform2f(pass.srcSize, width, height);
    gl.uniform1f(pass.flipY, target ? 0 : 1);
    uniforms?.();
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** The bright, coloured parts of the frame at half size, blurred: what the glow adds over the picture. */
  private bloom(srcWidth: number, srcHeight: number): WebGLTexture | undefined {
    if (!this.bright || !this.blur || !this.source) return undefined;
    const gl = this.gl!;
    const width = Math.max(1, srcWidth >> 1), height = Math.max(1, srcHeight >> 1);
    const a = this.target(3, width, height), b = this.target(4, width, height);
    this.pass(this.bright, this.source, srcWidth, srcHeight, a);
    for (const [from, to, dx, dy] of [[a, b, 1, 0], [b, a, 0, 1], [a, b, 2, 0], [b, a, 0, 2]] as const) {
      this.pass(this.blur, from.texture, width, height, to, () => gl.uniform2f(this.blur!.direction, dx, dy));
    }
    return a.texture;
  }

  private useGlow(pass: Pass, bloom: WebGLTexture | undefined): void {
    const gl = this.gl!;
    gl.uniform1f(pass.glow, bloom ? this.style.glow : 0);
    gl.uniform1f(pass.vivid, this.style.vivid);
    if (!bloom) return;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bloom);
    gl.uniform1i(pass.bloom, 2);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.screen.removeEventListener("webglcontextlost", this.onContextLost);
    this.screen.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.setEnabled(false);
    this.release();
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    // Keep the game visible on its 2D canvas while iOS restores GPU resources.
    this.enabled = false;
    this.screen.hidden = true;
    this.game.classList.remove("hq-source");
    this.release();
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.setEnabled(this.requested);
  };

  private release(): void {
    if (this.gl && !this.contextLost) {
      for (const target of this.targets) {
        this.gl.deleteTexture(target.texture);
        this.gl.deleteFramebuffer(target.framebuffer);
      }
      if (this.source) this.gl.deleteTexture(this.source);
      for (const pass of [this.epx, this.sharp, this.xbrDecide, this.xbr, this.bright, this.blur]) {
        if (pass) this.gl.deleteProgram(pass.program);
      }
    }
    this.targets = [];
    this.source = undefined;
    this.epx = this.sharp = this.xbrDecide = this.xbr = this.bright = this.blur = undefined;
    this.gl = undefined;
    this.sourceWidth = this.sourceHeight = 0;
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
    this.gl = gl;
    try {
      this.epx = this.compile(gl, EPX_FRAGMENT);
      this.sharp = this.compile(gl, SHARP_FRAGMENT);
    } catch (error) {
      console.warn("HQ display unavailable:", error);
      this.release();
      return;
    }
    const source = gl.createTexture();
    if (!source) {
      this.release();
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.source = source;
    this.gl = gl;
    this.compileStyle();
  }

  /** Compiles the passes the style needs, once; without them the picture falls back to EPX and no glow. */
  private compileStyle(): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;
    try {
      if (this.style.upscaler === "xbr" && !this.xbr) {
        this.xbrDecide = this.compile(gl, XBR_DECIDE_FRAGMENT);
        this.xbr = this.compile(gl, XBR_FRAGMENT);
      }
      if (this.style.glow > 0 && !this.blur) {
        this.bright = this.compile(gl, BRIGHT_FRAGMENT);
        this.blur = this.compile(gl, BLUR_FRAGMENT);
      }
    } catch (error) {
      console.warn("HQ display style unavailable:", error);
    }
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
    // Any pass can now be the final pass. EPX uses texelFetch, independent of this filter.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, VERTEX],
        [gl.FRAGMENT_SHADER, fragmentSource],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("createShader failed");
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const message = gl.getShaderInfoLog(shader) ?? "shader compile failed";
          gl.deleteShader(shader);
          throw new Error(message);
        }
        gl.attachShader(program, shader);
        gl.deleteShader(shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program link failed");
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    }
    return {
      program,
      tex: gl.getUniformLocation(program, "tex"),
      srcSize: gl.getUniformLocation(program, "srcSize"),
      outSize: gl.getUniformLocation(program, "outSize"),
      flipY: gl.getUniformLocation(program, "flipY"),
      decisions: gl.getUniformLocation(program, "decisions"),
      bloom: gl.getUniformLocation(program, "bloom"),
      glow: gl.getUniformLocation(program, "glow"),
      vivid: gl.getUniformLocation(program, "vivid"),
      direction: gl.getUniformLocation(program, "direction"),
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
