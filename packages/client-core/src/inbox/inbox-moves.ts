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
import type { InboxEntry, InboxGroupView } from "./inbox-groups";
import { findHolder } from "./inbox-holder";

/** The moves of a thing that the Inbox's keys and buttons make. */
export type InboxMoveKind = "dismiss" | "takeOn" | "handOff" | "goToTask" | "link";

/**
 * What a move acts on, as the visit hands it over: never inferred from a count.
 *
 * - `thing`: one row, with the refs of the group it is a member of (none when
 *   it stands alone).
 * - `group`: a group of linked things, under the keys as one row, as the list
 *   resolved it (see `InboxGroupView`). `isFresh` is true when the group came
 *   under the keys less than 0.6 seconds ago.
 * - `selection`: the rows the user selected. `lineKey` is the key of the list
 *   line that shows the selection's one thing (its group's head when the group
 *   is closed), or `null` for a selection of several or of a thing no line shows.
 */
export type InboxMoveTarget<Row extends { readonly ref: string } = InboxThing> =
  | {
      readonly kind: "thing";
      readonly row: Row;
      readonly groupMemberRefs: readonly string[];
    }
  | { readonly kind: "group"; readonly group: InboxGroupView<Row>; readonly isFresh: boolean }
  | {
      readonly kind: "selection";
      readonly rows: ReadonlyArray<Row>;
      readonly lineKey: string | null;
    };

/** One end of a link, named the way a line about the link names it. */
export type InboxLinkEnd = Pick<InboxThing, "ref" | "identifier" | "title">;

/** What "Link to..." opens with, when the user links one thing or one group and still has to pick the other end. */
export interface InboxLinkPick {
  /** The thing it links from: the thing, or the member a group is named after. */
  readonly from: InboxLinkEnd;
  /** How the popover names what is linked from: the thing's identifier, else its title; a group's label. */
  readonly fromLabel: string;
  /** The refs "Link to..." does not offer, because linking them changes nothing: the members of the group. */
  readonly excludedRefs: readonly string[];
  /** The key of the list line the popover opens under. */
  readonly anchorKey: string;
}

/** The words of an undo line: what happened, and the title of the thing it happened to. */
export interface InboxLineWords {
  readonly text: string;
  readonly title: string | null;
}

/**
 * What each move does when it may be made: everything the screen needs to send
 * it, so the screen executes the plan and derives nothing from the target.
 */
export interface InboxMovePlans<Row> {
  readonly dismiss: {
    readonly kind: "dismiss";
    readonly ids: readonly string[];
    readonly refs: readonly string[];
    readonly words: InboxLineWords;
    /** What a failure line names: each thing, or the group by its label. */
    readonly named: ReadonlyArray<Pick<InboxThing, "title">>;
  };
  readonly takeOn:
    | { readonly kind: "takeOn"; readonly thing: Row }
    | {
        readonly kind: "takeOnTogether";
        /** The things to take on under one Task. A group lists its label's thing first. */
        readonly ids: readonly string[];
        readonly refs: readonly string[];
        /** The Task's title, cut to `MAX_TASK_TITLE_LENGTH`. */
        readonly title: string;
      };
  readonly handOff: { readonly kind: "handOff"; readonly thing: Row };
  readonly goToTask: { readonly kind: "goToTask"; readonly taskId: string };
  readonly link:
    | {
        readonly kind: "link";
        readonly fromRef: string;
        readonly toRefs: readonly string[];
        /** The things the line names. */
        readonly named: readonly InboxLinkEnd[];
      }
    | ({ readonly kind: "pickLink" } & InboxLinkPick);
}

/** A move that may not be made, and why. */
interface Refusal {
  readonly kind: "refuse";
  readonly reason: string;
}

/** What `move` may do: its plan, or a refusal that says why. */
export type InboxMovePlan<Row, Move extends InboxMoveKind = InboxMoveKind> =
  | InboxMovePlans<Row>[Move]
  | Refusal;

/** A row a move can be planned for: a thing with the workflows it can be handed to. */
type MovedRow = InboxThing & { readonly offers: CardOffers };

