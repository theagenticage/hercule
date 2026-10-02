/**
 * Reads the token of a GitHub connection, for the core code that pushes and
 * clones with it. The GitHub type ships with Hercule, so the core knows its
 * fields, which it does not know for any other type.
 *
 * A GitHub connection holds one of two kinds of token:
 *
 * - a personal access token the user pasted, under the field `pat`;
 * - an access token from the device flow, which the runtime returns as
 *   `accessToken`.
 *
 * Callers get the same token either way and never read secrets themselves.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { isGithubConnection, connectionRepository } from "./repository";
import { ConnectionTypes } from "./runtime";

/** The field a GitHub connection set up with a pasted token stores it under. */
const PAT = "pat";

/** The token a GitHub connection holds, and the login of the account it belongs to. */
export interface GithubToken {
  readonly token: string;
  readonly login: string;
}

/** Builds `findGithubToken` from the connection repository and the connection runtime. */
export const githubTokens = Effect.gen(function* () {
  const connections = yield* connectionRepository;
  const types = yield* ConnectionTypes;

  return {
    /**
     * Returns the token a GitHub connection holds and the login it belongs
     * to. Returns `none` when the connection is gone, is not a GitHub
     * connection, holds no token, or needs reauthorization, because none of
     * those can authenticate a push. Fails only when the database fails.
     *
     * Callers may run this inside a transaction, because it never calls
     * GitHub. The runtime refreshes an expired access token only for a type
     * that declares a redirect flow, and the GitHub type declares none: a
     * device-flow token that has expired marks the connection as needing
     * reauthorization instead, which is a database write.
     */
    findGithubToken: (connectionId: string): Effect.Effect<Option.Option<GithubToken>, SqlError> =>
      Effect.gen(function* () {
        const found = yield* connections.one(connectionId);
        if (Option.isNone(found) || !isGithubConnection(found.value)) return Option.none();
        const credentials = yield* Effect.option(types.readCredentials(connectionId));
        return Option.flatMap(credentials, (fields) =>
          Option.map(Option.fromNullishOr(fields[PAT] ?? fields.accessToken), (token) => ({
            token,
            login: found.value.displayName,
          })),
        );
      }),
  };
});
