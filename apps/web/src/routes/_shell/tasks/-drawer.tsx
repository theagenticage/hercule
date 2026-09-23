import { useState, type JSX } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { isNotFound, type HerculeClient } from "@hercule/client-core";
import type { Project, Task, TaskUpdateInput } from "@hercule/contract";
import { Drawer } from "@hercule/ui";
import { taskQuery } from "../../../app/queries";
import { TaskDetail } from "./-detail";

/**
 * The drawer that shows and edits the task named in the URL, beside the list.
 *
 * The drawer sits over `/tasks`, so the open task is only a search parameter
 * of the list's URL. Opening, closing and the browser's Back button all work
 * the same way: they change that parameter. The list keys this component on
 * the parameter, so all state held here - above all an edit error - belongs to
 * one task and is discarded when the user leaves it, whichever way they leave.
 */
export function TaskDrawer({
  client,
  openId,
  listed,
  projects,
  timezone,
  reread,
  onClose,
}: {
  readonly client: HerculeClient;
  /** The id of the task named in the URL, if any. */
  readonly openId: string | undefined;
  /** The same task as the list already has it, if the list has it. */
  readonly listed: Task | undefined;
  readonly projects: readonly Project[];
  readonly timezone: string;
  readonly reread: (id: string) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element | null {
  // A failed edit belongs to the task it was made on. The mutation's own error
  // cannot track that, because every field in the drawer shares one mutation:
  // - a second edit sent before the first returns clears the first one's error
  //   before it is ever rendered;
  // - an error that does survive would render in whichever task's drawer is
  //   open next.
  // So the error is stored here with the id of its task, and shown only for
  // that task.
  const [refusal, setRefusal] = useState<
    { readonly taskId: string; readonly message: string } | undefined
  >(undefined);

  const edit = useMutation({
    mutationFn: ({ id, patch }: { readonly id: string; readonly patch: TaskUpdateInput }) =>
      client.task.update({ params: { id }, payload: patch }),
    // A successful edit supersedes an earlier failed one, so clear the stored
    // error by hand. The drawer shows the result of the task's latest edit,
    // not its worst one.
    onSuccess: (_, variables) => {
      setRefusal((held) => (held?.taskId === variables.id ? undefined : held));
      return reread(variables.id);
    },
    onError: (error, variables) => {
      setRefusal({ taskId: variables.id, message: error.message });
    },
  });

  // The list's copy fills the drawer instantly, and the task's own read keeps
  // it correct: a task opened by URL may not be on any fetched page, and a task
  // the user just edited may no longer match the list's filter. A query that is
  // refetching keeps its previous data, so an edit that removes the task from
  // the filter does not close the drawer.
  const opened = useQuery({ ...taskQuery(client, openId ?? ""), enabled: openId !== undefined });
  // A 404 is the one case where the earlier data should be dropped: the row is
  // gone from the list behind the drawer, and a drawer still showing the task
  // would contradict the list.
  const gone = isNotFound(opened.error);
  const selected = gone ? undefined : (opened.data ?? listed);

  if (selected === undefined) {
    // If the task in the URL cannot be read - it was deleted, or never
    // existed - the drawer still opens and shows the controller's error
    // message, rather than showing nothing.
    if (openId === undefined || !opened.isError) return null;
    return (
      <Drawer open onClose={onClose} title="Task not found">
        <p className="text-row leading-relaxed text-muted">{opened.error.message}</p>
      </Drawer>
    );
  }

  return (
    <TaskDetail
      task={selected}
      projects={projects}
      timezone={timezone}
      failure={refusal?.taskId === selected.id ? refusal.message : undefined}
      onEdit={(patch) => {
        edit.mutate({ id: selected.id, patch });
      }}
      onClose={onClose}
    />
  );
}
