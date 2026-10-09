import { describe, expect, it } from "vitest";
import { buildHueStyle } from "./face";
import {
  buildAssistantLook,
  buildLook,
  HEADWEAR,
  HUES,
  hashSeed,
  SHAPES,
  WARDROBE,
  type Look,
} from "./look";

// Computed with the Bureau book's own `hash` and `lookFor` in crew.js.
const VECTORS: ReadonlyArray<readonly [seed: string, hash: number, look: Look]> = [
  ["", 1698511862, { hue: "mint", shape: "wide", accessories: ["tache"], headwear: null }],
  ["a", 2426549645, { hue: "peach", shape: "egg", accessories: ["watch"], headwear: null }],
  [
    "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60",
    2687217523,
    { hue: "lime", shape: "wide", accessories: ["tache", "bowtie"], headwear: null },
  ],
  [
    "0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61",
    2737239707,
    { hue: "lime", shape: "tall", accessories: ["glasses"], headwear: null },
  ],
  [
    "0199a3c4-0d12-7a55-8b10-3e9f7c21d0aa",
    301455944,
    { hue: "iris", shape: "egg", accessories: ["bowtie"], headwear: null },
  ],
  // The book's cast table gives this name peach, egg and a tache. The app
  // never uses the cast table: every seed is hashed.
  [
    "Fix 3-D Secure checkout for EU cards",
    1898525329,
    { hue: "teal", shape: "tall", accessories: ["bowtie"], headwear: null },
  ],
];

/** The controller's id format: a canonical lowercase UUIDv7. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Returns `count` ids shaped like the controller's session ids. Their
 * timestamps are consecutive milliseconds from a fixed clock, and their other
 * bits come from a pseudo-random generator with a fixed start, so every run
 * checks the same ids.
 */
function buildSessionIds(count: number): ReadonlyArray<string> {
  let state = 1;
  const randomDigit = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 28;
  };
  const randomHex = (digits: number): string =>
    Array.from({ length: digits }, () => randomDigit().toString(16)).join("");
  const firstMillisecond = 0x0199a3c27b41;
  return Array.from({ length: count }, (_, index) => {
    const time = (firstMillisecond + index).toString(16).padStart(12, "0");
    const variant = (8 + (randomDigit() % 4)).toString(16);
    return `${time.slice(0, 8)}-${time.slice(8)}-7${randomHex(3)}-${variant}${randomHex(3)}-${randomHex(12)}`;
  });
}

describe("hashSeed", () => {
  it.each(VECTORS)("hashes %j to the book's %i", (seed, hash) => {
    expect(hashSeed(seed)).toBe(hash);
  });
});

describe("buildLook", () => {
  it.each(VECTORS)("gives %j the book's look", (seed, _hash, look) => {
    expect(buildLook(seed)).toEqual(look);
  });

  it("reaches every hue, shape and wardrobe entry from 1000 session ids", () => {
    const ids = buildSessionIds(1000);
    expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
    const looks = ids.map(buildLook);
    expect(new Set(looks.map((look) => look.hue))).toEqual(new Set(HUES));
    expect(new Set(looks.map((look) => look.shape))).toEqual(new Set(SHAPES));
    expect(new Set(looks.map((look) => look.accessories))).toEqual(new Set(WARDROBE));
  });

  it("returns one shared, frozen object for every seed with the same look", () => {
    const firstByLook = new Map<string, Look>();
    for (const look of buildSessionIds(1000).map(buildLook)) {
      expect(Object.isFrozen(look)).toBe(true);
      const key = `${look.hue} ${look.shape} ${look.accessories.join("+")}`;
      const first = firstByLook.get(key);
      if (first === undefined) firstByLook.set(key, look);
      else expect(look).toBe(first);
    }
    // At most 256 looks exist, so most of the 1000 seeds repeat a look.
    expect(firstByLook.size).toBeLessThanOrEqual(256);
  });
});

describe("buildAssistantLook", () => {
  const ids = buildSessionIds(1000);

  it("keeps the hue and shape buildLook gives the id, and drops only a homburg", () => {
    for (const id of ids) {
      const thread = buildLook(id);
      const assistant = buildAssistantLook(id);
      expect(assistant.hue).toBe(thread.hue);
      expect(assistant.shape).toBe(thread.shape);
      expect(assistant.accessories).toEqual(
        thread.accessories.filter((accessory) => accessory !== "homburg"),
      );
      expect(assistant.headwear).not.toBeNull();
    }
  });

  it("picks the headwear from the hash's bits 12-13", () => {
    for (const id of ids) {
      expect(buildAssistantLook(id).headwear).toBe(HEADWEAR[(hashSeed(id) >>> 12) % 3]);
    }
  });

  it("reaches every headwear, and drops a homburg, from 1000 ids", () => {
    expect(new Set(ids.map((id) => buildAssistantLook(id).headwear))).toEqual(new Set(HEADWEAR));
    const homburgIds = ids.filter((id) => buildLook(id).accessories.includes("homburg"));
    expect(homburgIds.length).toBeGreaterThan(0);
  });

  it("returns the same frozen object for the same id, every time", () => {
    for (const id of ids) {
      const look = buildAssistantLook(id);
      expect(Object.isFrozen(look)).toBe(true);
      expect(buildAssistantLook(id)).toBe(look);
    }
  });

  it("never gives a thread's look any headwear", () => {
    expect(ids.every((id) => buildLook(id).headwear === null)).toBe(true);
  });
});

describe("buildHueStyle", () => {
  it("sets --hue to the hue's token", () => {
    expect(buildHueStyle("teal")).toEqual({ "--hue": "var(--hue-teal)" });
  });
});
