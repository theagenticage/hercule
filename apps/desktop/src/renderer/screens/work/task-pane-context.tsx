import type { JSX, ReactNode } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { buildTaskContextRows } from "@hercule/client-core/work";
import type { PlaceRow } from "@hercule/client-core/desk";
import type { TaskDetail } from "@hercule/contract";
import { RelationRows } from "../desk";

/**
 * Renders what the Task is part of, and the outside things it links, as the
 * shared relation rows. Part of is not drawn when the Task has nothing for it.
 *
 * - Part of lists every place above the linked things by every path, each
 *   once, nearest first. A place no Connection can read is a locked row. A
 *   place of a kind the board can group by is a button that calls
 *   `onFilterByPlace` with its ref, to show all its Tasks.
 * - Linked lists the linked things themselves, in the order they were linked.
 *   They do not name their kind: the identifier in the title already does.
 *   Each has a button that removes the link (`onUnlink`), and `linkSearch`,
 *   which links something else, stands under them. It is drawn even when
 *   nothing is linked yet, because it is how the first link is made. A
 *   Task with no `linkSearch` and no links has no Linked section.
 *
 * `plugins` is what `plugin.query` returns, for the marks and the names.
 */
export function ContextSections({
  detail,
  plugins,
  onFilterByPlace,
  onUnlink,
  linkSearch,
}: {
  readonly detail: TaskDetail;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onFilterByPlace: (placeRef: string) => void;
  readonly onUnlink: (row: PlaceRow) => void;
  readonly linkSearch: ReactNode;
}): JSX.Element | null {
  const { partOf, linked } = buildTaskContextRows(detail);
  if (partOf.length === 0 && linked.length === 0 && linkSearch === null) return null;
  return (
    <>
      {partOf.length > 0 && (
        <section className="task-pane-sec task-pane-context" aria-label="Part of">
          <h3>Part of</h3>
          <RelationRows
            rows={partOf}
            plugins={plugins}
            onWalk={onFilterByPlace}
            canWalk={(row) => row.caption !== undefined}
          />
        </section>
      )}
      {/* The direct links between sources and the Mentioned section join here, with slice 5. */}
      {(linked.length > 0 || linkSearch !== null) && (
        <section className="task-pane-sec task-pane-context" aria-label="Linked">
          <h3>Linked</h3>
          {linked.length > 0 && (
            <RelationRows rows={linked} plugins={plugins} isKindShown={false} onUnlink={onUnlink} />
          )}
          {linkSearch}
        </section>
      )}
    </>
  );
}
