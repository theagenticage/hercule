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
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

/** The name the user knows the harness by. */
export const ANTIGRAVITY_NAME = "Antigravity";

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

/** The paths one conversation's plan files can be reported under. Each list holds every spelling of one file. */
export interface PlanFilePaths {
  readonly task: ReadonlyArray<string>;
  readonly plan: ReadonlyArray<string>;
}

/**
 * Returns the paths of a conversation's two plan files, `task.md` and
 * `implementation_plan.md`, in `<home>/antigravity-acp/brain/<nativeSessionId>/`.
 * Each path is absolute and normalized. On macOS, `/tmp`, `/var` and `/etc` are
 * links to `/private/tmp`, `/private/var` and `/private/etc`, and `agy` reports
 * the same file under either spelling, so each list then holds both. On any
 * other platform each list holds one path. `platform` is a parameter so a test
 * can ask for the macOS answer on any machine.
 */
export const buildPlanFilePaths = (
  home: string,
  nativeSessionId: string,
  platform: NodeJS.Platform = process.platform,
): PlanFilePaths => {
  const folder = resolve(home, APP_DATA_DIR, "brain", nativeSessionId);
  const spellings = (path: string): ReadonlyArray<string> => {
    if (platform !== "darwin") return [path];
    if (/^\/private\/(tmp|var|etc)(\/|$)/.test(path)) return [path, path.slice("/private".length)];
    return /^\/(tmp|var|etc)(\/|$)/.test(path) ? [path, `/private${path}`] : [path];
  };
  return {
    task: spellings(join(folder, "task.md")),
    plan: spellings(join(folder, "implementation_plan.md")),
  };
};

/** The file `agy` reads its hooks from at every tool call. */
const HOOKS_FILE_PATH = join("config", "hooks.json");

/** The file `agy` reads its MCP servers from. `agy` creates it empty. */
const MCP_CONFIG_PATH = join("config", "mcp_config.json");

/**
 * The paths below the Harness Home that Hercule removes at every `agy`
 * start, with the reason for each. Every session of an account shares the
 * Harness Home, and `agy` reads these in every session, so what an earlier
 * session left there would silently change every later one, in any workspace.
 *
 * - `antigravity-acp/settings.json`: `toolPermission` in it works under `agy
 *   acp`, and a tool permission would change every session of the account.
 * - `config/plugins`: `agy` loads a plugin from this folder live, and a
 *   plugin's `hooks.json` can approve a command without asking.
 * - `config/plugins.json`: `agy`'s docs name it as the list of plugin
 *   folders. Unmeasured: removed in case `agy` reads it from here.
 * - `skills`, `config/skills`, `antigravity-acp/skills`: the skills in these
 *   folders load into every session and are read again at each prompt.
 * - `config/skills.json`: lists folders of skills, which may be absolute paths
 *   anywhere on the machine, and which load into every session.
 * - `GEMINI.md`, `AGENTS.md`, `config/GEMINI.md`, `config/AGENTS.md`: the
 *   instructions in them are added to every session and read again at each
 *   prompt.
 * - `config/rules`: the `always_on` rules in this folder apply to every
 *   session.
 */
const PATHS_TO_REMOVE: ReadonlyArray<string> = [
  join(APP_DATA_DIR, "settings.json"),
  join("config", "plugins"),
  join("config", "plugins.json"),
  "skills",
  join("config", "skills"),
  join(APP_DATA_DIR, "skills"),
  join("config", "skills.json"),
  "GEMINI.md",
  "AGENTS.md",
  join("config", "GEMINI.md"),
  join("config", "AGENTS.md"),
  join("config", "rules"),
];

/** A file below the Harness Home that Hercule replaces with exactly this content. */
interface FileToWrite {
  readonly path: string;
  readonly content: string;
}

/**
 * Returns the files below the Harness Home that Hercule writes at every `agy`
 * start, with the reason for each.
 *
 * - `config/hooks.json` holds `hooksFile`. `agy` runs the hooks in it at every
 *   tool call, so a hook that approves every command would loosen every later
 *   session. The one hook allowed is Hercule's pre-tool hook. The file is
 *   never removed.
 * - `config/mcp_config.json` is empty. `agy` loads every MCP server in it in
 *   every session, and with no server in the session's own request such a
 *   server would connect. `agy` creates it as an empty file, so it is emptied,
 *   not removed.
 */
const buildFilesToWrite = (hooksFile: string): ReadonlyArray<FileToWrite> => [
  { path: HOOKS_FILE_PATH, content: hooksFile },
  { path: MCP_CONFIG_PATH, content: "" },
];

/**
 * Returns the absolute path of every file and folder Hercule owns in the
 * Harness Home `home`, so that the pre-tool hook can deny the agent every
 * change to them.
 */
export const listOwnedPaths = (home: string): ReadonlyArray<string> =>
  [...PATHS_TO_REMOVE, ...buildFilesToWrite("").map((file) => file.path)].map((path) =>
    join(home, path),
  );

/**
 * Returns the folders that hold the owned paths, from the Harness Home `home`
 * down: the home itself and every folder between it and an owned path.
 */
