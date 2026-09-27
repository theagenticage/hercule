/**
 * Git credentials, as the controller hands them out to runners.
 *
 * A runner holds no token. It asks for one per request, and the request names
 * the remote git is about to contact and who is asking: a session, identified
 * by the token it was started with, or the runner itself, naming a workspace.
 * The runner asks as itself only while it provisions that workspace or runs
 * a workspace step in it (spec 13 section 9.1). A session is entitled only
 * while it holds an active lease on its workspace. The credential is valid
 * for that request alone.
 *
 * The rule is simple: the remote must canonicalize to a resource the asker
 * already has a checkout of. Everything else gets `unauthorized`, including a
 * remote that matches no resource, because telling the two cases apart would
 * reveal which resources this controller holds. `no_connection` is the one
 * case where the asker is entitled to a credential but there is none: the
 * resource is theirs and no account is attached to it.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  CredentialAnswer,
  CredentialRefusal,
  CredentialRequest,
  GitIdentity,
} from "@hercule/protocol";
import { connectionRepository, isGithubConnection } from "../connections";
import { hashToken } from "../credentials";
import { uuidFromString, uuidToString } from "../db";
import { SessionTokens } from "../permissions";
import { canonicalRemoteOf } from "../resources";
import { Secrets, type SecretDecryptError, type SecretNameError } from "../secrets";

/**
 * The port through which the credential rule learns whether a workspace step
 * is running. A workspace step has no session and so no session token: its
 * git asks for a credential as the runner, naming the workspace, and gets one
 * only while the step runs.
 *
 * It is declared here and implemented by the runs domain, which owns step
 * records and already imports this domain. Boot provides the implementation.
 * The rule asks at the time of the request rather than reading a flag stored
 * on the run's lease: a flag would have to be cleared on every path that ends
 * a step, and one missed path would leave a push credential open.
 */
export class WorkspaceStepActivity extends Context.Service<
  WorkspaceStepActivity,
  {
    /**
     * Checks whether a workspace step of a run pinned to this runner is
     * running in this workspace. A step that has ended, or a controller step
     * of the same run such as `wait`, does not count.
     */
    readonly isStepRunning: (
      workspaceId: string,
      runnerId: string,
    ) => Effect.Effect<boolean, SqlError>;
  }
>()("hercule/controller/workspaces/WorkspaceStepActivity") {}

/** The field the shipped GitHub type stores its token under. */
const PAT = "pat";

/**
 * Builds the git identity an account commits as: its login, and the noreply
 * address GitHub gives an account that keeps its email private. The runner
 * receives the identity with the work it starts, a session or a workspace
 * step; a credential exchange carries the credential and nothing else.
 */
const buildGitIdentity = (login: string): GitIdentity => ({
  name: login,
  email: `${login}@users.noreply.github.com`,
});

/** The token a Connection holds and the login it belongs to. */
interface GitCredential {
  readonly token: string;
  readonly login: string;
}

/** A GitHub account as work uses it: the token it pushes with and the identity it commits as. */
export interface GithubAccount {
  readonly token: string;
  readonly gitIdentity: GitIdentity;
}

type CredentialError = SqlError | SecretNameError | SecretDecryptError;

/**
 * Reads the GitHub account behind a Connection. It is kept apart from
 * `gitCredentials` because work that starts with an account needs only the
 * account, not the rule that decides who may ask for a credential, nor the
 * `WorkspaceStepActivity` port that rule reads.
 */
