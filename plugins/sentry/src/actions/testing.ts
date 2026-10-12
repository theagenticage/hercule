/**
 * Helpers for the tests of the Sentry workflow actions: the context a step
 * passes. An action's `perform` runs against the fake Sentry with
 * `runAgainstStub` from `../testing`.
 */
import type { ActionContext } from "@hercule/plugin-host";
import { TEST_TOKEN } from "../testing";

/**
 * Builds the context a step passes to an action that acts through a
 * Connection with these credentials. The credentials default to a pasted
 * token.
 */
export const buildActionContext = (
  credentials: Readonly<Record<string, string>> = { token: TEST_TOKEN },
): ActionContext => ({
  connection: { id: "conn_sentry", credentials: { ...credentials }, config: {} },
  run: { runId: "run_1", stepId: "step_1" },
  signal: new AbortController().signal,
});
