/**
 * 영웅서기4: the pad's quick-slot keys show what the game's own slot bar holds (skills, potions, the weapon on 5), as
 * the touch pads of the series' smartphone games do. The slot bar sits at the bottom of the 240×320 field screen:
 * the icon of each slot is the 15×13 square inside its frame. Icons are copied from the game's own frame only while
 * the slot bar is showing (its frame pixels match), so menus, scenes and the title leave the last icons in place. An
 * empty slot (black inside) shows the key's number alone.
 */
export const HL4_SLOT_ICONS: Record<string, number> = { "1": 57, "3": 77, OK: 97, "7": 127, "9": 147, "0": 167 };
const ICON_Y = 297;
const ICON_WIDTH = 15;
const ICON_HEIGHT = 13;
/** Slot bar strip read to recognise it: x 50..190, y 293..311. */
const STRIP = { x: 50, y: 293, width: 140, height: 19 };
/** Frame pixels of the slot bar: [x, y, r, g, b]. */
const FRAME: ReadonlyArray<readonly [number, number, number, number, number]> = [
  ...Object.values(HL4_SLOT_ICONS).flatMap(x => [
    [x - 3, 297, 0, 0, 0],
    [x - 3, 305, 0, 0, 0],
    [x + 16, 300, 74, 73, 58],
  ] as const),
  [60, 311, 8, 8, 8],
  [100, 311, 8, 8, 8],
  [140, 311, 8, 8, 8],
  [180, 311, 8, 8, 8],
];

/** Whether `strip` (the slot bar strip of a frame, RGBA) shows the slot bar. */
export const showsSlotBar = (strip: Uint8ClampedArray): boolean => FRAME.every(([x, y, r, g, b]) => {
  const index = ((y - STRIP.y) * STRIP.width + (x - STRIP.x)) * 4;
  return Math.abs(strip[index] - r) <= 6 && Math.abs(strip[index + 1] - g) <= 6 && Math.abs(strip[index + 2] - b) <= 6;
});

/** Whether the slot whose icon starts at `left` is empty in `strip`: nothing but black inside its frame. */
export const isEmptySlot = (strip: Uint8ClampedArray, left: number): boolean => {
  for (let y = ICON_Y; y < ICON_Y + ICON_HEIGHT; y++) {
    for (let x = left; x < left + ICON_WIDTH; x++) {
      const index = ((y - STRIP.y) * STRIP.width + (x - STRIP.x)) * 4;
      if (strip[index] > 16 || strip[index + 1] > 16 || strip[index + 2] > 16) return false;
    }
  }
  return true;
};

/** Frames between reads of the slot bar: icons change only when the player sets a slot or swaps the belt. */
const EVERY = 4;

export class Hl4SlotIcons {
  private readonly icons = new Map<string, HTMLCanvasElement>();
  private frames = 0;

  constructor(private readonly game: HTMLCanvasElement, buttons: Iterable<HTMLButtonElement>) {
    for (const button of buttons) {
      const key = button.dataset.defaultKey;
      if (!key || !(key in HL4_SLOT_ICONS) || !button.closest(".action-cluster")) continue;
      const icon = document.createElement("canvas");
      icon.className = "slot-icon";
      icon.width = ICON_WIDTH;
      icon.height = ICON_HEIGHT;
      icon.hidden = true;
      icon.setAttribute("aria-hidden", "true");
      button.prepend(icon);
      this.icons.set(key, icon);
    }
  }

  /** Called after a new guest frame. */
  update(): void {
    if (this.frames++ % EVERY !== 0) return;
    const source = this.game.getContext("2d");
    if (!source || this.game.width !== 240 || this.game.height !== 320) return;
    const strip = source.getImageData(STRIP.x, STRIP.y, STRIP.width, STRIP.height).data;
    if (!showsSlotBar(strip)) return;
    for (const [key, icon] of this.icons) {
      const context = icon.getContext("2d");
      if (!context) continue;
      icon.hidden = isEmptySlot(strip, HL4_SLOT_ICONS[key]);
      if (icon.hidden) continue;
      context.clearRect(0, 0, ICON_WIDTH, ICON_HEIGHT);
      context.drawImage(this.game, HL4_SLOT_ICONS[key], ICON_Y, ICON_WIDTH, ICON_HEIGHT, 0, 0, ICON_WIDTH, ICON_HEIGHT);
    }
  }

  dispose(): void {
    for (const icon of this.icons.values()) icon.remove();
    this.icons.clear();
  }
}
