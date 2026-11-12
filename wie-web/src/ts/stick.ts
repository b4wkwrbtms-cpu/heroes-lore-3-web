import type { Direction } from "./pad_profile";

/** Keys held in each 45° sector, clockwise from right (screen y grows downward). */
export const OCTANT_DIRECTIONS: readonly (readonly Direction[])[] = [
  ["RIGHT"],
  ["DOWN", "RIGHT"],
  ["DOWN"],
  ["DOWN", "LEFT"],
  ["LEFT"],
  ["UP", "LEFT"],
  ["UP"],
  ["UP", "RIGHT"],
];

/**
 * Straight sectors are wider than diagonal ones (52° against 38°): a thumb drifting a little off a corridor keeps
 * walking straight, and a diagonal needs a clear push towards the corner.
 */
const STRAIGHT_HALF_DEG = 26;
const DIAGONAL_HALF_DEG = 45 - STRAIGHT_HALF_DEG;
/** A held sector is kept until the thumb is this far past its edge, so the border does not flicker. */
const HYSTERESIS_DEG = 8;

const halfWidth = (octant: number): number => (octant % 2 === 0 ? STRAIGHT_HALF_DEG : DIAGONAL_HALF_DEG);

/** Signed difference between `angle` and the sector's centre, in (-180, 180]. */
const offset = (angle: number, octant: number): number => {
  const difference = (((angle - octant * 45) % 360) + 360) % 360;
  return difference > 180 ? difference - 360 : difference;
};

/** Sector for a stick angle in degrees (0 right, 90 down), keeping `current` while the angle stays near it. */
export const pickOctant = (angle: number, current?: number): number => {
  if (current !== undefined && Math.abs(offset(angle, current)) <= halfWidth(current) + HYSTERESIS_DEG) return current;
  for (let octant = 0; octant < OCTANT_DIRECTIONS.length; octant++) {
    if (Math.abs(offset(angle, octant)) <= halfWidth(octant)) return octant;
  }
  return 0;
};

/** Straight sector (0, 2, 4 or 6) for cursor windows, which move one step per key and ignore a second held key. */
export const pickStraight = (angle: number, current?: number): number => {
  if (current !== undefined && current % 2 === 0 && Math.abs(offset(angle, current)) <= 45 + HYSTERESIS_DEG) return current;
  return (Math.round(angle / 90) % 4) * 2;
};
