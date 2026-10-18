/**
 * Gives each session on this runner the skills its start frame names, from
 * the Skill Library on the controller (spec 06 section 9.4, spec 15 section 5).
 *
 * Two folders in the runner's storage directory hold the files:
 *
 * - `skills/<revisionHash>/` is the cache: one folder per Skill Revision,
 *   fetched once from the controller and shared by every session that names
 *   the revision;
 * - `session-skills/<sessionId>/` is one session's folder: a Claude plugin
 *   named `skills`, with a copy of each of the session's skills in
 *   `skills/<name>/`.
 *
 * A fetched revision is checked before anything is written: it must be at
 * most `MAX_SKILL_BYTES` and pass `verifySkillRevisionArchive`. A folder in
 * the cache is never checked again. A session with full access runs as the
 * same OS user as the runner and could change any of the runner's files
 * anyway.
 *
 * The session's folder holds copies, never links, so a harness can never
 * write through a link into the cache that other sessions read. Each file
 * is cloned where the disk can (APFS, btrfs), which costs no space until a
 * copy is changed, and copied byte for byte elsewhere.
 *
 * Every start holds the revisions it names, from the moment its work begins
 * until its process exits or the start fails. When a hold is released, every
 * cached revision that no hold names is removed, so the cache holds only what
 * running sessions and starts in progress use. The runner never needs to know
 * what the library holds.
 *
 * Which revisions are cached and which are held is kept in memory, and every
 * change to it happens in one synchronous step, so two fibers never see it
 * half changed. The daemon empties both folders when it starts, so the
 * memory and the disk agree.
 */
