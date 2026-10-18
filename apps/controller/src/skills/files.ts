/**
 * The files of the Skill Library: each Skill Revision's files are a plain
 * folder at `<Data Root>/skills/<revisionHash>/` (spec 04 "Relocatable Data
 * Root"). A folder's path follows from the revision's hash, so the database
 * stores no path, and two Skills with the same content share one folder.
 *
 * - **Publish.** A revision's folder is written as `skills/.tmp-<random>/`,
 *   each file's mode set to `644` or `755` explicitly rather than left to
 *   the process's umask, and then renamed to its hash. A rename is atomic,
 *   so a half-written tree never sits under a real hash. A hash folder that
 *   already exists holds the same content, because the hash is computed from
 *   the content, so it is reused.
 * - **Clean up.** After a transaction that deleted revision rows commits,
 *   each of their folders is removed, unless a row still names its hash.
 * - **The Skill Library lock.** Publishing a folder through committing its
 *   row, and a cleanup's check for rows through removing the folder, each
 *   hold the one lock. Without it, a cleanup could find no row for a hash, an
 *   import of the same content could then reuse the folder and commit its
 *   row, and the cleanup would remove a folder a fresh row names.
 * - **The boot sweep** removes what an interrupted write or a crash left
 *   behind, before the controller serves requests.
 */
import { lstat, mkdir, readdir, readFile, rename, rm, chmod, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SkillFileRecord } from "@hercule/contract";
import { compareSkillPaths, convertToSkillFileMode, type SkillFile } from "@hercule/protocol";
import { HerculeHome } from "../config";
import { skillRepository } from "./repository";

/** A disk operation on the Skill Library's files failed. `action` is the verb the message uses. */
export class SkillFileError extends Schema.TaggedError<SkillFileError>()("SkillFileError", {
  action: Schema.Literals(["write", "read", "list", "remove"]),
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * Two files of a skill are one file on this machine's file system, as `a.md`
 * and `A.md` are where the file system ignores letter case. `path` is the
 * file that could not be written, and `earlierPath` the file written before
 * it under the same name, when it could be found.
 */
export class SkillPathsCollide extends Schema.TaggedError<SkillPathsCollide>()(
  "SkillPathsCollide",
  { path: Schema.String, earlierPath: Schema.optional(Schema.String) },
) {
  override get message(): string {
    const files =
      this.earlierPath === undefined
        ? `\`${this.path}\` and another file of the skill`
        : `\`${this.earlierPath}\` and \`${this.path}\``;
    return `${files} are one file on this machine's file system, which does not tell their names apart. Rename one of them so the names differ by more than letter case.`;
  }
}

/** What a transaction run by `publish` returns: its answer, and the hashes of the revision rows it deleted. */
export interface CommittedSkillChange<A> {
  readonly answer: A;
  readonly deletedHashes: ReadonlyArray<string>;
}

const TEMP_PREFIX = ".tmp-";
const HASH_FOLDER_NAME = /^[0-9a-f]{64}$/;
const SKILL_MD = "SKILL.md";

/** Returns the folder that holds every revision folder of the Data Root at `dataDir`. */
export const buildSkillsFolder = (dataDir: string): string => join(dataDir, "skills");

/**
 * Returns the folder that holds the files of the revision with this hash.
 * Throws when `hash` is not 64 lowercase hex characters. Every hash comes
 * from a row or from a hash computed here, so another value means a corrupt
 * database, and joining it into a path could reach outside `skills/`. Every
 * caller runs inside an Effect, where the throw is a defect.
 */
export const buildSkillRevisionFolder = (dataDir: string, hash: string): string => {
  if (!HASH_FOLDER_NAME.test(hash)) {
    throw new Error(`a Skill Revision hash must be 64 lowercase hex characters, not \`${hash}\``);
  }
  return join(buildSkillsFolder(dataDir), hash);
};

/** Returns whether something is at `path`. */
const pathExists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

/**
 * Lists the files under `root`, with their paths relative to it and `/`
 * between folders. A folder is not listed, only the files in it. The list is
 * sorted by `compareSkillPaths`.
 */
const listFolderFiles = async (root: string): Promise<Array<SkillFileRecord>> => {
  const found: Array<SkillFileRecord> = [];
  const walk = async (folder: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(full, path);
      } else {
        const stats = await lstat(full);
        found.push({ path, mode: convertToSkillFileMode(stats.mode), sizeBytes: stats.size });
      }
    }
  };
  await walk(root, "");
  return found.sort((left, right) => compareSkillPaths(left.path, right.path));
};

