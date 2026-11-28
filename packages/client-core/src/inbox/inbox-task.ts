/**
 * What runs on the active Task of a thing on the Inbox: the one rule the row,
 * the pane's Task strip and the group views all read, so they never disagree.
 */
import type { InboxThing } from "@hercule/contract";

/**
 * Returns what runs on the Task of `thing`, in words, or `undefined` when
 * nothing does:
 *
 * - the live workflows: "Review PR running", "Review PR and Triage running",
 *   or "3 workflows running";
 * - the working Threads: "1 thread working", "2 threads working";
 * - both, joined with " · ".
 *
 * A thing that was just handed to a workflow has that workflow in
 * `liveWorkflows` before it has a `task`, so the workflow is named even then.
 */
export const describeTaskActivity = (
  thing: Pick<InboxThing, "task" | "liveWorkflows">,
): string | undefined => {
  const names = thing.liveWorkflows.map((workflow) => workflow.name);
  const threads = thing.task?.workingThreadCount ?? 0;
  const parts = [
    ...(names.length === 0
      ? []
      : names.length <= 2
        ? [`${names.join(" and ")} running`]
        : [`${String(names.length)} workflows running`]),
    ...(threads === 0 ? [] : [`${String(threads)} thread${threads === 1 ? "" : "s"} working`]),
  ];
  return parts.length === 0 ? undefined : parts.join(" · ");
};
