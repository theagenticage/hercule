import type { JSX } from "react";
import type { Task } from "@hercule/contract";
import { Button, EmptyState } from "@hercule/ui";
import { TaskRow } from "./-row";

/**
 * The tasks themselves: the rows, or the reason there are none.
 *
 * Emptiness is never presented as the same thing twice: a filter that matched
 * nothing says so, and a store with no tasks in it says what a task is for.
 */
export function TaskList({
  tasks,
  failure,
  pending,
  filtering,
  timezone,
  nameOf,
  openId,
  onOpen,
  more,
}: {
  readonly tasks: readonly Task[];
  /** What the controller answered, when it refused the listing. */
  readonly failure: string | undefined;
  readonly pending: boolean;
  /** Whether the listing was asked under any filter at all. */
  readonly filtering: boolean;
  readonly timezone: string;
  readonly nameOf: (id: string) => string;
  readonly openId: string | undefined;
  readonly onOpen: (id: string) => void;
  /** The next page, when the listing has one. */
  readonly more: { readonly pending: boolean; readonly fetch: () => void } | undefined;
}): JSX.Element | null {
  if (failure !== undefined) {
    return <EmptyState headline="The tasks could not be read." lead={failure} />;
  }
  if (pending) return null;
  if (tasks.length === 0) {
    return filtering ? (
      <EmptyState headline="Nothing matches these filters." />
    ) : (
      <EmptyState
        headline="No tasks yet."
        lead="Triage proposes tasks from what comes in, and you can add one by hand. A task is intent; a run or a thread does the work."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-card border border-line-soft bg-surface px-1.5 py-1">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            project={task.projectId === undefined ? "" : nameOf(task.projectId)}
            timezone={timezone}
            selected={task.id === openId}
            onOpen={() => {
              onOpen(task.id);
            }}
          />
        ))}
      </div>
      {more === undefined ? null : (
        <Button disabled={more.pending} onClick={more.fetch}>
          Show more
        </Button>
      )}
    </div>
  );
}
