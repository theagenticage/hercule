/**
 * Formats a byte count for people to read.
 *
 * A runner reports every size in bytes, and a fleet row is scanned rather than
 * studied, so sizes use the largest unit that still gives a number of at least
 * one: whole numbers from ten up, one decimal below ten.
 */

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Formats `68719476736` as `64 GiB` and `1288490188` as `1.2 GiB`. */
export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Round before choosing the final unit, so a value that rounds up to 1024
  // moves to the next unit instead of being shown as `1024 MiB`.
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded === 1024 && unit < UNITS.length - 1
    ? `1 ${UNITS[unit + 1]}`
    : `${String(rounded)} ${UNITS[unit]}`;
};
