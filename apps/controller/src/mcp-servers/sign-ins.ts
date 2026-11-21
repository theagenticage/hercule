/**
 * The sign-in of an MCP Server added by URL: the one place that reads and
 * writes the secrets it is made of (spec 21 section 5.2).
 *
 * The secrets are owned by the server (owner kind `mcp-server`, owner id the
 * server's id), and the generic `secret.*` operations refuse that kind. A
 * pasted token is the secret named `token`. A server that needs no sign-in
 * holds no secret.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { SqlError } from "effect/sql/SqlError";
import { Secrets, type SecretOwner } from "../secrets";
import { mcpServerRepository, type McpServerStoredSource } from "./repository";

/** The name of the secret that holds a pasted token. */
export const SIGN_IN_TOKEN_SECRET = "token";

/** The sign-in a server was added with: what its `source` holds as `signIn`. */
type SignIn = Extract<McpServerStoredSource, { readonly kind: "url" }>["signIn"];

const buildOwner = (serverId: string): SecretOwner => ({ kind: "mcp-server", id: serverId });

const make = Effect.gen(function* () {
  const secrets = yield* Secrets;
  const servers = yield* mcpServerRepository;

  /**
   * Returns the token a request to the server carries, or `undefined` when
   * the server carries none. A secret that cannot be read means the database
   * or the Master Key is broken, which no caller can act on, so it is a
   * defect.
   */
  const readToken = (serverId: string, signIn: SignIn): Effect.Effect<string | undefined> =>
    signIn === "token"
      ? Effect.map(Effect.orDie(secrets.get(buildOwner(serverId), SIGN_IN_TOKEN_SECRET)), (found) =>
          Option.getOrUndefined(Option.map(found, Redacted.value)),
        )
      : Effect.sync(() => undefined);

  return {
    /**
     * Returns the token a request to the server carries as the server's
     * sign-in is now: the pasted token for `token`, and none for `none`.
     * Never fails: a broken secret store is a defect.
     */
    readToken,

    /**
     * Returns a string that changes whenever the server's sign-in changes:
     * its `revision` and the name and rotation time of each secret, without
     * decrypting any. Both are in it on purpose.
     *
     * - The `revision` rises with every new sign-in today, and covers a
     *   secret that is deleted and stored again within the same clock tick,
     *   which can leave its rotation time unchanged.
     * - The secrets' rotation times are what changes when a token is rotated
     *   without a new sign-in, as an OAuth refresh will do: it replaces the
     *   token and does not raise the `revision`.
     */
    readVersion: (serverId: string): Effect.Effect<string> =>
      Effect.gen(function* () {
        const found = yield* Effect.orDie(servers.readMany([serverId], "without-tools"));
        const refs = yield* Effect.orDie(secrets.refs("mcp-server", [serverId]));
        return JSON.stringify([found.get(serverId)?.revision, refs.get(serverId) ?? []]);
      }),

    /**
     * Stores a pasted token for the server, replacing the one it holds. The
     * caller raises the server's `revision` and sets its `signIn` in the same
     * transaction. Must run inside a transaction.
     */
    storeToken: (serverId: string, token: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        Effect.catchTag(
          secrets.set(buildOwner(serverId), SIGN_IN_TOKEN_SECRET, Redacted.make(token)),
          "SecretNameError",
          Effect.die,
        ),
      ),

    /**
     * Deletes every sign-in secret the server holds. Must run inside a
     * transaction, the one that deletes or replaces the server.
     */
    deleteAll: (serverId: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const refs = yield* secrets.refs("mcp-server", [serverId]);
        for (const { name } of refs.get(serverId) ?? []) {
          yield* Effect.catchTag(
            secrets.delete(buildOwner(serverId), name),
            "SecretNameError",
            Effect.die,
          );
        }
      }),
  };
});

/** Reads and writes the sign-in secrets of MCP Servers added by URL. */
export const mcpServerSignIns = make;

export type McpServerSignIns = Effect.Success<typeof mcpServerSignIns>;
