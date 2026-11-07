/**
 * The timeline of the open card: what happened to one thing and to the things
 * linked to it, oldest first, as one history. It weaves four kinds of line by
 * time: the thing's own signals, what changed at its source, and the newest
 * signal of each confirmed linked thing that has a card on the page. Nothing
 * here names a kind: a line is finished words, a time, and a tone.
 */
import type {
  EntityChange,
  EntityLink,
  EntityPeer,
  EntityPlace,
  EntityReason,
  EntitySignalLine,
  ExternalEntityDetail,
  InboxCard,
} from "@hercule/contract";
import { readEntityPluginId } from "../desk/entity-words";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Returns how long before `now` a line of the timeline happened, in words:
 * "4 min ago" under an hour (at least 1), "3h ago" under a day, "Yesterday"
 * for the next day, then "5 days ago". An `at` after `now` reads "1 min ago".
 */
export const describeTimelineAge = (at: string, now: Date): string => {
  const hours = Math.max(0, now.getTime() - Date.parse(at)) / HOUR_MS;
  if (hours < 1) return `${String(Math.max(1, Math.round(hours * 60)))} min ago`;
  if (hours < 24) return `${String(Math.min(23, Math.round(hours)))}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${String(days)} days ago`;
};

/** What a line of the timeline says about a signal of the thing itself. */
export interface TimelineSignal {
  readonly id: string;
  /** True while the signal has not ended. A line that is open can be opened to answer it. */
  readonly isOpen: boolean;
  readonly isSnoozed: boolean;
  /** What ended the signal, when it has ended. */
  readonly outcome: string | undefined;
}

/** One line of the open card's timeline. */
export interface TimelineLine {
  /** Names the line among the others, so a list can key by it. */
  readonly key: string;
  /** When it happened, as an ISO timestamp. */
  readonly at: string;
  /** The sentence, finished: the person is in it. */
  readonly say: string;
  readonly tone: EntityReason["tone"];
  /** The person who asked, when the sentence does not name them. */
  readonly person: string | undefined;
  /** For a line about another thing: how it names itself, such as "#6238". */
  readonly identifier: string | undefined;
  /** For a line about another thing: the plugin whose mark it wears. */
  readonly markPluginId: string | undefined;
  /** True for a line that is about a linked thing, which is drawn quieter. */
  readonly isLinked: boolean;
  /** True for the newest line that is still live: it is drawn in ink, or in its tone. */
  readonly isLatest: boolean;
  /** Set only for a signal of this thing. */
  readonly signal: TimelineSignal | undefined;
}

/** What the timeline is woven from: the thing's own read, and the cards of the page. */
export type TimelineSource = Pick<
  ExternalEntityDetail,
  "ref" | "signals" | "timeline" | "places" | "peers" | "links"
>;

/** How a line about another thing names it. */
interface OtherThing {
  readonly kind: string;
  readonly identifier: string | undefined;
}

/** Returns the end of `link` that is not `ref`. */
const readOtherRef = (link: EntityLink, ref: string): string =>
  link.fromRef === ref ? link.toRef : link.fromRef;

/** Returns the kind and the identifier of the thing at `ref`, from the page's cards, the peers and the places, or `undefined`. */
const findOtherThing = (
  ref: string,
  cards: ReadonlyArray<InboxCard>,
  peers: ReadonlyArray<EntityPeer>,
  places: ReadonlyArray<EntityPlace>,
): OtherThing | undefined => {
  const known: ReadonlyArray<
    { readonly kind: string; readonly identifier?: string | undefined } | undefined
  > = [
    cards.find((card) => card.ref === ref),
    peers.find((peer) => peer.ref === ref && !peer.restricted),
    places.find((place) => place.ref === ref && !place.restricted),
  ];
  const found = known.find((thing) => thing !== undefined);
  return found === undefined ? undefined : { kind: found.kind, identifier: found.identifier };
};

/** Returns the asker of a signal when the sentence does not name them, else `undefined`. */
const readUnnamedPerson = (line: EntitySignalLine): string | undefined =>
  line.asker === undefined || line.say.say.toLowerCase().includes(line.asker.toLowerCase())
    ? undefined
    : line.asker;

const buildSignalLine = (line: EntitySignalLine): TimelineLine => ({
  key: `signal:${line.id}`,
  at: line.createdAt,
  say: line.say.say,
  tone: line.say.tone,
  person: readUnnamedPerson(line),
  identifier: undefined,
  markPluginId: undefined,
  isLinked: false,
  isLatest: false,
  signal: {
    id: line.id,
    isOpen: line.status === "open",
    isSnoozed: line.snoozed,
    outcome: line.outcome,
  },
});

