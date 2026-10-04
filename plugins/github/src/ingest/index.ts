/**
 * The ingest handle of one GitHub Connection: what the host calls to poll
 * each of the three feeds, `notifications`, `repos` and `checks`.
 *
 * Every poll reads the token and the watch list afresh, so a refreshed token
 * or a newly linked repository is used from the next poll on.
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
import { DEFAULT_CHECKS_WINDOW_DAYS, GithubConnectionConfig } from "../connection-type";
import { readWatchList } from "../watch-list";
import { pollChecks } from "./checks";
import { pollNotifications } from "./notifications";
import { pollRepos } from "./repos";

/**
 * Reads the Connection's token. Fails with an `AuthError` when the
 * credentials hold no token, because only the user can fix that, and with a
 * `PluginError` when the host could not read the credentials at all.
 */
const readConnectionToken = (
  context: IngestContext,
): Effect.Effect<string, AuthError | PluginError> =>
  Effect.gen(function* () {
    const credentials = yield* context
      .credentials()
      .pipe(Effect.mapError((error) => new PluginError({ message: error.message })));
    const token = readToken(credentials);
    if (token === undefined) {
      return yield* new AuthError({
        message: "The Connection has no GitHub token. Reconnect it to sign in to GitHub again.",
      });
    }
    return token;
  });

/**
 * Polls one feed once and returns when the host may poll it next. A rate
 * limit is not a failure: the poll stops, and succeeds with
 * `nextAfterSeconds` set to the wait GitHub asked for.
 *
 * Fails with an `AuthError` when GitHub rejects the token, and with a
 * `PluginError` for an unknown feed or any other failure.
 */
export const pollGithubFeed = (
  feed: string,
  config: GithubConnectionConfig,
  context: IngestContext,
): Effect.Effect<PollResult, AuthError | PluginError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const token = yield* readConnectionToken(context);
    switch (feed) {
      case "notifications":
        return yield* pollNotifications(token, context);
      case "repos":
        return yield* pollRepos(
          token,
          context,
          yield* readWatchList(context.resources, config.repos ?? []),
        );
      case "checks":
        return yield* pollChecks(
          token,
          context,
          yield* readWatchList(context.resources, config.repos ?? []),
          config.checksWindowDays ?? DEFAULT_CHECKS_WINDOW_DAYS,
        );
      default:
        return yield* new PluginError({
          message: `The GitHub event source has no feed named "${feed}".`,
        });
    }
  }).pipe(
    Effect.catchTag("GithubRateLimited", (limit) =>
      Effect.succeed({ nextAfterSeconds: limit.retryAfterSeconds }),
    ),
  );

/**
 * Opens the ingest handle for one GitHub Connection. Fails with a
 * `PluginError` when the Connection's config does not match
 * `GithubConnectionConfig`.
 *
 * The fetch client is provided here, where the host calls in, so everything
 * below can be tested with a stub client.
 */
export const openGithubIngest: EventSourceContribution["open"] = (connection, context) =>
  Effect.map(
    Schema.decodeUnknownEffect(GithubConnectionConfig)(connection.config).pipe(
      Effect.mapError(
        (error) =>
          new PluginError({
            message: `The GitHub Connection's config is invalid: ${error.message}`,
          }),
      ),
    ),
    (config) => ({
      poll: (feed) =>
        pollGithubFeed(feed, config, context).pipe(Effect.provide(FetchHttpClient.layer)),
      close: Effect.void,
    }),
  );
