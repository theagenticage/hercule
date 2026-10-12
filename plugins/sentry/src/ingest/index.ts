/**
 * The ingest handle of one Sentry Connection: what the host calls to poll its
 * one feed, `issues`.
 *
 * Every poll reads the token and the organization afresh, so a refreshed token
 * is used from the next poll on, and a renamed organization keeps working.
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
import { readToken } from "../api";
import { SentryConnectionConfig } from "../connection-type";
import { findOrganization } from "../organization";
import { pollSentryIssues } from "./poll";

/**
 * Polls the `issues` feed once with the Connection's current credentials.
 * Returns when the host may poll next, as `pollSentryIssues` does. Fails with
 * an `AuthError` when the credentials hold no token or Sentry refuses it, and
 * with a `PluginError` for any other failure.
 */
export const pollWithConnection = (
  config: SentryConnectionConfig,
  identity: { readonly accountId: string },
  context: IngestContext,
): Effect.Effect<PollResult, AuthError | PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const credentials = yield* context
      .credentials()
      .pipe(Effect.mapError((error) => new PluginError({ message: error.message })));
    const token = readToken(credentials);
    if (token === undefined) {
      return yield* new AuthError({
        message: "The Connection has no Sentry token. Reconnect it to sign in to Sentry again.",
      });
    }
    const organization = yield* findOrganization(token, credentials);
    return yield* pollSentryIssues({ token, organization }, config, identity, context);
  }).pipe(
    // Looking up the organization can be rate limited too; the host waits as for a rate limited poll.
    Effect.catchTag("SentryRateLimited", (limit) =>
      Effect.succeed({ nextAfterSeconds: limit.retryAfterSeconds }),
    ),
  );

/**
 * Opens the ingest handle for one Sentry Connection. Fails with a
 * `PluginError` when the Connection's config does not match
 * `SentryConnectionConfig`.
 *
 * The fetch client is provided here, where the host calls in, so everything
 * below can be tested with a stub client.
 */
export const openSentryIngest: EventSourceContribution["open"] = (connection, context) =>
  Effect.map(
    Schema.decodeUnknownEffect(SentryConnectionConfig)(connection.config).pipe(
      Effect.mapError(
        (error) =>
          new PluginError({
            message: `The Sentry Connection's config is invalid: ${error.message}`,
          }),
      ),
    ),
    (config) => ({
      // The host polls only the feeds the event source declares, and there is one.
      poll: () =>
        pollWithConnection(config, { accountId: connection.accountId }, context).pipe(
          Effect.provide(FetchHttpClient.layer),
        ),
      close: Effect.void,
    }),
  );
