/**
 * The rows the details pane draws from the outside things its Task links:
 * what the Task is part of, and the linked things themselves. Both are rows
 * of the shared relation rows (`../desk/relation-rows`).
 */
import type { TaskDetail } from "@hercule/contract";
import {
  buildPlaceRow,
  indexRelationGraph,
  readAncestorRows,
  type AncestorRow,
  type PlaceRow,
  type RowLink,
} from "../desk/relation-rows";

/** What a row knows of a link the Task holds itself: no one's words explain it, and the user may remove it. */
const OWN_LINK: RowLink = { kind: "own", canUnlink: true };

/** What `task.readDetail` carries about the Task's linked things, which is all the rows are built from. */
export type TaskContext = Pick<TaskDetail, "entities" | "places" | "edges">;

/** The pane's rows for the outside graph. Either list is empty when the Task has nothing for it. */
export interface TaskContextRows {
  /** Every place above any linked thing, each once, nearest first. */
  readonly partOf: readonly PlaceRow[];
  /** The linked things, in the order they were linked. */
  readonly linked: readonly PlaceRow[];
}

/**
 * Builds the pane's rows from the Task's linked things.
 *
 * - `partOf` joins the ancestors of every linked thing by every path. A
 *   place two things lead to comes once, at its shortest distance from any of
 *   them, and places at the same distance keep the order the linked things
 *   were linked in.
 * - `linked` is a row per linked thing. An open row's title starts with its
 *   identifier ("SHOP-123 Serve smaller photos"). A thing no Connection can
 *   read is a locked row with neither. Every row is a link of the Task
 *   itself, so the user can remove it (`canUnlink`).
 */
export const buildTaskContextRows = (context: TaskContext): TaskContextRows => {
  const index = indexRelationGraph(context);
  const nearest = new Map<string, AncestorRow>();
  for (const entity of context.entities) {
    for (const ancestor of readAncestorRows(entity.ref, context, index)) {
      const known = nearest.get(ancestor.ref);
      if (known === undefined || ancestor.depth < known.depth) nearest.set(ancestor.ref, ancestor);
    }
  }
  return {
    // `toSorted` is stable, so equal distances keep the order they were found in.
    partOf: [...nearest.values()].toSorted((a, b) => a.depth - b.depth),
    linked: context.entities.map((entity) => {
      const row: PlaceRow = { ...buildPlaceRow(entity), link: OWN_LINK };
      return row.isLocked || entity.identifier === undefined
        ? row
        : { ...row, title: `${entity.identifier} ${row.title}` };
    }),
  };
};
