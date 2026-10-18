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
 * most `MAX_SKILL_BYTES`, hold only regular files with mode `644` or `755`,
 * follow the path rules, and hash to the revision's hash. A folder in the
 * cache is never checked again. A session with full access runs as the same
 * OS user as the runner and could change any of the runner's files anyway.
 *
 * The session's folder holds copies, never links, so a harness can never
 * write through a link into the cache that other sessions read.
 *
 * Every start holds the revisions it names, from the moment its frame
 * arrives until its process exits or the start fails. When a hold is
 * released, every cached revision that no hold names is removed, so the cache
 * holds only what running sessions and starts in progress use. The runner
 * never needs to know what the library holds.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chmod, cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import {
  MAX_MESSAGE_LENGTH,
  MAX_SKILL_BYTES,
  RUNNER_SKILL_REVISIONS_PATH,
  computeSkillRevisionHash,
  escapeControlCharacters,
  listSkillPathIssues,
  readSkillArchive,
  type SessionSkill,
  type SkillArchiveEntry,
  type SkillFile,
} from "@hercule/protocol";
import { parseErrorEnvelopeMessage } from "../error-envelope";

/** How long preparing one session's skills may take, every fetch included. */
export const SKILLS_DEADLINE: Duration.Duration = Duration.seconds(60);

/** How many revisions the runner fetches at the same time. */
const PARALLEL_FETCHES = 4;

/** The name of a revision's folder in the cache. Anything else there is a temporary folder. */
const REVISION_FOLDER = /^[0-9a-f]{64}$/;

/** The names of the archive entries a skill may not hold, for the message that refuses one. */
const ENTRY_KIND_NAMES: Record<Exclude<SkillArchiveEntry["kind"], "file">, string> = {
  directory: "a directory",
  symlink: "a symbolic link",
  other: "a special entry, such as a hard link or an extension header",
};

/**
 * The revisions one start names, held from the moment its frame arrives.
 * The start's session takes the hold over once its process runs, and
 * releases it when the process exits.
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
   * start. The message names the first skill that could not be fetched,
   * failed a check, or was not ready at the deadline.
   */
  readonly prepare: (sessionId: string) => Effect.Effect<string | undefined, string>;
  /**
   * Removes the session's folder if `prepare` began one and no later hold
   * has rebuilt it since, gives up the hold, and removes every cached
   * revision that no other hold names. Calling it a second time does
   * nothing. Never fails: a folder that cannot be removed is logged.
   */
  readonly release: Effect.Effect<void>;
}

/** The skill cache of this runner. Create it once per process: holds outlive a connection. */
export interface SkillStore {
  /** Holds the revisions the start of a session names. Call it as soon as the start's frame arrives. */
  readonly hold: (skills: ReadonlyArray<SessionSkill>) => SkillHold;
}

/** Returns the message of an error, or the value itself as text. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Builds the message that refuses a start because one of its skills could
 * not be loaded, in the form spec 06 section 9.4 gives.
 */
