/**
 * What the three adapters share in `deleteSessionFiles`: reading a folder that
 * may not exist, and removing the files found, turning a failure into an
 * `AdapterFailed` whose message is the reason the operating system gave.
 */
import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
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
 * Checks that `path` is a real folder: not a symbolic link, and not a file.
 * Returns false when it does not exist. Deleting below a link would leave the
 * Harness Home, so the adapters delete below a folder only when this holds.
 */
export const isRealFolder = async (path: string): Promise<boolean> => {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
};

/**
 * Returns the paths of the real folders directly in `folder`. Symbolic links
 * are skipped, and so is a `folder` that is itself not a real folder. Returns
 * none when `folder` does not exist.
 */
export const readChildFolders = async (folder: string): Promise<ReadonlyArray<string>> => {
  if (!(await isRealFolder(folder))) return [];
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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

/** A UUID in its usual form: the shape of a Claude Code session id and a Codex thread id. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id made of letters, digits, `_` and `-` only, such as a Hercule session id. */
export const PLAIN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Removes the files and folders `collect` lists, each with everything below it.
 * Returns once all are gone, and succeeds when there is nothing to remove or
 * a path is already gone. Fails with an `AdapterFailed` holding the reason
 * for the first failure; `collect` failing, for a reason other than a missing
 * folder, fails it too.
 *
 * Refuses a `nativeSessionId` that does not match `idPattern`, before it calls
 * `collect`. The adapters build paths and match names from the id, so an id
 * such as `..` or `memory` would otherwise delete files that are not the
 * session's.
 */
export const removeSessionFiles = (
  nativeSessionId: string,
  idPattern: RegExp,
  collect: () => Promise<ReadonlyArray<string>>,
): Effect.Effect<void, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      if (!idPattern.test(nativeSessionId)) throw new Error("the session id is not valid");
      for (const path of await collect()) await rm(path, { recursive: true, force: true });
    },
    catch: (error) => buildAdapterFailed(describeFileFailure(error)),
  });

/** Removes each of `folders` that is empty. Leaves the others, and ignores a folder it cannot remove. */
export const removeEmptyFolders = async (folders: ReadonlyArray<string>): Promise<void> => {
  await Promise.all(folders.map((folder) => rmdir(folder).catch(() => undefined)));
};
