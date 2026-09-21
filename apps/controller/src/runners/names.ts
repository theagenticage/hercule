/**
 * The name a machine is given when it joins. Mythological names are short and
 * hard to confuse with each other, which a hostname or a random id is not.
 */

const NAMES = [
  "atlas",
  "calypso",
  "daedalus",
  "echo",
  "hermes",
  "hercule",
  "icarus",
  "iris",
  "janus",
  "morpheus",
  "nemesis",
  "nyx",
  "orpheus",
  "pandora",
  "perseus",
  "proteus",
  "selene",
  "thalia",
  "triton",
  "vesta",
] as const;

/** Past the pool the names come round with a number, so a big fleet still differs. */
export const pickName = (taken: ReadonlySet<string>): string => {
  for (let round = 1; ; round++) {
    for (const name of NAMES) {
      const candidate = round === 1 ? name : `${name}-${String(round)}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
};
