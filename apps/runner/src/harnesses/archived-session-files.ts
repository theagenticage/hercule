/**
 * Finds the Harness Adapter of an archived session and has it delete the
 * session's files, for the workspace removal that lists the session.
 */
import type { ArchivedSession } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import type { SessionFilesKept } from "../workspaces/archived-session-files";
import { buildHarnessHomePath } from "./account";
import { findAdapter } from "./index";

/**
 * Deletes the harness's files of one archived session, in the Harness Home the
 * controller named. Fails with `SessionFilesKept` when this runner has no
 * adapter for the harness (named by its id then), or when the adapter cannot
 * delete the files. Does not create the home: a home that is not there has no
 * files to delete.
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
  return adapter
    .deleteSessionFiles(
      buildHarnessHomePath(storageDir, session.harnessHome),
      session.nativeSessionId,
    )
    .pipe(
      Effect.mapError((error) => ({
        harnessName: adapter.harnessName,
        // The adapter ends its message with a period, and the warning joins it to more text.
        reason: error.message.replace(/\.$/, ""),
      })),
    );
};
