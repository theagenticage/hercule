/**
 * What one row of the Inbox list says. A row is drawn from a thing the
 * controller lists (`InboxThing`), the order of the list and the time, and
 * everything in it is decided here as plain values, so the row component only
 * draws them.
 */
import type { EntityStatus, InboxOrder, InboxThing } from "@hercule/contract";
import { listAvailableHandOffs, type CardOffers } from "./card-hand-off";
import { formatCompactNumber, readFieldWords } from "./field-words";
import { describeWaitSince, measureSpan, type Span, type WaitLevel } from "./card-wait";
import { describeTaskActivity } from "./inbox-task";

/**
 * What the time column shows:
 * - `wait`: `text` ("5d") in `tone`, with `words` ("Waiting 5 days, overdue") as its tooltip;
 * - `task`: in place of a time, for a thing on a Task that asks nothing: the
 *   face of the workflow running on it, grown from `faceSeed` (the workflow's
 *   id, so it matches the face on the hand-off menu), or the Task mark when
 *   no workflow runs. `words` is its tooltip;
 * - `none`: nothing, for a thing that asks nothing in a list ordered by waiting.
 */
export type InboxRowTime =
  | {
      readonly kind: "wait";
      readonly text: string;
      readonly tone: WaitLevel;
      readonly words: string;
    }
  | { readonly kind: "task"; readonly faceSeed?: string | undefined; readonly words: string }
  | { readonly kind: "none" };

/** The words of the second line, already decided. */
export interface InboxRowReason {
  /** The person the sentence starts with, drawn in ink, such as "Mei". */
  readonly who?: string | undefined;
  /** The rest of the sentence, such as "asked for your review". */
  readonly rest: string;
  /** How many more asks the thing has: drawn as a "+1" chip, nothing when 0. */
  readonly more: number;
  /** What follows the sentence, such as "dismissed 1d ago" or "Review PR running". Drawn after a dot. */
  readonly aside?: string | undefined;
  /** True for a thing that asks nothing: its sentence is drawn faint. */
  readonly quiet: boolean;
}

/**
 * The hand-off button of a row: one workflow shows its face and its name, and
 * several show the first faces and "Hand to…". A face never stands alone.
 * `faceSeed` is the workflow's id, as in `InboxRowTime`.
 */
export type InboxRowHandOff =
  | { readonly kind: "one"; readonly name: string; readonly faceSeed: string }
  | { readonly kind: "several"; readonly faceSeeds: ReadonlyArray<string> };

/** Everything a row draws, as values the caller has already decided. */
export interface InboxRowView {
  /** The thing's reference. It keys the row and goes back with every callback. */
  readonly ref: string;
  readonly title: string;
  /** The plugin whose mark the row draws. */
  readonly pluginId: string;
  /** The status shape, or `undefined` for a kind with no status. */
  readonly status?: EntityStatus | undefined;
  readonly time: InboxRowTime;
  readonly reason: InboxRowReason;
  /** The place the thing lives in, or `undefined` when the row leaves it to the pane. */
  readonly place?: string | undefined;
  readonly identifier?: string | undefined;
  /** What a screen reader says for the whole row. */
  readonly label: string;
  /** The hand-off button, or `null` when no workflow offers one. */
  readonly handOff: InboxRowHandOff | null;
  /** True when the thing is on a Task: its buttons are G and E instead of N, T, H and E. */
  readonly isOnTask: boolean;
}

/** What `describeInboxRow` needs besides the thing. */
export interface InboxRowContext {
  /** The order of the list the row is in. It decides what the time column shows. */
  readonly order: InboxOrder;
  readonly now: Date;
  /** The workflows the thing can be handed to, from `listCardOffers`. */
  readonly offers: CardOffers;
}

/** The longest place and identifier together that a row draws side by side. */
const PLACE_AND_IDENTIFIER_LIMIT = 26;

/** How many faces the hand-off button of a row shows when several workflows fit. */
const HAND_OFF_FACES = 3;

/** Returns an age as it follows "ago": "1d ago", or "just now" for less than a minute. */
const formatAgo = (span: Span): string => (span.text === "now" ? "just now" : `${span.text} ago`);

/** Returns the wait of the oldest open ask, or `undefined` when the thing asks nothing. */
const readWait = (thing: InboxThing, now: Date) => {
  if (thing.askCount === 0 || thing.waitingSince === undefined) return undefined;
  const { text, words, level } = describeWaitSince(thing.waitingSince, thing.patience, now);
  return { text, words, tone: level };
};

/**
 * Decides the time column:
 *
 * - A thing on a Task shows the Task (`task`), but only when no ask is left
 *   for the user. With asks left, the wait shows like any ask's. A thing
 *   just handed to a workflow counts as on a Task, before its Task is known.
 * - In a "waiting" list the wait of the oldest ask shows, and a thing that asks
 *   nothing shows nothing.
 * - In a "newest" list the moment the thing last changed shows, faint, and
 *   only an overdue wait shows in its place.
 */
