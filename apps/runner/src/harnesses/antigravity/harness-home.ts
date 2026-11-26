/**
 * The files Google's `agy` keeps in an account's Harness Home. The Harness
 * Home is what the runner passes to `agy` as `--gemini-dir`, and everything
 * `agy` writes that matters here is below `<home>/antigravity-acp/`: the
 * login file, and the files of each conversation.
 *
 * Every path below `<home>` is checked without following links, so a link
 * placed in the Harness Home is never read or deleted through. This guards
 * against stale or misplaced links only. It does not protect against another
 * process of the same user that swaps paths while this code runs.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AdapterFailed } from "@hercule/protocol";
import { buildAdapterFailed } from "../adapter-error-builders";
import {
  describeFileFailure,
  isMissingPath,
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

/**
 * What a plain email address looks like: one `@` with text on both sides, no
 * whitespace and no control or format characters (the format characters
 * include the ones that reverse the direction of text). Up to 254 characters.
 */
const PLAIN_EMAIL = /^[^\s@\p{Cc}\p{Cf}]+@[^\s@\p{Cc}\p{Cf}]+$/u;
const MAX_EMAIL_LENGTH = 254;

/** The one field of the token file that `readLoginFile` decodes. */
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

const isPlainEmail = (email: string): boolean =>
  email.length <= MAX_EMAIL_LENGTH && PLAIN_EMAIL.test(email);

/**
 * Reads the account's login file. Returns undefined when the account has none:
 * `<home>/antigravity-acp` or the token file in it does not exist. Otherwise
 * returns the email address the file names, which is undefined when there is
 * no email to read: text that is not JSON, a missing or empty `id_token_email`,
 * a file over 64 KiB, or an `id_token_email` that is not a plain address (see
 * `PLAIN_EMAIL`). The email becomes the account's identity, which is shown to
 * the user and compared between two reads, so text that could hide or reorder
 * itself must not pass for one.
 *
 * Fails with an `AdapterFailed` that says what is wrong when the app data
 * folder or the token file exists but is not what `agy` writes (a link, a
 * FIFO, a folder where a file should be), and for any I/O error, such as a
 * token file nobody may read. The runner cannot tell whether the user is
 * signed in then, and "not signed in" would send the user to a login that is
 * not needed.
 *
 * The file also holds the account's secrets, so only the one field is decoded,
 * and nothing of the file's text goes to a log or an error. See
 * `readRegularFile` for how the file is opened and why the read is capped.
 */
export const readLoginFile = (
  home: string,
): Effect.Effect<{ readonly email: string | undefined } | undefined, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      const appData = join(home, APP_DATA_DIR);
      try {
        if (!(await lstat(appData)).isDirectory()) {
          throw new Error(`${APP_DATA_DIR} is not a real folder`);
        }
        const { text, isTruncated } = await readRegularFile(
          join(appData, TOKEN_FILE),
          TOKEN_FILE_LIMIT,
        );
        if (isTruncated) return { email: undefined };
        try {
          const email = decodeTokenFile(text).id_token_email;
          return { email: isPlainEmail(email) ? email : undefined };
        } catch {
          return { email: undefined };
        }
      } catch (error) {
        if (isMissingPath(error)) return undefined;
        throw error;
      }
    },
    catch: (error) =>
      buildAdapterFailed(
        `Could not look for the login file of this account on this runner: ${describeFileFailure(error)}`,
      ),
  });

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
