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
import { basename, isAbsolute, join } from "node:path";
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

/**
 * The name of a folder `make` creates: the caller's prefix, which starts with
 * `hercule-`, and six hex characters. Six characters, because a folder the
 * agent's programs make Unix sockets in has to keep its path short.
 */
const FOLDER_NAME_PATTERN = /^hercule-[a-z-]+-[0-9a-f]{6}$/;

/** The record file of a folder: a hash of its path, so `remove` finds it without a lookup table. */
const recordFile = (recordsDir: string, folder: string): string =>
  join(recordsDir, createHash("sha256").update(folder).digest("hex"));

/** Returns true when `error` is a file system error with the given `code`. */
const hasCode = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException).code === code;

/** Returns the `RecordedFolders` that keeps its records in `recordsDir`. */
export const makeRecordedFolders = (recordsDir: string): RecordedFolders => ({
  make: (parent, prefix) => {
    mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
    for (;;) {
      const folder = join(parent, prefix + randomBytes(3).toString("hex"));
      const record = recordFile(recordsDir, folder);
      try {
        // `wx`: a record of a folder that exists is never overwritten.
        writeFileSync(record, folder, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (hasCode(error, "EEXIST")) continue;
        throw error;
      }
      try {
        mkdirSync(folder, { mode: 0o700 });
        return folder;
      } catch (error) {
        rmSync(record, { force: true });
        // The name is taken by a folder this runner did not make: pick another.
        if (hasCode(error, "EEXIST")) continue;
        throw error;
      }
    }
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
 * Removes the folder one record names, and then the record, and logs what it
 * did. Never fails: a folder that cannot be removed is logged with the reason.
 *
 * A record is only trusted when it is whole: the file is named by the hash of
 * the path in it, and the folder has the shape of a folder `make` creates. A
 * record cut short by a crash, or one an agent wrote into the records
 * directory, names a different path or a different shape, and is dropped
 * without touching the path. Without that check such a record could make the
 * runner remove a Harness Home.
 */
const sweepRecord = (recordsDir: string, name: string): Effect.Effect<void> =>
  Effect.try({
    try: () => {
      const record = join(recordsDir, name);
      const folder = readFileSync(record, "utf8");
      const trusted =
        isAbsolute(folder) &&
        recordFile(recordsDir, folder) === record &&
        FOLDER_NAME_PATTERN.test(basename(folder));
      if (!trusted) {
        rmSync(record, { force: true });
        return Effect.logWarning(
          `dropped the record ${record}: it does not name a folder this runner made`,
        );
      }
      rmSync(folder, { recursive: true, force: true });
      rmSync(record, { force: true });
      return Effect.logInfo(`removed the leftover folder ${folder} of an earlier run`);
    },
    catch: describeFailure,
  }).pipe(
    Effect.flatten,
    Effect.catch((reason) =>
      Effect.logWarning(
        `could not delete the leftover folder recorded in ${join(recordsDir, name)}: ${reason}. ` +
          "Delete the folder by hand, or change the owner of the files in it to the runner's user.",
      ),
    ),
  );

/**
 * Removes every folder recorded in `recordsDir`, and then its record. Meant
 * for the start of a runner: the runner assumes no process of an earlier run
 * is still a session of it, as it does for every other folder it wipes at
 * start, so every recorded folder is a leftover.
 *
 * Never fails, because a leftover is cleanup and must not keep the runner from
 * starting. A folder that cannot be removed (for example one that holds files
 * a container created as root) is logged with its path and the reason, and
 * its record stays for the next start. Each removed folder is logged with its
 * path. A record that does not name a folder this runner made is dropped with
 * a warning (see `sweepRecord`).
 */
export const sweepRecordedFolders = (recordsDir: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const names = yield* Effect.try({
      try: () => readdirSync(recordsDir),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        hasCode(error, "ENOENT")
          ? Effect.succeed([])
          : Effect.logWarning(
              `could not list the records of leftover folders in ${recordsDir}: ${describeFailure(error)}`,
            ).pipe(Effect.as([])),
      ),
    );
    for (const name of names) yield* sweepRecord(recordsDir, name);
  });
