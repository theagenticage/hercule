/**
 * The files Google's `agy` keeps in an account's Harness Home. The Harness
 * Home is what the runner passes to `agy` as `--gemini-dir`, and everything
 * `agy` writes that matters here is below `<home>/antigravity-acp/`.
 *
 * Besides `agy`'s files, the Harness Home holds the two things the probe keeps:
 * the folder `hercule-probe/`, the working folder of one conversation the
 * probe resumes each time, and the file `hercule-probe-conversation` with that
 * conversation's id. `agy` cannot delete a conversation, and every new one
 * adds to its shared files for good, so the probe makes one and keeps it.
 *
 * Every path below `<home>` is checked without following links, so a link
 * placed in the Harness Home is never read or deleted through. This guards
 * against stale or misplaced links only. It does not protect against another
 * process of the same user that swaps paths while this code runs.
 */
import { constants, mkdtempSync } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { AdapterFailed } from "@hercule/protocol";
import { buildAdapterFailed } from "../adapter-error-builders";
import { writeFileAtomically } from "../atomic-file";
import {
  describeFileFailure,
  isMissingPath,
  isRealFolder,
  removeSessionFiles,
  UUID_PATTERN,
} from "../session-files";
import { ANTIGRAVITY_NAME } from "./harness-name";

/** The folder in the Harness Home where `agy` keeps its own data. */
export const APP_DATA_DIR = "antigravity-acp";

const TOKEN_FILE = "antigravity-oauth-token";

/** The most bytes of the token file that are read. A real one is well under 4 KiB. */
const TOKEN_FILE_LIMIT = 64 * 1024;

/** How many bytes `readRegularFile` asks for in one read. */
const READ_CHUNK = 64 * 1024;

/** The working folder of the probe's conversation, directly in the Harness Home. */
const PROBE_FOLDER = "hercule-probe";

/** The file in the Harness Home that holds the id of the probe's conversation, as one line. */
const PROBE_CONVERSATION_FILE = "hercule-probe-conversation";

/** The most bytes of the probe's conversation file that are read. A UUID line is 37. */
const PROBE_CONVERSATION_FILE_LIMIT = 128;

/** The one field of the token file that `readSignedInEmail` decodes. */
const TokenFile = Schema.fromJsonString(Schema.Struct({ id_token_email: Schema.NonEmptyString }));
const decodeTokenFile = Schema.decodeUnknownSync(TokenFile);

/**
 * Reads at most `limit` bytes from the start of the regular file at `path`,
 * and returns them as UTF-8 text. `isTruncated` is true when the file has more
 * bytes than that. Fails (the promise rejects) when the file cannot be opened,
 * is a link, or is not a regular file.
 *
 * The file is opened without following a link, so that a link put in its
 * place cannot send the read to another file. It is opened without blocking,
 * so that a FIFO put in its place cannot hang the runner: opening a FIFO for
 * reading otherwise waits for a writer. Whether it is a regular file is
 * checked on the open descriptor, which cannot change under the check. The
 * read stops one byte after the limit, so a file that grows or lies about its
 * size cannot make it read more.
 */
export const readRegularFile = async (
  path: string,
  limit: number,
): Promise<{ readonly text: string; readonly isTruncated: boolean }> => {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    // Opening a link with O_NOFOLLOW fails with a message about "too many
    // symbolic links", which names the cause badly.
    throw (error as NodeJS.ErrnoException).code === "ELOOP" ? new Error("it is a link") : error;
  });
  try {
    if (!(await file.stat()).isFile()) throw new Error("it is not a regular file");
    const chunks: Array<Buffer> = [];
    let length = 0;
    while (length <= limit) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK, limit + 1 - length));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    const bytes = Buffer.concat(chunks).subarray(0, limit);
    return { text: bytes.toString("utf8"), isTruncated: length > limit };
  } finally {
    await file.close();
  }
};

/**
 * Checks whether the account has an Antigravity login file. Returns false only
 * when `<home>/antigravity-acp` or the token file in it does not exist. Fails
 * with an `AdapterFailed` that says what is wrong when either exists but is
 * not what `agy` writes (a link, a FIFO, a folder where a file should be), and
 * for any I/O error, such as a token file nobody may read. The runner cannot
 * tell whether the user is signed in then, and "not signed in" would send the
 * user to a login that is not needed.
 *
 * The token is opened and its first byte read, nothing more, so the file's
 * secrets stay out of memory. See `readRegularFile` for how it is opened.
 */
