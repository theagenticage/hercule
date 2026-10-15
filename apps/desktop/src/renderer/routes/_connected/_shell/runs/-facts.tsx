import { useState, type JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  describeReruns,
  describeRunnerWait,
  describeRunWorkspace,
  describeTextGenerationWait,
  formatWorkspaceLabel,
  type HerculeClient,
} from "@hercule/client-core";
import type { Run } from "@hercule/contract";
import {
  controllerQuery,
  rerunsQuery,
  resourcesQuery,
  runnersQuery,
  workflowActionsQuery,
  workspacesQuery,
} from "../../../../app/queries";
import { RunFacts } from "../../../../screens/workflows/run-page";
import { DeleteWorkspaceDialog } from "./-dialogs";

/**
 * Reads and draws what the web app's run page shows about `run` besides its
 * lead (`RunFacts`): its re-runs, its runner, its workspace, and why it
 * waits for a runner or for text generation, with times in `timezone`. It
 * opens the Delete workspace dialog from the workspace's row.
 *
 * The route's loader reads the re-runs and the workflow actions, and the
 * controller's own record for a run with a text generation step; the
 * runners, the workspaces and the resources are shell reads, cached already.
 * A run with no text generation step does not read the controller's record.
 */
export function RunFactsSection({
  client,
  run,
  timezone,
}: {
  readonly client: HerculeClient;
  readonly run: Run;
  readonly timezone: string;
}): JSX.Element {
  const [isDeletingWorkspace, setIsDeletingWorkspace] = useState(false);
  const { data: reruns } = useSuspenseQuery(rerunsQuery(client, run.id));
  const { data: runners } = useSuspenseQuery(runnersQuery(client));
  const { data: workspaces } = useSuspenseQuery(workspacesQuery(client));
  const { data: resources } = useSuspenseQuery(resourcesQuery(client));
  const { data: actions } = useSuspenseQuery(workflowActionsQuery(client));
  const hasTextGeneration = run.plan.steps.some((step) => step.kind === "text-generation");
  const { data: controllerInfo } = useQuery({
    ...controllerQuery(client),
    enabled: hasTextGeneration,
  });
  const runner = runners.find((each) => each.id === run.runnerId);
  const workspace = workspaces.find((each) => each.id === run.workspaceId);
  const workspaceReading = describeRunWorkspace(run, workspace, timezone);
  return (
    <>
      <RunFacts
        originalRunId={run.originalRunId}
        reruns={describeReruns({ items: reruns })}
        runner={runner}
        workspaceLabel={
          workspace === undefined ? undefined : formatWorkspaceLabel(workspace, resources, runners)
        }
        workspaceNote={workspaceReading.note}
        onDeleteWorkspace={
          workspaceReading.offersDelete ? () => setIsDeletingWorkspace(true) : undefined
        }
        runnerWaitText={describeRunnerWait(run, runner, actions, timezone)?.text}
        textGenerationWaitReason={
          controllerInfo === undefined
            ? undefined
            : describeTextGenerationWait(run, controllerInfo.textGeneration)?.reason
        }
        timezone={timezone}
      />
      {isDeletingWorkspace && workspace !== undefined ? (
        <DeleteWorkspaceDialog
          client={client}
          workspaceId={workspace.id}
          onClose={() => setIsDeletingWorkspace(false)}
        />
      ) : null}
    </>
  );
}
