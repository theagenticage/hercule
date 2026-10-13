/**
 * Finds session and workflow ids whose face looks exactly like the Bureau
 * book's.
 *
 * The book picks a face from a thread's full title, a workflow's name or an
 * assistant's name: from the hand-made CAST table in crew.js, or else from a
 * hash of the name. The app picks it from the session, workflow or assistant
 * id, through `buildLook`, or `buildAssistantLook` for an assistant. For a
 * comparison to draw the same face on both sides, a specimen needs ids that
 * hash to the book's looks. This script counts through UUIDv7-shaped ids
 * until it finds one for each wanted look, and prints them.
 *
 * Run it with `node scripts/find-look-seeds.ts` from `apps/desktop`. These
 * fixtures record the ids it prints:
 *
 * - the sidebar specimen's fixture, the thread ids;
 * - the Intake specimen's fixture, the workflow ids;
 * - the Android app's book fixtures (apps/android/app/src/test/kotlin/dev/
 *   hercule/android/ui/fixtures/BookFixtures.kt), the ids of the threads and
 *   assistants on the book's phone pages.
 */
import {
  buildAssistantLook,
  buildLook,
  type Accessory,
  type Headwear,
  type Hue,
  type Shape,
} from "../src/renderer/faces/look.ts";

/**
 * A look the book draws, and the thread title, workflow name or assistant
 * name it draws it for. An assistant's look has `headwear`; a thread's or a
 * workflow's has none.
 */
interface WantedLook {
  readonly title: string;
  readonly hue: Hue;
  readonly shape: Shape;
  readonly accessories: ReadonlyArray<Accessory>;
  readonly headwear?: Headwear;
}

// The book's CAST entries for the two threads waiting on the user, then the
// workflows the Intake drawing hands signals to. "Fix bug" is in CAST; the
// book hashes the other two names, the same way `buildLook` hashes a seed.
const WANTED: ReadonlyArray<WantedLook> = [
  {
    title: "Fix 3-D Secure checkout for EU cards",
    hue: "peach",
    shape: "egg",
    accessories: ["tache"],
  },
  { title: "Migrate ops dashboards", hue: "mint", shape: "wide", accessories: ["bowtie"] },
  { title: "Fix bug", hue: "iris", shape: "wide", accessories: ["glasses"] },
  { title: "Review PR", hue: "mint", shape: "wide", accessories: ["watch"] },
  { title: "Address review", hue: "mint", shape: "round", accessories: ["bowtie"] },
  // The other threads on the book's phone pages (mobile/office.html), from CAST.
  { title: "Read the Stripe v14 changelog", hue: "sky", shape: "tall", accessories: ["glasses"] },
  // CAST gives this thread a tache and a homburg. No hashed look wears both,
  // because only Hercule's fixed look does, so the homburg alone is the
  // nearest look an id can get.
  { title: "Investigate backup timeouts", hue: "sky", shape: "round", accessories: ["homburg"] },
  { title: "Refactor cart totals", hue: "grape", shape: "egg", accessories: ["watch"] },
  { title: "Webhook retry backoff", hue: "iris", shape: "tall", accessories: ["monocle"] },
  {
    title: "Cart total rounding on discounts",
    hue: "mint",
    shape: "round",
    accessories: ["glasses"],
  },
  { title: "Payout report for September", hue: "peach", shape: "wide", accessories: ["homburg"] },
  { title: "Rotate staging secrets", hue: "teal", shape: "tall", accessories: ["tache"] },
  { title: "Tidy checkout CSS", hue: "orchid", shape: "egg", accessories: ["bowtie"] },
  { title: "Label new issues run", hue: "grape", shape: "tall", accessories: ["watch"] },
  { title: "Ship release v2.15", hue: "orchid", shape: "round", accessories: ["bowtie"] },
  { title: "Add iDEAL research", hue: "lime", shape: "tall", accessories: ["monocle"] },
  {
    title: "Draft reply to Jonas at Kiteworks",
    hue: "teal",
    shape: "wide",
    accessories: ["tache", "bowtie"],
  },
  // The book's assistants, from CAST.
  { title: "Ada", hue: "iris", shape: "egg", accessories: [], headwear: "cloche" },
  { title: "Milo", hue: "teal", shape: "round", accessories: [], headwear: "headset" },
  { title: "Juno", hue: "orchid", shape: "tall", accessories: [], headwear: "beret" },
];

// Every id shares this UUIDv7 prefix: the millisecond timestamp of
// 2026-09-29 09:00 UTC, version 7 and the RFC 4122 variant. Only the last 12
// hex digits count.
const ID_PREFIX = "01a0ec64-6e80-7000-8000-";

/** Returns the id for a counter value: the prefix, then the counter as 12 hex digits. */
const buildCandidateId = (counter: number): string =>
  ID_PREFIX + counter.toString(16).padStart(12, "0");

/**
 * Checks whether an id's look matches the wanted look on hue, shape, every
 * accessory and the headwear. A wanted look with headwear is an assistant's,
 * so the id's look is built with `buildAssistantLook`.
 */
const hasWantedLook = (id: string, wanted: WantedLook): boolean => {
  const look = wanted.headwear === undefined ? buildLook(id) : buildAssistantLook(id);
  return (
    look.hue === wanted.hue &&
    look.shape === wanted.shape &&
    look.accessories.join("+") === wanted.accessories.join("+") &&
    look.headwear === (wanted.headwear ?? null)
  );
};

/** Returns the first candidate id whose look matches, counting up from 0. */
const findSeed = (wanted: WantedLook): string => {
  // A thread's look is one of 256 and an assistant's one of 768, so a match
  // turns up within a few thousand tries.
  for (let counter = 0; ; counter++) {
    const id = buildCandidateId(counter);
    if (hasWantedLook(id, wanted)) return id;
  }
};

for (const wanted of WANTED) {
  console.log(`${wanted.title}: ${findSeed(wanted)}`);
}