/**
 * Returns the one thing a target is: a thing, or a selection of just one row.
 * Returns `undefined` for a group, an empty selection and a selection of several.
 */
const findSingleThing = <Row extends { readonly ref: string }>(
  target: InboxMoveTarget<Row>,
): Row | undefined =>
  target.kind === "thing"
    ? target.row
    : target.kind === "selection" && target.rows.length === 1
      ? target.rows[0]
      : undefined;

const refuse = (reason: string): Refusal => ({ kind: "refuse", reason });

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

/** What the undo line says when "Link to..." finds no line to open under. */
export const NO_LINE_TO_LINK_FROM =
  "Can't open Link to... here: that thing's line is not on the list.";

const formatCount = (count: number): string => count.toLocaleString("en-US");

/**
 * Returns the reason a group cut by the controller's bound on members (more
 * than `MAX_INBOX_MOVED_THINGS` things) cannot be moved as a whole, or
 * `undefined` for a group whose members are all known.
 */
const refuseTooLargeGroup = (
  group: InboxGroupView<unknown>,
  verb: string,
  key: string,
): Refusal | undefined =>
  group.size > group.members.length
    ? refuse(
        `This group has ${formatCount(group.size)} things, and ${verb} takes up to ${formatCount(MAX_INBOX_MOVED_THINGS)} at once. Open the group, select some of its things, then press ${key}.`,
      )
    : undefined;

/** Returns the reason a selection of more than `MAX_INBOX_MOVED_THINGS` rows is refused, or `undefined` for a smaller target. */
const refuseTooLargeSelection = (
  target: InboxMoveTarget<{ readonly ref: string }>,
  verb: string,
  key: string,
): Refusal | undefined =>
  target.kind === "selection" && target.rows.length > MAX_INBOX_MOVED_THINGS
    ? refuse(
        `${verb} takes up to ${formatCount(MAX_INBOX_MOVED_THINGS)} things at once, and ${formatCount(target.rows.length)} are selected. Select fewer, then press ${key} again.`,
      )
    : undefined;

/** Plans a Dismiss: a thing, a whole group or a selection, in one call. */
const planDismiss = <Row extends MovedRow>(
  target: InboxMoveTarget<Row>,
): InboxMovePlan<Row, "dismiss"> => {
  if (target.kind === "group") {
    const { group } = target;
    const refusal =
      refuseTooLargeGroup(group, "Dismiss", "E") ??
      (target.isFresh
        ? refuse(
            `The group ${quoteTitle(group.label)} is under the keys now. E again dismisses all ${formatCount(group.size)}.`,
          )
        : undefined);
    return (
      refusal ?? {
        kind: "dismiss",
        ids: group.members.map((member) => member.id),
        refs: group.members.map((member) => member.ref),
        words: describeInboxGroupDismissal(group),
        named: [{ title: group.label }],
      }
    );
  }
  const things = target.kind === "thing" ? [target.row] : target.rows;
  return (
    refuseTooLargeSelection(target, "Dismiss", "E") ?? {
      kind: "dismiss",
      ids: things.map((thing) => thing.id),
      refs: things.map((thing) => thing.ref),
      words: describeInboxDismissal(things),
      named: things,
    }
  );
};

/**
 * Plans a Take on. A thing becomes its own Task. A group or a selection of
 * several things become one Task: a group lists its label's thing first,
 * because the Task takes its stage and Project from the first thing, and is
 * titled with the group's label; a selection is titled with its first row's
 * title.
 */
