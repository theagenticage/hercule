/**
 * What the Inbox's moves decide and say: whether a move may be made on the
 * things it was asked for, and the words the undo line shows for it. The
 * screen sends the move; this module never reads or writes anything.
 *
 * Every refusal says what was wrong and what to do instead, and an undo line
 * puts the title of the thing last (`title`), so a line that is too narrow
 * cuts the title and never the words before it.
 */
import {
  MAX_INBOX_MOVED_THINGS,
  MAX_TASK_TITLE_LENGTH,
  type EntityUnlinkResult,
  type InboxThing,
  type WorkflowOffer,
} from "@hercule/contract";
import { decideHandMove, type CardOffers } from "./card-hand-off";
import { findHolder } from "./inbox-holder";

/** The moves of a thing that the Inbox's keys and buttons make. */
export type InboxMoveKind = "dismiss" | "takeOn" | "handOff" | "goToTask" | "link";

/**
 * What a move acts on, as the visit hands it over: never inferred from a count.
 *
 * - `thing`: one row.
 * - `group`: a group of linked things, under the keys as one row.
 *   - `labelRef` and `label` are the member the group is named after and its title.
 *   - `members` is every member the group names, with its id, minus the ones the
 *     visit hid or has not shown yet.
 *   - `rows` are the members the visit holds.
 *   - `size` is how many members the group has. It is above `members.length`
 *     only for a group of more than `MAX_INBOX_MOVED_THINGS`.
 *   - `isFresh` is true when the group came under the keys less than 0.6 seconds ago.
 * - `selection`: the rows the user selected.
 */
export type InboxMoveTarget<Row extends { readonly ref: string } = InboxThing> =
  | { readonly kind: "thing"; readonly row: Row }
  | {
      readonly kind: "group";
      readonly labelRef: string;
      readonly label: string;
      readonly members: ReadonlyArray<{ readonly id: string; readonly ref: string }>;
      readonly rows: ReadonlyArray<Row>;
      readonly size: number;
      readonly isFresh: boolean;
    }
  | { readonly kind: "selection"; readonly rows: ReadonlyArray<Row> };

/**
 * What may be done: go on, ask the screen to open "Link to..." so the user
 * picks the thing to link to, or refuse and say why.
 */
export type InboxMovePlan =
  | { readonly kind: "go" }
  | { readonly kind: "pick" }
  | { readonly kind: "refuse"; readonly reason: string };

/** The words of an undo line: what happened, and the title of the thing it happened to. */
export interface InboxLineWords {
  readonly text: string;
  readonly title: string | null;
}

const GO: InboxMovePlan = { kind: "go" };
const refuse = (reason: string): InboxMovePlan => ({ kind: "refuse", reason });

/** The longest title a sentence quotes before it is cut, in letters. */
const QUOTED_TITLE_LENGTH = 44;

/** Returns `title` in quotes for the middle of a sentence, cut with an ellipsis when it is long. */
const quoteTitle = (title: string): string =>
  `“${title.length > QUOTED_TITLE_LENGTH ? `${title.slice(0, QUOTED_TITLE_LENGTH - 2)}…` : title}”`;

/** Returns who has the thing, as a sentence's subject (see `findHolder`). Used for a thing the user took on. */
const describeWhoHasIt = (thing: Pick<InboxThing, "liveWorkflows" | "takenOn">): string => {
  const holder = findHolder(thing);
  return holder?.kind === "colleague" ? `${holder.name} has` : "You have";
};

export const REFUSED_OFFLINE =
  "You are offline, so that was not done. Try again when the connection is back.";

const formatCount = (count: number): string => count.toLocaleString("en-US");

/** Returns the reason a group of more than `MAX_INBOX_MOVED_THINGS` things cannot be moved as a whole, or `undefined` for a smaller one. */
const refuseTooLargeGroup = (
  target: Extract<InboxMoveTarget, { kind: "group" }>,
  verb: string,
  key: string,
): InboxMovePlan | undefined =>
  target.size > target.members.length
    ? refuse(
        `This group has ${formatCount(target.size)} things, and ${verb} takes up to ${formatCount(MAX_INBOX_MOVED_THINGS)} at once. Open the group, select some of its things, then press ${key}.`,
      )
    : undefined;

