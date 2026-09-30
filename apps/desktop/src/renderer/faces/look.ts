/** The eight hues of the crew wheel, in the order the hash picks them. Each names a `--hue-<hue>` token. */
export const HUES = ["iris", "teal", "orchid", "lime", "sky", "peach", "mint", "grape"] as const;
/** One hue of the crew wheel. */
export type Hue = (typeof HUES)[number];

/** The four body shapes, in the order the hash picks them. */
export const SHAPES = ["egg", "tall", "round", "wide"] as const;
/** One body shape. */
export type Shape = (typeof SHAPES)[number];

/** One small thing a colleague wears: a hat, a moustache, glasses, a tie or a watch. */
export type Accessory = "homburg" | "bowtie" | "tache" | "monocle" | "watch" | "glasses";

/** What a colleague looks like: its hue, its body shape, and what it wears, in drawing order. */
export interface Look {
  readonly hue: Hue;
  readonly shape: Shape;
  readonly accessories: ReadonlyArray<Accessory>;
}

/**
 * The eight sets of accessories a colleague can wear, in the order the hash
 * picks them: the Bureau book's ACCESSORIES table. Each set is in drawing
 * order, so "tache, bowtie" draws the tache first.
 */
export const WARDROBE: ReadonlyArray<ReadonlyArray<Accessory>> = [
  [],
  ["homburg"],
  ["bowtie"],
  ["tache"],
  ["monocle"],
  ["watch"],
  ["glasses"],
  ["tache", "bowtie"],
];

/**
 * Hashes text to an unsigned 32-bit integer: FNV-1a over the UTF-16 code
 * units, then a final mix so that seeds differing in one character spread
 * over every hue. Identical to `hash` in the Bureau book's crew.js.
 */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 16;
  return h >>> 0;
}

// Every look built so far, indexed by its hue, shape and wardrobe entry. There
// are only 8 x 4 x 8 = 256 looks, so each is built once and then shared.
const builtLooks: Array<Look | undefined> = [];

/**
 * Returns the look a seed always gets: the hash's low 3 bits pick the hue,
 * bits 4-5 the shape, bits 8-10 the wardrobe. A thread's seed is its session
 * id, exactly as the API returns it.
 *
 * Every seed with the same look gets the same frozen object. A face whose
 * look did not change then receives the same prop again, so React can skip
 * rendering it.
 */
export function buildLook(seed: string): Look {
  const h = hashSeed(seed);
  const hue = h % 8;
  const shape = (h >>> 4) % 4;
  const wardrobeEntry = (h >>> 8) % 8;
  return (builtLooks[(wardrobeEntry * 4 + shape) * 8 + hue] ??= Object.freeze({
    hue: HUES[hue]!,
    shape: SHAPES[shape]!,
    accessories: WARDROBE[wardrobeEntry]!,
  }));
}