export const githubAccounts = Effect.gen(function* () {
  const connections = yield* connectionRepository;
  const secrets = yield* Secrets;

  /**
   * Returns the GitHub token a Connection holds, and the login it belongs to.
   * Returns `none` if the connection is gone, is not a GitHub connection, or
   * holds no token, because none of those can authenticate a push. Fails if
   * the database or the secret store fails.
   */
  const findCredential = (
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

  return {
    findCredential,

    /**
     * Returns the GitHub account of a Connection, for work that starts with
     * it: the token it pushes with and the identity it commits as. Returns
     * `undefined` if the connection has no usable token. A connection that
     * cannot be read is logged and treated the same way, because work that
     * starts without an account is better than work that does not start.
     */
    readGithubAccount: (connectionId: string): Effect.Effect<GithubAccount | undefined> =>
      Effect.map(
        Effect.catchCause(findCredential(connectionId), (cause) =>
          // An interruption is not an unreadable connection. A cause that
          // contains one is passed on rather than logged, so a caller waiting
          // on this read learns it was interrupted instead of seeing
          // "no account".
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.as(
                Effect.logError("A GitHub connection could not be read", cause),
                Option.none<GitCredential>(),
              ),
        ),
        (credential) =>
          Option.isNone(credential)
            ? undefined
            : {
                token: credential.value.token,
                gitIdentity: buildGitIdentity(credential.value.login),
              },
      ),
  };
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const accounts = yield* githubAccounts;
  const sessionTokens = yield* SessionTokens;
  const stepActivity = yield* WorkspaceStepActivity;

  /**
   * Looks for a workspace in which the asker has a checkout of this canonical
   * remote, and returns the Connection that workspace was opened with. Returns
   * `none` if the asker has no such checkout, or is not who it claims to be;
   * this function cannot tell the two apart.
   *
   * - A runner that names a workspace has such a checkout only while the
   *   workspace is on that runner and is either `provisioning` or running a
   *   workspace step.
   * - A session has one only while it holds an active lease on a workspace
   *   on that runner.
   *
   * The Connection is read from the workspace, not from the resource. A
   * workspace's Connection is fixed when it is opened, so a resource that is
   * moved to another Connection afterwards does not change work already
   * running.
   */
  const findHeldResource = (
    runnerId: string,
    request: CredentialRequest,
    canonicalRemote: string,
  ): Effect.Effect<Option.Option<{ readonly connectionId: string | null }>, SqlError> =>
    Effect.gen(function* () {
      if ("workspaceId" in request) {
        const workspaceId = uuidFromString(request.workspaceId);
        const rows = yield* sql<{
          readonly connection_id: Uint8Array | null;
          readonly status: string;
        }>`
          SELECT w.designated_connection_id AS connection_id, w.status FROM resources r
          JOIN checkouts c ON c.resource_id = r.id
          JOIN workspaces w ON w.id = c.workspace_id
          WHERE r.canonical_remote = ${canonicalRemote}
            AND w.id = ${workspaceId}
            AND w.runner_id = ${uuidFromString(runnerId)}
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) return Option.none();
        if (
          row.status !== "provisioning" &&
          !(yield* stepActivity.isStepRunning(request.workspaceId, runnerId))
        ) {
          return Option.none();
        }
        return Option.some({
          connectionId: row.connection_id === null ? null : uuidToString(row.connection_id),
        });
      }

      // The session-token resolver decides who the asker is, rather than a
      // separate SQL condition here. One lookup finds whether a live session
      // holds this token and which session it is, and the token stops working
      // as soon as that session stops running. The query below only checks
      // whether that session holds an active lease on a workspace on this
      // runner with a checkout of this remote.
      const actor = yield* sessionTokens.resolve(hashToken(request.sessionToken));
      if (Option.isNone(actor)) return Option.none();
      const rows = yield* sql<{ readonly connection_id: Uint8Array | null }>`
        SELECT w.designated_connection_id AS connection_id FROM resources r
        JOIN checkouts c ON c.resource_id = r.id
        JOIN workspaces w ON w.id = c.workspace_id
        JOIN workspace_leases l ON l.workspace_id = w.id
        WHERE r.canonical_remote = ${canonicalRemote}
          AND l.holder_kind = 'session' AND l.holder_id = ${uuidFromString(actor.value.sessionId)}
          AND l.released_at IS NULL
          AND w.runner_id = ${uuidFromString(runnerId)}
        LIMIT 1
      `;
      return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
        connectionId: row.connection_id === null ? null : uuidToString(row.connection_id),
      }));
    });

  return {
    /**
     * Builds the answer frame for one credential request: the token and
     * username, or `unauthorized` or `no_connection` as explained at the top of
     * this file. Fails if the database or the secret store fails.
     */
    answer: (
      runnerId: string,
      request: CredentialRequest,
    ): Effect.Effect<CredentialAnswer, CredentialError> =>
      Effect.gen(function* () {
        const buildRefusalAnswer = (error: CredentialRefusal): CredentialAnswer => ({
          _tag: "credentialAnswer",
          requestId: request.requestId,
          error,
        });
        const canonicalRemote = canonicalRemoteOf(request.remote);
        if (canonicalRemote === undefined) return buildRefusalAnswer("unauthorized");
        const held = yield* findHeldResource(runnerId, request, canonicalRemote);
        if (Option.isNone(held)) return buildRefusalAnswer("unauthorized");
        if (held.value.connectionId === null) return buildRefusalAnswer("no_connection");
        const credential = yield* accounts.findCredential(held.value.connectionId);
        if (Option.isNone(credential)) return buildRefusalAnswer("no_connection");
        return {
          _tag: "credentialAnswer",
          requestId: request.requestId,
          token: credential.value.token,
          username: credential.value.login,
        };
      }),
  };
});

/** Answers a runner's git credential requests. */
export const gitCredentials = make;
