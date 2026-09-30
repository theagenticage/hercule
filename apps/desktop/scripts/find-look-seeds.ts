/**
 * Finds session ids whose face looks exactly like the Bureau book's cast.
 *
 * The book picks a face from a thread's full title, through the hand-made
 * CAST table in crew.js. The app picks it from the session id through
 * `buildLook`. For the sidebar comparison to draw the same face on both
 * sides, the sidebar specimen's waiting threads need ids that hash to the
 * book's looks. This script counts through UUIDv7-shaped ids until it finds
 * one for each wanted look, and prints them.
 *
 * Run it with `node scripts/find-look-seeds.ts` from `apps/desktop`. The
 * sidebar specimen's fixture records the ids it prints.
 */
import { buildLook, type Accessory, type Hue, type Shape } from "../src/renderer/faces/look.ts";

/** A look the book casts by hand, and the thread title it casts it for. */
interface WantedLook {
  readonly title: string;
  readonly hue: Hue;
  readonly shape: Shape;
  readonly accessories: ReadonlyArray<Accessory>;
}

// The book's CAST entries for the two threads waiting on the user.
const WANTED: ReadonlyArray<WantedLook> = [
  {
    title: "Fix 3-D Secure checkout for EU cards",
    hue: "peach",
    shape: "egg",
    accessories: ["tache"],
  },
  { title: "Migrate ops dashboards", hue: "mint", shape: "wide", accessories: ["bowtie"] },
];

// Every id shares this UUIDv7 prefix: the millisecond timestamp of
// 2026-09-29 09:00 UTC, version 7 and the RFC 4122 variant. Only the last 12
// hex digits count.
const ID_PREFIX = "01a0ec64-6e80-7000-8000-";

/** Returns the id for a counter value: the prefix, then the counter as 12 hex digits. */
const buildCandidateId = (counter: number): string =>
  ID_PREFIX + counter.toString(16).padStart(12, "0");

/** Checks whether an id's look matches the wanted look on hue, shape and every accessory. */
const hasWantedLook = (id: string, wanted: WantedLook): boolean => {
  const look = buildLook(id);
  return (
    look.hue === wanted.hue &&
    look.shape === wanted.shape &&
    look.accessories.join("+") === wanted.accessories.join("+")
  );
};

/** Returns the first candidate id whose look matches, counting up from 0. */
const findSeed = (wanted: WantedLook): string => {
  // A look is one of 256, so a match turns up within a few thousand tries.
  for (let counter = 0; ; counter++) {
    const id = buildCandidateId(counter);
    if (hasWantedLook(id, wanted)) return id;
  }
};

for (const wanted of WANTED) {
  console.log(`${wanted.title}: ${findSeed(wanted)}`);
}
