/**
 * What one cell of the Work board shows. The rules, from the design's "Rows
 * at rest":
 *
 * - A cell shows four cards. A fifth is shown rather than hidden. Past that
 *   the rest wait behind a line, "13 more", that opens them in place.
 * - A card with an open question or a failure is always shown, also past the
 *   fourth row.
 * - A failed card leads its cell. Failed cards keep their stored order among
 *   themselves, and so do all the others.
 * - A filter, or a Find text, lifts the limit.
 * - Landed shows as a line, "3 landed", that opens the same way. A card with a
 *   question or a failure in Landed is shown as a card above that line.
 * - A stack is one lead card and the member cards under its sheet. It counts
 *   as one row, it floats as one unit, and it is loud when the lead or any
 *   member is.
 *
 * Arranging only chooses what to draw. It does not change `boardRank`.
 */
import type { BoardStage, WorkCard, WorkStackCandidate } from "@hercule/contract";
import { lowerFirst } from "../text";
import { pluralizeNoun } from "./context-lanes";

/** The most cards a cell shows before it hides any (the Landed cell shows none). */
export const ROWS_BEFORE_HIDING = 4;

/** A cell with this many cards or fewer shows all of them: the fifth is shown rather than hidden. */
const MOST_CARDS_SHOWN_WHOLE = ROWS_BEFORE_HIDING + 1;

/**
 * The line under the cards of a cell:
 *
 * - `none`: no line;
 * - `more`: "13 more", which opens the hidden cards;
 * - `landed`: "3 landed", the same for the Landed cell;
 * - `fewer`: "Show fewer", which closes an opened cell.
 */
export type CellFoot = "none" | "more" | "landed" | "fewer";

/** The cards a lead card holds under its sheet. */
export interface CellStack {
  /** The Tasks the lead takes, in the cell's stored order. Never empty. */
  readonly members: readonly WorkCard[];
  /** What the sheet says, such as "2 pull requests". */
  readonly reason: string;
  /** Whether the stack opens by itself: a member has an open question or a failure. */
  readonly opensItself: boolean;
}

/** What a cell shows. */
export interface ArrangedCell {
  /**
   * The cards to draw, top to bottom: each Task that is alone, and each lead
   * of a stack. A member of a stack is not in this list. It is in the
   * lead's entry in `stacks`.
   */
  readonly cards: readonly WorkCard[];
  /**
   * The stacks of the cell, by the id of the lead card, for the leads in
   * `cards` and in `hiddenCards`. A cell with no stack has an empty map.
   */
  readonly stacks: ReadonlyMap<string, CellStack>;
  /**
   * Every Task not drawn, hidden members included: each hidden card followed
   * by the members of its stack. Their number is the count on a `more` or
   * `landed` line.
   */
  readonly hiddenCards: readonly WorkCard[];
  readonly foot: CellFoot;
}

/** How the user looks at a cell. */
export interface CellView {
  readonly stage: BoardStage;
  /** Whether the user opened the hidden cards of this cell. */
  readonly opened: boolean;
  /** Whether a filter or a Find text is on. */
  readonly filtered: boolean;
}

const isFailed = (card: WorkCard): boolean => card.failure !== undefined;

/** Returns whether a card must never wait out of sight: it has a question or a failure. */
export const isLoudCard = (card: WorkCard): boolean =>
  isFailed(card) || card.openQuestion !== undefined;

/** A card that is drawn on its own row: a Task alone, or the lead of a stack with its members. */
interface CellRow {
  readonly card: WorkCard;
  readonly members: readonly WorkCard[];
}

/** Returns whether a row has a failure, in its card or in a member. */
const isFailedRow = (row: CellRow): boolean => isFailed(row.card) || row.members.some(isFailed);

/** Returns whether a row must never wait out of sight: its card or a member is loud. */
const isLoudRow = (row: CellRow): boolean => isLoudCard(row.card) || row.members.some(isLoudCard);

/**
 * Returns the rows of a cell: each Task once, as a lead with its members or
 * alone, in the cell's stored order. Stacks never nest:
 *
 * 1. Walk `cards` in stored order.
 * 2. A Task that no lead has taken becomes a lead when at least one of its
 *    candidate members in this cell is neither a lead nor taken yet. It takes
 *    all of those members.
 * 3. A Task taken as a member never leads, and a lead is never taken.
 *
 * A Task that the walk passed without leading is not placed yet: a later
 * lead may still take it. So a pull request's Task that sits above its
 * ticket's Task still joins the ticket's stack. A member wanted by two leads
 * joins the first lead in stored order, and two Tasks that each hold the
 * other make one stack, led by the first.
 */
