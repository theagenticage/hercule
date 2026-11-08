/**
 * The timeline of the open card: what happened to one thing and to the things
 * linked to it, oldest first, as one history. It weaves four kinds of line by
 * time: the thing's own signals, what changed at its source, and the newest
 * signal of each confirmed linked thing that has a card on the page. Nothing
 * here names a kind: a line is finished words, a time, and a tone.
 */
import type {
  EntityChange,
  EntityPeer,
  EntityReason,
  EntitySignalLine,
  ExternalEntityDetail,
  InboxCard,
} from "@hercule/contract";
import { readEntityPluginId } from "../desk/entity-words";
import { readOtherRef } from "../desk/link-ends";

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
  /**
   * Names the line among the others, so a list can key by it: the time and
   * the reason or signal it is about, so a line keeps its key when others
   * come before it.
   */
  readonly key: string;
  /** When it happened, as an ISO timestamp. */
  readonly at: string;
  /** The sentence, finished: the person is in it. */
  readonly say: string;
  readonly tone: EntityReason["tone"];
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
  readonly identifier?: string | undefined;
}

/**
 * Returns the peers and the places of `detail` by ref, for finding the thing a
 * line is about without searching a list for each line. A peer wins over a
 * place for a ref that both hold. A restricted one has no kind to draw and is
 * left out.
 */
const indexOtherThings = (detail: TimelineSource): ReadonlyMap<string, OtherThing> => {
  const others = new Map<string, OtherThing>();
  for (const thing of [...detail.places, ...detail.peers]) {
    if (!thing.restricted) others.set(thing.ref, thing);
  }
  return others;
};

const buildSignalLine = (line: EntitySignalLine): TimelineLine => ({
  key: `signal:${line.id}`,
  at: line.createdAt,
  say: line.say.say,
  tone: line.say.tone,
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

/** Returns the line for `change`. `other` is the thing a `linked` change is about, when it is known. */
const buildChangeLine = (change: EntityChange, other: OtherThing | undefined): TimelineLine => ({
  key: `change:${change.at}:${change.reason}:${change.ref ?? ""}`,
  at: change.at,
  say: change.sentence.say,
  tone: change.sentence.tone,
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
 * - For each link (never a hint) whose far end has a card on the page, that card's newest signal,
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
  const cardByRef = new Map(cards.map((card) => [card.ref, card]));
  const others = indexOtherThings(detail);
  const lines: TimelineLine[] = [
    ...detail.timeline.map((change) => {
      const card = change.ref === undefined ? undefined : cardByRef.get(change.ref);
      const other = change.ref === undefined ? undefined : others.get(change.ref);
      return buildChangeLine(change, card ?? other);
    }),
    ...detail.signals.map(buildSignalLine),
  ];
  for (const link of detail.links) {
    const card = cardByRef.get(readOtherRef(link, detail.ref));
    const latest = card?.signals.latest;
    if (card === undefined || latest === undefined) continue;
    lines.push({
      key: `linked:${card.id}:${latest.id}`,
      at: latest.createdAt,
      say: latest.say.say,
      tone: latest.say.tone,
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
  const counts = new Map<string, number>();
  return ordered.map((line, index) => {
    // Two changes of one reason in one moment would share a key, so the later ones are counted.
    const earlier = counts.get(line.key) ?? 0;
    counts.set(line.key, earlier + 1);
    return {
      ...line,
      key: earlier === 0 ? line.key : `${line.key}#${String(earlier)}`,
      isLatest: index === latestIndex,
    };
  });
};

/**
 * Returns the source of the timeline for a card the Inbox holds when its own
 * read has not answered yet: the card's newest signal alone.
 */
export const buildListedTimelineSource = (card: InboxCard): TimelineSource => ({
  ref: card.ref,
  signals: card.signals.latest === undefined ? [] : [card.signals.latest],
  timeline: [],
  places: [],
  peers: [],
  links: [],
});

/**
 * Returns the id a link to a thing opens inside the sheet, by the thing's ref.
 * A thing opens when it has an id to read: a card of the page, or a peer that
 * is a full record. A card wins over a peer for a ref both hold.
 */
export const buildWalkableIds = (
  peers: ReadonlyArray<Pick<EntityPeer, "id" | "ref">>,
  cards: ReadonlyArray<Pick<InboxCard, "id" | "ref">>,
): ReadonlyMap<string, string> =>
  new Map<string, string>([
    ...peers.flatMap((peer) => (peer.id === undefined ? [] : [[peer.ref, peer.id] as const])),
    ...cards.map((card) => [card.ref, card.id] as const),
  ]);

/** What a card's lines leave out: how many, and whether they are open work or only older, resolved lines. */
export interface TimelineOverflow {
  readonly kind: "open" | "older";
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
    return { kind: "open", words: `and ${COUNT_FORMAT.format(count)} more open` };
  }
  if (detail.signalCount > detail.signals.length) {
    const count = detail.signalCount - detail.signals.length;
    return { kind: "older", words: `and ${COUNT_FORMAT.format(count)} older` };
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
