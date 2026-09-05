/**
 * A byte count as a person reads it.
 *
 * Every size a runner reports is in bytes, and a fleet row is scanned rather
 * than studied, so what a row wants is the largest unit that leaves a figure
 * someone can hold: whole numbers from ten up, one decimal below that.
 */

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** `68719476736` reads `64 GiB`; `1288490188` reads `1.2 GiB`. */
export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Rounded before the unit is settled, so a figure that rounds up to 1024
  // climbs rather than being written as `1024 MiB`.
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded === 1024 && unit < UNITS.length - 1
    ? `1 ${UNITS[unit + 1]}`
    : `${String(rounded)} ${UNITS[unit]}`;
};