const listOwnedFolders = (home: string): ReadonlyArray<string> => {
  const folders = new Set([home]);
  for (const path of [...PATHS_TO_REMOVE, HOOKS_FILE_PATH, MCP_CONFIG_PATH]) {
    for (let at = dirname(path); at !== "."; at = dirname(at)) folders.add(join(home, at));
  }
  return [...folders];
};

/**
 * Fails with `AdapterFailed` naming the folder when the Harness Home `home`,
 * or a folder between it and an owned path, is a link or a file instead of a
 * real folder. Changing an owned path through a link would change a file
 * outside the Harness Home. A folder that does not exist yet passes: it is
 * created as a real folder.
 *
 * This check runs before the changes. A process of the same user that swaps a
 * folder for a link while the changes run is not prevented.
 */
const checkOwnedFolders = (home: string): Effect.Effect<void, AdapterFailed> =>
  Effect.forEach(
    listOwnedFolders(home),
    (folder) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return (await lstat(folder)).isDirectory();
          } catch (error) {
            if (isMissingPath(error)) return true;
            throw error;
          }
        },
        catch: (error) =>
          buildAdapterFailed(
            `${ANTIGRAVITY_NAME} could not start, because Hercule could not check ${folder}: ${describeFileFailure(error)}`,
          ),
      }).pipe(
        Effect.filterOrFail(
          (isFolder) => isFolder,
          () =>
            buildAdapterFailed(
              `${ANTIGRAVITY_NAME} could not start, because ${folder} is a link or a file, not a folder. Hercule changes files in it that ${ANTIGRAVITY_NAME} reads in every session, and through a link it would change files outside the Harness Home. Remove it, and the account starts again.`,
            ),
        ),
      ),
    { discard: true },
  );

/**
 * Deletes the file, link or folder (with all it holds) at `path`. A link is
 * deleted, never followed. Returns whether there was anything to delete.
 */
const removePath = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
  await rm(path, { recursive: true, force: true });
  return true;
};

/**
 * Makes `path` a regular file that holds exactly `content`: writes the content
 * to a file beside it, then renames that file over `path`, so a link or a file
 * in its place is replaced and nothing is written through a link. A reader
 * sees the old content or the new, never half of it. Creates the folder when
 * it is missing. Removes the temporary file when the write or the rename
 * fails. Returns whether `path` held anything else. Throws when a folder is at
 * `path`, because replacing a folder would delete what is in it.
 */
const replaceWithFile = async (path: string, content: string): Promise<boolean> => {
  const isAsWanted = await readRegularFile(path, Buffer.byteLength(content)).then(
    ({ text, isTruncated }) => text === content && !isTruncated,
    () => false,
  );
  if (isAsWanted) return false;
  const existing = await lstat(path).catch(() => undefined);
  if (existing?.isDirectory() === true) {
    throw new Error("it is a folder, and Hercule needs a file there. Remove the folder");
  }
  await mkdir(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(next, content, { flag: "wx" });
    await rename(next, path);
  } catch (error) {
    await rm(next, { force: true });
    throw error;
  }
  return true;
};

/**
 * Brings the Harness Home `home` to what Hercule owns: removes every path in
 * `PATHS_TO_REMOVE` and writes every file in `buildFilesToWrite(hooksFile)`.
 * Logs each path it had to change. A path that is already as wanted (missing,
 * or a file with the wanted content) is left alone and not logged. A link at
 * an owned path is removed or replaced, never followed. Before any change,
 * `checkOwnedFolders` checks the folders above the owned paths. Fails with
 * `AdapterFailed` naming the path when it cannot be changed, because then
 * Hercule cannot tell what `agy` would load.
 *
 * What stays possible: a process that writes one of these paths while another
 * session of the same account runs. That needs code execution as the runner's
 * user, which already reaches everything this user can. The agent's own edit
 * tools are denied these paths by the pre-tool hook.
 */
export const resetOwnedHomePaths = (
  home: string,
  hooksFile: string,
): Effect.Effect<void, AdapterFailed> => {
  const changes = [
    ...PATHS_TO_REMOVE.map((path) => ({
      path: join(home, path),
      verb: "remove",
      past: "Removed",
      apply: () => removePath(join(home, path)),
    })),
    ...buildFilesToWrite(hooksFile).map(({ path, content }) => ({
      path: join(home, path),
      verb: "write",
      past: "Wrote",
      apply: () => replaceWithFile(join(home, path), content),
    })),
  ];
  return checkOwnedFolders(home).pipe(
    Effect.andThen(
      Effect.forEach(
        changes,
        ({ path, verb, past, apply }) =>
          Effect.tryPromise({
            try: apply,
            catch: (error) =>
              buildAdapterFailed(
                `${ANTIGRAVITY_NAME} could not start, because Hercule could not ${verb} ${path}: ${describeFileFailure(error)}`,
              ),
          }).pipe(
            Effect.flatMap((wasChanged) =>
              wasChanged
                ? Effect.logWarning(
                    `${past} ${path}: Hercule owns this path of the Harness Home, because ${ANTIGRAVITY_NAME} reads it in every session of the account.`,
                  )
                : Effect.void,
            ),
          ),
        { discard: true },
      ),
    ),
  );
};
