import { useQuery } from "@tanstack/react-query";
import { isNotFound, type HerculeClient } from "@hercule/client-core";
import type { Workflow } from "@hercule/contract";
import { workflowQuery } from "../../app/queries";

/** What `useRunWorkflow` reads of a run's workflow. */
export interface RunWorkflow {
  /** The workflow, or `undefined` while it is not read, when the run has none, or when it was deleted. */
  readonly workflow: Workflow | undefined;
  /** Whether the workflow was deleted since the run started: the read failed as not found. */
  readonly isDeleted: boolean;
}

/**
 * Reads the workflow `workflowId`, which a run was started from, without
 * suspending: the run's loader has already started the read. `workflowId` is
 * `null` for a run started with a workflow that was never saved, which reads
 * nothing.
 *
 * A deleted workflow fails as not found, which is the answer, so the read is
 * not tried again when the component mounts again.
 */
export const useRunWorkflow = (client: HerculeClient, workflowId: string | null): RunWorkflow => {
  const read = useQuery({
    ...workflowQuery(client, workflowId ?? ""),
    enabled: workflowId !== null,
    retryOnMount: false,
  });
  const isDeleted = isNotFound(read.error);
  return { workflow: isDeleted ? undefined : read.data, isDeleted };
};
