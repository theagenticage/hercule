/**
 * Checks whether a session's transcript can be resumed, and returns the
 * harness-native session to resume.
 *
 * The check reads three places: the session's row, the workspace it ran in,
 * and the runner that holds its native state. Resuming a session in place and
 * forking from it ask exactly the same question, so the check lives here once.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { createInvalidStateError, type InvalidState } from "@hercule/contract";
import {
  buildRunnerRefusal,
  ProviderAccountRunners,
  providerAccountRepository,
} from "../../provider-accounts";
import { DRAINING, RETIRED, runnerRepository } from "../../runners";
import { ACCOUNT_DELETED, type StoredSession } from "../../sessions";
import { WorkspaceService } from "../../workspaces";

const STILL_LIVE = "that session is still live; stop it first";

/**
 * The error message for the one reason an exited session cannot be resumed
 * that is not about its runner: it never reported a harness-native session,
 * so there is no transcript to resume.
 */
const NO_TRANSCRIPT =
  "that session left no harness-native session, so its transcript is gone and there is " +
  "nothing to resume";

/**
 * The error message for a session that answered an assistant's conversation
 * that was deleted, with its assistant. The session is history: there is no
 * assistant to resume it as, and nobody reads what it would answer.
 */
const CONVERSATION_DELETED =
  "that session answered an assistant's conversation that was deleted, so it is kept as " +
  "history and is never resumed";

/** Returns the error message for a session whose workspace is gone. */
const describeWorkspaceGone = (status: string): string =>
  `that session's workspace is ${status}, so there is nothing left to resume it in`;

/**
 * Builds the check that every resume and fork goes through. The check returns
 * the session's harness-native session id. It fails with an invalid state
 * error, whose message states the reason, when:
 *
 * - the session is still live;
 * - the session answered an assistant's conversation that was deleted;
 * - the session left no transcript;
 * - its workspace is gone;
 * - its runner is retired, or is draining and takes no new sessions even
 *   though the transcript is still there;
 * - the session's Provider Account was deleted;
 * - its runner can no longer run the session's account in the session's
 *   harness: the harness is gone from it, or a subscription account is no
 *   longer signed in on it, or the account's key is gone or its token has
 *   expired.
 */
export const resumable: Effect.Effect<
  (session: StoredSession) => Effect.Effect<string, InvalidState | SqlError | Schema.SchemaError>,
  never,
  SqlClient.SqlClient | WorkspaceService | ProviderAccountRunners
> = Effect.gen(function* () {
  const workspaces = yield* WorkspaceService;
  const accountRunners = yield* ProviderAccountRunners;
  const runners = yield* runnerRepository;
  const accounts = yield* providerAccountRepository;

  return (session: StoredSession) =>
    Effect.gen(function* () {
      if (session.status !== "exited")
        return yield* Effect.fail(createInvalidStateError(STILL_LIVE));
      if (session.conversationDeleted)
        return yield* Effect.fail(createInvalidStateError(CONVERSATION_DELETED));
      if (session.nativeSessionId === null)
        return yield* Effect.fail(createInvalidStateError(NO_TRANSCRIPT));
      // A session keeps its account id after the account is deleted, as
      // history. Without this check the refusal below would blame the runner,
      // which is not what the user needs to fix.
      if (Option.isNone(yield* accounts.one(session.providerAccountId))) {
        return yield* Effect.fail(createInvalidStateError(ACCOUNT_DELETED));
      }
      if (!session.resumable) {
        // A transcript belongs to the workspace it ran in, so a session whose
        // workspace is gone cannot be resumed. The error then names the
        // workspace status, not the runner, because that is what the user
        // needs to know.
        const status =
          session.workspaceId === null
            ? undefined
            : yield* workspaces.statusOf(session.workspaceId);
        if (status !== undefined && status !== "ready") {
          return yield* Effect.fail(createInvalidStateError(describeWorkspaceGone(status)));
        }
        return yield* Effect.fail(createInvalidStateError(RETIRED));
      }
      // The transcript is still there, but a draining runner takes no new
      // sessions. Whether the runner is connected right now is for dispatch to
      // decide: a disconnected runner gets the session queued, not rejected.
      const machine = yield* runners.read(session.runnerId);
      if (Option.isSome(machine) && machine.value.lifecycle !== "active") {
        return yield* Effect.fail(createInvalidStateError(DRAINING));
      }
      // Check the runner that holds the native state, not the whole fleet,
      // because the transcript exists only on that runner.
      const available = yield* accountRunners.list(session.providerAccountId, session.harnessId);
      if (!available.runnerIds.includes(session.runnerId)) {
        return yield* Effect.fail(createInvalidStateError(buildRunnerRefusal(available)));
      }
      return session.nativeSessionId;
    });
});
