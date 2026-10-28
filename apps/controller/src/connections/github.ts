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
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/sql/SqlError";
import { Secrets } from "../secrets";
import { isExpired, OAUTH_TOKENS, parseTokens } from "./oauth";
import { connectionRepository, isGithubConnection, type StoredConnection } from "./repository";
import { ConnectionTypes } from "./runtime";

/** The field a GitHub connection set up with a pasted token stores it under. */
const PAT = "pat";

/**
 * The token a GitHub connection holds, when it expires, and the login of the
 * account it belongs to. `expiresAt` is an ISO timestamp, and is `undefined`
 * for a pasted token and for a token set the provider gave no expiry.
 */
export interface GithubToken {
  readonly token: string;
  readonly expiresAt: string | undefined;
  readonly login: string;
}

/**
 * A GitHub connection cannot give out a token right now. `reason` is one
 * line a person can read, naming the connection where that helps, and says
 * what to do about it.
 */
export class GithubTokenUnavailable extends Schema.TaggedError<GithubTokenUnavailable>()(
  "GithubTokenUnavailable",
  { reason: Schema.String },
) {}

/**
 * The credential a GitHub connection holds: the pasted token, or the stored
 * token set of the device flow, which has not been parsed or refreshed yet.
 */
type GithubCredential =
  | { readonly kind: "pat"; readonly token: string }
  | { readonly kind: "tokenSet"; readonly stored: Redacted.Redacted<string> };

/**
 * Picks the credential among a connection's secrets, or returns `undefined`
 * when it holds neither. A pasted token wins over a token set, because the
 * user pasting one is the more recent and more deliberate choice.
 */
const pickGithubCredential = (
  stored: ReadonlyArray<{ readonly name: string; readonly value: Redacted.Redacted<string> }>,
): GithubCredential | undefined => {
  const pat = stored.find((secret) => secret.name === PAT);
  if (pat !== undefined) return { kind: "pat", token: Redacted.value(pat.value) };
  const tokenSet = stored.find((secret) => secret.name === OAUTH_TOKENS);
  return tokenSet === undefined ? undefined : { kind: "tokenSet", stored: tokenSet.value };
};

/** The reason given when a Connection must be signed in to again before it can give a token. */
const needsReconnecting = (row: StoredConnection): string =>
  `the Connection '${row.displayName}' needs reconnecting in Settings → Connections`;

/**
 * The one rule for which Connections may give out a token at all: a
 * `disabled` Connection and one that `needs-reauth` give none, even when they
 * still hold a pasted token. Returns the reason for a person to read when the
 * Connection is refused, and `undefined` when it may give a token. Both the
 * plain read and the refreshing read use it, so they never disagree.
 */
const findStatusRefusal = (row: StoredConnection): string | undefined => {
  if (row.status === "disabled") {
    return `the Connection '${row.displayName}' is disabled in Settings → Connections`;
  }
  if (row.status === "needs-reauth") return needsReconnecting(row);
  return undefined;
};

/**
 * Builds the two reads of a GitHub Connection's token, `findGithubToken` and
 * `readFreshGithubToken`, from the connection repository, the secrets store
 * and the core's token refresh.
 */
