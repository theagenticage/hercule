/**
 * The ingest handle of one Sentry Connection: what the host calls to poll its
 * two feeds, `issues` and `entities`.
 *
 * Every poll reads the token and the organization afresh, so a refreshed token
 * is used from the next poll on, and a renamed organization keeps working.
 */
import { Effect, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import {
  AuthError,
  PluginError,
  type EventSourceContribution,
  type IngestContext,
  type PollResult,
} from "@hercule/plugin-host";
import { readToken } from "../api";
import { DEFAULT_LAST_SEEN_DAYS, SentryConnectionConfig } from "../connection-type";
import { readUserId } from "../identity";
import { findOrganization } from "../organization";
import { pollSentryEntities } from "./entities";
import { pollSentryIssues } from "./poll";

/**
 * Polls the `issues` feed once with the Connection's current credentials.
 * Returns when the host may poll next, as `pollSentryIssues` does. Fails with
 * an `AuthError` when the credentials hold no token or Sentry refuses it, and
 * with a `PluginError` for any other failure.
 */
export const pollWithConnection = (
  feed: string,
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
    const access = { token, organization };
    switch (feed) {
      case "issues":
        return yield* pollSentryIssues(access, config, identity, context);
      case "entities":
        return context.entities === undefined
          ? yield* new PluginError({
              message:
                "The host gave the Sentry plugin no way to report entities, so the entities feed cannot run.",
            })
          : yield* pollSentryEntities(
              access,
              {
                userId: readUserId(identity.accountId),
                lastSeenDays: config.lastSeenDays ?? DEFAULT_LAST_SEEN_DAYS,
              },
              context.entities,
            );
      default:
        return yield* new PluginError({
          message: `The Sentry event source has no feed "${feed}".`,
        });
    }
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
      poll: (feed) =>
        pollWithConnection(feed, config, { accountId: connection.accountId }, context).pipe(
          Effect.provide(FetchHttpClient.layer),
        ),
      close: Effect.void,
    }),
  );