/**
 * Decides whether `move` may be made on `target`.
 *
 * - Every move but Go to its Task needs the connection, because the outbox
 *   that would hold a move for later does not exist yet.
 * - Dismiss takes a thing, a whole group or a selection, up to
 *   `MAX_INBOX_MOVED_THINGS` things, in one call. A group of more than that is
 *   refused, and so is a group that came under the keys less than 0.6 seconds
 *   ago, because a second E that fast is most likely the first one repeated.
 * - Take on on a thing refuses a thing the user already took on. On a group or
 *   a selection of several things it makes one Task for all of them, so it
 *   refuses a group of more than `MAX_INBOX_MOVED_THINGS`.
 * - The hand-off takes one thing, and refuses a thing no workflow can take
 *   (`offers`, the offers of the one thing). It refuses a group or a selection.
 * - Go to its Task needs one thing that has a Task.
 * - Link links the things of a selection of two or more. On one thing, one
 *   selected thing or a group it answers `pick`: the screen opens "Link to..."
 *   and the user picks the other thing. It refuses an empty selection.
 */
export const planInboxMove = ({
  move,
  target,
  isOffline,
  offers,
}: {
  readonly move: InboxMoveKind;
  readonly target: InboxMoveTarget;
  readonly isOffline: boolean;
  readonly offers: CardOffers;
}): InboxMovePlan => {
  if (isOffline && move !== "goToTask") return refuse(REFUSED_OFFLINE);
  // A selection of one row acts as that row.
  const only =
    target.kind === "thing"
      ? target.row
      : target.kind === "selection" && target.rows.length === 1
        ? target.rows[0]
        : undefined;
  switch (move) {
    case "dismiss":
      if (target.kind === "group") {
        const tooLarge = refuseTooLargeGroup(target, "Dismiss", "E");
        if (tooLarge !== undefined) return tooLarge;
        return target.isFresh
          ? refuse(
              `The group ${quoteTitle(target.label)} is under the keys now. E again dismisses all ${formatCount(target.size)}.`,
            )
          : GO;
      }
      if (target.kind === "selection" && target.rows.length > MAX_INBOX_MOVED_THINGS)
        return refuse(
          `Dismiss takes up to ${formatCount(MAX_INBOX_MOVED_THINGS)} things at once, and ${formatCount(target.rows.length)} are selected. Select fewer, then press E again.`,
        );
      return GO;
    case "takeOn":
      if (target.kind === "group") return refuseTooLargeGroup(target, "Take on", "T") ?? GO;
      if (target.kind === "selection" && target.rows.length > MAX_INBOX_MOVED_THINGS)
        return refuse(
          `Take on takes up to ${formatCount(MAX_INBOX_MOVED_THINGS)} things at once, and ${formatCount(target.rows.length)} are selected. Select fewer, then press T again.`,
        );
      // A thing with a Task the user did not take on (a signal's, a hand-off's) may be taken on:
      // the controller marks that Task as taken instead of making another.
      // A group or a selection of several things may hold things with Tasks: the controller
      // joins them when they all share one Task, and refuses and names the Tasks when they do not.
      if (only === undefined) return GO;
      return !only.takenOn
        ? GO
        : refuse(`${describeWhoHasIt(only)} this already. G goes to its Task.`);
    case "handOff":
      if (only === undefined)
        return refuse(
          target.kind === "group"
            ? "Hand-off takes one thing at a time. Open the group and pick one, or start a thread on all of it with N."
            : `Hand-off takes one thing at a time. Press Esc to clear the selection, then H on the thing you want, or start a thread on all ${formatCount(target.kind === "selection" ? target.rows.length : 0)} with N.`,
        );
      return decideHandMove(offers).kind === "none"
        ? refuse(`No workflow can take this ${only.noun.toLowerCase()} yet.`)
        : GO;
    case "goToTask":
      if (only === undefined) return refuse("Go to its Task takes one thing at a time.");
      return only.taskId === undefined ? refuse("This has no Task yet. T takes it on.") : GO;
    case "link":
      if (target.kind === "selection" && target.rows.length === 0)
        return refuse(
          "There is nothing selected to link. Select two or more with X, then press L.",
        );
      return target.kind === "selection" && target.rows.length >= 2 ? GO : { kind: "pick" };
  }
};

