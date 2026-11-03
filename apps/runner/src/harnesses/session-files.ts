/**
 * What the three adapters share in `deleteSessionFiles`: reading a folder that
 * may not exist, and removing the files found, turning a failure into an
 * `AdapterFailed` whose message is the reason the operating system gave.
 */
import { readdir, rm } from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { AdapterFailed } from "@hercule/protocol";
import { buildAdapterFailed } from "./adapter-error-builders";

/** Returns the names in `folder`, or none when it does not exist or is not a folder. */
export const readFolderNames = async (folder: string): Promise<ReadonlyArray<string>> => {
  try {
    return await readdir(folder);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
};

/**
 * Returns the reason a file operation failed, as the operating system words
 * it ("permission denied"). Node's message also names the call and the path
 * ("EACCES: permission denied, unlink '/home/...'"), which the user does not
 * need.
 */
const describeFileFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z0-9]+: ([^,]+),/.exec(message)?.[1] ?? message;
};

/**
 * Removes the files and folders `collect` lists, each with everything below it.
 * Returns once all are gone, and succeeds when there is nothing to remove or
 * a path is already gone. Fails with an `AdapterFailed` holding the reason
 * for the first failure; `collect` failing, for a reason other than a missing
 * folder, fails it too.
 *
 * Refuses a `nativeSessionId` that is not a plain file name before it calls
 * `collect`, because the adapters build paths from it and a removal that
 * follows `..` would leave the Harness Home.
 */
export const removeSessionFiles = (
  nativeSessionId: string,
  collect: () => Promise<ReadonlyArray<string>>,
): Effect.Effect<void, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      if (
        /[/\\]/.test(nativeSessionId) ||
        nativeSessionId === "" ||
        nativeSessionId.startsWith(".")
      ) {
        throw new Error("the session id is not a valid file name");
      }
      for (const path of await collect()) await rm(path, { recursive: true, force: true });
    },
    catch: (error) => buildAdapterFailed(describeFileFailure(error)),
  });
