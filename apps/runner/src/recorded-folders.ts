/**
 * The runner's record of the private folders its harness adapters make for one
 * process (pi's agent folder, Antigravity's log folder and temporary folder).
 * An adapter removes its folder when the process ends. A runner that crashes
 * never gets there, and the folder stays with what is in it: model files that
 * may hold an API key, the account's email address in a log, whatever the
 * agent's commands wrote.
 *
 * The record is how the runner finds those folders again. At start it removes
 * exactly the folders it recorded, never every folder whose name looks like
 * one: other runners and several accounts' processes use the same machine, and
 * a folder of a process that still runs must stay.
 *
 * A record is one small file in `recordsDir` that holds the folder's absolute
 * path. One file per folder, not one list, so sessions that start at the same
 * moment never rewrite each other's entries.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as Effect from "effect/Effect";

/** What an adapter uses to make and remove the folders the runner records. */
export interface RecordedFolders {
  /**
   * Makes an empty folder named `prefix` plus random characters inside
   * `parent`, readable by the runner's user only (mode 0700), and returns its
   * path. The record is written before the folder exists, so a crash between
   * the two leaves a record of a folder that is not there, never a folder
   * without a record. Throws when the record or the folder cannot be written.
   */
  readonly make: (parent: string, prefix: string) => string;
  /**
   * Removes a folder made by `make`, with everything in it, and then its
   * record. Throws when the folder cannot be removed. The record then stays,
   * so the next runner start tries again.
   */
  readonly remove: (path: string) => void;
}

/** The record file of a folder: a hash of its path, so `remove` finds it without a lookup table. */
const recordFile = (recordsDir: string, folder: string): string =>
  join(recordsDir, createHash("sha256").update(folder).digest("hex"));

/** Returns the `RecordedFolders` that keeps its records in `recordsDir`. */
export const makeRecordedFolders = (recordsDir: string): RecordedFolders => ({
  make: (parent, prefix) => {
    const folder = join(parent, prefix + randomBytes(4).toString("hex"));
    const record = recordFile(recordsDir, folder);
    mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
    writeFileSync(record, folder, { mode: 0o600 });
    try {
      mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      rmSync(record, { force: true });
      throw error;
    }
    return folder;
  },
  remove: (path) => {
    // A few retries cover a process that has just been killed and is still
    // closing a file in the folder.
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    rmSync(recordFile(recordsDir, path), { force: true });
  },
});

/** Returns the text of an error, or of whatever else was thrown. */
const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Removes every folder recorded in `recordsDir`, and then its record. Meant
 * for the start of a runner: no process of an earlier run is still a session
 * of this runner, so every recorded folder is a leftover.
 *
 * Never fails, because a leftover is cleanup and must not keep the runner from
 * starting. A folder that cannot be removed (for example one that holds files
 * a container created as root) is logged with its path and the reason, and
 * its record stays for the next start. Each removed folder is logged with its
 * path. A record that does not hold an absolute path (a crash can leave an
 * empty file) is dropped with a warning, because there is no folder to find.
 */
export const sweepRecordedFolders = (recordsDir: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const names = yield* Effect.try({
      try: () => readdirSync(recordsDir),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? Effect.succeed([])
          : Effect.logWarning(
              `could not list the records of leftover folders in ${recordsDir}: ${describeFailure(error)}`,
            ).pipe(Effect.as([])),
      ),
    );
    for (const name of names) {
      const record = join(recordsDir, name);
      yield* Effect.try({
        try: () => {
          const folder = readFileSync(record, "utf8");
          if (!isAbsolute(folder)) return { folder: undefined };
          rmSync(folder, { recursive: true, force: true });
          rmSync(record, { force: true });
          return { folder };
        },
        catch: describeFailure,
      }).pipe(
        Effect.flatMap(({ folder }) =>
          folder === undefined
            ? Effect.sync(() => rmSync(record, { force: true })).pipe(
                Effect.andThen(
                  Effect.logWarning(`dropped the record ${record}: it holds no folder path`),
                ),
              )
            : Effect.logInfo(`removed the leftover folder ${folder} of an earlier run`),
        ),
        Effect.catch((reason) =>
          Effect.logWarning(
            `could not delete the leftover folder recorded in ${record}: ${reason}. ` +
              "Delete the folder by hand, or change the owner of the files in it to the runner's user.",
          ),
        ),
      );
    }
  });