export const hasTokenFile = (home: string): Effect.Effect<boolean, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      const appData = join(home, APP_DATA_DIR);
      try {
        if (!(await lstat(appData)).isDirectory()) {
          throw new Error(`${APP_DATA_DIR} is not a real folder`);
        }
        await readRegularFile(join(appData, TOKEN_FILE), 0);
        return true;
      } catch (error) {
        if (isMissingPath(error)) return false;
        throw error;
      }
    },
    catch: (error) =>
      buildAdapterFailed(
        `Could not look for the ${ANTIGRAVITY_NAME} login on this runner: ${describeFileFailure(error)}`,
      ),
  });

/**
 * Reads the account's email address from the token file. Returns undefined
 * when there is no email to read, and never fails. That covers a missing
 * file, a link, anything that is not a regular file, a file over 64 KiB, text
 * that is not JSON, a missing or empty `id_token_email`, and any I/O error.
 *
 * The file also holds the account's secrets, so only that one field is
 * decoded, and nothing of the file's text goes to a log or an error. See
 * `readRegularFile` for how the file is opened and why the read is capped.
 */
export const readSignedInEmail = (home: string): Effect.Effect<string | undefined> =>
  Effect.promise(async (): Promise<string | undefined> => {
    try {
      if (!(await isRealFolder(join(home, APP_DATA_DIR)))) return undefined;
      const { text, isTruncated } = await readRegularFile(
        join(home, APP_DATA_DIR, TOKEN_FILE),
        TOKEN_FILE_LIMIT,
      );
      if (isTruncated) return undefined;
      return decodeTokenFile(text).id_token_email;
    } catch {
      return undefined;
    }
  });

/** The start of the name of a log folder, directly in the Harness Home. */
const LOG_FOLDER_PREFIX = "hercule-log-";

/**
 * Makes an empty folder for the log of one `agy` process, readable by the
 * runner's user only (mode 0700), directly in the Harness Home, and returns
 * its path. Throws when the folder cannot be made.
 *
 * `agy` writes its log where `--log-file` says. Without it the log goes to
 * `antigravity-acp/log/` and stays there for good, with the account's email in
 * it. The folder is in the Harness Home, not in the system's temporary folder,
 * because the `agy` processes of an account keep nothing outside its Harness
 * Home.
 */
export const createLogFolder = (home: string): string => mkdtempSync(join(home, LOG_FOLDER_PREFIX));

/**
 * Makes a log folder with `createLogFolder` and removes it, with everything in
 * it, when the scope closes. A failed removal is logged as a warning with the
 * reason the operating system gave and nothing of the folder's contents. Fails
 * with an `AdapterFailed` when the folder cannot be made. A runner that
 * crashes leaves the folder behind, and nothing removes it later.
 */
