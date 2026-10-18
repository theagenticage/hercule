/**
 * Gives each start of a session on this runner the skills its start frame
 * names, fetched from the Skill Library on the controller (spec 06 section
 * 9.4, spec 15 section 5).
 *
 * Every start gets a folder of its own, `session-skills/<sessionId>-<uuid>/`:
 * a Claude plugin named `skills`, with each of the start's skills in
 * `skills/<name>/`. The runner fetches every skill again for every start and
 * writes it straight into that folder. No folder is shared between two
 * starts, so a start never waits for another, and removing one start's
 * folder can never touch a folder another start is using. The runner keeps
 * no state about skills and never needs to know what the library holds.
 *
 * A fetched revision is checked before anything is written: it must be at
 * most `MAX_SKILL_BYTES` and pass `verifySkillRevisionArchive`.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  MAX_MESSAGE_LENGTH,
  MAX_SKILL_BYTES,
  RUNNER_SKILL_REVISIONS_PATH,
  verifySkillRevisionArchive,
  type SessionSkill,
  type SkillFileMode,
} from "@hercule/protocol";
import { parseErrorEnvelopeMessage } from "../error-envelope";

/** How long filling one start's skills folder may take, every fetch included. */
const SKILLS_DEADLINE: Duration.Duration = Duration.seconds(60);

/** How many skills of one start the runner fetches at the same time. */
const PARALLEL_FETCHES = 4;

/** The skills folders of the starts on this runner. */
export interface SkillFolders {
  /**
   * Returns the path of a new skills folder for one start of the session. The
   * path is unique to the call. Creates nothing.
   */
  readonly buildFolderPath: (sessionId: string) => string;
  /**
   * Fetches each skill from the controller, checks it, and writes it into
   * `folder`, together with the plugin's `.claude-plugin/plugin.json`.
   *
   * Fails, after at most the deadline, with the message that refuses the
   * start:
   *
   * - when a skill could not be fetched, failed a check, could not be
   *   written, or was not ready at the deadline, the message names the first
   *   such skill;
   * - when the folder itself could not be made, the message says so and
   *   names no skill.
   *
   * The folder may then hold part of the skills. The caller owns the folder
   * and removes it whether this succeeds or fails.
   */
  readonly fillFolder: (
    folder: string,
    skills: ReadonlyArray<SessionSkill>,
  ) => Effect.Effect<void, string>;
}

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
 * Runs one short file operation that a deadline must not cut off halfway.
 * The caller removes the folder right after a failure, and a write still
 * running then would put a file back. Interruption is checked between such
 * steps, so a deadline stops a long write between two files.
 */
const runFileStep = (
  step: () => Promise<unknown>,
  describeFailure: (error: unknown) => string,
): Effect.Effect<void, string> =>
  Effect.uninterruptible(Effect.tryPromise({ try: step, catch: describeFailure }));

/**
 * Creates the skills folders of this runner, each in `sessionSkillsDir`. A
 * fetch carries `credential` and goes to the controller URL
 * `readControllerUrl` returns at that moment, so a controller that moved is
 * fetched from at its new address.
 *
 * `deadline` defaults to 60 seconds. Tests set a shorter one.
 */
export const makeSkillFolders = (options: {
  readonly sessionSkillsDir: string;
  readonly credential: string;
  readonly readControllerUrl: () => string;
  readonly deadline?: Duration.Duration;
}): SkillFolders => {
  const deadline = options.deadline ?? SKILLS_DEADLINE;
  const notReady = `it was not ready within ${String(Duration.toSeconds(deadline))} seconds`;

  /** Fetches one skill, checks it, and writes its files into the folder, each with its mode. */
  const writeSkill = (folder: string, skill: SessionSkill): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const url = new URL(
        `${RUNNER_SKILL_REVISIONS_PATH}/${skill.revisionHash}`,
        options.readControllerUrl(),
      );
      const archive = yield* Effect.tryPromise({
        try: (signal) => downloadArchive(url, options.credential, signal),
        catch: describeError,
      });
      const files = yield* verifySkillRevisionArchive(archive, skill.revisionHash).pipe(
        Effect.mapError((error) => error.message),
      );
      for (const file of files) {
        yield* runFileStep(
          async () => {
            const path = join(folder, "skills", skill.name, file.path);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, file.content, { flag: "wx" });
            // Set after the write, because the mode `writeFile` creates a
            // file with is reduced by the process's umask.
            await chmod(path, convertToPermissionBits(file.mode));
          },
          (error) => `the runner could not write its files: ${describeError(error)}`,
        );
      }
    });

  return {
    buildFolderPath: (sessionId) => join(options.sessionSkillsDir, `${sessionId}-${randomUUID()}`),
    fillFolder: (folder, skills) => {
      // The skills not yet written, in the order of the list, so a deadline
      // names the first of them.
      const pending = new Set(skills);
      const fill = Effect.gen(function* () {
        yield* runFileStep(
          async () => {
            await mkdir(join(folder, ".claude-plugin"), { recursive: true });
            await writeFile(
              join(folder, ".claude-plugin", "plugin.json"),
              `${JSON.stringify({ name: "skills" })}\n`,
            );
          },
          (error) => describeFolderFailure(describeError(error)),
        );
        yield* Effect.forEach(
          skills,
          (skill) =>
            writeSkill(folder, skill).pipe(
              Effect.tap(() => Effect.sync(() => pending.delete(skill))),
              Effect.mapError((reason) => describeSkillFailure(skill, reason)),
            ),
          { concurrency: PARALLEL_FETCHES, discard: true },
        );
      });
      return fill.pipe(
        Effect.timeoutOrElse({
          duration: deadline,
          orElse: () => {
            const [first] = pending;
            return Effect.fail(
              first === undefined
                ? describeFolderFailure(notReady)
                : describeSkillFailure(first, notReady),
            );
          },
        }),
        Effect.catchDefect((defect) => Effect.fail(describeFolderFailure(describeError(defect)))),
      );
    },
  };
};