const planTakeOn = <Row extends MovedRow>(
  target: InboxMoveTarget<Row>,
): InboxMovePlan<Row, "takeOn"> => {
  const cut = (title: string): string => title.slice(0, MAX_TASK_TITLE_LENGTH);
  if (target.kind === "group") {
    const { group } = target;
    const label = group.members.filter((member) => member.ref === group.labelRef);
    const others = group.members.filter((member) => member.ref !== group.labelRef);
    const members = [...label, ...others];
    return (
      refuseTooLargeGroup(group, "Take on", "T") ?? {
        kind: "takeOnTogether",
        ids: members.map((member) => member.id),
        refs: members.map((member) => member.ref),
        title: cut(group.label),
      }
    );
  }
  const tooLarge = refuseTooLargeSelection(target, "Take on", "T");
  if (tooLarge !== undefined) return tooLarge;
  if (target.kind === "selection" && target.rows.length >= 2) {
    return {
      kind: "takeOnTogether",
      ids: target.rows.map((row) => row.id),
      refs: target.rows.map((row) => row.ref),
      title: cut(target.rows[0]!.title),
    };
  }
  const only = findSingleThing(target);
  if (only === undefined) return refuse("There is nothing selected to take on.");
  // A thing with a Task the user did not take on (a signal's, a hand-off's) may be taken on:
  // the controller marks that Task as taken instead of making another.
  return only.takenOn
    ? refuse(`${describeWhoHasIt(only)} this already. G goes to its Task.`)
    : { kind: "takeOn", thing: only };
};

/** Plans a hand-off: one thing, which some workflow can take. */
const planHandOff = <Row extends MovedRow>(
  target: InboxMoveTarget<Row>,
): InboxMovePlan<Row, "handOff"> => {
  const only = findSingleThing(target);
  if (only === undefined)
    return refuse(
      target.kind === "group"
        ? "Hand-off takes one thing at a time. Open the group and pick one."
        : "Hand-off takes one thing at a time. Press Esc to clear the selection, then H on the thing you want.",
    );
  return decideHandMove(only.offers).kind === "none"
    ? refuse(`No workflow can take this ${only.noun.toLowerCase()} yet.`)
    : { kind: "handOff", thing: only };
};

/** Plans Go to its Task: one thing that has a Task. */
const planGoToTask = <Row extends MovedRow>(
  target: InboxMoveTarget<Row>,
): InboxMovePlan<Row, "goToTask"> => {
  const only = findSingleThing(target);
  if (only === undefined) return refuse("Go to its Task takes one thing at a time.");
  return only.taskId === undefined
    ? refuse("This has no Task yet. T takes it on.")
    : { kind: "goToTask", taskId: only.taskId };
};

/**
 * Plans a link. A selection of two or more is linked at once, as a star from
 * its first row to each of the others. Rows that are already linked are not
 * skipped: the controller answers which links it wrote, and the rows do not
 * say which group they are in. One thing, one selected thing or a group still
 * needs the other end: "Link to..." opens under the line of what is linked.
 */
const planLink = <Row extends MovedRow>(
  target: InboxMoveTarget<Row>,
): InboxMovePlan<Row, "link"> => {
  if (target.kind === "selection" && target.rows.length === 0)
    return refuse("There is nothing selected to link. Select two or more with X, then press L.");
  if (target.kind === "selection" && target.rows.length >= 2) {
    const [first, ...others] = target.rows;
    return {
      kind: "link",
      fromRef: first!.ref,
      toRefs: others.map((row) => row.ref),
      named: target.rows,
    };
  }
  if (target.kind === "group") {
    const { group } = target;
    return {
      kind: "pickLink",
      from: buildGroupLinkEnd(group),
      fromLabel: group.label,
      excludedRefs: group.members.map((member) => member.ref),
      anchorKey: group.key,
    };
  }
  const thing = target.kind === "thing" ? target.row : target.rows[0]!;
  const anchorKey = target.kind === "thing" ? thing.ref : target.lineKey;
  if (anchorKey === null) return refuse(NO_LINE_TO_LINK_FROM);
  return {
    kind: "pickLink",
    from: { ref: thing.ref, identifier: thing.identifier, title: thing.title },
    fromLabel: thing.identifier !== "" ? thing.identifier : thing.title,
    excludedRefs: target.kind === "thing" ? target.groupMemberRefs : [],
    anchorKey,
  };
};

/**
 * Decides whether `move` may be made on `target`, and returns what to send.
 *
 * - Every move but Go to its Task needs the connection, because the outbox
 *   that would hold a move for later does not exist yet.
 * - Dismiss takes a thing, a whole group or a selection, up to
 *   `MAX_INBOX_MOVED_THINGS` things, in one call. A group cut by that bound is
 *   refused, and so is a group that came under the keys less than 0.6 seconds
 *   ago, because a second E that fast is most likely the first one repeated.
 * - Take on on a thing refuses a thing the user already took on. On a group or
 *   a selection of several things it makes one Task for all of them (the
 *   controller joins them when they all share one Task, and refuses and names
 *   the Tasks when they do not).
 * - The hand-off takes one thing, and refuses a thing no workflow can take.
 * - Go to its Task needs one thing that has a Task.
 * - Link links the things of a selection of two or more, and opens "Link
 *   to..." for anything else (see `planLink`).
 *
 * A selection of one row acts as that row.
 */
