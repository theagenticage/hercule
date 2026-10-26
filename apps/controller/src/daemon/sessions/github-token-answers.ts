/**
 * Answers a runner's request for a session's GitHub token.
 *
 * A session's `gh` command asks its runner for a token. When the runner's
 * copy is stale, the runner asks here. Only the controller can refresh a
 * Connection's token, so this is the one place that reads it for a running
 * session after its start.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { GithubTokenAnswer, GithubTokenRequest } from "@hercule/protocol";
import { githubTokens } from "../../connections";
import { hashToken } from "../../credentials";
import { SessionTokens } from "../../permissions";
import { RunnerConnections } from "../../runners";
import { sessionRepository } from "../../sessions";

/**
 * The reason for a session token that is unknown, whose session has ended, or
 * whose session runs on another runner. The three share one message, so a
 * runner learns nothing about sessions that are not its own.
 */
const NOT_RUNNING_HERE = "this session is not running on this runner";

const NO_CONNECTION = "this session has no GitHub Connection";

/**
 * Builds `answerGithubTokenRequest`, the use case that answers a runner's
 * `githubTokenRequest` with the fresh token of the asking session's GitHub
 * Connection, or the reason there is none.
 */
export const makeGithubTokenAnswers = Effect.gen(function* () {
  const rows = yield* sessionRepository;
  const sessionTokens = yield* SessionTokens;
  const connections = yield* RunnerConnections;
  const { readFreshGithubToken } = yield* githubTokens;

  /**
   * Finds the session that holds this token, when it is running on this
   * runner, and returns the id of its GitHub Connection, which is `null` when
   * it has none. Returns `none` when there is no such session.
   */
  const findSessionConnection = (
    runnerId: string,
    sessionToken: string,
  ): Effect.Effect<Option.Option<string | null>, SqlError> =>
    Effect.gen(function* () {
      const actor = yield* sessionTokens.resolve(hashToken(sessionToken));
      if (Option.isNone(actor)) return Option.none();
      const session = yield* rows.one(actor.value.sessionId);
      return Option.filter(session, (row) => row.runnerId === runnerId).pipe(
        Option.map((row) => row.githubConnectionId),
      );
    });

  return {
    /**
     * Answers one `githubTokenRequest` from a runner with a `githubTokenAnswer`
     * on the same connection: the fresh token of the GitHub Connection of the
     * session that holds `sessionToken`, or the reason there is none.
     *
     * The session must be running on the runner that asks. The request names
     * no Connection, so a session can only get the token of its own. The
     * reasons are for a person to read, and the runner passes them on to the
     * `gh` command that asked.
     *
     * Reading the token can call GitHub, so the caller runs this on a fiber of
     * its own and never inline with other fleet traffic. Fails when the
     * database fails.
     */
    answerGithubTokenRequest: (
      runnerId: string,
      request: GithubTokenRequest,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const refuse = (reason: string): GithubTokenAnswer => ({
          _tag: "githubTokenAnswer",
          requestId: request.requestId,
          reason,
        });
        const answer = yield* Effect.gen(function* () {
          const connectionId = yield* findSessionConnection(runnerId, request.sessionToken);
          if (Option.isNone(connectionId)) return refuse(NOT_RUNNING_HERE);
          if (connectionId.value === null) return refuse(NO_CONNECTION);
          return yield* readFreshGithubToken(connectionId.value).pipe(
            Effect.map((fresh): GithubTokenAnswer => ({
              _tag: "githubTokenAnswer",
              requestId: request.requestId,
              token: fresh.token,
              ...(fresh.expiresAt === undefined ? {} : { expiresAt: fresh.expiresAt }),
            })),
            Effect.catchTag("GithubTokenUnavailable", (error) =>
              Effect.succeed(refuse(error.reason)),
            ),
          );
        });
        yield* connections.tell(runnerId, answer);
      }),
  };
});