export const githubTokens = Effect.gen(function* () {
  const connections = yield* connectionRepository;
  const secrets = yield* Secrets;
  const types = yield* ConnectionTypes;

  /**
   * Returns the usable token among a connection's secrets, with its expiry:
   * the pasted token, or else the device flow's access token while it has not
   * expired. Returns `none` when there is neither, or when the stored token
   * set cannot be read.
   */
  const findUsableToken = (
    stored: ReadonlyArray<{ readonly name: string; readonly value: Redacted.Redacted<string> }>,
  ): Effect.Effect<
    Option.Option<{ readonly token: string; readonly expiresAt: string | undefined }>
  > =>
    Effect.gen(function* () {
      const credential = pickGithubCredential(stored);
      if (credential === undefined) return Option.none();
      if (credential.kind === "pat") {
        return Option.some({ token: credential.token, expiresAt: undefined });
      }
      const tokens = yield* Effect.option(parseTokens(Redacted.value(credential.stored)));
      const now = yield* Clock.currentTimeMillis;
      return Option.flatMap(tokens, (parsed) =>
        isExpired(parsed, now)
          ? Option.none()
          : Option.some({ token: parsed.accessToken, expiresAt: parsed.expiresAt }),
      );
    });

  return {
    /**
     * Returns the token a GitHub connection holds, its expiry and the login it
     * belongs to. Returns `none` when the connection is gone, is not a GitHub
     * connection, is `disabled` or `needs-reauth` (even with a pasted token),
     * or holds no usable token, because none of those has a token to give.
     * A token from the device flow expires (GitHub gives it about eight hours)
     * and is refreshed by `readFreshGithubToken`, not here: this read never
     * refreshes, so a token that has expired is reported as not usable. A token
     * inside the refresh margin is still returned, because it still works and
     * the refresh may have failed. A pasted token has no expiry and is always
     * usable. A session's claim on its Connection uses this read; git and `gh`
     * use the refreshing read.
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
        if (findStatusRefusal(found.value) !== undefined) return Option.none();
        const stored = yield* secrets
          .values({ kind: "connection", id: connectionId })
          .pipe(Effect.catchTag("SecretDecryptError", Effect.die));
        const usable = yield* findUsableToken(stored);
        return Option.map(usable, (value) => ({ ...value, login: found.value.displayName }));
      }),

    /**
     * Returns the token of a GitHub Connection, its expiry and the login of
     * its account, refreshing the token first when it has expired or is inside
     * the refresh margin. Where `findGithubToken` is the plain read that never
     * refreshes, this is the read for core code that hands the token to a
     * session. The expiry is `undefined` for a pasted token and for a token
     * set with no expiry.
     *
     * Fails with `GithubTokenUnavailable`, whose `reason` is for a person to
     * read, when:
     *
     * - the Connection does not exist or is not a GitHub Connection;
     * - the Connection is `disabled` or `needs-reauth`. Both are refused before
     *   any token is read, even a pasted one;
     * - the Connection holds no usable token, the provider refused the refresh,
     *   or the token set cannot be refreshed. A refresh that fails like this
     *   also marks the Connection `needs-reauth`;
     * - GitHub could not be reached during a refresh and the token held has
     *   expired. A token that is inside the refresh margin but has not expired
     *   still works, so it is returned as it is: refusing it would make the
     *   caller drop a copy that is still valid.
     *
     * This calls GitHub and may write the Connection's status, so it must run
     * outside any transaction: never call it inside `withTransaction`.
     */
    readFreshGithubToken: (
      connectionId: string,
    ): Effect.Effect<GithubToken, GithubTokenUnavailable> =>
      Effect.gen(function* () {
        const refuse = (reason: string) => Effect.fail(new GithubTokenUnavailable({ reason }));
        const found = yield* Effect.orDie(connections.one(connectionId));
        if (Option.isNone(found) || !isGithubConnection(found.value)) {
          return yield* refuse("the session's GitHub Connection no longer exists");
        }
        const row = found.value;
        const name = row.displayName;
        const statusRefusal = findStatusRefusal(row);
        if (statusRefusal !== undefined) return yield* refuse(statusRefusal);

        const stored = yield* Effect.orDie(secrets.values({ kind: "connection", id: row.id }));
        const credential = pickGithubCredential(stored);
        if (credential === undefined) return yield* refuse(needsReconnecting(row));
        if (credential.kind === "pat") {
          return { token: credential.token, login: name, expiresAt: undefined };
        }
        const tokens = yield* types.readFreshTokenSet(row, credential.stored).pipe(
          Effect.catchTags({
            ConnectionUnavailable: () => refuse(needsReconnecting(row)),
            ProviderUnreachable: () =>
              Effect.gen(function* () {
                const held = yield* Effect.option(parseTokens(Redacted.value(credential.stored)));
                const now = yield* Clock.currentTimeMillis;
                if (
                  Option.isSome(held) &&
                  held.value.expiresAt !== undefined &&
                  Date.parse(held.value.expiresAt) > now
                ) {
                  return held.value;
                }
                return yield* refuse(
                  `GitHub could not be reached to refresh the Connection '${name}'`,
                );
              }),
          }),
        );
        return { token: tokens.accessToken, login: name, expiresAt: tokens.expiresAt };
      }),
  };
});
