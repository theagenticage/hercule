import { useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { taskAttentionQuery } from "./queries";

/** What `useFailedRun` returns. */
export interface FailedRun {
  /** Whether any live Task has a failed run, which the sidebar draws as a dot. */
  readonly hasFailedRun: boolean;
  /**
   * Opens Work with the Failed filter on and the first failed card in view
   * (see the `failed` search param of the Work route).
   */
  readonly openFailedRuns: () => void;
}

/**
 * Returns whether a run failed on a Task, and a function that opens Work on
 * what failed. The Overview row and the Hercule segment of the face switch
 * both draw the dot from it, so a failure reaches the user from any screen.
 * The read is shell data, so it is cached before the sidebar draws.
 */
export function useFailedRun(): FailedRun {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const navigate = useNavigate();
  const { anyFailure } = useSuspenseQuery(taskAttentionQuery(client)).data;
  return {
    hasFailedRun: anyFailure,
    openFailedRuns: () => {
      void navigate({ to: "/work", search: { failed: true } });
    },
  };
}
