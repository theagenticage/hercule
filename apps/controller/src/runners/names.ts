/**
 * The name a machine is given when it joins.
 *
 * A runner needs something to be called before anybody has looked at it, and a
 * name is how a person picks one row out of a fleet. Mythological names are
 * short, memorable and hard to confuse with each other, which a hostname or a
 * random id is not; the owner renames whenever they like.
 */

/** The pool, in the order it is handed out. */
const NAMES = [
  "atlas",
  "calypso",
  "daedalus",
  "echo",
  "hermes",
  "hydra",
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

/**
 * The first name in the pool nobody holds. Once the pool is used up the names
 * come round again with a number on them, so a fleet larger than the pool still
 * gets distinct names rather than a collision.
 */
export const pickName = (taken: ReadonlySet<string>): string => {
  for (let round = 1; ; round++) {
    for (const name of NAMES) {
      const candidate = round === 1 ? name : `${name}-${String(round)}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
};
