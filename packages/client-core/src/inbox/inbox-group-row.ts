/**
 * What the head row of a group of linked things says in the Inbox list. The
 * head is drawn from a group the visit holds (`InboxGroupView`) and the same
 * context as a lone row, and everything in it is decided here as plain values.
 */
import type { InboxThing } from "@hercule/contract";
import {
  decideReason,
  decideTime,
  findRowHolder,
  type InboxRowContext,
  type InboxRowReason,
  type InboxRowTime,
} from "./inbox-row";
import type { GroupKey, InboxGroupView } from "./inbox-groups";

/** Everything the head row of a group draws, as values the caller has already decided. */
export interface InboxGroupRowView {
  /** The group's key. It keys the row and goes back with every callback. */
  readonly key: GroupKey;
  /** The label of the group: the title of its most lasting member. */
  readonly title: string;
  /** The time of the member that placed the group, so the column reads in the list's order. */
  readonly time: InboxRowTime;
  /** The most pressing ask among the held members, with the number of other members that ask as `more`. */
  readonly reason: InboxRowReason;
  /** The plugins the group's held members come from, each once, in the order of their first member. */
  readonly sources: readonly string[];
  /** How many things the group has, such as "4 things". */
  readonly count: string;
  /** What a screen reader says for the whole row. */
  readonly label: string;
}

/**
 * Returns the held members that ask the user something that is not taken, most
 * pressing first: the longest wait comes first. A Task a hand-off made does not
 * change that: the row counts only the asks the hand-off did not answer.
 */
const listAskingMembers = (rows: readonly InboxThing[]): InboxThing[] =>
  rows
    .filter((row) => row.askCount > 0)
    .sort((a, b) => (a.waitingSince ?? "").localeCompare(b.waitingSince ?? ""));

/**
 * Returns everything the head row of `group` draws.
 *
 * - The time is the one `describeInboxRow` gives the member that placed the group.
 * - The second line is the sentence of the member that has waited longest
 *   among those that ask, with "+n" for the other asking members. When no
 *   member asks, it is the quiet sentence of the member that placed the group.
 */
export const describeInboxGroupRow = (
  group: InboxGroupView<InboxThing>,
  context: InboxRowContext,
): InboxGroupRowView => {
  const placer = group.placedBy ?? group.rows[0];
  const [pressing, ...others] = listAskingMembers(group.rows);
  const reasonOwner = pressing ?? placer;
  const reason: InboxRowReason =
    reasonOwner === undefined
      ? { rest: "", more: 0, quiet: true }
      : {
          ...decideReason(reasonOwner, context, findRowHolder(reasonOwner, context.userName)),
          // The group counts the members that ask, not the asks of one member.
          more: others.length,
          aside: undefined,
        };
  const time: InboxRowTime =
    placer === undefined
      ? { kind: "none" }
      : decideTime(placer, context, findRowHolder(placer, context.userName));
  const sources = [...new Set(group.rows.map((row) => row.source))];
  const count = `${String(group.size)} things`;
  const sentence = [reason.who, reason.rest].filter((word) => word !== undefined).join(" ");
  const parts = [
    `Linked group, ${count}: ${group.label}`,
    reason.more > 0
      ? `${sentence}, and ${String(reason.more)} more ask${reason.more === 1 ? "" : "s"}`
      : sentence,
  ];
  if (time.kind === "wait") parts.push(time.words.replace(/^Waiting/, "waiting"));
  return {
    key: group.key,
    title: group.label,
    time,
    reason,
    sources,
    count,
    label: parts.join(". "),
  };
};