const buildRows = (
  cards: readonly WorkCard[],
  candidates: readonly WorkStackCandidate[],
): { rows: readonly CellRow[]; nouns: ReadonlyMap<string, ReadonlyMap<string, string>> } => {
  const position = new Map(cards.map((card, index) => [card.id, index]));
  // lead id -> member id -> noun, only for pairs that are both in this cell.
  const nounsByLead = new Map<string, Map<string, string>>();
  for (const { leadTaskId, memberTaskId, noun } of candidates) {
    if (leadTaskId === memberTaskId) continue;
    if (!position.has(leadTaskId) || !position.has(memberTaskId)) continue;
    const members = nounsByLead.get(leadTaskId) ?? new Map<string, string>();
    if (!members.has(memberTaskId)) members.set(memberTaskId, noun);
    nounsByLead.set(leadTaskId, members);
  }
  const membersByLead = new Map<string, readonly WorkCard[]>();
  const taken = new Set<string>();
  for (const card of cards) {
    if (taken.has(card.id)) continue;
    const members = [...(nounsByLead.get(card.id)?.keys() ?? [])]
      .filter((id) => !taken.has(id) && !membersByLead.has(id))
      .toSorted((a, b) => position.get(a)! - position.get(b)!)
      .map((id) => cards[position.get(id)!]!);
    if (members.length === 0) continue;
    membersByLead.set(card.id, members);
    for (const member of members) taken.add(member.id);
  }
  const rows = cards
    .filter((card) => !taken.has(card.id))
    .map((card) => ({ card, members: membersByLead.get(card.id) ?? [] }));
  return { rows, nouns: nounsByLead };
};

/**
 * Returns what a stack's sheet says: the members counted by their noun, in
 * the order the nouns first appear, such as "2 pull requests" or
 * "2 pull requests, 1 issue".
 */
const describeStackReason = (members: readonly WorkCard[], nouns: ReadonlyMap<string, string>) => {
  const counts = new Map<string, number>();
  for (const member of members) {
    const noun = lowerFirst(nouns.get(member.id) ?? "");
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  return [...counts]
    .map(([noun, count]) => `${String(count)} ${count === 1 ? noun : pluralizeNoun(noun)}`)
    .join(", ");
};

/** The rows a cell draws and the rows it hides, with the line under them. */
interface RowSplit {
  readonly shown: readonly CellRow[];
  readonly hidden: readonly CellRow[];
  readonly foot: CellFoot;
}

/** Returns the split of a cell that is not opened, from its rows in display order. */
const splitClosed = (ordered: readonly CellRow[], stage: BoardStage): RowSplit => {
  if (stage !== "landed" && ordered.length <= MOST_CARDS_SHOWN_WHOLE) {
    return { shown: ordered, hidden: [], foot: "none" };
  }
  const lead = stage === "landed" ? [] : ordered.slice(0, ROWS_BEFORE_HIDING);
  const rest = stage === "landed" ? ordered : ordered.slice(ROWS_BEFORE_HIDING);
  const hidden = rest.filter((row) => !isLoudRow(row));
  return {
    shown: [...lead, ...rest.filter(isLoudRow)],
    hidden,
    foot: hidden.length === 0 ? "none" : stage === "landed" ? "landed" : "more",
  };
};

/**
 * Returns what the cell shows. `cards` are the cards of the cell in stored
 * order, as `buildLanes` returns them. The result lists the cards to draw,
 * the cards left out and the line under them.
 *
 * `candidates` are the pairs `WorkBoard.stackCandidates` holds that have
 * their lead in this cell (the caller selects them, so this function does not
 * walk the whole board's pairs). Only the pairs with both Tasks in this cell
 * can make a stack. A stack
 * is one row: the failed rows lead the cell, a stack counts as failed or loud
 * when its lead or any member is, and the row limit counts it once.
 *
 * An opened cell has a `fewer` line only when closing it would hide
 * something, so a cell of three never offers "Show fewer".
 */
export const arrangeCell = (
  cards: readonly WorkCard[],
  view: CellView,
  candidates: readonly WorkStackCandidate[],
): ArrangedCell => {
  const { rows, nouns } = buildRows(cards, candidates);
  const ordered = [...rows.filter(isFailedRow), ...rows.filter((row) => !isFailedRow(row))];
  const stacks = new Map<string, CellStack>(
    ordered
      .filter((row) => row.members.length > 0)
      .map((row) => [
        row.card.id,
        {
          members: row.members,
          reason: describeStackReason(row.members, nouns.get(row.card.id) ?? new Map()),
          opensItself: row.members.some(isLoudCard),
        },
      ]),
  );
  const draw = ({ shown, hidden, foot }: RowSplit): ArrangedCell => ({
    cards: shown.map((row) => row.card),
    stacks,
    hiddenCards: hidden.flatMap((row) => [row.card, ...row.members]),
    foot,
  });
  if (view.filtered) return draw({ shown: ordered, hidden: [], foot: "none" });
  const closed = splitClosed(ordered, view.stage);
  if (!view.opened || closed.hidden.length === 0) return draw(closed);
  return draw({ shown: ordered, hidden: [], foot: "fewer" });
};
