/**
 * The files Google's `agy` keeps in an account's Harness Home. The Harness
 * Home is what the runner passes to `agy` as `--gemini-dir`, and everything
 * `agy` writes that matters here is below `<home>/antigravity-acp/`.
 *
 * Every path below `<home>` is checked without following links, so a link
 * placed in the Harness Home is never read or deleted through. This guards
 * against stale or misplaced links only. It does not protect against another
 * process of the same user that swaps paths while this code runs.
 */
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { AdapterFailed } from "@hercule/protocol";
import { buildAdapterFailed } from "../adapter-error-builders";
import {
  describeFileFailure,
  isRealFolder,
  removeSessionFiles,
  UUID_PATTERN,
} from "../session-files";

/** The folder in the Harness Home where `agy` keeps its own data. */
export const APP_DATA_DIR = "antigravity-acp";

const TOKEN_FILE = "antigravity-oauth-token";

/** The most bytes of the token file that are read. A real one is well under 4 KiB. */
const TOKEN_FILE_LIMIT = 64 * 1024;

/** How many bytes `readRegularFile` asks for in one read. */
const READ_CHUNK = 64 * 1024;

/** The one field of the token file that `readSignedInEmail` decodes. */
const TokenFile = Schema.fromJsonString(Schema.Struct({ id_token_email: Schema.NonEmptyString }));
const decodeTokenFile = Schema.decodeUnknownSync(TokenFile);

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

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
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
 * Checks whether the account has an Antigravity login file. Returns true only
 * when `<home>/antigravity-acp` is a real folder and the token file in it is
 * a regular file. A missing file, a link, a folder or a FIFO gives false.
 * Fails with an `AdapterFailed` for any other I/O error, such as permission
 * denied: the runner cannot tell whether the user is signed in, and "not
 * signed in" would send the user to a login that is not needed.
 */
export const hasTokenFile = (home: string): Effect.Effect<boolean, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await isRealFolder(join(home, APP_DATA_DIR)))) return false;
      try {
        return (await lstat(join(home, APP_DATA_DIR, TOKEN_FILE))).isFile();
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    catch: (error) =>
      buildAdapterFailed(
        `Could not look for the Antigravity login on this runner: ${describeFileFailure(error)}`,
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

/**
 * Makes an empty folder, readable by the runner's user only (mode 0700),
 * directly in the Harness Home, and returns its path. Removes the folder with
 * everything in it when the scope closes. A failed removal is logged as a
 * warning with the reason the operating system gave and nothing of the
 * folder's contents. Fails with an `AdapterFailed` when the folder cannot be
 * made.
 *
 * The folder is in the Harness Home, not in the system's temporary folder,
 * because the `agy` processes of an account keep nothing outside its Harness
 * Home. A runner that crashes leaves the folder behind, and nothing removes
 * it later.
 */
export const makeScratchFolder = (
  home: string,
): Effect.Effect<string, AdapterFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(home, "hercule-scratch-")),
      catch: (error) =>
        buildAdapterFailed(
          `Could not make a scratch folder for Antigravity on this runner: ${describeFileFailure(error)}`,
        ),
    }),
    (folder) =>
      Effect.tryPromise(() => rm(folder, { recursive: true, force: true })).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Could not remove a scratch folder of Antigravity: ${describeFileFailure(error.cause)}`,
          ),
        ),
      ),
  );

/**
 * Deletes the files of one Antigravity conversation: `conversations/<id>.db`
 * with its `-wal` and `-shm` files, and the folder `brain/<id>/`, all below
 * `<home>/antigravity-acp`. Succeeds when there is nothing to delete. Fails
 * with an `AdapterFailed` when `nativeSessionId` is not a UUID, before
 * anything is touched, or when a file cannot be removed.
 *
 * `agy` has no call that deletes a conversation, so the files are removed
 * directly. The app data folder, `conversations` and `brain` must each be a
 * real folder, not a link, or nothing below it is deleted. The files `agy`
 * shares between all conversations of the account are never touched:
 * `conversation_summaries.db`, `jetbox_summaries_proto.pb`, `implicit/` and
 * the token file.
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
    const brain = join(appData, "brain");
    if (await isRealFolder(brain)) paths.push(join(brain, nativeSessionId));
    return paths;
  });
