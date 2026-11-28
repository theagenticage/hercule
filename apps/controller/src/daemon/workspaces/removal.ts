/**
 * What the controller daemon adds to a workspace's removal beyond the rows:
 *
 * - the list of archived sessions whose harness files the runner deletes with
 *   the workspace, frozen into the removal instruction when it is reserved;
 * - the send of an instruction to its runner, which the first send and the
 *   resend to a runner that has just connected share. It shapes the stored
 *   instruction for what the connected runner understands.
 *
 * The Harness Home of a session is named here because it comes from the
 * session's provider account, and the workspaces domain knows no accounts.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";
import {
  ARCHIVED_SESSION_FILES_CAPABILITY,
  MAX_ARCHIVED_SESSIONS,
  type ArchivedSession,
  type WorkspaceRemoval,
} from "@hercule/protocol";
import { providerAccountRepository, resolveHarnessHome } from "../../provider-accounts";
import { RunnerConnections, runnerRepository } from "../../runners";
import { WorkspaceService } from "../../workspaces";

/** Stored on a workspace removed while its runner cannot delete the harness's files. */
const RUNNER_TOO_OLD_FOR_HARNESS_FILES =
  "This machine's runner is too old to delete the harness's files. Update it.";

/** Returns "1 archived session" or "N archived sessions". */
const countArchivedSessions = (count: number): string =>
  `${String(count)} archived ${count === 1 ? "session" : "sessions"}`;

/**
 * Builds the archived sessions of a workspace that its removal lists, and the
 * warnings for the harness files that stay: those of sessions whose provider
 * account was deleted (their Harness Home cannot be named), and those past
 * what one removal lists.
 *
 * The Harness Home is named by `resolveHarnessHome` from the session's account
 * and harness, the same way a session's start names it. Those never change
 * after the session started, so the name is the one the session used.
 */
export const makeArchivedSessionsBuilder = Effect.gen(function* () {
  const workspaces = yield* WorkspaceService;
  const accounts = yield* providerAccountRepository;

  return (
    workspaceId: string,
  ): Effect.Effect<
    {
      readonly archivedSessions: ReadonlyArray<ArchivedSession>;
      readonly warnings: ReadonlyArray<string>;
    },
    SqlError
  > =>
    Effect.gen(function* () {
      const { sessions, total } = yield* workspaces.listArchivedSessions(
        workspaceId,
        MAX_ARCHIVED_SESSIONS,
      );
      if (sessions.length === 0) return { archivedSessions: [], warnings: [] };
      const accountsById = new Map(
        (yield* accounts.list()).map((account) => [account.id, account]),
      );
      const archivedSessions: Array<ArchivedSession> = [];
      for (const session of sessions) {
        const account = accountsById.get(session.providerAccountId);
        if (account === undefined) continue;
        archivedSessions.push({
          harnessId: session.harnessId,
          harnessHome: resolveHarnessHome(account, session.harnessId),
          nativeSessionId: session.nativeSessionId,
        });
      }
      const deletedAccounts = sessions.length - archivedSessions.length;
      const overLimit = total - sessions.length;
      return {
        archivedSessions,
        warnings: [
          ...(deletedAccounts === 0
            ? []
            : [
                `The harness's files of ${countArchivedSessions(deletedAccounts)} were kept: their account was deleted.`,
              ]),
          ...(overLimit === 0
            ? []
            : [
                `The harness's files of ${countArchivedSessions(overLimit)} were kept: one removal deletes at most ${String(MAX_ARCHIVED_SESSIONS)}.`,
              ]),
        ],
      };
    });
});

/**
 * Builds the function that sends a removal instruction to its runner and
 * returns whether it was sent. The instruction stays as stored; what is sent
 * is shaped for the runner:
 *
 * - a runner that is online and did not negotiate `archivedSessionFiles`
 *   ignores the list of archived sessions, so it gets the instruction without
 *   the list, and the pending removal records the older-runner warning (once),
 *   which is stored on the workspace when the removal is confirmed;
 * - any other runner gets the instruction as stored. An offline runner gets
 *   nothing now, and is sent the instruction again when it connects.
 */
export const makeRemovalSender = Effect.gen(function* () {
  const connections = yield* RunnerConnections;
  const workspaces = yield* WorkspaceService;
  const runners = yield* runnerRepository;

  return (runnerId: string, frame: WorkspaceRemoval): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      if (frame._tag !== "workspaceDispose" || frame.archivedSessions === undefined)
        return yield* connections.tell(runnerId, frame);
      const runner = yield* runners.read(runnerId);
      if (
        Option.isNone(runner) ||
        runner.value.connectivity !== "online" ||
        (runner.value.negotiatedCapabilities ?? []).includes(ARCHIVED_SESSION_FILES_CAPABILITY)
      )
        return yield* connections.tell(runnerId, frame);
      yield* workspaces.recordRemovalWarning(frame.workspaceId, RUNNER_TOO_OLD_FOR_HARNESS_FILES);
      return yield* connections.tell(runnerId, {
        _tag: "workspaceDispose",
        workspaceId: frame.workspaceId,
        ...(frame.requestId === undefined ? {} : { requestId: frame.requestId }),
        ...(frame.discardChanges === undefined ? {} : { discardChanges: frame.discardChanges }),
      });
    });
});