/**
 * Returns what `takeOnTogether` takes for a take on of a group or a selection of
 * several things: the ids of the things and the Task's title. Returns `null` for
 * a target that is one thing (the plain take on makes its Task) or a selection
 * of none.
 *
 * - A group lists its label's thing first, because the Task takes its stage and
 *   Project from the first thing, and is titled with the group's label.
 * - A selection is titled with its first row's title and lists the rows in order.
 * - A title is cut to `MAX_TASK_TITLE_LENGTH`.
 */
export const buildTakeOnTogether = (
  target: InboxMoveTarget,
): { readonly ids: string[]; readonly title: string } | null => {
  const cut = (title: string): string => title.slice(0, MAX_TASK_TITLE_LENGTH);
  if (target.kind === "group") {
    const label = target.members.filter((member) => member.ref === target.labelRef);
    const others = target.members.filter((member) => member.ref !== target.labelRef);
    return { ids: [...label, ...others].map((member) => member.id), title: cut(target.label) };
  }
  if (target.kind === "selection" && target.rows.length >= 2)
    return { ids: target.rows.map((row) => row.id), title: cut(target.rows[0]!.title) };
  return null;
};

/**
 * Returns the pairs to link for L on a selection: a star from the first row to
 * each of the other rows. Rows that are already linked are not skipped: `link`
 * answers `created: false` for a pair the user already linked, and the rows do
 * not say which group they are in. Returns no pair for a target that is not a
 * selection of two or more.
 */
export const buildLinkPairs = (
  target: InboxMoveTarget,
): ReadonlyArray<{ readonly fromRef: string; readonly toRef: string }> => {
  if (target.kind !== "selection") return [];
  const [first, ...others] = target.rows;
  return first === undefined ? [] : others.map((row) => ({ fromRef: first.ref, toRef: row.ref }));
};

/**
 * Returns `thing` as it reads once `offer` has it: the workflow is live on it,
 * and the asks the workflow answers are gone. A thing left with no ask has no
 * wait, so its row shows who has it. The row shows this at once, until the
 * next read of the list says what the controller made of the hand-off.
 */
export const buildHandedThing = (thing: InboxThing, offer: WorkflowOffer): InboxThing => {
  const askKinds = thing.askKinds.filter((kind) => !offer.answers.includes(kind));
  const liveWorkflows = [
    { workflowId: offer.workflowId, name: offer.name },
    ...thing.liveWorkflows,
  ];
  if (askKinds.length > 0) {
    const asks = thing.asks.filter((ask) => !offer.answers.includes(ask.kind));
    const answered = thing.asks.length - asks.length;
    const everyAskIsListed = thing.askCount === thing.asks.length;
    // The row lists only the newest asks. When it lists them all, the count and the
    // wait follow exactly. When older ones are not listed, their kinds are not known:
    // the count drops by the answered asks it can see (an upper bound) and the wait
    // stays the oldest ask's, until the next read says what the controller made of it.
    const oldest = asks.at(-1);
    const waiting =
      answered > 0 && everyAskIsListed && oldest !== undefined
        ? { waitingSince: oldest.createdAt }
        : {};
    return {
      ...thing,
      asks,
      askCount: thing.askCount - answered,
      askKinds,
      liveWorkflows,
      ...waiting,
    };
  }
  // A thing with no ask waits for nobody, so its row has no wait to show.
  const unwaiting: { -readonly [Key in keyof InboxThing]: InboxThing[Key] } = { ...thing };
  delete unwaiting.waitingSince;
  return { ...unwaiting, asks: [], askCount: 0, askKinds, liveWorkflows };
};

/** Returns the words for the line after `things` were dismissed. One thing shows its title. */
export const describeInboxDismissal = (things: readonly InboxThing[]): InboxLineWords =>
  things.length === 1
    ? { text: "Dismissed", title: things[0]!.title }
    : { text: `Dismissed ${things.length.toLocaleString("en-US")} things`, title: null };

/**
 * Returns the words for the line after the group `label` of `count` things was
 * dismissed. `outside` is how many of its things do not answer the current list.
 */
export const describeInboxGroupDismissal = (
  label: string,
  count: number,
  outside: number,
): InboxLineWords => ({
  text: `Dismissed the group ${quoteTitle(label)}: ${formatCount(count)} things${
    outside > 0 ? `, ${formatCount(outside)} of them not in this list` : ""
  }`,
  title: null,
});

