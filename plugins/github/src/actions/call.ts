/**
 * What every GitHub workflow action shares: how it is defined, how it reads
 * the Connection's token, how it calls GitHub, and how it turns GitHub's
 * failures into an `ActionError`. All nine actions fail with the same codes:
 *
 * - `unauthenticated`: the step has no Connection, the Connection has no
 *   token, or GitHub rejected the token (401).
 * - `rate_limited`: GitHub's rate limit for the account is used up (429, or
 *   403 with `Retry-After` or no requests left; see `isRateLimited`).
 * - `forbidden`: the account may not do this (403).
 * - `not_found`: the thing does not exist, or the account cannot see it (404).
 * - `conflict`: the thing is not in a state that allows the change, such as
 *   a pull request that cannot be merged (405, 409).
 * - `validation`: GitHub refused the request as invalid (422).
 * - `unavailable`: GitHub could not be reached, or failed (5xx).
 * - `unexpected`: GitHub answered with any other status, or with a body of
 *   an unexpected shape.
 *
 * The codes are spelled like the public API's error codes, which a step
 * record stores for a built-in action.
 */
import { Effect, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  ActionError,
  type ActionContext,
  type WorkflowActionContribution,
} from "@hercule/plugin-host";
import {
  isRateLimited,
  readGithubExplanation,
  readToken,
  requestGithub,
  type GithubRequest,
  type GithubResponse,
} from "../api";
import { GITHUB_CONNECTION_TYPE } from "../connection-type";

/**
 * A GitHub workflow action as this plugin writes it: the contribution the
 * host registers, plus `perform`, which does the work.
 *
 * `perform` still requires an `HttpClient`. The contribution's `execute`
 * provides the fetch client, and a test calls `perform` with a stub client
 * instead (see `testing.ts`).
 */
export interface GithubAction<
  Input extends Schema.Top,
  Output extends Schema.Top,
> extends WorkflowActionContribution {
  readonly input: Input;
  readonly output: Output;
  readonly perform: (
    input: Input["Type"],
    context: ActionContext,
  ) => Effect.Effect<Output["Type"], ActionError, HttpClient.HttpClient>;
}

/**
 * Builds a GitHub workflow action from its id, names, schemas and `perform`.
 * The action declares the GitHub Connection type, and its `execute` calls
 * `perform` with the fetch client.
 */
export const defineGithubAction = <Input extends Schema.Top, Output extends Schema.Top>(
  definition: Omit<GithubAction<Input, Output>, "connection" | "execute">,
): GithubAction<Input, Output> => ({
  ...definition,
  connection: { type: GITHUB_CONNECTION_TYPE },
  // The host decodes the step's params with `input` before it calls
  // `execute`, so the input already has the input schema's type.
  execute: (input, context) =>
    Effect.provide(definition.perform(input as Input["Type"], context), FetchHttpClient.layer),
});

/**
 * Returns the token of the Connection the step acts through. Fails with
 * `unauthenticated` when the step has no Connection, or the Connection's
 * credentials hold no token.
 */
export const readConnectionToken = (context: ActionContext): Effect.Effect<string, ActionError> => {
  if (context.connection === undefined) {
    return Effect.fail(
      new ActionError({
        code: "unauthenticated",
        message:
          "The step names no GitHub Connection to act through. Set the step's connection param to a GitHub Connection.",
      }),
    );
  }
  const token = readToken(context.connection.credentials);
  return token === undefined
    ? Effect.fail(
        new ActionError({
          code: "unauthenticated",
          message: "The GitHub Connection has no token. Reconnect it under Connections.",
        }),
      )
    : Effect.succeed(token);
};

/** Appends GitHub's explanation to a sentence, when there is one. */
const appendExplanation = (sentence: string, explanation: string): string =>
  explanation.length === 0 ? sentence : `${sentence} GitHub said: ${explanation}`;

/**
 * Converts a response GitHub answered with a status other than 2xx into the
 * `ActionError` the step fails with. `subject` names what the request was
 * about, such as "The issue octocat/hello-world#42", for the message of a 404.
 */
const convertGithubFailure = (response: GithubResponse, subject: string): ActionError => {
  const explanation = readGithubExplanation(response.body);
  const buildError = (code: string, message: string) => new ActionError({ code, message });
  const { status } = response;
  if (status === 401) {
    return buildError(
      "unauthenticated",
      "GitHub rejected the Connection's token. Reconnect it under Connections.",
    );
  }
  if (isRateLimited(response)) {
    const wait =
      response.retryAfterSeconds === undefined
        ? "Try again later."
        : `Try again in ${String(response.retryAfterSeconds)} seconds.`;
    return buildError(
      "rate_limited",
      `GitHub's rate limit for the Connection's account is used up. ${wait}`,
    );
  }
  if (status === 403) {
    return buildError(
      "forbidden",
      appendExplanation(
        "The Connection's account is not allowed to do this on GitHub.",
        explanation,
      ),
    );
  }
  if (status === 404) {
    return buildError(
      "not_found",
      `${subject} does not exist, or the Connection's account cannot see it.`,
    );
  }
  if (status === 405 || status === 409) {
    return buildError("conflict", appendExplanation("GitHub refused the change.", explanation));
  }
  if (status === 422) {
    return buildError(
      "validation",
      appendExplanation("GitHub refused the request as invalid.", explanation),
    );
  }
  if (status >= 500) {
    return buildError(
      "unavailable",
      `GitHub failed with status ${String(status)}. Try again later.`,
    );
  }
  return buildError(
    "unexpected",
    appendExplanation(`GitHub answered with status ${String(status)}.`, explanation),
  );
};

/**
 * Sends one request to GitHub and returns the body of a 2xx response. Fails
 * with the `ActionError` from `convertGithubFailure` for any other status,
 * and with `unavailable` when GitHub could not be reached.
 */
export const callGithub = (
  request: GithubRequest,
  subject: string,
): Effect.Effect<Schema.Json, ActionError, HttpClient.HttpClient> =>
  requestGithub(request).pipe(
    Effect.mapError((error) => new ActionError({ code: "unavailable", message: error.message })),
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response.body)
        : Effect.fail(convertGithubFailure(response, subject)),
    ),
  );

/**
 * Decodes the body of a GitHub response with `schema`. Fails with
 * `unexpected` when the body does not match, which happens only when GitHub
 * changes its API.
 */
export const decodeGithubBody = <S extends Schema.Decoder<unknown>>(
  schema: S,
  body: Schema.Json,
): Effect.Effect<S["Type"], ActionError> =>
  Effect.mapError(
    Schema.decodeUnknownEffect(schema)(body),
    (error) =>
      new ActionError({
        code: "unexpected",
        message: `GitHub's response did not have the expected shape: ${error.message}`,
      }),
  );
