import { useEffect, useEffectEvent, useState } from "react";
import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import type { HerculeClient, Live, WorkflowValidation } from "@hercule/client-core";
import type { Issue } from "@hercule/contract";
import { workflowValidationQuery } from "../../../app/queries";
import { readErrorMessage } from "../../../screens/save-status";

/** How long the source must stay unchanged before the page asks the controller to validate it. */
const VALIDATION_DELAY_MS = 400;

/**
 * Asks the controller to validate the page's source. Returns the latest
 * result, which is either the issues or the reason the request failed, or
 * `undefined` while there is no result yet.
 *
 * - The request is sent once the source has not changed for 400 ms, so no
 *   request is sent while the user is still typing.
 * - The result for a source that was validated before comes from the cache.
 * - While a new source is being validated, the previous result stays. Each
 *   result includes the source it belongs to, so the editor can tell them
 *   apart.
 * - A failed validation runs again when the live connection reconnects,
 *   because that is when the controller is reachable again.
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
  // A retry after a failure has no result yet.
  return validation.isFetching
    ? undefined
    : { source: validatedSource, reason: readErrorMessage(validation.error) };
};

/**
 * Stores the errors from a rejected save of `source` as the validation result
 * for that source, so the editor marks them like any other validation errors.
 * The result that arrives last wins: a validation of the same source that
 * returns after the rejection replaces it. Warnings from an earlier
 * validation of the same source are kept, because a rejected save returns
 * errors only.
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