/** The words for the line after an undo put dismissed things back. */
export const DISMISSAL_UNDONE = "Back in your Inbox.";

/** Returns the sentence for a dismissal the controller refused: the things are back, and why. */
export const describeInboxDismissalFailure = (
  things: readonly InboxThing[],
  reason: string,
): string =>
  things.length === 1
    ? `${quoteTitle(things[0]!.title)} was not dismissed, so it is back: ${reason}. Try again.`
    : `${things.length.toLocaleString("en-US")} things were not dismissed, so they are back: ${reason}. Try again.`;

/** Returns the words for the line after `thing` was taken on, with `created` saying whether this made the Task. */
export const describeInboxTakeOn = (thing: InboxThing, created: boolean): InboxLineWords =>
  created
    ? { text: "Took on, a Task on Work", title: thing.title }
    : { text: "It already had a Task, so no new one was made", title: null };

/** The words for the line after an undo took the Task a Take on made away again. */
export const TAKE_ON_UNDONE = "The Task is gone, and nothing had started.";

/** Returns the sentence for a Take on the controller refused. */
export const describeInboxTakeOnFailure = (thing: InboxThing, reason: string): string =>
  `${quoteTitle(thing.title)} was not taken on: ${reason}. Try again.`;

/** Returns the words for the line after `thing` was handed to the workflow `workflowName`. */
export const describeInboxHandOff = (thing: InboxThing, workflowName: string): InboxLineWords => ({
  text: `Handed to ${workflowName}`,
  title: thing.title,
});

/** Returns the sentence for a hand-off the controller refused. */
export const describeInboxHandOffFailure = (
  thing: InboxThing,
  workflowName: string,
  reason: string,
): string => `${quoteTitle(thing.title)} was not handed to ${workflowName}: ${reason}. Try again.`;

/** Returns the line for a thing that has no address to open at its source. */
export const NO_SOURCE_ADDRESS = "This has no address to open at its source.";

/** Returns how a sentence names `thing`: by its identifier, else by its quoted title. */
const nameThing = (thing: Pick<InboxThing, "identifier" | "title">): string =>
  thing.identifier !== "" ? thing.identifier : quoteTitle(thing.title);

/**
 * Returns the words for the line after the user linked `things`. `created` is
 * false when every pair was linked already. Two things are named by identifier,
 * last, so a narrow line cuts the names and not the words before them.
 */
export const describeInboxLink = (
  things: readonly InboxThing[],
  created: boolean,
): InboxLineWords => {
  if (!created) return { text: "These are linked already.", title: null };
  return things.length === 2
    ? { text: "Linked", title: `${nameThing(things[0]!)} and ${nameThing(things[1]!)}` }
    : { text: `Linked ${formatCount(things.length)} things`, title: null };
};

/** The words for the line after an undo took a link away again. */
export const LINK_UNDONE = "Unlinked. The sources were never told.";

/**
 * Returns the words for the line after the user unlinked `first` and `second`,
 * from what `unlink` answered. A link a source made cannot be removed, so the
 * line says the source still links them.
 */
export const describeInboxUnlink = (
  first: InboxThing,
  second: InboxThing,
  result: EntityUnlinkResult,
): InboxLineWords => {
  if (!result.removed) return { text: "You had not linked these, so nothing changed", title: null };
  return result.remaining === "source"
    ? { text: "Unlinked, but the source still links them", title: null }
    : { text: "Unlinked", title: `${nameThing(first)} and ${nameThing(second)}` };
};

/** The words for the line after an undo linked two things again. */
export const UNLINK_UNDONE = "Linked again.";

/**
 * Returns the words for the line after a group or a selection was taken on
 * under one Task, titled `title`. `created` is false when the things joined a
 * Task that already existed.
 */
export const describeInboxTakeOnTogether = (title: string, created: boolean): InboxLineWords => ({
  text: created ? "Took on, a Task on Work" : "Added to its Task on Work",
  title,
});

/** Returns the words for the line after an undo of a take on together; `created` is whether the call made the Task. */
export const describeInboxTakeOnTogetherUndone = (created: boolean): string =>
  created ? TAKE_ON_UNDONE : "Taken back off the Task.";
