/**
 * The teams the user belongs to, which tell a review requested from one of
 * them apart from one requested from a team the user is not on.
 *
 * GitHub's `GET /user/teams` lists them. The list changes rarely, so the
 * feeds keep it in the Connection's state under `teams` and read it again
 * once an hour.
 */
import { Clock, Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { PluginError, type KeyValueStore } from "@hercule/plugin-host";
import { ListedTeam } from "./feed-objects";
import { decodeGithubValue, fetchListing, type FeedError } from "./requests";
import { readFeedState } from "./state";

/** The key of the stored list. */
const TEAMS_KEY = "teams";

/** How long the stored list is used before it is read again. */
const TEAMS_REFRESH_MS = 60 * 60 * 1000;

/** The most pages of teams read, 100 each. */
const MAX_TEAM_PAGES = 5;

/** The stored list, and when it was read, as ISO 8601 by this machine's clock. */
const TeamsState = Schema.Struct({
  fetchedAt: Schema.String,
  /** Each team as lowercase `org/slug`. */
  teams: Schema.Array(Schema.String),
});

/** Returns how a team is written in the stored list and in an event: lowercase `org/slug`. */
export const buildTeamName = (organization: string, slug: string): string =>
  `${organization}/${slug}`.toLowerCase();

/**
 * Returns the user's teams as lowercase `org/slug`, read from the state when
 * the stored list is less than an hour old, and from GitHub otherwise.
 *
 * A token that may not read teams, such as a classic token without
 * `read:org`, gets an error from GitHub other than a 401. That is not worth
 * stopping a feed for: the last list read stays in use, or no teams when
 * there never was one, a warning is logged, and the list is read again in an
 * hour. The Connection already warns the user about a token without
 * `read:org` (see `connection-type.ts`). Fails with an `AuthError` when
 * GitHub rejects the token, and with `GithubRateLimited` on a rate limit.
 */
export const readUserTeams = (
  token: string,
  store: KeyValueStore,
): Effect.Effect<ReadonlySet<string>, FeedError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stored = yield* readFeedState(store, TEAMS_KEY, TeamsState);
    if (Option.isSome(stored) && now - Date.parse(stored.value.fetchedAt) < TEAMS_REFRESH_MS) {
      return new Set(stored.value.teams);
    }
    const teams = yield* Effect.gen(function* () {
      const listing = yield* fetchListing(
        { method: "GET", path: "/user/teams", token, query: { per_page: "100" } },
        MAX_TEAM_PAGES,
      );
      const listed = yield* decodeGithubValue(Schema.Array(ListedTeam), listing.items, "teams");
      return listed.map((team) => buildTeamName(team.organization.login, team.slug));
    }).pipe(
      Effect.catchIf(
        (error): error is PluginError => error instanceof PluginError,
        (error) =>
          Effect.as(
            Effect.logWarning(
              `The GitHub plugin could not read the user's teams, so it keeps the last list it read for the next hour: ${error.message}`,
            ),
            Option.isSome(stored) ? stored.value.teams : [],
          ),
      ),
    );
    yield* store.set(TEAMS_KEY, { fetchedAt: new Date(now).toISOString(), teams });
    return new Set(teams);
  });
