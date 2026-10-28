/**
 * The files of the Skill Library: each Skill Revision is one file,
 * `<Data Root>/skills/<revisionHash>.tar`, holding the revision's archive as
 * `buildSkillArchive` builds it from the revision's files (spec 04
 * "Relocatable Data Root"). A file's path follows from the revision's hash,
 * so the database stores no path, and two Skills with the same content share
 * one file. The archive carries each file's mode, and it is what promotion
 * sends, so the file is sent as is.
 *
 * - **Publish.** A revision's archive is written as `skills/.tmp-<random>.tar`
 *   and then renamed to its hash. A rename is atomic, so a half-written file
 *   never sits under a real hash. A hash file that already exists holds the
 *   same archive, because the hash is computed from the content and the
 *   archive is built the same way every time, so it is reused.
 * - **Clean up.** After a transaction that deleted revision rows commits,
 *   each of their files is removed, unless a row still names its hash. So
 *   is a file a publish wrote for a revision its transaction then chose not
 *   to store, as an update check does when the Skill's source changed while
 *   it ran.
 * - **The Skill Library lock.** Publishing a file through committing its row,
 *   and a cleanup's check for rows through removing the file, each hold the
 *   one lock. Without it, a cleanup could find no row for a hash, an import of
 *   the same content could then reuse the file and commit its row, and the
 *   cleanup would remove a file a fresh row names.
 * - **The boot sweep** removes what an interrupted write or a crash left
 *   behind, before the controller serves requests.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { SkillFileRecord } from "@hercule/contract";
import {
  buildSkillArchive,
  convertToSkillFileMode,
  readSkillArchive,
  type SkillFile,
} from "@hercule/protocol";
import { HerculeHome } from "../config";
import { skillRepository } from "./repository";

/** A disk operation on the Skill Library's files failed. `action` is the verb the message uses. */
export class SkillFileError extends Schema.TaggedError<SkillFileError>()("SkillFileError", {
  action: Schema.Literals(["write", "read", "list", "remove"]),
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A revision's content as `publish` writes it: its hash and its files. */
export interface PublishedSkillContent {
  readonly revisionHash: string;
  readonly files: ReadonlyArray<SkillFile>;
}

/** What a transaction run by `publish` or `publishAll` returns. */
export interface CommittedSkillChange<A> {
  readonly answer: A;
  /**
   * The hashes whose archives may have no row left once the transaction
   * commits: those of the revision rows it deleted, and the published hash
   * when it stored no row for it. Each archive is removed after the commit,
   * unless a row still names its hash.
   */
  readonly releasedHashes: ReadonlyArray<string>;
}

/** A revision's files as `skill.read` shows them: each file without its content, and the text of `SKILL.md`. */
export interface StoredSkillRevision {
  readonly files: ReadonlyArray<SkillFileRecord>;
  readonly skillMd: string;
}

const TEMP_FILE = /^\.tmp-.*\.tar$/;
const HASH = /^[0-9a-f]{64}$/;
const ARCHIVE_FILE = /^[0-9a-f]{64}\.tar$/;
const SKILL_MD = "SKILL.md";

/** Returns the folder that holds every revision archive of the Data Root at `dataDir`. */
export const buildSkillsFolder = (dataDir: string): string => join(dataDir, "skills");

/**
 * Returns the path of the archive of the revision with this hash. Throws when
 * `hash` is not 64 lowercase hex characters. Every hash comes from a row or
 * from a hash computed here, so another value means a corrupt database, and
 * joining it into a path could reach outside `skills/`. Every caller runs
 * inside an Effect, where the throw is a defect.
 */
export const buildSkillArchivePath = (dataDir: string, hash: string): string => {
  if (!HASH.test(hash)) {
    throw new Error(`a Skill Revision hash must be 64 lowercase hex characters, not \`${hash}\``);
  }
  return join(buildSkillsFolder(dataDir), `${hash}.tar`);
};

/**
 * Removes every `.tmp-*.tar` file in the Data Root's `skills/` folder, and
 * every `<hash>.tar` that no `skill_revisions` row names. Anything else in
 * `skills/` is left alone.
 *
 * It runs once at boot, before the controller serves requests, so nothing
 * else writes to `skills/` meanwhile and it takes no lock. It covers a write
 * that was interrupted, and a crash between a commit and the removal of a
 * file the commit stopped naming.
 *
 * Each file is removed on its own. A file it cannot remove only takes disk
 * space, so the failure is logged with the file's path and the sweep goes on
 * to the next file. Fails with `SkillFileError` only when the `skills/`
 * folder cannot be listed.
 */
export const sweepSkillArchives: Effect.Effect<
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
  const storedArchives = new Set(
    (yield* repository.listRevisionHashes()).map((hash) => `${hash}.tar`),
  );
  const stray = names.filter(
    (name) => TEMP_FILE.test(name) || (ARCHIVE_FILE.test(name) && !storedArchives.has(name)),
  );
  yield* Effect.forEach(
    stray,
    (name) => {
      const path = join(directory, name);
      return Effect.tryPromise(() => rm(path, { force: true })).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Could not remove the leftover Skill Library file ${path}; the next boot tries again`,
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

  const removeFile = (path: string): Effect.Effect<void, SkillFileError> =>
    Effect.tryPromise({
      try: () => rm(path, { force: true }),
      catch: (cause) => new SkillFileError({ action: "remove", path, cause }),
    });

  /**
   * Removes the archive of each hash that no row names any more. The caller
   * holds the lock, so no publish can name a hash between the check and the
   * removal.
   *
   * The removal cannot be interrupted. An interrupted fiber gives the lock
   * back at once, while a removal it started goes on in the file system; a
   * publish taking the lock meanwhile would reuse the archive being removed,
   * and its new row would name a file that is gone.
   */
  const removeUnnamedArchives = (
    hashes: ReadonlyArray<string>,
  ): Effect.Effect<void, SkillFileError | SqlError> =>
    Effect.uninterruptible(
      Effect.forEach(
        new Set(hashes),
        (hash) =>
          Effect.flatMap(repository.isRevisionHashStored(hash), (stored) =>
            stored ? Effect.void : removeFile(buildSkillArchivePath(dataDir, hash)),
          ),
        { discard: true },
      ),
    );

  /**
   * Removes archives after a commit stopped naming them. The rows are already
   * gone, so a failure here only leaves a file behind, which the next boot
   * sweep removes. It is logged rather than failing an operation that
   * succeeded.
   */
  const cleanUpAfterCommit = (hashes: ReadonlyArray<string>): Effect.Effect<void> =>
    removeUnnamedArchives(hashes).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "Removing the archives of deleted Skill Revisions failed; the next boot removes them",
          error,
        ),
      ),
    );

  /** Writes a revision's archive to a new temp file in `skills/` and returns the temp file's path. */
  const writeTempArchive = (
    files: ReadonlyArray<SkillFile>,
  ): Effect.Effect<string, SkillFileError> =>
    Effect.gen(function* () {
      // The content rules refused every path too long for a ustar header.
      const archive = yield* Effect.orDie(buildSkillArchive(files));
      const temp = join(directory, `.tmp-${crypto.randomUUID()}.tar`);
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(temp, archive, { flag: "wx", mode: 0o600 });
        },
        catch: (cause) => new SkillFileError({ action: "write", path: temp, cause }),
      }).pipe(Effect.tapError(() => Effect.ignore(removeFile(temp))));
      return temp;
    });

  /**
   * Moves a temp file to the hash's archive path, or removes it when that
   * file already exists: it holds the same archive, because the hash is
   * computed from the content. The caller holds the lock.
   */
  const moveToHashPath = (temp: string, hash: string): Effect.Effect<void, SkillFileError> => {
    const path = buildSkillArchivePath(dataDir, hash);
    return Effect.tryPromise({
      try: async () => {
        const exists = await stat(path).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (exists) await rm(temp, { force: true });
        else await rename(temp, path);
      },
      catch: (cause) => new SkillFileError({ action: "write", path, cause }),
    }).pipe(Effect.tapError(() => Effect.ignore(removeFile(temp))));
  };

  /**
   * Reads the archive of the revision with this hash and returns its files
   * with their content, sorted by path as the archive holds them. Fails with
   * `SkillFileError` when the file cannot be read or holds no archive. The
   * cause of a missing file is the `ENOENT` error of the read.
   */
  const readRevisionFiles = (
    hash: string,
  ): Effect.Effect<ReadonlyArray<SkillFile>, SkillFileError> => {
    const path = buildSkillArchivePath(dataDir, hash);
    const fail = (cause: unknown) => new SkillFileError({ action: "read", path, cause });
    return Effect.gen(function* () {
      const bytes = yield* Effect.tryPromise({ try: () => readFile(path), catch: fail });
      const entries = yield* Effect.mapError(readSkillArchive(bytes), fail);
      return entries.map((entry) => ({
        path: entry.path,
        mode: convertToSkillFileMode(entry.mode),
        content: entry.content,
      }));
    });
  };

  /**
   * Publishes the archive of each revision in `contents` and runs `commit`,
   * the transaction that stores the rows, holding the Skill Library lock from
   * the first archive's move through the commit. Returns the transaction's
   * answer.
   *
   * An archive that cannot be written does not stop the others: `commit`
   * receives each failed hash with its error, and must store no row for it.
   *
   * - When the transaction fails, the archive of each published hash is
   *   removed unless a row names it, and the transaction's error is the
   *   result.
   * - After the commit, the archive of each hash the transaction released
   *   is removed unless a row still names it.
   *
   * The archives are written to temp files before the lock is taken, so a
   * slow write never holds up another operation. The renames, or the reuse
   * of existing archives, happen under the lock, so a delete's cleanup
   * cannot remove an archive this publish reused.
   */
  const publishAll = <A, E, R>(
    contents: ReadonlyArray<PublishedSkillContent>,
    commit: (
      failures: ReadonlyMap<string, SkillFileError>,
    ) => Effect.Effect<CommittedSkillChange<A>, E, R>,
  ): Effect.Effect<A, E | SqlError, R> =>
    Effect.gen(function* () {
      const failures = new Map<string, SkillFileError>();
      const temps = new Map<string, string>();
      for (const content of contents) {
        if (temps.has(content.revisionHash) || failures.has(content.revisionHash)) continue;
        const written = yield* Effect.result(writeTempArchive(content.files));
        if (Result.isFailure(written)) failures.set(content.revisionHash, written.failure);
        else temps.set(content.revisionHash, written.success);
      }
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const published: Array<string> = [];
          for (const [hash, temp] of temps) {
            const moved = yield* Effect.result(moveToHashPath(temp, hash));
            if (Result.isFailure(moved)) failures.set(hash, moved.failure);
            else published.push(hash);
          }
          const committed = yield* commit(failures).pipe(
            Effect.tapError(() =>
              removeUnnamedArchives(published).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    "Removing a Skill Revision archive no row names failed; the next boot removes it",
                    error,
                  ),
                ),
              ),
            ),
          );
          yield* cleanUpAfterCommit(committed.releasedHashes);
          return committed.answer;
        }),
      );
    });

  return {
    /**
     * Publishes one revision's archive and runs `commit`, as `publishAll`
     * does. Fails with `SkillFileError`, without running `commit`, when the
     * archive cannot be written.
     */
    publish: <A, E, R>(
      content: PublishedSkillContent,
      commit: Effect.Effect<CommittedSkillChange<A>, E, R>,
    ): Effect.Effect<A, E | SkillFileError | SqlError, R> =>
      publishAll<A, E | SkillFileError, R>([content], (failures) => {
        const failure = failures.get(content.revisionHash);
        return failure === undefined ? commit : Effect.fail(failure);
      }),

    publishAll,

    /**
     * Removes the archives of revisions whose rows a committed transaction
     * deleted, each unless a row still names its hash. Holds the Skill
     * Library lock while it checks and removes. A failure is logged, and the
     * next boot sweep removes the file.
     */
    removeDeletedRevisionArchives: (hashes: ReadonlyArray<string>): Effect.Effect<void> =>
      hashes.length === 0 ? Effect.void : lock.withPermit(cleanUpAfterCommit(hashes)),

    /**
     * Runs `effect` holding the Skill Library lock, so no cleanup removes an
     * archive while it runs. A reader that found a hash in a row reads that
     * hash's archive under it, because a delete that commits meanwhile
     * removes the archive only once it holds the lock.
     */
    withLibraryLock: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      lock.withPermit(effect),

    /**
     * Reads the archive of the revision with this hash and returns its bytes
     * as they are stored, without parsing them. Fails with `SkillFileError`
     * when the file cannot be read. The cause of a missing file is the
     * `ENOENT` error of the read.
     */
    readArchive: (hash: string): Effect.Effect<Uint8Array, SkillFileError> => {
      const path = buildSkillArchivePath(dataDir, hash);
      return Effect.tryPromise({
        try: () => readFile(path),
        catch: (cause) => new SkillFileError({ action: "read", path, cause }),
      });
    },

    readRevisionFiles,

    /**
     * Reads the archive of the revision with this hash and returns its files
     * without their content, in archive order, which is sorted by path, and the text
     * of its `SKILL.md`. Fails with `SkillFileError` when the file cannot be
     * read, or holds no archive with a `SKILL.md`. The cause of a missing
     * file is the `ENOENT` error of the read.
     */
    readRevision: (hash: string): Effect.Effect<StoredSkillRevision, SkillFileError> =>
      Effect.gen(function* () {
        const files = yield* readRevisionFiles(hash);
        const skillMd = files.find((file) => file.path === SKILL_MD);
        if (skillMd === undefined) {
          return yield* new SkillFileError({
            action: "read",
            path: buildSkillArchivePath(dataDir, hash),
            cause: new Error(`the archive has no ${SKILL_MD}`),
          });
        }
        return {
          files: files.map((file) => ({
            path: file.path,
            mode: file.mode,
            sizeBytes: file.content.byteLength,
          })),
          skillMd: new TextDecoder().decode(skillMd.content),
        };
      }),
  };
});

/** The Skill Library's files, and the one lock that orders their writes and removals. */
export class SkillFiles extends Context.Service<SkillFiles, Effect.Success<typeof make>>()(
  "hercule/controller/skills/SkillFiles",
) {}

export const SkillFilesLayer: Layer.Layer<SkillFiles, never, SqlClient.SqlClient | HerculeHome> =
  Layer.effect(SkillFiles)(make);
