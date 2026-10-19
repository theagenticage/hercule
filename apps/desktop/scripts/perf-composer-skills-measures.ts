/**
 * The parts of the composer-skills perf script (`perf-composer-skills.ts`)
 * that need no app: the skills it seeds, the long message it types after, the
 * in-page probe that times a key from input to paint, and the statistics that
 * turn readings into the numbers spec 17 §Performance records.
 *
 * It runs on plain Node, like the perf script, so it uses only TypeScript that
 * Node can strip.
 */

/** One skill the script seeds, with the description its row shows. */
export interface SeededSkill {
  readonly name: string;
  readonly description: string;
}

const LIBRARY_VERBS = [
  "review",
  "debug",
  "deploy",
  "migrate",
  "refactor",
  "triage",
  "profile",
  "document",
  "test",
  "release",
] as const;
const LIBRARY_NOUNS = [
  "checkout",
  "billing",
  "search",
  "auth",
  "inventory",
  "orders",
  "emails",
  "reports",
  "uploads",
  "webhooks",
] as const;
const REPOSITORY_VERBS = ["audit", "seed", "lint", "rollback"] as const;
const REPOSITORY_NOUNS = ["stripe", "shipping", "catalog", "cart", "tax"] as const;

/** The name of the checkout whose skills the runner lists. */
export const CHECKOUT_NAME = "webshop";

/**
 * Describes the skill `verb noun`. Every description holds `team-wide`, so a
 * filter such as `team-w` keeps every row: the worst case for the list.
 */
const buildDescription = (verb: string, noun: string): string =>
  `${verb[0]!.toUpperCase()}${verb.slice(1)}s ${noun} changes against the team-wide checklist, then reports what it found.`;

/** Returns every combination of `verbs` and `nouns` as a skill named `verb-noun`. */
const crossSkills = (verbs: ReadonlyArray<string>, nouns: ReadonlyArray<string>): SeededSkill[] =>
  verbs.flatMap((verb) =>
    nouns.map((noun) => ({ name: `${verb}-${noun}`, description: buildDescription(verb, noun) })),
  );

/** The 100 skills of the Skill Library: `review-checkout`, `debug-billing` and on. */
export const LIBRARY_SKILLS: ReadonlyArray<SeededSkill> = crossSkills(LIBRARY_VERBS, LIBRARY_NOUNS);

/** The 20 skills in the checkout's `.agents/skills`, named without the checkout's prefix. */
export const REPOSITORY_SKILLS: ReadonlyArray<SeededSkill> = crossSkills(
  REPOSITORY_VERBS,
  REPOSITORY_NOUNS,
);

/** How many chips the long message holds. */
export const LONG_MESSAGE_CHIPS = 10;

/** About how many characters the long message holds. */
export const LONG_MESSAGE_LENGTH = 4_000;

const FILLER_WORDS = [
  "the",
  "quick",
  "brown",
  "fox",
  "jumps",
  "over",
  "a",
  "lazy",
  "dog",
  "and",
  "then",
  "runs",
  "back",
  "across",
  "field",
  "to",
  "find",
  "other",
  "foxes",
] as const;

/**
 * Builds one paragraph of about `LONG_MESSAGE_LENGTH` characters: filler words
 * with `LONG_MESSAGE_CHIPS` skills named in it, spread evenly. With
 * `withReferences`, each is written `$name`, a Skill Reference that becomes a
 * chip. Without, it is the bare name, so the text is as long and holds no `$`.
 * Returns the text and ends it on a plain word, so no reference ends at the
 * caret when the text is inserted.
 */
export function buildLongMessage(withReferences: boolean): string {
  const words: string[] = [];
  let length = 0;
  let wordIndex = 0;
  const chipEvery = Math.floor(LONG_MESSAGE_LENGTH / LONG_MESSAGE_CHIPS);
  let nextChipAt = chipEvery / 2;
  let chips = 0;
  while (length < LONG_MESSAGE_LENGTH) {
    let word: string = FILLER_WORDS[wordIndex % FILLER_WORDS.length]!;
    if (length >= nextChipAt && chips < LONG_MESSAGE_CHIPS) {
      const skill = LIBRARY_SKILLS[chips * 9]!;
      word = withReferences ? `$${skill.name}` : skill.name;
      chips += 1;
      nextChipAt += chipEvery;
    } else {
      wordIndex += 1;
    }
    words.push(word);
    length += word.length + 1;
  }
  words.push("end");
  return words.join(" ");
}

