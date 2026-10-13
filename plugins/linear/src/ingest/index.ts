/**
 * The ingest handle of one Linear Connection: what the host calls to poll its
 * two feeds, `issues` and `notifications`.
 *
 * Every poll reads the credentials afresh, so a refreshed token is used from
 * the next poll on.
 */
import { Effect, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  AuthError,
  PluginError,
  type EventSourceContribution,
  type IngestContext,
  type PollResult,
} from "@hercule/plugin-host";
import { buildAuthorization } from "../api";
import { LinearConnectionConfig } from "../connection-type";
import { pollLinearIssues } from "./issues";
import { pollLinearNotifications } from "./notifications";

/**
 * Polls one feed once with the Connection's current credentials. Returns
 * when the host may poll next: `nextAfterSeconds` when Linear rate limited
 * the poll, which then emitted and stored nothing new. Fails with an
 * `AuthError` when the credentials hold no token or key or Linear refuses
 * them, and with a `PluginError` for an unknown feed and any other failure.
 */
export const pollWithConnection = (
  feed: string,
  config: LinearConnectionConfig,
  context: IngestContext,
): Effect.Effect<PollResult, AuthError | PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const credentials = yield* context
      .credentials()
      .pipe(Effect.mapError((error) => new PluginError({ message: error.message })));
    const authorization = buildAuthorization(credentials);
    if (authorization === undefined) {
      return yield* new AuthError({
        message:
          "The Connection has no Linear credential. Reconnect it to sign in to Linear again.",
      });
    }
    switch (feed) {
      case "issues":
        return yield* pollLinearIssues(authorization, config, context);
      case "notifications":
        return yield* pollLinearNotifications(authorization, context);
      default:
        return yield* new PluginError({
          message: `The Linear event source has no feed "${feed}".`,
        });
    }
  }).pipe(
    Effect.catchTag("LinearRateLimited", (limit) =>
      Effect.succeed({ nextAfterSeconds: limit.retryAfterSeconds }),
    ),
  );

/**
 * Opens the ingest handle for one Linear Connection. Fails with a
 * `PluginError` when the Connection's config does not match
 * `LinearConnectionConfig`.
 *
 * The fetch client is provided here, where the host calls in, so everything
 * below can be tested with a fake Linear.
 */
export const openLinearIngest: EventSourceContribution["open"] = (connection, context) =>
  Effect.map(
    Schema.decodeUnknownEffect(LinearConnectionConfig)(connection.config).pipe(
      Effect.mapError(
        (error) =>
          new PluginError({
            message: `The Linear Connection's config is invalid: ${error.message}`,
          }),
      ),
    ),
    (config) => ({
      poll: (feed) =>
        pollWithConnection(feed, config, context).pipe(Effect.provide(FetchHttpClient.layer)),
      close: Effect.void,
    }),
  );
