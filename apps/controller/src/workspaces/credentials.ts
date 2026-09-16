/**
 * Git credentials, as the controller answers them.
 *
 * A machine holds no token. It asks per request, naming the remote git is about
 * to talk to and who is asking - a session by the token it was started with, or
 * the machine itself while it is provisioning a workspace - and the answer is
 * good for that request alone.
 *
 * The rule is one sentence: the remote has to canonicalise to a resource the
 * asker already has a checkout of. Everything else is `unauthorized`, including
 * a remote no resource matches, because saying which of the two it was would
 * tell a caller what this controller holds. `no_connection` is the one case
 * where the asker is entitled to an answer and there is none to give: the
 * resource is theirs and no account is attached to it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { CredentialAnswer, CredentialRefusal, CredentialRequest } from "@hydra/protocol";
import { connectionRepository, isGithubConnection } from "../connections";
import { hashToken } from "../credentials";
import { uuidFromString, uuidToString } from "../db";
import { SessionTokens } from "../permissions";
import { canonicalRemoteOf } from "../resources";
import { Secrets, type SecretDecryptError, type SecretNameError } from "../secrets";

/** The field the shipped GitHub type stores its token under. */
const PAT = "pat";

/**
 * Who an account commits as: its login, and the address GitHub gives an account
 * that keeps its mail private. The machine is told this once, at session start;
 * a credential exchange carries the credential and nothing else.
 */
export const gitIdentityOf = (
  login: string,
): { readonly name: string; readonly email: string } => ({
  name: login,
  email: `${login}@users.noreply.github.com`,
});

/** The git identity and the token a Connection stands for. */
export interface GitCredential {
  readonly token: string;
  readonly login: string;
}

type CredentialError = SqlError | SecretNameError | SecretDecryptError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const secrets = yield* Secrets;
  const sessionTokens = yield* SessionTokens;

  /**
   * The GitHub token a Connection holds, and the login it belongs to. `none`
   * where the connection is gone, is not a GitHub one, or holds no token: each
   * is a connection that cannot authenticate a push.
   */
  const credentialOf = (
    connectionId: string,
  ): Effect.Effect<Option.Option<GitCredential>, CredentialError> =>
    Effect.gen(function* () {
      const found = yield* connections.one(connectionId);
      if (Option.isNone(found) || !isGithubConnection(found.value)) return Option.none();
      const token = yield* secrets.get({ kind: "connection", id: connectionId }, PAT);
      return Option.map(token, (value) => ({
        token: Redacted.value(value),
        login: found.value.displayName,
      }));
    });

  /**
   * The workspace the asker holds a checkout of this canonical remote in, and
   * the Connection that workspace was opened against. `none` means the asker
   * does not hold it - or is not who it says it is, which reads the same from
   * here.
   *
   * The Connection is the workspace's own column rather than the resource's:
   * what a workspace acts through is settled when it is opened, and a resource
   * that changes hands afterwards does not change what is already running.
   */
  const heldResource = (
    runnerId: string,
    request: CredentialRequest,
    canonicalRemote: string,
  ): Effect.Effect<Option.Option<{ readonly connectionId: string | null }>, SqlError> =>
    Effect.gen(function* () {
      if ("workspaceId" in request) {
        const rows = yield* sql<{ readonly connection_id: Uint8Array | null }>`
          SELECT w.designated_connection_id AS connection_id FROM resources r
          JOIN checkouts c ON c.resource_id = r.id
          JOIN workspaces w ON w.id = c.workspace_id
          WHERE r.canonical_remote = ${canonicalRemote}
            AND w.id = ${uuidFromString(request.workspaceId)}
            AND w.runner_id = ${uuidFromString(runnerId)}
            AND w.status = 'provisioning'
          LIMIT 1
        `;
        return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          connectionId: row.connection_id === null ? null : uuidToString(row.connection_id),
        }));
      }

      // Who the asker is, is the session-token resolver's answer and not a
      // predicate of its own: one lookup says whether a live session holds this
      // token and which session it is, and the token is dead the moment that
      // session stops running. What is left to ask here is only whether that
      // session's workspace is a checkout of this remote.
      const actor = yield* sessionTokens.resolve(hashToken(request.sessionToken));
      if (Option.isNone(actor)) return Option.none();
      const rows = yield* sql<{ readonly connection_id: Uint8Array | null }>`
        SELECT w.designated_connection_id AS connection_id FROM resources r
        JOIN checkouts c ON c.resource_id = r.id
        JOIN workspaces w ON w.id = c.workspace_id
        JOIN sessions s ON s.workspace_id = c.workspace_id
        WHERE r.canonical_remote = ${canonicalRemote}
          AND s.id = ${uuidFromString(actor.value.sessionId)}
          AND s.runner_id = ${uuidFromString(runnerId)}
        LIMIT 1
      `;
      return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
        connectionId: row.connection_id === null ? null : uuidToString(row.connection_id),
      }));
    });

  return {
    credentialOf,

    /** What goes back on the wire for one request. */
    answer: (
      runnerId: string,
      request: CredentialRequest,
    ): Effect.Effect<CredentialAnswer, CredentialError> =>
      Effect.gen(function* () {
        const refuse = (error: CredentialRefusal): CredentialAnswer => ({
          _tag: "credentialAnswer",
          requestId: request.requestId,
          error,
        });
        const canonicalRemote = canonicalRemoteOf(request.remote);
        if (canonicalRemote === undefined) return refuse("unauthorized");
        const held = yield* heldResource(runnerId, request, canonicalRemote);
        if (Option.isNone(held)) return refuse("unauthorized");
        if (held.value.connectionId === null) return refuse("no_connection");
        const credential = yield* credentialOf(held.value.connectionId);
        if (Option.isNone(credential)) return refuse("no_connection");
        return {
          _tag: "credentialAnswer",
          requestId: request.requestId,
          token: credential.value.token,
          username: credential.value.login,
        };
      }),
  };
});

/** How a git credential is resolved, for the wire and for a session's env. */
export const gitCredentials = make;