const describeSkillFailure = (skill: SessionSkill, reason: string): string =>
  `Could not load skill \`${skill.name}\` (revision ${skill.revisionHash.slice(0, 8)}...) from the controller: ${reason}${reason.endsWith(".") ? "" : "."} The Thread did not start.`.slice(
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
 * Reads a revision's archive into its files and checks them. Fails with the
 * reason when an entry is not a regular file, a mode is not `644` or `755`,
 * a path breaks the path rules, or the files do not hash to `revisionHash`.
 */
const checkRevisionFiles = (
  revisionHash: string,
  archive: Uint8Array,
): Effect.Effect<ReadonlyArray<SkillFile>, string> =>
  Effect.gen(function* () {
    const entries = yield* Effect.mapError(readSkillArchive(archive), (error) => error.message);
    const files: Array<SkillFile> = [];
    for (const entry of entries) {
      const shownPath = `\`${escapeControlCharacters(entry.path)}\``;
      if (entry.kind !== "file") {
        return yield* Effect.fail(
          `${shownPath} is ${ENTRY_KIND_NAMES[entry.kind]}, and a skill holds only regular files`,
        );
      }
      if (entry.mode !== 0o644 && entry.mode !== 0o755) {
        return yield* Effect.fail(
          `${shownPath} has mode ${entry.mode.toString(8)}, and a skill's files have mode 644 or 755`,
        );
      }
      files.push({
        path: entry.path,
        mode: entry.mode === 0o755 ? "755" : "644",
        content: entry.content,
      });
    }
    const issues = listSkillPathIssues(files.map((file) => file.path));
    if (issues.length > 0) return yield* Effect.fail(issues.join(" "));
    if ((yield* computeSkillRevisionHash(files)) !== revisionHash) {
      return yield* Effect.fail("the files the controller sent do not match the revision's hash");
    }
    return files;
  });

/**
 * Creates the skill cache of this runner, in `skillsDir`, and the sessions'
 * folders, in `sessionSkillsDir`. A fetch carries `credential` and goes to
 * the controller URL `readControllerUrl` returns at that moment, so a
 * controller that moved is fetched from at its new address.
 *
 * `deadline` defaults to `SKILLS_DEADLINE`. Tests set a shorter one.
 */
export const makeSkillStore = (options: {
  readonly skillsDir: string;
  readonly sessionSkillsDir: string;
  readonly credential: string;
  readonly readControllerUrl: () => string;
  readonly deadline?: Duration.Duration;
}): SkillStore => {
  const { skillsDir, sessionSkillsDir } = options;
  const deadline = options.deadline ?? SKILLS_DEADLINE;
  const notReady = `it was not ready within ${String(Duration.toSeconds(deadline))} seconds`;
  /** How many holds name each revision, by revision hash. A hash no hold names is absent. */
  const holdCounts = new Map<string, number>();
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
    Effect.try(() => rmSync(path, { recursive: true, force: true })).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`could not remove ${path}: ${String(error.cause)}`),
      ),
    );

  /** Removes every cached revision that no hold names. Temporary folders of running fetches stay. */
  const removeUnheldRevisions: Effect.Effect<void> = Effect.suspend(() => {
    const names = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
    return Effect.forEach(
      names.filter((name) => REVISION_FOLDER.test(name) && !holdCounts.has(name)),
      (name) => removeFolder(join(skillsDir, name)),
      { discard: true },
    );
  });

  /**
   * Writes a checked revision's files into a temporary folder in the cache,
   * each with its mode, and renames the folder into place. On failure the
   * temporary folder is removed. Uninterruptible, so a deadline never cuts
   * it off between a write and the removal of the folder.
   */
  const writeRevision = (
    revisionHash: string,
    files: ReadonlyArray<SkillFile>,
  ): Effect.Effect<void, string> =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: async () => {
          const temporary = join(skillsDir, `.tmp-${randomUUID()}`);
          try {
            await mkdir(temporary, { recursive: true });
            for (const file of files) {
              const path = join(temporary, file.path);
              await mkdir(dirname(path), { recursive: true });
              await writeFile(path, file.content, { flag: "wx" });
              // Set after the write, because the mode `writeFile` creates a
              // file with is reduced by the process's umask.
              await chmod(path, file.mode === "755" ? 0o755 : 0o644);
            }
            await rename(temporary, join(skillsDir, revisionHash));
          } catch (error) {
            await rm(temporary, { recursive: true, force: true });
            throw error;
          }
        },
        catch: (error) => `the runner could not write its files: ${describeError(error)}`,
      }),
    );

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
      const files = yield* checkRevisionFiles(revisionHash, archive);
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
      if (existsSync(join(skillsDir, revisionHash))) return;
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
                  if (!holdCounts.has(revisionHash)) {
                    yield* removeFolder(join(skillsDir, revisionHash));
                  }
                  yield* Deferred.done(started, exit);
                }),
              ),
            ),
        );
      }
      yield* Deferred.await(done);
    });

  /** Copies one cached revision into a session's folder, keeping each file's mode. */
  const copySkill = (folder: string, skill: SessionSkill): Effect.Effect<void, string> =>
    Effect.uninterruptible(
      Effect.tryPromise({
        try: () =>
          cp(join(skillsDir, skill.revisionHash), join(folder, "skills", skill.name), {
            recursive: true,
            errorOnExist: true,
            force: false,
          }),
        catch: (error) =>
          `the runner could not copy it into the session's folder: ${describeError(error)}`,
      }),
    );

  return {
    hold: (skills) => {
      const hashes = [...new Set(skills.map((skill) => skill.revisionHash))];
      for (const hash of hashes) holdCounts.set(hash, (holdCounts.get(hash) ?? 0) + 1);
      let preparedSession: string | undefined;
      let released = false;
      const skillHold: SkillHold = {
        prepare: (sessionId) =>
          Effect.suspend(() => {
            if (skills.length === 0) return Effect.succeed(undefined);
            const sessionFolder = join(sessionSkillsDir, sessionId);
            preparedSession = sessionId;
            folderBuilders.set(sessionId, skillHold);
            // The skills not yet copied into the folder, in the order of the
            // list, so a deadline names the first of them.
            const pending = new Set(skills);
            const build = Effect.gen(function* () {
              yield* Effect.try({
                try: () => {
                  rmSync(sessionFolder, { recursive: true, force: true });
                  mkdirSync(join(sessionFolder, ".claude-plugin"), { recursive: true });
                  writeFileSync(
                    join(sessionFolder, ".claude-plugin", "plugin.json"),
                    `${JSON.stringify({ name: "skills" })}\n`,
                  );
                },
                catch: (error) => describeSkillFailure(skills[0]!, describeError(error)),
              });
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
                  Effect.fail(describeSkillFailure([...pending][0] ?? skills[0]!, notReady)),
              }),
              Effect.catchDefect((defect) =>
                Effect.fail(describeSkillFailure(skills[0]!, describeError(defect))),
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
          const session = preparedSession;
          const ownsFolder = session !== undefined && folderBuilders.get(session) === skillHold;
          if (ownsFolder) folderBuilders.delete(session);
          return Effect.andThen(
            ownsFolder ? removeFolder(join(sessionSkillsDir, session)) : Effect.void,
            removeUnheldRevisions,
          );
        }),
      };
      return skillHold;
    },
  };
};
