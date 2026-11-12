import type { CheatApi } from "./backend";

/** Read-only presentation adapter for the LGT 2009-03-10 binary (including the gameplay patches).
 * 0x3863c records damage at monster+0xaa, age at +0xac and kind at +0xae; kinds 1/2 do not
 * subtract HP. 0x17080 clamps the camera, and 0x1c868 adds the collider's world/render offsets.
 * These are observations of guest state, never a second combat simulation.
 */
const STATE = 0x01503ab0;
const STRIDE = 0x158;
const MAX_MONSTERS = 512;
const heap = (p: number): boolean => p >= 0x40000000 && p < 0x50000000;
const signed16 = (n: number): number => (n << 16) >> 16;

export interface HitView {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Same camera clamping as the native field renderer, including maps smaller than the viewport. */
export const cameraOffset = (offset: number, viewport: number, mapSize: number): number =>
  mapSize < viewport ? Math.floor((viewport - mapSize) / 2) : Math.max(viewport - mapSize, Math.min(0, offset));

export class Hl3HitTracker {
  readonly view: HitView = { x: 0, y: 0, width: 240, height: 320 };
  private supported: boolean | undefined;
  private table = 0;
  private map = 0;
  private count = 0;
  private readonly hp = new Uint16Array(MAX_MONSTERS);
  private readonly entities = new Uint32Array(MAX_MONSTERS);

  reset(): void {
    this.table = this.map = this.count = 0;
  }

  /** Called only after a new guest frame. Returning false also clears transient screen effects. */
  sample(api: Pick<CheatApi, "read">, hit: (x: number, y: number, damage: number) => void): boolean {
    const read = (address: number, width = 4) => api.read(address, width, false);
    if (read(STATE + 0x50) !== 4 || read(0x0150db48) !== 3) {
      this.reset();
      return false;
    }
    // Fail closed for a different edition instead of interpreting arbitrary guest memory as monsters.
    this.supported ??= read(0x38620) === 0x307eb500 && read(0x17080) === 0xb0a8b5f0;
    if (!this.supported) return false;

    const table = read(STATE + 0x9c94);
    const count = signed16(read(STATE + 0x9c98, 2));
    const map = read(STATE + 0x9c68);
    if (!heap(table) || !heap(map) || count < 0 || count > MAX_MONSTERS || table + count * STRIDE >= 0x50000000) {
      this.reset();
      return false;
    }
    const width = read(STATE + 0x44), height = read(STATE + 0x48);
    const mapWidth = signed16(read(map + 0x50, 2)), mapHeight = signed16(read(map + 0x52, 2));
    if (width !== 240 || height !== 320 || mapWidth <= 0 || mapHeight <= 0) {
      this.reset();
      return false;
    }
    this.view.x = cameraOffset(read(STATE + 0x9e6c) | 0, width, mapWidth);
    this.view.y = cameraOffset(read(STATE + 0x9e70) | 0, height, mapHeight);
    this.view.width = width;
    this.view.height = height;
    const baseline = table !== this.table || map !== this.map || count !== this.count;
    this.table = table;
    this.map = map;
    this.count = count;

    for (let i = 0; i < count; i++) {
      const record = table + i * STRIDE;
      const entity = read(record);
      const hp = read(record + 0x7e, 2);
      const damaged = !baseline && entity === this.entities[i] && hp < this.hp[i];
      this.hp[i] = hp;
      this.entities[i] = entity;
      if (!damaged || !heap(entity)) continue;
      const damage = signed16(read(record + 0xaa, 2));
      const age = signed16(read(record + 0xac, 2));
      const kind = signed16(read(record + 0xae, 2));
      // HP alone could change on spawn or a script. Require the native hit marker as well.
      if (damage <= 0 || kind !== 0 || age < 0 || age > 2) continue;
      const collider = read(entity + 0x18);
      if (!heap(collider)) continue;
      const flags = read(collider + 0x0c);
      if (((flags >>> 8) & 0xff) === 0xff || read(collider + 4, 2) % 256 !== 5) continue;
      const offsets = read(collider + 0x14, 2);
      const x = signed16(read(collider + 0x10, 2)) + (offsets & 0xff);
      const y = signed16(read(collider + 0x12, 2)) + (offsets >>> 8) - 12;
      const sx = x + this.view.x, sy = y + this.view.y;
      if (sx < 0 || sx >= width || sy < 0 || sy >= height - 28) continue;
      hit(x, y, damage);
    }
    return !baseline;
  }
}
