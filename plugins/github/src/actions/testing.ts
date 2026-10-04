/**
 * Helpers for the tests of the GitHub workflow actions: the context a step
 * passes, a way to read the output of an action that succeeded, and a way to
 * read back the JSON body of a request the stub received. An action's
 * `perform` runs against a stub client with `runAgainstStub` from
 * `../testing`.
 */
import { Result } from "effect";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { ActionContext, ActionError } from "@hercule/plugin-host";

/** The token every test's Connection holds. */
export const TEST_TOKEN = "ghp_a-real-looking-token";

/**
 * Builds the context a step passes to an action that acts through a
 * Connection with these credentials. The credentials default to a pasted
 * token.
 */
export const buildActionContext = (
  credentials: Readonly<Record<string, string>> = { pat: TEST_TOKEN },
): ActionContext => ({
  connection: { id: "conn_github", credentials: { ...credentials }, config: {} },
  run: { runId: "run_1", stepId: "step_1" },
  signal: new AbortController().signal,
});

/** Returns the output of an action that succeeded. Throws when it failed, with its error. */
export const readSuccess = <A>(outcome: Result.Result<A, ActionError>): A => {
  if (Result.isFailure(outcome)) {
    throw new Error(`the action failed: ${outcome.failure.code}: ${outcome.failure.message}`);
  }
  return outcome.success;
};

/** Parses the JSON body of a request. Returns undefined when the request has no body. */
export const readJsonBody = (request: HttpClientRequest.HttpClientRequest | undefined): unknown =>
  request?.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;