/** What the in-page probe read after a key, in the page's `performance.now()` milliseconds. */
export interface ProbeReading {
  /** When the key's `keydown` was created, or `null` when no key was pressed since `arm`. */
  readonly t0: number | null;
  /** When the first frame after the key was drawn, or `null`. */
  readonly firstPaint: number | null;
  /** When the frame that drew the last change to the page after the key was drawn, or `null`. */
  readonly lastPaint: number | null;
  /** When the page last changed after the key, or `null`. */
  readonly lastMutation: number | null;
  /** Whether the list said "Reading skills…" at some change after the key. */
  readonly sawReading: boolean;
  /** The time of the reading. */
  readonly now: number;
  /** How many requests for skills the page has made so far. */
  readonly reads: number;
  /** How many rows the open list has. */
  readonly rows: number;
  /** How many chips the message field holds. */
  readonly chips: number;
}

/**
 * An expression that installs the probe, `window.__probe`, once, and does
 * nothing the next time:
 *
 * - `arm()` forgets the last key, waits for the next `keydown`, and returns
 *   how many requests for skills the page has made so far;
 * - `read()` returns a `ProbeReading`.
 *
 * After the armed key, every change to the page schedules a frame callback,
 * and a message posted from it runs after that frame is drawn. The last such
 * time is when the key's effect was painted: the key's input-to-paint
 * latency is `lastPaint - t0`, and `firstPaint - t0` is when the first change
 * was painted. The key's `keydown` is marked in the trace with
 * `console.timeStamp("keystroke")`.
 */
export const INSTALL_PROBE = `(() => {
  if (window.__probe) return;
  performance.setResourceTimingBufferSize(100000);
  const countReads = () =>
    performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/skills")).length;
  const channel = new MessageChannel();
  const state = { armed: false, t0: null, firstPaint: null, lastPaint: null, lastMutation: null, sawReading: false };
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => channel.port2.postMessage(performance.now()));
  };
  channel.port1.onmessage = (message) => {
    pending = false;
    if (state.t0 === null) return;
    const paintedAt = performance.now();
    if (state.firstPaint === null) state.firstPaint = paintedAt;
    state.lastPaint = paintedAt;
    // A change after the frame callback ran is drawn by the next frame.
    if (state.lastMutation !== null && state.lastMutation > message.data) schedule();
  };
  // The page adds a one-pixel sentinel at start-up to time its first screen and
  // removes it when that frame is presented. After a reload that can land just
  // after the first key. It draws nothing, so it is not part of the key's effect.
  const isSentinel = (node) => node.nodeType === 1 && node.getAttribute("elementtiming") === "presented-frame";
  const onlySentinel = (record) =>
    record.type === "childList" &&
    record.addedNodes.length + record.removedNodes.length > 0 &&
    [...record.addedNodes, ...record.removedNodes].every(isSentinel);
  new MutationObserver((records) => {
    if (state.t0 === null) return;
    if (records.every(onlySentinel)) return;
    state.lastMutation = performance.now();
    const empty = document.querySelector(".composer-skill-list-empty");
    if (empty !== null && empty.textContent.includes("Reading")) state.sawReading = true;
    schedule();
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  document.addEventListener("keydown", (event) => {
    if (!state.armed) return;
    state.armed = false;
    state.t0 = event.timeStamp;
    console.timeStamp("keystroke");
  }, true);
  window.__probe = {
    arm: () => {
      Object.assign(state, { armed: true, t0: null, firstPaint: null, lastPaint: null, lastMutation: null, sawReading: false });
      return countReads();
    },
    read: () => ({
      ...state,
      now: performance.now(),
      reads: countReads(),
      rows: document.querySelectorAll(".composer-skill-list-row").length,
      chips: document.querySelectorAll(".composer-field [data-skill]").length,
    }),
  };
})()`;

/**
 * Returns whether the page has stopped changing after the armed key: a change
 * happened, it has been drawn, and nothing changed for `quietMs` since.
 */
export const hasSettled = (reading: ProbeReading, quietMs: number): boolean =>
  reading.t0 !== null &&
  reading.lastMutation !== null &&
  reading.lastPaint !== null &&
  reading.lastPaint >= reading.lastMutation &&
  reading.now - reading.lastMutation >= quietMs;

/** The median and the 95th percentile of a set of readings. */
export interface Spread {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
}

/** Returns the `Spread` of `values`. Fails when there are none. */
export const summarizeReadings = (values: ReadonlyArray<number>): Spread => ({
  count: values.length,
  p50: readMedian(values),
  p95: readPercentile95(values),
});

/** Returns the median of `values`: the middle one, or the mean of the two in the middle. Fails when there are none. */
export function readMedian(values: ReadonlyArray<number>): number {
  if (values.length === 0) throw new Error("there are no values to take the median of");
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Returns the 95th percentile of `values`, as the keystroke scenario does: the value at rank `ceil(0.95 * n)`. Fails when there are none. */
export function readPercentile95(values: ReadonlyArray<number>): number {
  if (values.length === 0) throw new Error("there are no values to take the 95th percentile of");
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}
