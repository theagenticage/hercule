/**
 * Deletes the harness files of archived sessions, for the workspace removal
 * that lists them: finds each session's Harness Adapter, checks the Harness
 * Home, and turns the files that stay into warnings.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ArchivedSession } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import { buildHarnessHomePath } from "./account";
import { findAdapter } from "./index";
import { describeFileFailure } from "./session-files";

/**
 * Checks where a Harness Home really is. Returns "missing" when nothing is
 * there, "inside" when the home is a real folder at its path under the
 * storage directory, and "redirected" when a symbolic link in the home or in
 * any folder above it leads elsewhere. Fails when the path cannot be read.
 */
const locateHome = async (
  storageDir: string,
  harnessHome: string,
): Promise<"missing" | "inside" | "redirected"> => {
  try {
    const physical = await realpath(join(storageDir, harnessHome));
    return physical === join(await realpath(storageDir), harnessHome) ? "inside" : "redirected";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw error;
  }
};

/** Why a harness kept a session's files, and the name the user knows the harness by. */
interface SessionFilesKept {
  readonly harnessName: string;
  readonly reason: string;
}

/**
 * Deletes the harness's files of one archived session, in the Harness Home the
 * controller named. Fails with `SessionFilesKept` when this runner has no
 * adapter for the harness (named by its id then), when the home is not a
 * folder inside the storage directory (a symbolic link could otherwise make
 * the deletion reach outside it), or when the adapter cannot delete the files.
 * Does not create the home: a home that is not there has no files to delete.
 */
const deleteHarnessSessionFiles = (
  storageDir: string,
  session: ArchivedSession,
): Effect.Effect<void, SessionFilesKept> => {
  const adapter = findAdapter(session.harnessId);
  if (adapter === undefined)
    return Effect.fail({
      harnessName: session.harnessId,
      reason: "this runner has no adapter for the harness",
    });
  const kept = (reason: string): SessionFilesKept => ({ harnessName: adapter.harnessName, reason });
  return Effect.gen(function* () {
    const location = yield* Effect.tryPromise({
      try: () => locateHome(storageDir, session.harnessHome),
      catch: (error) => kept(`its home cannot be read: ${describeFileFailure(error)}`),
    });
    if (location === "missing") return;
    if (location === "redirected")
      return yield* Effect.fail(kept("its home is not a folder inside the runner's storage"));
    yield* adapter
      .deleteSessionFiles(
        buildHarnessHomePath(storageDir, session.harnessHome),
        session.nativeSessionId,
      )
      .pipe(
        // The adapter ends its message with a period, and the warning joins it to more text.
        Effect.mapError((error) => kept(error.message.replace(/\.$/, ""))),
      );
  });
};

/**
 * Deletes the harness files of every listed session and returns one warning
 * per harness that kept some, such as "Claude Code kept the files of 2
 * sessions: permission denied". Never fails: a session whose files stay does
 * not stop the others, and does not undo the workspace removal that came
 * before.
 */
export const deleteArchivedSessionFiles = (
  storageDir: string,
  sessions: ReadonlyArray<ArchivedSession>,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const kept = new Map<string, { count: number; reasons: Set<string> }>();
    for (const session of sessions) {
      const failure = yield* deleteHarnessSessionFiles(storageDir, session).pipe(
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
