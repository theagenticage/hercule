import { useState, type JSX } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { isNotFound, type HerculeClient } from "@hercule/client-core";
import type { Project, Task, TaskUpdateInput } from "@hercule/contract";
import { Drawer } from "@hercule/ui";
import { taskQuery } from "../../../app/queries";
import { TaskDetail } from "./-detail";

/**
 * The task the address names, read and edited beside the list.
 *
 * Detail is a drawer over `/tasks`, so what is open is a parameter of the
 * list's own address and nothing else: opening, closing and the browser's own
 * Back are one mechanism. The list keys this component on that parameter, so
 * everything held here - a refusal above all - belongs to one task and is left
 * behind with it, whichever of the three the reader used.
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
  /** The task the address names, or none. */
  readonly openId: string | undefined;
  /** The same task as the listing already holds it, when it holds it. */
  readonly listed: Task | undefined;
  readonly projects: readonly Project[];
  readonly timezone: string;
  readonly reread: (id: string) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element | null {
  // A refused edit belongs to the task it was made on. The mutation's own error
  // cannot say that: every field of the drawer shares one mutation, so a second
  // edit issued before the first answers clears the first one's error before it
  // is ever rendered, and an error that does survive is rendered inside
  // whichever task's drawer is open next. So the refusal is held here, named by
  // the task it refused, and shown only there.
  const [refusal, setRefusal] = useState<
    { readonly taskId: string; readonly message: string } | undefined
  >(undefined);

  const edit = useMutation({
    mutationFn: ({ id, patch }: { readonly id: string; readonly patch: TaskUpdateInput }) =>
      client.task.update({ params: { id }, payload: patch }),
    // A write the controller took answers the refusal before it, so a refusal
    // held by hand is cleared by hand: what the drawer says about a task is
    // that task's last word, not its worst one.
    onSuccess: (_, variables) => {
      setRefusal((held) => (held?.taskId === variables.id ? undefined : held));
      return reread(variables.id);
    },
    onError: (error, variables) => {
      setRefusal({ taskId: variables.id, message: error.message });
    },
  });

  // The listing answers the panel instantly and the read keeps it right: a task
  // reached by address may be on no page fetched, and one the user has just
  // edited may have left the filter the listing is under. A read that is being
  // refetched keeps the answer it had, so an edit that takes the task out of
  // the filter does not take the panel with it.
  const opened = useQuery({ ...taskQuery(client, openId ?? ""), enabled: openId !== undefined });
  // A task the controller no longer has is the one case where what was read
  // before is not worth keeping: the row is gone from the list under the panel,
  // and a panel still showing it would be the screen contradicting itself.
  const gone = isNotFound(opened.error);
  const selected = gone ? undefined : (opened.data ?? listed);

  if (selected === undefined) {
    // A task named in the address that the controller will not answer for -
    // deleted, or never there - is not silence: the drawer opens and says what
    // the controller said.
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
