/**
 * The name a runner gets when it joins. Mythological names are short and hard
 * to confuse with each other, unlike hostnames or random ids.
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

/**
 * Returns the first name in the list that is not in `taken`. Once every name is
 * taken, the names repeat with a number (`atlas-2`), so a large fleet still has
 * unique names.
 */
export const pickName = (taken: ReadonlySet<string>): string => {
  for (let round = 1; ; round++) {
    for (const name of NAMES) {
      const candidate = round === 1 ? name : `${name}-${String(round)}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
};
