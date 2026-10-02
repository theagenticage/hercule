/**
 * Reads the token of a GitHub connection, for the core code that pushes and
 * clones with it. The GitHub type ships with Hercule, so the core knows its
 * fields, which it does not know for any other type.
 *
 * A GitHub connection holds one of two kinds of token:
 *
 * - a personal access token the user pasted, under the field `pat`;
 * - an access token from the device flow, inside the token set stored under
 *   `oauth.tokens`.
 *
 * Callers get the same token either way and never read secrets themselves.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Secrets } from "../secrets";
import { isStale, OAUTH_TOKENS, parseTokens } from "./oauth";
import { isGithubConnection, connectionRepository } from "./repository";

/** The field a GitHub connection set up with a pasted token stores it under. */
const PAT = "pat";

/** The token a GitHub connection holds, and the login of the account it belongs to. */
export interface GithubToken {
  readonly token: string;
  readonly login: string;
}

/** Builds `findGithubToken` from the connection repository and the secrets store. */
export const githubTokens = Effect.gen(function* () {
  const connections = yield* connectionRepository;
  const secrets = yield* Secrets;

  /**
   * Returns the usable token among a connection's secrets: the pasted token,
   * or else the device flow's access token while it has not expired. Returns
   * `none` when there is neither, or when the stored token set cannot be read.
   */
  const findUsableToken = (
    stored: ReadonlyArray<{ readonly name: string; readonly value: Redacted.Redacted<string> }>,
  ): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      const pat = stored.find((secret) => secret.name === PAT);
      if (pat !== undefined) return Option.some(Redacted.value(pat.value));
      const tokenSet = stored.find((secret) => secret.name === OAUTH_TOKENS);
      if (tokenSet === undefined) return Option.none();
      const tokens = yield* Effect.option(parseTokens(Redacted.value(tokenSet.value)));
      const now = yield* Clock.currentTimeMillis;
      return Option.flatMap(tokens, (parsed) =>
        isStale(parsed, now) ? Option.none() : Option.some(parsed.accessToken),
      );
    });

  return {
    /**
     * Returns the token a GitHub connection holds and the login it belongs
     * to. Returns `none` when the connection is gone, is not a GitHub
     * connection, or holds no usable token, because none of those can
     * authenticate a push. A device flow token that has expired, or is about
     * to, is not usable: the GitHub type cannot refresh it, so the user has to
     * sign in again.
     *
     * This is a plain read: it never calls GitHub and never changes the
     * connection's status, so callers may run it inside a transaction. Fails
     * when the database fails. A secret that does not decrypt is a defect,
     * because it means the Master Key or the database is broken, and no caller
     * can recover from that.
     */
    findGithubToken: (connectionId: string): Effect.Effect<Option.Option<GithubToken>, SqlError> =>
      Effect.gen(function* () {
        const found = yield* connections.one(connectionId);
        if (Option.isNone(found) || !isGithubConnection(found.value)) return Option.none();
        const stored = yield* secrets
          .values({ kind: "connection", id: connectionId })
          .pipe(Effect.catchTag("SecretDecryptError", Effect.die));
        const token = yield* findUsableToken(stored);
        return Option.map(token, (value) => ({ token: value, login: found.value.displayName }));
      }),
  };
});
