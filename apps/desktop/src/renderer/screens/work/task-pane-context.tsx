import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { buildTaskContextRows } from "@hercule/client-core/work";
import type { TaskDetail } from "@hercule/contract";
import { RelationRows } from "../desk";

/**
 * Renders what the Task is part of, and the outside things it links, as the
 * shared relation rows. A section the Task has nothing for is not drawn.
 *
 * - Part of lists every place above the linked things by every path, each
 *   once, nearest first. A place no Connection can read is a locked row.
 * - Linked lists the linked things themselves, in the order they were linked.
 *
 * `plugins` is what `plugin.query` returns, for the marks and the names.
 */
export function ContextSections({
  detail,
  plugins,
}: {
  readonly detail: TaskDetail;
  readonly plugins: ReadonlyArray<PluginIdentity>;
}): JSX.Element | null {
  const { partOf, linked } = buildTaskContextRows(detail);
  if (partOf.length === 0 && linked.length === 0) return null;
  return (
    <>
      {partOf.length > 0 && (
        <section className="task-pane-sec task-pane-context" aria-label="Part of">
          <h3>Part of</h3>
          <RelationRows rows={partOf} plugins={plugins} />
        </section>
      )}
      {/* The direct links between sources and the Mentioned section join here, with slice 5. */}
      {linked.length > 0 && (
        <section className="task-pane-sec task-pane-context" aria-label="Linked">
          <h3>Linked</h3>
          <RelationRows rows={linked} plugins={plugins} />
        </section>
      )}
    </>
  );
}
