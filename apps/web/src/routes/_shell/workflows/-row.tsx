import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient, readErrorMessage } from "@hercule/client-core";
import type { WorkflowSummary } from "@hercule/contract";
import { Switch, cn } from "@hercule/ui";
import { SaveStatus } from "../../../screens/save-status";

/**
 * Renders one workflow in the list: its name, its description, a switch that
 * turns its triggers on or off, and how long ago its source changed. The
 * whole row links to the workflow's page. The row owns the switch's
 * mutation, because nothing above the row needs it.
 */
export function WorkflowRow({
  client,
  workflow,
  age,
}: {
  readonly client: HerculeClient;
  readonly workflow: WorkflowSummary;
  /** How long ago the workflow's source changed, already formatted. */
  readonly age: string;
}): JSX.Element {
  const queryClient = useQueryClient();

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      client.workflow.update({ params: { id: workflow.id }, payload: { enabled } }),
    // Returning the promise keeps the mutation pending until the list is
    // refetched. Otherwise the switch would briefly show the old state
    // between the response and the refetch.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.workflows() }),
  });

  return (
    <li className="relative flex flex-col gap-1 rounded-control px-2.5 py-2 text-row hover:bg-line-soft">
      <div className="flex items-center gap-3">
        <Link
          to="/workflows/$workflowId"
          params={{ workflowId: workflow.id }}
          className={cn(
            "max-w-[45%] shrink-0 truncate font-emph text-ink focus-visible:outline-none",
            // The link covers the row, so the whole row opens the workflow.
            "after:absolute after:inset-0 after:rounded-control after:content-['']",
            "focus-visible:after:outline-2 focus-visible:after:outline-offset-1 focus-visible:after:outline-live",
          )}
        >
          {workflow.name}
        </Link>
        <span className="min-w-0 flex-1 truncate text-muted">{workflow.description}</span>
        {/* Placed after the link that covers the row, so the switch sits on
            top of it: a click toggles the switch and does not open the
            workflow. `aria-disabled` makes the switch ignore clicks while the
            request is in flight, and it keeps the focus. */}
        <Switch
          aria-label="Enabled"
          checked={setEnabled.isPending ? setEnabled.variables : workflow.enabled}
          aria-disabled={setEnabled.isPending}
          onCheckedChange={(enabled) => {
            setEnabled.mutate(enabled);
          }}
        />
        <span className="w-8 shrink-0 text-right font-mono text-fine text-faint tabular-nums">
          {age}
        </span>
      </div>
      <SaveStatus
        saved={false}
        failure={setEnabled.error === null ? null : readErrorMessage(setEnabled.error)}
      />
    </li>
  );
}
