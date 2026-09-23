import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import type { WorkflowSummary } from "@hercule/contract";
import { Switch, cn } from "@hercule/ui";
import { readErrorMessage, SaveStatus } from "../../../screens/save-status";

/**
 * One workflow: what it is called and what it does, whether its triggers
 * are on, and how long ago its text changed. The name opens the workflow's
 * page, and the whole row answers to it. The row owns the switch's write,
 * because the write is about this workflow and nothing above it needs to
 * know.
 */
export function WorkflowRow({
  client,
  workflow,
  age,
}: {
  readonly client: HerculeClient;
  readonly workflow: WorkflowSummary;
  /** How long ago the workflow's text changed, as the app reads an age. */
  readonly age: string;
}): JSX.Element {
  const queryClient = useQueryClient();

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      client.workflow.update({ params: { id: workflow.id }, payload: { enabled } }),
    // The write stays pending until the listing is read again, so the switch
    // never shows the old state between the answer and the new listing.
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
        {/* After the link that covers the row, so it is above the link: a
            press turns the switch and opens nothing. While the write is in
            flight, the switch ignores presses and keeps the focus. */}
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