const buildChangeLine = (
  change: EntityChange,
  index: number,
  other: OtherThing | undefined,
): TimelineLine => ({
  key: `change:${String(index)}`,
  at: change.at,
  say: change.say.say,
  tone: change.say.tone,
  person: undefined,
  identifier: other?.identifier,
  markPluginId: other === undefined ? undefined : readEntityPluginId(other.kind),
  isLinked: false,
  isLatest: false,
  signal: undefined,
});

/** Returns whether a line is still live: a change, a linked line, or a signal that is open and not snoozed. */
const isLive = (line: TimelineLine): boolean =>
  line.signal === undefined || (line.signal.isOpen && !line.signal.isSnoozed);

/**
 * Returns the timeline of `detail`, oldest first.
 *
 * - The thing's own signals, resolved and snoozed ones included, and what
 *   changed at its source (`detail.timeline`).
 * - For each confirmed link (a `source` or `person` claim, never a hint in
 *   text) whose far end has a card on the page, that card's newest signal,
 *   drawn with the far end's mark and identifier and marked `isLinked`.
 * - A change that says a thing was linked wears that thing's mark and
 *   identifier when `detail` or `cards` know the thing.
 *
 * Lines are ordered by time, then as they were given (changes, signals, then
 * linked lines). The newest line that is still live is `isLatest`.
 */
export const buildOpenTimeline = (
  detail: TimelineSource,
  cards: ReadonlyArray<InboxCard>,
): readonly TimelineLine[] => {
  const lines: TimelineLine[] = [
    ...detail.timeline.map((change, index) =>
      buildChangeLine(
        change,
        index,
        change.ref === undefined
          ? undefined
          : findOtherThing(change.ref, cards, detail.peers, detail.places),
      ),
    ),
    ...detail.signals.map(buildSignalLine),
  ];
  for (const link of detail.links) {
    if (link.claim.type === "text") continue;
    const ref = readOtherRef(link, detail.ref);
    const card = cards.find((each) => each.ref === ref);
    const latest = card?.signals.latest;
    if (card === undefined || latest === undefined) continue;
    lines.push({
      key: `linked:${card.id}:${latest.id}`,
      at: latest.createdAt,
      say: latest.say.say,
      tone: latest.say.tone,
      person: undefined,
      identifier: card.identifier,
      markPluginId: readEntityPluginId(card.kind),
      isLinked: true,
      isLatest: false,
      signal: undefined,
    });
  }
  // `toSorted` is stable, so lines of one moment keep the order they were added in.
  const ordered = lines.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latestIndex = ordered.findLastIndex(isLive);
  return ordered.map((line, index) => (index === latestIndex ? { ...line, isLatest: true } : line));
};

/** What a card's lines leave out: how many, and whether they are open work or only older, resolved lines. */
export interface TimelineOverflow {
  readonly kind: "open" | "older";
  readonly count: number;
  /** The words for the line, such as "and 12 more open" or "and 1,204 older". */
  readonly words: string;
}

const COUNT_FORMAT = new Intl.NumberFormat("en");

/**
 * Returns the line that says how many of the thing's signals the timeline
 * leaves out, or `undefined` when it leaves none out.
 *
 * Open work is never hidden behind the word "older": when the thing has more
 * open signals than `signals` holds, the line counts those ("and 12 more
 * open"). Otherwise, when only resolved ones are left out, it counts them
 * ("and 12 older"). `signals` are the lines the read returned, which keep the
 * newest open signals first, so what is left out is the oldest.
 */
export const describeTimelineOverflow = (
  detail: Pick<ExternalEntityDetail, "signals" | "openCount" | "signalCount">,
): TimelineOverflow | undefined => {
  const shownOpen = detail.signals.filter((line) => line.status === "open").length;
  if (detail.openCount > shownOpen) {
    const count = detail.openCount - shownOpen;
    return { kind: "open", count, words: `and ${COUNT_FORMAT.format(count)} more open` };
  }
  if (detail.signalCount > detail.signals.length) {
    const count = detail.signalCount - detail.signals.length;
    return { kind: "older", count, words: `and ${COUNT_FORMAT.format(count)} older` };
  }
  return undefined;
};

/**
 * Returns the id of the signal a card opens first: the newest open one that
 * is not snoozed, else the newest open one, else `undefined`. `signals` are
 * in time order, oldest first, as the read gives them.
 */
export const findFirstOpenLine = (signals: ReadonlyArray<EntitySignalLine>): string | undefined => {
  const open = signals.filter((line) => line.status === "open");
  return (open.findLast((line) => !line.snoozed) ?? open.at(-1))?.id;
};