export const makeLogFolder = (home: string): Effect.Effect<string, AdapterFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => createLogFolder(home),
      catch: (error) =>
        buildAdapterFailed(
          `Could not make a log folder for ${ANTIGRAVITY_NAME} on this runner: ${describeFileFailure(error)}`,
        ),
    }),
    (folder) =>
      Effect.tryPromise(() => rm(folder, { recursive: true, force: true })).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Could not remove a log folder of ${ANTIGRAVITY_NAME}: ${describeFileFailure(error.cause)}`,
          ),
        ),
      ),
  );

/**
 * Makes the working folder of the probe's conversation, `<home>/hercule-probe`,
 * with mode 0700 when it is missing, and returns its path. Fails with an
 * `AdapterFailed` when the folder cannot be made, or when something that is not
 * a real folder, such as a link or a file, is in its place.
 *
 * The folder is fixed, not new for each probe, because `agy` adds a file below
 * `implicit/` for every new working folder it sees, and nothing removes it.
 */
export const makeProbeFolder = (home: string): Effect.Effect<string, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      const folder = join(home, PROBE_FOLDER);
      try {
        await mkdir(folder, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!(await isRealFolder(folder))) throw new Error("it is not a folder");
      return folder;
    },
    catch: (error) =>
      buildAdapterFailed(
        `Could not make the working folder for the ${ANTIGRAVITY_NAME} check on this runner: ${describeFileFailure(error)}`,
      ),
  });

/**
 * Returns the id of the probe's conversation, or undefined when there is none
 * to use. A missing file, and a regular file whose text is not exactly one
 * UUID (empty, too long, anything else), mean none: the probe then makes a new
 * conversation and its id replaces the file. Fails with an `AdapterFailed` for
 * everything else: a folder, a link or a FIFO in the file's place, and any I/O
 * error such as permission denied. The probe could not store a new id over
 * those either, and would make a conversation every time it runs.
 */
export const readProbeConversationId = (
  home: string,
): Effect.Effect<string | undefined, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      try {
        const { text, isTruncated } = await readRegularFile(
          join(home, PROBE_CONVERSATION_FILE),
          PROBE_CONVERSATION_FILE_LIMIT,
        );
        const id = text.trim();
        return isTruncated || !UUID_PATTERN.test(id) ? undefined : id;
      } catch (error) {
        if (isMissingPath(error)) return undefined;
        throw error;
      }
    },
    catch: (error) =>
      buildAdapterFailed(
        `Could not read the conversation of the ${ANTIGRAVITY_NAME} check on this runner: ${describeFileFailure(error)}`,
      ),
  });

/**
 * Stores `id` as the id of the probe's conversation, replacing the one there.
 * The file is written to a temporary file in the Harness Home and then
 * renamed, so a reader never sees half of it. Fails with an `AdapterFailed`
 * when `id` is not a UUID, before anything is written, or when the file cannot
 * be written.
 */
export const writeProbeConversationId = (
  home: string,
  id: string,
): Effect.Effect<void, AdapterFailed> =>
  UUID_PATTERN.test(id)
    ? Effect.try({
        try: () => writeFileAtomically(join(home, PROBE_CONVERSATION_FILE), `${id}\n`),
        catch: (error) =>
          buildAdapterFailed(
            `Could not remember the conversation of the ${ANTIGRAVITY_NAME} check on this runner: ${describeFileFailure(error)}`,
          ),
      })
    : Effect.fail(
        buildAdapterFailed(
          `${ANTIGRAVITY_NAME} gave a conversation id that is not a UUID, so the check cannot keep that conversation`,
        ),
      );

/**
 * Deletes the files of one Antigravity conversation: `conversations/<id>.db`
 * with its `-wal` and `-shm` files, the file `annotations/<id>.pbtxt`, and the
 * folder `brain/<id>/`, all below `<home>/antigravity-acp`. Succeeds when
 * there is nothing to delete. Fails with an `AdapterFailed` when
 * `nativeSessionId` is not a UUID, before anything is touched, or when a file
 * cannot be removed.
 *
 * `agy` has no call that deletes a conversation, so the files are removed
 * directly. The app data folder, `conversations`, `annotations` and `brain`
 * must each be a real folder, not a link, or nothing below it is deleted. The
 * files `agy` shares between all conversations of the account are never
 * touched: `conversation_summaries.db`, `jetbox_summaries_proto.pb`,
 * `implicit/` and the token file.
 */
export const deleteSessionFiles = (
  home: string,
  nativeSessionId: string,
): Effect.Effect<void, AdapterFailed> =>
  removeSessionFiles(nativeSessionId, UUID_PATTERN, async () => {
    const appData = join(home, APP_DATA_DIR);
    if (!(await isRealFolder(appData))) return [];
    const paths: Array<string> = [];
    const conversations = join(appData, "conversations");
    if (await isRealFolder(conversations)) {
      for (const suffix of [".db", ".db-wal", ".db-shm"]) {
        paths.push(join(conversations, `${nativeSessionId}${suffix}`));
      }
    }
    const annotations = join(appData, "annotations");
    if (await isRealFolder(annotations)) paths.push(join(annotations, `${nativeSessionId}.pbtxt`));
    const brain = join(appData, "brain");
    if (await isRealFolder(brain)) paths.push(join(brain, nativeSessionId));
    return paths;
  });
