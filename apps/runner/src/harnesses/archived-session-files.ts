/**
 * Finds the Harness Adapter of an archived session and has it delete the
 * session's files, for the workspace removal that lists the session.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ArchivedSession } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import type { SessionFilesKept } from "../workspaces/archived-session-files";
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

/**
 * Deletes the harness's files of one archived session, in the Harness Home the
 * controller named. Fails with `SessionFilesKept` when this runner has no
 * adapter for the harness (named by its id then), when the home is not a
 * folder inside the storage directory (a symbolic link could otherwise make
 * the deletion reach outside it), or when the adapter cannot delete the files.
 * Does not create the home: a home that is not there has no files to delete.
 */
export const deleteHarnessSessionFiles = (
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