/**
 * Returns the path in `written` of the file that is the same file on disk as
 * `full`, the absolute path of a file in `folder`, or `undefined` when none
 * is found.
 */
const findSameFile = async (
  folder: string,
  written: ReadonlyArray<string>,
  full: string,
): Promise<string | undefined> => {
  const target = await lstat(full).catch(() => undefined);
  if (target === undefined) return undefined;
  for (const path of written) {
    if ((await lstat(join(folder, path))).ino === target.ino) return path;
  }
  return undefined;
};

/**
 * Writes `files` into `folder`, which must not exist yet, and sets each
 * file's mode itself: `writeFile`'s mode is reduced by the umask. Fails with
 * `SkillPathsCollide` when two of the paths are one file on this file system,
 * and with `SkillFileError` when any other write fails.
 *
 * Each file is created exclusively. The content rules refuse paths that
 * differ only in letter case, but a file system can fold names in ways no
 * rule foresees, and a plain write would let the second file overwrite the
 * first, leaving a folder whose files no longer have the revision's hash.
 */
export const writeFolderFiles = (
  folder: string,
  files: ReadonlyArray<SkillFile>,
): Effect.Effect<void, SkillPathsCollide | SkillFileError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(folder, { recursive: true });
      const written: Array<string> = [];
      for (const file of files) {
        const full = join(folder, file.path);
        try {
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, file.content, { flag: "wx" });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOTDIR") throw error;
          throw new SkillPathsCollide({
            path: file.path,
            earlierPath: await findSameFile(folder, written, full),
          });
        }
        await chmod(full, file.mode === "755" ? 0o755 : 0o644);
        written.push(file.path);
      }
    },
    catch: (cause) =>
      cause instanceof SkillPathsCollide
        ? cause
        : new SkillFileError({ action: "write", path: folder, cause }),
  });

/**
 * Lists the files of the revision with this hash, in the Data Root at
 * `dataDir`, without their content, sorted by path. Fails with
 * `SkillFileError` when the folder cannot be read.
 */
export const listRevisionFiles = (
  dataDir: string,
  hash: string,
): Effect.Effect<ReadonlyArray<SkillFileRecord>, SkillFileError> => {
  const folder = buildSkillRevisionFolder(dataDir, hash);
  return Effect.tryPromise({
    try: () => listFolderFiles(folder),
    catch: (cause) => new SkillFileError({ action: "read", path: folder, cause }),
  });
};

/**
 * Reads the folder of the revision with this hash, in the Data Root at
 * `dataDir`, back into its files, with their content, sorted by path: the
 * files the revision's hash was computed from. Fails with `SkillFileError`
 * when the folder cannot be read.
 *
 * It takes no lock, so a cleanup could remove the folder while it reads. A
 * caller either holds the Skill Library lock (`SkillFiles.withLibraryLock`),
 * or knows that no row naming the hash can be deleted meanwhile, as during a
 * promotion's freeze, when the database refuses every write.
 */
export const readRevisionFiles = (
  dataDir: string,
  hash: string,
): Effect.Effect<ReadonlyArray<SkillFile>, SkillFileError> => {
  const folder = buildSkillRevisionFolder(dataDir, hash);
  return Effect.tryPromise({
    try: async () => {
      const records = await listFolderFiles(folder);
      return Promise.all(
        records.map(async (record): Promise<SkillFile> => ({
          path: record.path,
          mode: record.mode,
          content: new Uint8Array(await readFile(join(folder, record.path))),
        })),
      );
    },
    catch: (cause) => new SkillFileError({ action: "read", path: folder, cause }),
  });
};