export function planInboxMove<Row extends MovedRow, Move extends InboxMoveKind>({
  move,
  target,
  isOffline,
}: {
  readonly move: Move;
  readonly target: InboxMoveTarget<Row>;
  readonly isOffline: boolean;
}): InboxMovePlan<Row, Move> {
  if (isOffline && move !== "goToTask") return refuse(REFUSED_OFFLINE);
  const planners: { readonly [M in InboxMoveKind]: () => InboxMovePlan<Row, M> } = {
    dismiss: () => planDismiss(target),
    takeOn: () => planTakeOn(target),
    handOff: () => planHandOff(target),
    goToTask: () => planGoToTask(target),
    link: () => planLink(target),
  };
  return planners[move]();
}

/**
 * Returns `group` (a head's group) as one end of a link: the member it is
 * named after, titled with the group's label and with no identifier, because
 * a group has none of its own.
 */
const buildGroupLinkEnd = (group: {
  readonly labelRef: string;
  readonly label: string;
}): InboxLinkEnd => ({
  ref: group.labelRef,
  identifier: "",
  title: group.label,
});

/** What the undo line says when a row is dropped on a line of its own group. */
const ALREADY_IN_ONE_GROUP = "These are in one group already.";

/**
 * Returns the end of a link that the list line `entry` stands for: the thing
 * itself, or for a group's head the thing the group is named after. Returns
 * `undefined` for a "Show N more" line, which links nothing.
 */
const readLinkEnd = (
  entry: InboxEntry<Pick<InboxThing, "ref" | "identifier" | "title">>,
): InboxLinkEnd | undefined => {
  if (entry.kind === "head") return buildGroupLinkEnd(entry.group);
  if (entry.kind === "more") return undefined;
  const { ref, identifier, title } = entry.row;
  return { ref, identifier, title };
};

/**
 * Decides what dropping the line `carriedKey` on the line `targetKey` does,
 * from the list's `entries`:
 * - links the two, `from` the line dropped on and `to` the carried line, so
 *   the undo line names them in the order the drawing shows them;
 * - refuses when both are lines of one group, which are linked already
 *   however they were linked;
 * - returns `null` when there is nothing to link: a line is no longer on the
 *   list, or it is a "Show N more" line.
 */
export function planInboxDrop(
  entries: readonly InboxEntry<Pick<InboxThing, "ref" | "identifier" | "title">>[],
  carriedKey: string,
  targetKey: string,
):
  | { readonly kind: "link"; readonly from: InboxLinkEnd; readonly to: InboxLinkEnd }
  | { readonly kind: "refuse"; readonly reason: string }
  | null {
  const carried = entries.find((entry) => entry.key === carriedKey);
  const target = entries.find((entry) => entry.key === targetKey);
  if (carried === undefined || target === undefined) return null;
  const carriedGroup = carried.kind === "member" ? carried.groupKey : undefined;
  const targetGroup =
    target.kind === "head" ? target.key : target.kind === "member" ? target.groupKey : undefined;
  if (carriedGroup !== undefined && carriedGroup === targetGroup)
    return refuse(ALREADY_IN_ONE_GROUP);
  const from = readLinkEnd(target);
  const to = readLinkEnd(carried);
  return from === undefined || to === undefined ? null : { kind: "link", from, to };
}

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
const describeInboxDismissal = (
  things: ReadonlyArray<Pick<InboxThing, "title">>,
): InboxLineWords =>
  things.length === 1
    ? { text: "Dismissed", title: things[0]!.title }
    : { text: `Dismissed ${things.length.toLocaleString("en-US")} things`, title: null };