import { randomUUID } from "node:crypto";
import { constants, renameSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import {
  MAX_MESSAGE_LENGTH,
  MAX_SKILL_BYTES,
  RUNNER_SKILL_REVISIONS_PATH,
  verifySkillRevisionArchive,
  type SessionSkill,
  type SkillFile,
  type SkillFileMode,
} from "@hercule/protocol";
import { parseErrorEnvelopeMessage } from "../error-envelope";

/** How long preparing one session's skills may take, every fetch included. */
const SKILLS_DEADLINE: Duration.Duration = Duration.seconds(60);

/** How many revisions the runner fetches at the same time. */
const PARALLEL_FETCHES = 4;

/**
 * The revisions one start names, held from the moment its work begins. The
 * start's session takes the hold over once its process runs, and releases it
 * when the process exits.
 */
export interface SkillHold {
  /**
   * Fetches every revision of the hold that is not cached yet, then builds
   * the session's folder from scratch: `.claude-plugin/plugin.json` and a
   * copy of each skill. Returns the folder's path, or undefined when the
   * start names no skills, and then no folder is made.
   *
   * Call it while the session's process is not running: it removes the
   * folder an earlier run of the session may have left.
   *
   * Fails, after at most the deadline, with the message that refuses the
   * start:
   *
   * - when a skill could not be fetched, failed a check, could not be
   *   copied, or was not ready at the deadline, the message names the first
   *   such skill;
   * - when the folder itself could not be made, the message says so and
   *   names no skill.
   */
  readonly buildSessionFolder: (sessionId: string) => Effect.Effect<string | undefined, string>;
  /**
   * Removes the session's folder if `buildSessionFolder` began one and no
   * later hold has rebuilt it since, gives up the hold, and removes every
   * cached revision that no other hold names. Calling it a second time does
   * nothing. Never fails: a folder that cannot be removed is logged.
   */
  readonly release: Effect.Effect<void>;
}

/** The skill cache of this runner. Create it once per process: holds outlive a connection. */
export interface SkillCache {
  /**
   * Holds the revisions the start of a session names. Call it when the
   * start's work begins, and release the hold whatever happens to the start.
   */
  readonly hold: (skills: ReadonlyArray<SessionSkill>) => SkillHold;
}

/** The path and mode of one file of a cached revision. Its content is on disk. */
type CachedFile = Pick<SkillFile, "path" | "mode">;

/** Converts a skill file's mode to the permission bits of the file on disk. */
const convertToPermissionBits = (mode: SkillFileMode): number => (mode === "755" ? 0o755 : 0o644);

/** Returns the message of an error, or the value itself as text. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Returns `text` with a period at its end, unless it already has one. */
const endSentence = (text: string): string => (text.endsWith(".") ? text : `${text}.`);

/**
 * Builds the message that refuses a start because one of its skills could
 * not be loaded, in the form spec 06 section 9.4 gives.
 */
const describeSkillFailure = (skill: SessionSkill, reason: string): string =>
  `Could not load skill \`${skill.name}\` (revision ${skill.revisionHash.slice(0, 8)}...) from the controller: ${endSentence(reason)} The Thread did not start.`.slice(
    0,
    MAX_MESSAGE_LENGTH,
  );

/**
 * Builds the message that refuses a start because the runner could not make
 * the session's skills folder on its own disk. No skill is to blame, so none
 * is named.
 */
const describeFolderFailure = (reason: string): string =>
  `The runner could not prepare the session's skills folder: ${endSentence(reason)} The Thread did not start.`.slice(
    0,
    MAX_MESSAGE_LENGTH,
  );

/**
 * Fetches the archive of one revision into memory. Throws an error whose
 * message says what went wrong: the controller could not be reached,
 * refused the request, or sent more than `MAX_SKILL_BYTES`.
 */
const downloadArchive = async (
  url: URL,
  credential: string,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${credential}` }, signal });
  } catch (error) {
    throw new Error(
      `the controller at ${url.origin} could not be reached: ${describeError(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      parseErrorEnvelopeMessage(await response.text().catch(() => "")) ??
        `the controller responded with HTTP ${String(response.status)}`,
    );
  }
  const tooLarge = `the skill's archive is larger than ${String(MAX_SKILL_BYTES / 1024 / 1024)} MiB`;
  const announced = response.headers.get("content-length");
  if (announced !== null && Number(announced) > MAX_SKILL_BYTES) {
    await response.body?.cancel();
    throw new Error(tooLarge);
  }
  if (response.body === null) return new Uint8Array();
  // Bun types a response's body as a stream of `any`. A fetch body is bytes.
  const body: ReadableStream<Uint8Array> = response.body;
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_SKILL_BYTES) {
      // Stops the transfer at the first chunk past the limit.
      await reader.cancel();
      throw new Error(tooLarge);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

/**
 * Creates the skill cache of this runner, in `skillsDir`, and the sessions'
 * folders, in `sessionSkillFoldersDir`. Both folders must be empty or absent.
 * A fetch carries `credential` and goes to the controller URL
 * `readControllerUrl` returns at that moment, so a controller that moved is
 * fetched from at its new address.
 *
 * `deadline` defaults to 60 seconds. Tests set a shorter one.
 */
export const makeSkillCache = (options: {
  readonly skillsDir: string;
  readonly sessionSkillFoldersDir: string;
  readonly credential: string;
  readonly readControllerUrl: () => string;
  readonly deadline?: Duration.Duration;
}): SkillCache => {
  const { skillsDir, sessionSkillFoldersDir } = options;
  const deadline = options.deadline ?? SKILLS_DEADLINE;
  const notReady = `it was not ready within ${String(Duration.toSeconds(deadline))} seconds`;
  /** How many holds name each revision, by revision hash. A hash no hold names is absent. */
  const holdCounts = new Map<string, number>();
  /** The files of each revision whose folder is in the cache, by revision hash. */
  const cachedRevisions = new Map<string, ReadonlyArray<CachedFile>>();
  /** The fetches running now, by revision hash. A start naming one of them waits for it. */
  const fetching = new Map<string, Deferred.Deferred<void, string>>();
  const fetchPermits = Semaphore.makeUnsafe(PARALLEL_FETCHES);
  /**
   * The hold that last built each session's folder, by session id. A new
   * start of a session can build the folder while the teardown of its
   * earlier run is still releasing the earlier hold, so a hold removes the
   * folder only while it is still the one that built it.
   */
  const folderBuilders = new Map<string, SkillHold>();

  /** Removes a folder, and logs a failure instead of failing. */
  const removeFolder = (path: string): Effect.Effect<void> =>
    Effect.tryPromise(() => rm(path, { recursive: true, force: true })).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`could not remove ${path}: ${describeError(error.cause)}`),
      ),
    );

  /**
   * Renames a folder to a unique temporary name in the same parent folder,
   * synchronously, and returns the new path. Fails as `renameSync` does.
   *
   * A folder is moved aside before it is deleted, because deleting takes a
   * while: a folder built again at the old path in the meantime must not be
   * the one deleted.
   */
  const moveFolderAside = (path: string): string => {
    const aside = join(dirname(path), `.tmp-${randomUUID()}`);
    renameSync(path, aside);
    return aside;
  };

  /**
   * Removes a cached revision unless a hold names it. The check and the
   * rename that takes the folder out of the cache happen in one synchronous
   * step, so a hold taken at any moment either keeps the folder or finds it
   * gone and fetches it again. It never copies from a folder being deleted.
   * The cache forgets the revision only once the rename succeeds: after a
   * failed rename the folder is still in place, and a later hold uses it.
   */
  const removeUnheldRevision = (revisionHash: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (holdCounts.has(revisionHash) || !cachedRevisions.has(revisionHash)) return Effect.void;
      let aside: string;
      try {
        aside = moveFolderAside(join(skillsDir, revisionHash));
      } catch (error) {
        return Effect.logWarning(
          `could not remove the cached Skill Revision ${revisionHash}: ${describeError(error)}`,
        );
      }
      cachedRevisions.delete(revisionHash);
      return removeFolder(aside);
    });

  /**
   * Removes a session's skills folder. The folder is moved aside at once, so
   * a resume of the session that builds the folder again while this removal
   * runs keeps its new folder. A folder that was never built needs nothing.
   */
  const removeSessionFolder = (sessionFolder: string): Effect.Effect<void> => {
    let aside: string;
    try {
      aside = moveFolderAside(sessionFolder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Effect.void;
      return Effect.logWarning(`could not remove ${sessionFolder}: ${describeError(error)}`);
    }
    return removeFolder(aside);
  };

  /** Removes every cached revision that no hold names. */
  const removeUnheldRevisions: Effect.Effect<void> = Effect.suspend(() =>
    Effect.forEach([...cachedRevisions.keys()], removeUnheldRevision, { discard: true }),
  );

  /**
   * Runs one short file operation that a deadline must not cut off halfway,
   * because the cleanup after it would race with it. Interruption is checked
   * between such steps, so a deadline stops a long copy between two files.
   */
  const runFileStep = (
    step: () => Promise<unknown>,
    describeFailure: (error: unknown) => string,
  ): Effect.Effect<void, string> =>
    Effect.uninterruptible(Effect.tryPromise({ try: step, catch: describeFailure }));

  /**
   * Writes a checked revision's files into a temporary folder in the cache,
   * each with its mode, and renames the folder into place. On failure or
   * interruption the temporary folder is removed.
   */
  const writeRevision = (
    revisionHash: string,
    files: ReadonlyArray<SkillFile>,
  ): Effect.Effect<void, string> => {
    const temporary = join(skillsDir, `.tmp-${randomUUID()}`);
    const describeFailure = (error: unknown) =>
      `the runner could not write its files: ${describeError(error)}`;
    return Effect.gen(function* () {
      yield* runFileStep(() => mkdir(temporary, { recursive: true }), describeFailure);
      for (const file of files) {
        yield* runFileStep(async () => {
          const path = join(temporary, file.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.content, { flag: "wx" });
          // Set after the write, because the mode `writeFile` creates a
          // file with is reduced by the process's umask.
          await chmod(path, convertToPermissionBits(file.mode));
        }, describeFailure);
      }
      yield* runFileStep(async () => {
        await rename(temporary, join(skillsDir, revisionHash));
        cachedRevisions.set(
          revisionHash,
          files.map(({ path, mode }) => ({ path, mode })),
        );
      }, describeFailure);
    }).pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : removeFolder(temporary))),
    );
  };

  /** Fetches one revision, checks it, and writes it into the cache. Fails with the reason. */
  const fetchRevision = (revisionHash: string): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const url = new URL(
        `${RUNNER_SKILL_REVISIONS_PATH}/${revisionHash}`,
        options.readControllerUrl(),
      );
      const archive = yield* Effect.tryPromise({
        try: (signal) => downloadArchive(url, options.credential, signal),
        catch: describeError,
      });
      const files = yield* verifySkillRevisionArchive(archive, revisionHash).pipe(
        Effect.mapError((error) => error.message),
      );
      yield* writeRevision(revisionHash, files);
    });

  /**
   * Waits until a revision is in the cache, and starts its fetch unless the
   * revision is cached or being fetched already. Fails with the reason the
   * fetch failed.
   *
   * The fetch runs in a fiber of its own, at most `PARALLEL_FETCHES` at a
   * time, and ends at the deadline. So a start that gives up waiting, or is
   * interrupted, never fails the fetch another start is waiting for.
   */
  const ensureCached = (revisionHash: string): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      if (cachedRevisions.has(revisionHash)) return;
      let done = fetching.get(revisionHash);
      if (done === undefined) {
        const started = Deferred.makeUnsafe<void, string>();
        done = started;
        fetching.set(revisionHash, started);
        yield* Effect.forkDetach(
          fetchPermits
            .withPermits(1)(fetchRevision(revisionHash))
            .pipe(
              Effect.timeoutOrElse({ duration: deadline, orElse: () => Effect.fail(notReady) }),
              Effect.catchDefect((defect) => Effect.fail(describeError(defect))),
              Effect.exit,
              Effect.flatMap((exit) =>
                Effect.gen(function* () {
                  fetching.delete(revisionHash);
                  // Every start that named the revision may have given up
                  // before the fetch ended.
                  yield* removeUnheldRevision(revisionHash);
                  yield* Deferred.done(started, exit);
                }),
              ),
            ),
        );
      }
      yield* Deferred.await(done);
    });

  /**
   * Copies one cached revision into a session's folder, one file at a time,
   * and sets each file's mode. The revision is held, so its folder stays in
   * the cache while it is copied.
   */
  const copySkill = (folder: string, skill: SessionSkill): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const source = join(skillsDir, skill.revisionHash);
      const target = join(folder, "skills", skill.name);
      for (const file of cachedRevisions.get(skill.revisionHash) ?? []) {
        yield* runFileStep(
          async () => {
            const path = join(target, file.path);
            await mkdir(dirname(path), { recursive: true });
            await copyFile(
              join(source, file.path),
              path,
              constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
            );
            await chmod(path, convertToPermissionBits(file.mode));
          },
          (error) =>
            `the runner could not copy it into the session's folder: ${describeError(error)}`,
        );
      }
    });

  return {
    hold: (skills) => {
      const hashes = [...new Set(skills.map((skill) => skill.revisionHash))];
      for (const hash of hashes) holdCounts.set(hash, (holdCounts.get(hash) ?? 0) + 1);
      let builtSession: string | undefined;
      let released = false;
      const skillHold: SkillHold = {
        buildSessionFolder: (sessionId) =>
          Effect.suspend(() => {
            const [firstSkill] = skills;
            if (firstSkill === undefined) return Effect.succeed(undefined);
            const sessionFolder = join(sessionSkillFoldersDir, sessionId);
            builtSession = sessionId;
            folderBuilders.set(sessionId, skillHold);
            // The skills not yet copied into the folder, in the order of the
            // list, so a deadline names the first of them.
            const pending = new Set(skills);
            const build = Effect.gen(function* () {
              yield* runFileStep(
                async () => {
                  await rm(sessionFolder, { recursive: true, force: true });
                  await mkdir(join(sessionFolder, ".claude-plugin"), { recursive: true });
                  await writeFile(
                    join(sessionFolder, ".claude-plugin", "plugin.json"),
                    `${JSON.stringify({ name: "skills" })}\n`,
                  );
                },
                (error) => describeFolderFailure(describeError(error)),
              );
              yield* Effect.forEach(
                skills,
                (skill) =>
                  ensureCached(skill.revisionHash).pipe(
                    Effect.andThen(copySkill(sessionFolder, skill)),
                    Effect.tap(() => Effect.sync(() => pending.delete(skill))),
                    Effect.mapError((reason) => describeSkillFailure(skill, reason)),
                  ),
                { concurrency: "unbounded", discard: true },
              );
            });
            return build.pipe(
              Effect.timeoutOrElse({
                duration: deadline,
                orElse: () =>
                  Effect.fail(describeSkillFailure([...pending][0] ?? firstSkill, notReady)),
              }),
              Effect.catchDefect((defect) =>
                Effect.fail(describeFolderFailure(describeError(defect))),
              ),
              Effect.as(sessionFolder),
            );
          }),
        release: Effect.suspend(() => {
          if (released) return Effect.void;
          released = true;
          for (const hash of hashes) {
            const count = (holdCounts.get(hash) ?? 1) - 1;
            if (count === 0) holdCounts.delete(hash);
            else holdCounts.set(hash, count);
          }
          const session = builtSession;
          const ownsFolder = session !== undefined && folderBuilders.get(session) === skillHold;
          if (ownsFolder) folderBuilders.delete(session);
          return Effect.andThen(
            ownsFolder ? removeSessionFolder(join(sessionSkillFoldersDir, session)) : Effect.void,
            removeUnheldRevisions,
          );
        }),
      };
      return skillHold;
    },
  };
};
