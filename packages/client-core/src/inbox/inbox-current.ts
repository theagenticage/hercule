/**
 * What the current entry of the Inbox list means to the screen around the
 * list: which pane shows, and what Return does. Pure: both functions read a
 * snapshot of the visit and return a decision.
 */
import type { InboxVisitRow, InboxVisitSnapshot } from "./inbox-visit";

/**
 * What the pane is about:
 * - `selection`: two or more selected things, or one that is not the current
 *   line. `thing` is the current thing, else the first selected one, because
 *   the pane of a selection is drawn around one thing.
 * - `thing`: the current line is a thing (alone or a member of an open group).
 * - `group`: the current line is a group's head or its "Show N more" line.
 *   `labelRef` is the member the group is named after, by which the pane
 *   reads the group.
 * - `none`: nothing is current, or the list is not ready.
 */
export type InboxPaneSubject<Row> =
  | { readonly kind: "selection"; readonly thing: Row; readonly rows: readonly Row[] }
  | { readonly kind: "thing"; readonly thing: Row }
  | { readonly kind: "group"; readonly labelRef: string }
  | { readonly kind: "none" };

/** Returns what the pane is about for `snapshot` (see `InboxPaneSubject`). */
export function findPaneSubject<Row extends InboxVisitRow>(
  snapshot: Pick<
    InboxVisitSnapshot<Row, unknown>,
    "status" | "rows" | "entries" | "current" | "selection"
  >,
): InboxPaneSubject<Row> {
  if (snapshot.status !== "ready") return { kind: "none" };
  const current = snapshot.rows.find((row) => row.ref === snapshot.current);
  const selected = snapshot.rows.filter((row) => snapshot.selection.has(row.ref));
  if (selected.length >= 2 || (selected.length === 1 && selected[0]!.ref !== snapshot.current)) {
    return { kind: "selection", thing: current ?? selected[0]!, rows: selected };
  }
  if (current !== undefined) return { kind: "thing", thing: current };
  const entry = snapshot.entries.find((candidate) => candidate.key === snapshot.current);
  if (entry?.kind !== "head" && entry?.kind !== "more") return { kind: "none" };
  const groupKey = entry.kind === "head" ? entry.key : entry.groupKey;
  const head = snapshot.entries.find((candidate) => candidate.key === groupKey);
  return head?.kind === "head"
    ? { kind: "group", labelRef: head.group.labelRef }
    : { kind: "none" };
}

/**
 * Returns what Return does on the current line of `snapshot`. `isPaneHidden`
 * is true when the window is too narrow for the pane to sit beside the list
 * and the pane is not slid over it.
 * - On a group's head: opens the group, or when it is open already and the
 *   pane is hidden, shows the pane (`showPane`), so the group's pane is
 *   reachable from the keys.
 * - On a "Show N more" line: shows the rest of the group (`showMore`).
 * - On a thing: shows the pane when it is hidden, else answers the thing's
 *   current ask in the pane (`answerAsk`).
 * - `none` when the pane is hidden and nothing is current.
 */
export function decideInboxActivation(
  snapshot: Pick<InboxVisitSnapshot<InboxVisitRow, unknown>, "status" | "entries" | "current">,
  isPaneHidden: boolean,
): "openGroup" | "showMore" | "showPane" | "answerAsk" | "none" {
  const entry = snapshot.entries.find((candidate) => candidate.key === snapshot.current);
  if (entry?.kind === "head") return entry.group.isOpen && isPaneHidden ? "showPane" : "openGroup";
  if (entry?.kind === "more") return "showMore";
  if (!isPaneHidden) return "answerAsk";
  return snapshot.status === "ready" && snapshot.current !== null ? "showPane" : "none";
}