export const decideTime = (thing: InboxThing, context: InboxRowContext): InboxRowTime => {
  const wait = readWait(thing, context.now);
  const [workflow] = thing.liveWorkflows;
  if (wait === undefined && (thing.task !== undefined || workflow !== undefined)) {
    return {
      kind: "task",
      faceSeed: workflow?.workflowId,
      words: describeTaskActivity(thing) ?? `On the Task “${thing.task!.title}”`,
    };
  }
  if (context.order === "waiting") {
    return wait === undefined ? { kind: "none" } : { kind: "wait", ...wait };
  }
  if (wait !== undefined && wait.tone === "over") return { kind: "wait", ...wait };
  const changed = measureSpan(thing.sourceUpdatedAt, context.now);
  return {
    kind: "wait",
    text: changed.text,
    tone: "fresh",
    words: `Updated ${formatAgo(changed)}`,
  };
};

/**
 * Decides the sentence of the second line.
 *
 * - With asks, it is the newest ask's sentence with the asker set apart, "+n"
 *   for the other asks, and an aside: what runs on its Task, or that the thing came
 *   back after a dismissal.
 * - A thing that asks nothing, with something running on its Task, says what
 *   runs (`describeTaskActivity`).
 * - Any other thing that asks nothing says what it is, quietly: its status,
 *   its face's context and fact, or its noun when the face has none of these.
 */
export const decideReason = (
  thing: InboxThing,
  context: Pick<InboxRowContext, "now">,
): InboxRowReason => {
  const [newest] = thing.asks;
  if (newest === undefined) {
    const activity = describeTaskActivity(thing);
    if (activity !== undefined) return { rest: activity, more: 0, quiet: true };
    const words = [
      thing.status?.label,
      readFieldWords(thing.face?.context, formatCompactNumber, context.now),
      readFieldWords(thing.face?.fact, formatCompactNumber, context.now),
    ].filter((word): word is string => word !== undefined);
    return { rest: words.length === 0 ? thing.noun : words.join(" · "), more: 0, quiet: true };
  }
  const aside =
    describeTaskActivity(thing) ??
    (thing.dismissedAt === undefined
      ? undefined
      : `dismissed ${formatAgo(measureSpan(thing.dismissedAt, context.now))}`);
  const sentence = newest.say.say;
  const { asker } = newest;
  // A person raised the ask when the sentence starts with their name; a system's ask has none to set apart.
  const who = asker !== undefined && sentence.startsWith(asker) ? asker : undefined;
  return {
    who,
    rest: who === undefined ? sentence : sentence.slice(who.length).trimStart(),
    more: thing.askCount - 1,
    aside,
    quiet: false,
  };
};

/**
 * Decides the hand-off button: the one workflow that can take the thing, by
 * name, or the first faces of the best fits when several can. Returns `null`
 * when none can.
 */
export const decideHandOff = (thing: InboxThing, offers: CardOffers): InboxRowHandOff | null => {
  const choices = listAvailableHandOffs(offers, thing);
  const [first] = choices;
  if (first === undefined) return null;
  if (choices.length === 1) {
    return { kind: "one", name: first.offer.name, faceSeed: first.offer.workflowId };
  }
  return {
    kind: "several",
    faceSeeds: choices.slice(0, HAND_OFF_FACES).map(({ offer }) => offer.workflowId),
  };
};

/**
 * Returns what a screen reader says for the whole row, in reading order:
 * title, sentence (with "and 2 more asks"), the Task it is on, the wait,
 * status, kind with its place, and the identifier.
 */
const describeRowAloud = (
  thing: InboxThing,
  reason: InboxRowReason,
  place: string | undefined,
  now: Date,
): string => {
  const sentence = [reason.who, reason.rest].filter((word) => word !== undefined).join(" ");
  const wait = readWait(thing, now);
  const parts = [
    thing.title,
    reason.more > 0
      ? `${sentence}, and ${String(reason.more)} more ask${reason.more === 1 ? "" : "s"}`
      : sentence,
  ];
  if (reason.aside !== undefined) parts.push(reason.aside);
  if (thing.task !== undefined) parts.push(`on the Task ${thing.task.title}`);
  if (wait !== undefined) parts.push(wait.words.replace(/^Waiting/, "waiting"));
  if (thing.status !== undefined) parts.push(thing.status.label);
  parts.push(place === undefined ? thing.noun : `${thing.noun} in ${place}`);
  parts.push(thing.identifier);
  return parts.join(". ");
};

/**
 * Returns the place `thing` lives in ("storefront-web"), or `undefined` when
 * its face has none. The row and the pane's head both read the place here.
 */
export const readThingPlace = (thing: InboxThing, now: Date): string | undefined =>
  readFieldWords(thing.face?.place, formatCompactNumber, now);

/**
 * Returns everything the row of `thing` draws.
 *
 * The place the thing lives in is dropped from the row when it would not fit
 * beside the identifier (together over 26 characters), or when the second line
 * already has an aside to say. The pane still has it.
 */
export const describeInboxRow = (thing: InboxThing, context: InboxRowContext): InboxRowView => {
  const reason = decideReason(thing, context);
  const place = readThingPlace(thing, context.now);
  const dropPlace =
    place !== undefined &&
    (reason.aside !== undefined ||
      place.length + thing.identifier.length > PLACE_AND_IDENTIFIER_LIMIT);
  return {
    ref: thing.ref,
    title: thing.title,
    pluginId: thing.source,
    status: thing.status,
    time: decideTime(thing, context),
    reason,
    place: dropPlace ? undefined : place,
    identifier: thing.identifier,
    label: describeRowAloud(thing, reason, place, context.now),
    handOff: decideHandOff(thing, context.offers),
    isOnTask: thing.task !== undefined,
  };
};
