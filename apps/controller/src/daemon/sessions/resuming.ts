/**
 * Checks whether a session's transcript can be resumed, and returns the
 * provider-native session to resume.
 *
 * The check reads three places: the session's row, the workspace it ran in,
 * and the runner that holds its native state. Resuming a session in place and
 * forking from it ask exactly the same question, so the check lives here once.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { createInvalidStateError, type InvalidState } from "@hercule/contract";
import { isLoggedIn, NO_PLACEMENT, providerRepository } from "../../providers";
import { DRAINING, RETIRED, runnerRepository } from "../../runners";
import type { StoredSession } from "../../sessions";
import { WorkspaceService } from "../../workspaces";

const STILL_LIVE = "that session is still live; stop it first";

/**
 * The error message for the one reason an exited session cannot be resumed
 * that is not about its runner: it never reported a provider-native session,
 * so there is no transcript to resume.
 */
const NO_TRANSCRIPT =
  "that session left no provider-native session, so its transcript is gone and there is " +
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
 * the session's provider-native session id. It fails with an invalid state
 * error, whose message states the reason, when:
 *
 * - the session is still live;
 * - the session answered an assistant's conversation that was deleted;
 * - the session left no transcript;
 * - its workspace is gone;
 * - its runner is retired, or is draining and takes no new sessions even
 *   though the transcript is still there;
 * - its runner is no longer logged in to the session's provider instance.
 */
export const resumable: Effect.Effect<
  (session: StoredSession) => Effect.Effect<string, InvalidState | SqlError | Schema.SchemaError>,
  never,
  SqlClient.SqlClient | WorkspaceService
> = Effect.gen(function* () {
  const workspaces = yield* WorkspaceService;
  const runners = yield* runnerRepository;
  const instances = yield* providerRepository;

  return (session: StoredSession) =>
    Effect.gen(function* () {
      if (session.status !== "exited")
        return yield* Effect.fail(createInvalidStateError(STILL_LIVE));
      if (session.conversationDeleted)
        return yield* Effect.fail(createInvalidStateError(CONVERSATION_DELETED));
      if (session.nativeSessionId === null)
        return yield* Effect.fail(createInvalidStateError(NO_TRANSCRIPT));
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
      // Check the snapshot of the runner that holds the native state, not of
      // the whole fleet, because the transcript exists only on that runner.
      const snapshots = yield* instances.listSnapshots(session.instanceId);
      if (!snapshots.some((one) => isLoggedIn(one) && one.runnerId === session.runnerId)) {
        return yield* Effect.fail(createInvalidStateError(NO_PLACEMENT));
      }
      return session.nativeSessionId;
    });
});