/**
 * Removes every `.tmp-*` folder in the Data Root's `skills/` folder, and
 * every hash folder that no `skill_revisions` row names. Anything else in
 * `skills/` is left alone.
 *
 * It runs once at boot, before the controller serves requests, so nothing
 * else writes to `skills/` meanwhile and it takes no lock. It covers a write
 * that was interrupted, and a crash between a commit and the removal of a
 * folder the commit stopped naming.
 *
 * Each folder is removed on its own. A folder it cannot remove only takes
 * disk space, so the failure is logged with the folder's path and the sweep
 * goes on to the next folder. Fails with `SkillFileError` only when the
 * `skills/` folder cannot be listed.
 */
export const sweepSkillFolders: Effect.Effect<
  void,
  SkillFileError | SqlError,
  SqlClient.SqlClient | HerculeHome
> = Effect.gen(function* () {
  const { dataDir } = yield* HerculeHome;
  const directory = buildSkillsFolder(dataDir);
  const repository = yield* skillRepository;
  const names = yield* Effect.tryPromise({
    try: () =>
      readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }),
    catch: (cause) => new SkillFileError({ action: "list", path: directory, cause }),
  });
  const storedHashes = new Set(yield* repository.listRevisionHashes());
  const stray = names.filter(
    (name) =>
      name.startsWith(TEMP_PREFIX) || (HASH_FOLDER_NAME.test(name) && !storedHashes.has(name)),
  );
  yield* Effect.forEach(
    stray,
    (name) => {
      const path = join(directory, name);
      return Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Could not remove the leftover Skill Library folder ${path}; the next boot tries again`,
            error.cause,
          ),
        ),
      );
    },
    { discard: true },
  );
});

const make = Effect.gen(function* () {
  const { dataDir } = yield* HerculeHome;
  const repository = yield* skillRepository;
  const directory = buildSkillsFolder(dataDir);
  const lock = yield* Semaphore.make(1);

  const removeFolder = (path: string): Effect.Effect<void, SkillFileError> =>
    Effect.tryPromise({
      try: () => rm(path, { recursive: true, force: true }),
      catch: (cause) => new SkillFileError({ action: "remove", path, cause }),
    });

  /**
   * Removes the folder of each hash that no row names any more. The caller
   * holds the lock, so no publish can name a hash between the check and the
   * removal.
   */
  const removeUnnamedFolders = (
    hashes: ReadonlyArray<string>,
  ): Effect.Effect<void, SkillFileError | SqlError> =>
    Effect.forEach(
      new Set(hashes),
      (hash) =>
        Effect.flatMap(repository.isRevisionHashStored(hash), (stored) =>
          stored ? Effect.void : removeFolder(buildSkillRevisionFolder(dataDir, hash)),
        ),
      { discard: true },
    );

  /**
   * Removes folders after a commit stopped naming them. The rows are already
   * gone, so a failure here only leaves a folder behind, which the next boot
   * sweep removes. It is logged rather than failing an operation that
   * succeeded.
   */
  const cleanUpAfterCommit = (hashes: ReadonlyArray<string>): Effect.Effect<void> =>
    removeUnnamedFolders(hashes).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "Removing the folders of deleted Skill Revisions failed; the next boot removes them",
          error,
        ),
      ),
    );

  /**
   * Writes a revision's files to a new temp folder in `skills/` and returns
   * the temp folder's path. Removes the temp folder when a write fails.
   */
  const writeTempFolder = (
    files: ReadonlyArray<SkillFile>,
  ): Effect.Effect<string, SkillPathsCollide | SkillFileError> => {
    const temp = join(directory, `${TEMP_PREFIX}${crypto.randomUUID()}`);
    return Effect.tryPromise({
      try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
      catch: (cause) => new SkillFileError({ action: "write", path: directory, cause }),
    }).pipe(
      Effect.andThen(writeFolderFiles(temp, files)),
      Effect.as(temp),
      Effect.tapError(() => Effect.ignore(removeFolder(temp))),
    );
  };

  /**
   * Moves a temp folder to the hash folder, or removes it when the hash
   * folder already exists: that folder holds the same content, because the
   * hash is computed from the content. The caller holds the lock.
   */
  const moveToHashFolder = (temp: string, hash: string): Effect.Effect<void, SkillFileError> => {
    const folder = buildSkillRevisionFolder(dataDir, hash);
    return Effect.tryPromise({
      try: async () => {
        if (await pathExists(folder)) await rm(temp, { recursive: true, force: true });
        else await rename(temp, folder);
      },
      catch: (cause) => new SkillFileError({ action: "write", path: folder, cause }),
    }).pipe(Effect.tapError(() => Effect.ignore(removeFolder(temp))));
  };

  return {
    /**
     * Publishes a revision's folder and runs `commit`, the transaction that
     * stores the rows, holding the Skill Library lock for both. Returns the
     * transaction's answer.
     *
     * - When the transaction fails, the hash folder is removed unless a row
     *   names it, and the transaction's error is the result.
     * - After the commit, the folder of each hash the transaction deleted is
     *   removed unless a row still names it.
     *
     * The files are written to a temp folder before the lock is taken, so
     * one import's writes never hold up another operation. The rename, or
     * the reuse of an existing hash folder, happens under the lock, so a
     * delete's cleanup cannot remove a folder this publish reused.
     */
    publish: <A, E, R>(
      content: { readonly revisionHash: string; readonly files: ReadonlyArray<SkillFile> },
      commit: Effect.Effect<CommittedSkillChange<A>, E, R>,
    ): Effect.Effect<A, E | SkillPathsCollide | SkillFileError | SqlError, R> =>
      Effect.flatMap(writeTempFolder(content.files), (temp) =>
        lock.withPermit(
          Effect.gen(function* () {
            yield* moveToHashFolder(temp, content.revisionHash);
            const committed = yield* commit.pipe(
              Effect.tapError(() =>
                removeUnnamedFolders([content.revisionHash]).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(
                      "Removing a Skill Revision folder no row names failed; the next boot removes it",
                      error,
                    ),
                  ),
                ),
              ),
            );
            yield* cleanUpAfterCommit(committed.deletedHashes);
            return committed.answer;
          }),
        ),
      ),

    /**
     * Removes the folders of revisions whose rows a committed transaction
     * deleted, each unless a row still names its hash. Holds the Skill
     * Library lock while it checks and removes. A failure is logged, and the
     * next boot sweep removes the folder.
     */
    removeDeletedRevisionFolders: (hashes: ReadonlyArray<string>): Effect.Effect<void> =>
      hashes.length === 0 ? Effect.void : lock.withPermit(cleanUpAfterCommit(hashes)),

    /**
     * Runs `effect` holding the Skill Library lock, so no cleanup removes a
     * folder while it runs. A reader that found a hash in a row reads that
     * hash's folder under it, because a delete that commits meanwhile removes
     * the folder only once it holds the lock.
     */
    withLibraryLock: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      lock.withPermit(effect),

    /**
     * Lists a revision's files without their content, sorted by path. Fails
     * with `SkillFileError` when the folder cannot be read.
     */
    listFiles: (hash: string): Effect.Effect<ReadonlyArray<SkillFileRecord>, SkillFileError> =>
      listRevisionFiles(dataDir, hash),

    /** Reads the text of a revision's `SKILL.md`. Fails with `SkillFileError` when it cannot be read. */
    readSkillMd: (hash: string): Effect.Effect<string, SkillFileError> => {
      const path = join(buildSkillRevisionFolder(dataDir, hash), SKILL_MD);
      return Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: (cause) => new SkillFileError({ action: "read", path, cause }),
      });
    },
  };
});

/** The Skill Library's files, and the one lock that orders their writes and removals. */
export class SkillFiles extends Context.Service<SkillFiles, Effect.Success<typeof make>>()(
  "hercule/controller/skills/SkillFiles",
) {}

export const SkillFilesLayer: Layer.Layer<SkillFiles, never, SqlClient.SqlClient | HerculeHome> =
  Layer.effect(SkillFiles)(make);
