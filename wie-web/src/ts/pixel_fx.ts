/**
 * Hit effects drawn the way the 영웅서기5 player draws them: in squares on the game's own pixel grid, so they read as
 * part of the pixel art rather than as smooth vector lines over it. The context is scaled to game pixels; `offsetX`
 * and `offsetY` move map coordinates onto the screen. Colour and alpha come from the context's fill style.
 */
export const pixelPen = (ctx: CanvasRenderingContext2D, offsetX: number, offsetY: number) => {
  /** One square of `size` game pixels centred on (x, y). */
  const dot = (x: number, y: number, size: number): void =>
    ctx.fillRect(Math.round(x + offsetX - size / 2), Math.round(y + offsetY - size / 2), size, size);
  const line = (x0: number, y0: number, x1: number, y1: number, size: number): void => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= steps; i++) dot(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, size);
  };
  /** A dotted ellipse. */
  const ring = (x: number, y: number, radiusX: number, radiusY: number): void => {
    const points = Math.max(12, Math.ceil(Math.max(radiusX, radiusY) * 4.2));
    for (let i = 0; i < points; i++) {
      const angle = (i / points) * Math.PI * 2;
      dot(x + Math.cos(angle) * radiusX, y + Math.sin(angle) * radiusY, 1);
    }
  };
  /** A star of four long rays and four short ones, from `inner` out to `length`, a little flat like the ground. */
  const star = (x: number, y: number, length: number, inner: number): void => {
    for (let i = 0; i < 8; i++) {
      const angle = (i * Math.PI) / 4, reach = i % 2 ? length * 0.55 : length;
      if (reach <= inner) continue;
      line(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner * 0.8, x + Math.cos(angle) * reach, y + Math.sin(angle) * reach * 0.8, 1);
    }
  };
  return { dot, line, ring, star };
};
