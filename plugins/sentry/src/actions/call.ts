/**
 * What every Sentry workflow action shares: how it is defined, how it reads
 * the Connection's token, and how it changes an issue. All three actions fail
 * with the same codes:
 *
 * - `unauthenticated`: the step has no Connection, the Connection has no
 *   token, or Sentry refused the token (401).
 * - `rate_limited`: Sentry refused the request because the Connection sent too
 *   many (429). The message says when to try again.
 * - `forbidden`: the account may not change this issue (403).
 * - `not_found`: the issue does not exist, or the account cannot see it (404).
 * - `unavailable`: Sentry could not be reached, did not answer in time, or
 *   failed (5xx). Trying again later may work.
 * - `unexpected`: Sentry answered with any other status, with a body that is
 *   not JSON or has an unexpected shape, or the request was refused before it
 *   was sent. Trying again changes nothing.
 *
 * The codes are spelled like the public API's error codes, which a step
 * record stores for a built-in action.
 */
import { Clock, Effect, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import {
  ActionError,
  type ActionContext,
  type AnswerAction,
  type WorkflowStepAction,
} from "@hercule/plugin-host";
import {
  computeRateLimitWaitSeconds,
  readSentryExplanation,
  readToken,
  requestSentry,
  SENTRY_API_URL,
  TOKEN_REFUSED_MESSAGE,
} from "../api";
import { SENTRY_CONNECTION_TYPE } from "../connection-type";

/** A Sentry workflow action as this plugin writes it: names, schemas, and where a signal's answer may run it. */
type SentryActionDefinition<Input extends Schema.Top, Output extends Schema.Top> = Pick<
  WorkflowStepAction,
  "id" | "displayName" | "description"
> &
  Pick<AnswerAction, "usableIn" | "describe" | "outcome"> & {
    readonly input: Input;
    readonly output: Output;
    readonly perform: (
      input: Input["Type"],
      context: ActionContext,
    ) => Effect.Effect<Output["Type"], ActionError, HttpClient.HttpClient>;
  };

/** A Sentry workflow action: its definition plus what the host registers it with. */
export type SentryAction<
  Input extends Schema.Top,
  Output extends Schema.Top,
> = SentryActionDefinition<Input, Output> & Pick<WorkflowStepAction, "connection" | "execute">;

/**
 * Builds a Sentry workflow action from its definition. The action declares
 * the Sentry Connection type, and its `execute` calls `perform` with the
 * fetch client. `perform` keeps the `HttpClient` requirement so a test can
 * call it with a stub client.
 */
export const defineSentryAction = <Input extends Schema.Top, Output extends Schema.Top>(
  definition: SentryActionDefinition<Input, Output>,
): SentryAction<Input, Output> => ({
  ...definition,
  connection: { type: SENTRY_CONNECTION_TYPE },
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
          "The step names no Sentry Connection to act through. Set the step's connection param to a Sentry Connection.",
      }),
    );
  }
  const token = readToken(context.connection.credentials);
  return token === undefined
    ? Effect.fail(
        new ActionError({
          code: "unauthenticated",
          message: "The Sentry Connection has no token. Reconnect it under Connections.",
        }),
      )
    : Effect.succeed(token);
};

/** The fields that name one issue. `shortId` and `projectSlug` are there for describe lines and outcomes. */
export const IssueAddress = Schema.Struct({
  orgSlug: Schema.NonEmptyString.annotate({ description: "The slug of the organization." }),
  issueId: Schema.NonEmptyString.annotate({ description: "The issue's numeric id." }),
  shortId: Schema.String.annotate({ description: "The issue's short id, such as WEBSHOP-1A." }),
  projectSlug: Schema.String.annotate({ description: "The slug of the issue's project." }),
});

/** What every action returns: the issue and the status it has afterwards. */
export const IssueUpdated = Schema.Struct({
  issueId: Schema.String,
  status: Schema.String.annotate({
    description: "The issue's status in Sentry afterwards: resolved, ignored or unresolved.",
  }),
});

/** The part of Sentry's answer to an update that the actions read. */
const UpdateAnswer = Schema.Struct({ status: Schema.String });

/**
 * Changes one issue with `PUT /api/0/organizations/{orgSlug}/issues/{issueId}/`
 * and returns the issue's id and status afterwards. `changes` is the JSON body.
 * Fails with the `ActionError` codes in the header of this file.
 */
export const updateIssue = (
  address: Pick<typeof IssueAddress.Type, "orgSlug" | "issueId">,
  changes: Readonly<Record<string, string>>,
  token: string,
): Effect.Effect<typeof IssueUpdated.Type, ActionError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const path = `/api/0/organizations/${encodeURIComponent(address.orgSlug)}/issues/${encodeURIComponent(address.issueId)}/`;
    const response = yield* requestSentry({
      method: "PUT",
      baseUrl: SENTRY_API_URL,
      path,
      token,
      body: changes,
    }).pipe(
      Effect.mapError(
        (error) =>
          new ActionError({
            code: error._tag === "SentryUnreachable" ? "unavailable" : "unexpected",
            message: error.message,
          }),
      ),
    );
    const { status } = response;
    const fail = (code: string, message: string) => Effect.fail(new ActionError({ code, message }));
    if (status === 401) return yield* fail("unauthenticated", TOKEN_REFUSED_MESSAGE);
    if (status === 429) {
      const seconds = computeRateLimitWaitSeconds(response, yield* Clock.currentTimeMillis);
      return yield* fail(
        "rate_limited",
        `Sentry rate limited the Connection. Try again in ${String(seconds)} seconds.`,
      );
    }
    const explanation = readSentryExplanation(response.body);
    const said = explanation === "" ? "" : ` Sentry said: ${explanation}`;
    if (status === 403) {
      return yield* fail(
        "forbidden",
        `The Connection's account is not allowed to change this issue in Sentry.${said}`,
      );
    }
    if (status === 404) {
      return yield* fail(
        "not_found",
        `The issue ${address.issueId} does not exist, or the Connection's account cannot see it.`,
      );
    }
    if (status >= 500) {
      return yield* fail(
        "unavailable",
        `Sentry failed with status ${String(status)}. Try again later.`,
      );
    }
    if (status < 200 || status >= 300) {
      return yield* fail("unexpected", `Sentry answered with status ${String(status)}.${said}`);
    }
    const answer = yield* Schema.decodeUnknownEffect(UpdateAnswer)(response.body).pipe(
      Effect.mapError(
        (error) =>
          new ActionError({
            code: "unexpected",
            message: `Sentry's response did not have the expected shape: ${error.message}`,
          }),
      ),
    );
    return { issueId: address.issueId, status: answer.status };
  });
