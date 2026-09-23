/**
 * The controller's validation of the source on a workflow's page. The page
 * owns the request, and the editor marks the answer that the page hands it.
 */
import { useEffect, useEffectEvent, useState } from "react";
import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import type { HerculeClient, Live, WorkflowValidation } from "@hercule/client-core";
import type { Issue } from "@hercule/contract";
import { workflowValidationQuery } from "../../../app/queries";
import { readErrorMessage } from "../../../screens/save-status";

/** How long the source must stay unchanged before the controller validates it. */
const VALIDATION_DELAY_MS = 400;

/**
 * The controller's last answer about a source of the page. The controller
 * validates a source once it has stayed unchanged for about 400 ms, so a
 * source that the author is still typing sends no request. A source that was
 * validated before answers from the cache, with no wait for the controller.
 * While the answer about the new source is to come, the answer about the
 * source before it stays, and it names the source that it is about. A
 * validation that could not run runs again when the live connection comes
 * back, because that is when the controller can be reached again.
 */
export const useWorkflowValidation = (
  client: HerculeClient,
  live: Live,
  source: string,
): WorkflowValidation | undefined => {
  const [validatedSource, setValidatedSource] = useState(source);
  useEffect(() => {
    const timer = setTimeout(() => {
      setValidatedSource(source);
    }, VALIDATION_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [source]);

  const validation = useQuery({
    ...workflowValidationQuery(client, validatedSource),
    placeholderData: keepPreviousData,
  });

  const validateAgainAfterFailure = useEffectEvent(() => {
    if (validation.isError) void validation.refetch();
  });
  useEffect(
    () =>
      live.onStatus((status) => {
        if (status === "connected") validateAgainAfterFailure();
      }),
    [live],
  );

  if (!validation.isError) return validation.data;
  // A validation that runs again after a failure has no answer yet.
  return validation.isFetching
    ? undefined
    : { source: validatedSource, reason: readErrorMessage(validation.error) };
};

/**
 * Records the errors that the controller refused a save of `source` with, as
 * its answer about that source. A refusal is an answer about its source as a
 * validation is, and the last answer to arrive wins: a validation of the same
 * source that answers after the refusal replaces it. The warnings of an
 * earlier validation of the same source stay, because a refusal names errors
 * only.
 */
export const recordSaveRefusal = (
  queryClient: QueryClient,
  client: HerculeClient,
  source: string,
  errors: ReadonlyArray<Issue>,
): void => {
  queryClient.setQueryData(workflowValidationQuery(client, source).queryKey, (last) => ({
    source,
    issues: { errors, warnings: last?.issues.warnings ?? [] },
  }));
};
