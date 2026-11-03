/**
 * Deletes the harness files of the archived sessions a removed workspace
 * listed, and turns what could not be deleted into warnings for the workspace.
 */
import type { ArchivedSession } from "@hercule/protocol";
import * as Effect from "effect/Effect";

/** Why a harness kept a session's files, and the name the user knows the harness by. */
export interface SessionFilesKept {
  readonly harnessName: string;
  readonly reason: string;
}

/**
 * Deletes what one harness keeps about one session in its Harness Home. Fails
 * with `SessionFilesKept` when the files stay; the reason is written for the
 * user and has no final period. Succeeds when there is nothing left to delete.
 */
export type DeleteSessionFiles = (
  session: ArchivedSession,
) => Effect.Effect<void, SessionFilesKept>;

/**
 * Deletes the files of every listed session and returns one warning per
 * harness that kept some, such as "Claude Code kept the files of 2 sessions:
 * permission denied". Never fails: a session whose files stay does not stop
 * the others, and does not undo the removal that came before.
 */
export const deleteArchivedSessionFiles = (
  deleteSessionFiles: DeleteSessionFiles,
  sessions: ReadonlyArray<ArchivedSession>,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const kept = new Map<string, { count: number; reasons: Set<string> }>();
    for (const session of sessions) {
      const failure = yield* deleteSessionFiles(session).pipe(
        Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
      );
      if (failure === undefined) continue;
      const group = kept.get(failure.harnessName) ?? { count: 0, reasons: new Set<string>() };
      group.count += 1;
      group.reasons.add(failure.reason);
      kept.set(failure.harnessName, group);
    }
    return [...kept].map(
      ([harnessName, { count, reasons }]) =>
        `${harnessName} kept the files of ${count} ${count === 1 ? "session" : "sessions"}: ${[...reasons].join("; ")}`,
    );
  });