/**
 * Returns the words for the line after `group` was dismissed: its label and
 * how many things it has, and how many of its members do not answer the
 * current list ("not in this list").
 */
const describeInboxGroupDismissal = (
  group: Pick<InboxGroupView<unknown>, "label" | "size" | "members">,
): InboxLineWords => {
  const outside = group.members.filter((member) => !member.matches).length;
  return {
    text: `Dismissed the group ${quoteTitle(group.label)}: ${formatCount(group.size)} things${
      outside > 0 ? `, ${formatCount(outside)} of them not in this list` : ""
    }`,
    title: null,
  };
};

/** The words for the line after an undo put dismissed things back. */
export const DISMISSAL_UNDONE = "Back in your Inbox.";

/** Returns the sentence for a dismissal the controller refused: the things are back, and why. */
export const describeInboxDismissalFailure = (
  things: ReadonlyArray<Pick<InboxThing, "title">>,
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
export const describeInboxTakeOnFailure = (
  thing: Pick<InboxThing, "title">,
  reason: string,
): string => `${quoteTitle(thing.title)} was not taken on: ${reason}. Try again.`;

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
  things: ReadonlyArray<Pick<InboxThing, "identifier" | "title">>,
  created: boolean,
): InboxLineWords => {
  if (!created) return { text: "These are linked already.", title: null };
  return things.length === 2
    ? { text: "Linked", title: `${nameThing(things[0]!)} and ${nameThing(things[1]!)}` }
    : { text: `Linked ${formatCount(things.length)} things`, title: null };
};

/** Returns the sentence for a link the controller refused or could not save. */
export const describeInboxLinkFailure = (reason: string): string =>
  `The link did not save: ${reason}. Try again.`;

/** The words for the line after an undo took a link away again. */
export const LINK_UNDONE = "Unlinked. The sources were never told.";

/**
 * Returns the words for the line after the user unlinked `first` and `second`,
 * from what `unlink` answered. A link a source made cannot be removed, so the
 * line says the source still links them.
 */
export const describeInboxUnlink = (
  first: Pick<InboxThing, "identifier" | "title">,
  second: Pick<InboxThing, "identifier" | "title">,
  result: EntityUnlinkResult,
): InboxLineWords => {
  if (!result.removed) return { text: "You had not linked these, so nothing changed", title: null };
  return result.remaining === "source"
    ? { text: "Unlinked, but the source still links them", title: null }
    : { text: "Unlinked", title: `${nameThing(first)} and ${nameThing(second)}` };
};

/** The words for the line after an undo linked two things again. */
export const UNLINK_UNDONE = "Linked again.";

/** Returns the sentence for an unlink the controller refused or could not save. */
export const describeInboxUnlinkFailure = (reason: string): string =>
  `The link was not removed: ${reason}. Try again.`;

/** What `externalEntity.takeOnTogether` answered, as far as the words and the undo need it. */
export interface TakeOnTogetherOutcome {
  readonly created: boolean;
  readonly added: readonly string[];
  readonly taken: readonly string[];
}

/**
 * Returns true when a take on together wrote something that an undo can take
 * back: a Task, a link to it or a taken mark. A call that changed nothing has
 * nothing to undo.
 */
export const didTakeOnTogetherChange = (outcome: TakeOnTogetherOutcome): boolean =>
  outcome.created || outcome.added.length > 0 || outcome.taken.length > 0;

/**
 * Returns the words for the line after a group or a selection was taken on
 * under one Task, titled `title`. When the things joined a Task that already
 * existed, the line says so; when they were all on it and marked already, it
 * says nothing changed.
 */
export const describeInboxTakeOnTogether = (
  title: string,
  outcome: TakeOnTogetherOutcome,
): InboxLineWords => {
  if (outcome.created) return { text: "Took on, a Task on Work", title };
  return didTakeOnTogetherChange(outcome)
    ? { text: "Added to its Task on Work", title }
    : { text: "Already on its Task on Work, so nothing changed", title };
};

/** Returns the words for the line after an undo of a take on together; `created` is whether the call made the Task. */
export const describeInboxTakeOnTogetherUndone = (created: boolean): string =>
  created ? TAKE_ON_UNDONE : "Taken back off the Task.";
