/**
 * Whether a session's transcript can be picked up again, and the
 * provider-native session to pick up.
 *
 * It is one answer read from three places - the session's row, the working area
 * it ran in and the machine that holds its native state - so it is given once
 * here rather than twice: resuming a session in place and forking off it ask
 * exactly the same question.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { createInvalidStateError, type InvalidState } from "@hercule/contract";
import { loggedIn, NO_PLACEMENT, providerRepository } from "../providers";
import { DRAINING, RETIRED, runnerRepository } from "../runners";
import type { StoredSession } from "../sessions";
import { WorkspaceService } from "../workspaces";

const STILL_LIVE = "that session is still live; stop it first";

/**
 * The one way an exited session can be past resuming that is not about its
 * machine: it never reported a provider-native session, so there is no
 * transcript left anywhere to pick up.
 */
const NO_TRANSCRIPT =
  "that session left no provider-native session, so its transcript is gone and there is " +
  "nothing to resume";

/** Why a thread cannot be picked up again: the files it worked in are gone. */
const workspaceGone = (status: string): string =>
  `that session's workspace is ${status}, so there is nothing left to resume it in`;

/**
 * The one gate onto a session's transcript - resuming it in place, or forking
 * off it - and the provider-native session that comes out of it. Each refusal
 * names its own reason (spec 06 section 5): the session is still live, the
 * transcript is gone, or the machine is - retired, on its way out and taking
 * no new placement even though the transcript is still there, or no longer
 * logged in to the instance the session runs against.
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
      if (session.nativeSessionId === null)
        return yield* Effect.fail(createInvalidStateError(NO_TRANSCRIPT));
      if (!session.resumable) {
        // A thread's transcript is keyed to the working area it ran in, so a
        // workspace that is gone is a session that cannot be picked up - and
        // the user needs to read which one it was, not a word about machines.
        const status =
          session.workspaceId === null
            ? undefined
            : yield* workspaces.statusOf(session.workspaceId);
        if (status !== undefined && status !== "ready") {
          return yield* Effect.fail(createInvalidStateError(workspaceGone(status)));
        }
        return yield* Effect.fail(createInvalidStateError(RETIRED));
      }
      // `resumable` says the transcript is still there; this says the machine
      // will not open it. Whether it can be reached right now is dispatch's to
      // decide: unreachable queues the session rather than refusing it.
      const machine = yield* runners.read(session.runnerId);
      if (Option.isSome(machine) && machine.value.lifecycle !== "active") {
        return yield* Effect.fail(createInvalidStateError(DRAINING));
      }
      // The stored snapshot's word, asked of the one machine holding the native
      // state rather than of the fleet, because the transcript is only where it
      // already is.
      const snapshots = yield* instances.snapshotsOf(session.instanceId);
      if (!snapshots.some((one) => loggedIn(one) && one.runnerId === session.runnerId)) {
        return yield* Effect.fail(createInvalidStateError(NO_PLACEMENT));
      }
      return session.nativeSessionId;
    });
});
