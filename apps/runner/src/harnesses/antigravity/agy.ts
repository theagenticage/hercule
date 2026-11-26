/**
 * How a process of Google's `agy` is started for one account, and whose login
 * it uses. Every `agy` process of an account (login, version, probe, session)
 * is built here, so that all of them get the same environment and none of
 * them can run as another account.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { openAcpConnection } from "@hercule/acp";
import type {
  AcpConnection,
  AcpError,
  AcpHandlers,
  NewSessionRequest,
  SessionSettings,
} from "@hercule/acp";
import { ANTIGRAVITY_VERSION, VERSION } from "@hercule/home/version";
import { ResumeTranscriptMissing } from "@hercule/protocol";
import type { AccessMode, AdapterError, AdapterFailed, ModelDescriptor } from "@hercule/protocol";
import { describeError } from "../../report";
import {
  buildAdapterFailed,
  buildHarnessLoginMissing,
  buildHarnessNotInstalled,
  buildStartFailure,
} from "../adapter-error-builders";
import type { HarnessRunnerContext } from "../index";
import type { LoginCommand } from "../login";
import { isExecutableNotFound, stopChild } from "../process";
import type { CheckedFramedChild, FramedChild, Run } from "../process";
import { describeFileFailure, isMissingPath } from "../session-files";
import { truncateFact } from "../text";
import { APP_DATA_DIR, readLoginFile, readRegularFile } from "./harness-home";

/** The name the user knows the harness by. */
export const ANTIGRAVITY_NAME = "Antigravity";

/**
 * What a caller opens `agy` for. A session also says how much the agent may do
 * without asking, and carries the request of its conversation: the request is
 * built before `agy` opens, so that `openSignedInAgy` can check that `agy`
 * takes everything the request uses.
 */
export type AgyPurpose =
  | { readonly kind: "probe" }
  | {
      readonly kind: "session";
      readonly accessMode: AccessMode;
      readonly request: NewSessionRequest;
    };

/** What Hercule does at a session start with a path it owns in the Harness Home. */
interface OwnedHomePath {
  /** The path, relative to the Harness Home. */
  readonly path: string;
  /**
   * `remove` deletes a file or a whole folder. `empty` replaces the file with
   * an empty one, which is what `agy` creates itself and may need to find.
   */
  readonly whenStarting: "remove" | "empty";
  /** Why Hercule owns the path, for the log line and the failure message. */
  readonly reason: string;
}

/**
 * The paths of the Harness Home that Hercule owns. Every session of an account
 * shares the Harness Home, and `agy` reads these in every session, so what an
 * earlier session left there would silently change every later one, in any
 * workspace. `resetOwnedHomePaths` resets them all before `agy` runs.
 *
 * - `config/hooks.json`: `agy` runs the hooks in it at every tool call, so a
 *   hook that approves every command would loosen every later session.
 * - `antigravity-acp/settings.json`: `toolPermission` in it works under
 *   `agy acp`. `agy` does not create the file.
 * - `config/mcp_config.json`: `agy` loads every MCP server in it in every
 *   session, and with no server in the session's own request, such a server
 *   would connect. `agy` creates it as an empty file, so it is emptied, not
 *   removed.
 */
const OWNED_HOME_PATHS: ReadonlyArray<OwnedHomePath> = [
  {
    path: join("config", "hooks.json"),
    whenStarting: "remove",
    reason: `Hercule allows no hooks in the Harness Home, because ${ANTIGRAVITY_NAME} runs them for every session of the account.`,
  },
  {
    path: join(APP_DATA_DIR, "settings.json"),
    whenStarting: "remove",
    reason: `Hercule owns the settings of the Harness Home, because a tool permission in them would change every session of the account.`,
  },
  {
    path: join("config", "mcp_config.json"),
    whenStarting: "empty",
    reason: `Hercule gives ${ANTIGRAVITY_NAME} its MCP servers in each session, and a server in this file would load in every session of the account.`,
  },
];

/**
 * Applies `OWNED_HOME_PATHS` to the Harness Home `home`, and logs each path it
 * had to change. A path that is already as wanted (missing for `remove`, an
 * empty file for `empty`) is left alone and not logged. A link is removed or
 * replaced, never followed. Fails with `AdapterFailed` naming the path when it
 * cannot be changed, because then Hercule cannot tell what `agy` would load.
 *
 * What stays possible: a session that writes one of these paths while another
 * session of the same account runs. That needs code execution as the runner's
 * user, which already reaches everything this user can.
 */
const resetOwnedHomePaths = (home: string): Effect.Effect<void, AdapterFailed> =>
  Effect.forEach(
    OWNED_HOME_PATHS,
    (owned) => {
      const path = join(home, owned.path);
      return Effect.tryPromise({
        try: () =>
          owned.whenStarting === "remove" ? removePath(path) : replaceWithEmptyFile(path),
        catch: (error) =>
          buildAdapterFailed(
            `${ANTIGRAVITY_NAME} could not start, because Hercule could not ${owned.whenStarting === "remove" ? "remove" : "empty"} ${path}: ${describeFileFailure(error)}`,
          ),
      }).pipe(
        Effect.flatMap((wasChanged) =>
          wasChanged
            ? Effect.logWarning(
                `${owned.whenStarting === "remove" ? "Removed" : "Emptied"} ${path}: ${owned.reason}`,
              )
            : Effect.void,
        ),
      );
    },
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
 * Makes `path` an empty regular file: writes an empty file beside it, then
 * renames it over `path`, so a link or a file in its place is replaced and
 * nothing is written through a link. Creates the folder when it is missing.
 * Returns whether `path` held anything else than an empty regular file.
 */
const replaceWithEmptyFile = async (path: string): Promise<boolean> => {
  const wasEmpty = await readRegularFile(path, 1).then(
    ({ text }) => text === "",
    () => false,
  );
  if (wasEmpty) return false;
  await mkdir(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(next, "", { flag: "wx" });
  await rename(next, path);
  return true;
};

/**
 * Returns the id of the `agy` mode that matches a Hercule Access Mode, or
 * undefined for `full-access`, which `agy` has no mode for: a session in it
 * starts `agy` with `--dangerously-skip-permissions` instead (see
 * `openSignedInAgy`) and keeps the default mode.
 */
export const chooseAgyMode = (accessMode: Exclude<AccessMode, "auto">): string | undefined => {
  switch (accessMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
      return "accept-edits";
    case "full-access":
      return undefined;
  }
};

/** Spawns an `agy` process in the folder `cwd`. */
export type AgySpawn = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
) => CheckedFramedChild;

/** What the adapter needs from the machine: how to start `agy`, and how to run a command to its end. */
export interface AgySeam {
  readonly spawn: AgySpawn;
  readonly run: Run;
}

/** A conversation `agy` opened: its id, the settings it returned for it, and whether Google holds the account. */
export interface OpenedConversation {
  readonly id: string;
  readonly settings: SessionSettings;
  /**
   * Whether a worker log shows that Google holds the account for
   * verification. The call does not fail for it, so that the caller can store
   * the conversation first. The caller decides with `checkAccountUsable`.
   */
  readonly isHeldByGoogle: boolean;
}

/** An open connection to the `agy` process of an account that is signed in. */
export interface SignedInAgy {
  readonly connection: AcpConnection;
  /** The name of the account's plan, such as "Antigravity Starter Quota". Undefined when `agy` gave none. */
  readonly planLabel: string | undefined;
  /**
   * Starts a new conversation with the request of the purpose the process was
   * opened for. Fails with `HarnessLoginMissing` when `agy`
   * says the account is not signed in, with an `AdapterFailed` when the new
   * worker process that serves the conversation does not use this account's
   * own login, and with the `AcpError` of the call for any other failure. It
   * does not fail for an account that cannot be used (see
   * `OpenedConversation.isHeldByGoogle` and `checkAccountUsable`).
   *
   * `onReply`, when given, is called with the id of the new conversation as
   * soon as `agy` replies, in the same step that cannot be interrupted, and
   * before the check of the worker's login. A caller that keeps the id there
   * never loses a conversation to a failed check. When `onReply` fails, so
   * does the call.
   */
  readonly newConversation: (
    onReply?: (id: string) => Effect.Effect<void, AdapterError>,
  ) => Effect.Effect<OpenedConversation, AcpError | AdapterError>;
  /**
   * Resumes the conversation `nativeSessionId`, with the same request as
   * `newConversation`. Fails like `newConversation`, and with
   * `ResumeTranscriptMissing` when `agy` has no such conversation
   * (`isConversationMissing`). `onReply` works as for `newConversation`, with
   * the id of the resumed conversation. A caller that starts reading the
   * conversation's updates there knows that every update before the reply was
   * the resume's replay, and every one after it is not.
   */
  readonly resumeConversation: (
    nativeSessionId: string,
    onReply?: (id: string) => Effect.Effect<void, AdapterError>,
  ) => Effect.Effect<OpenedConversation, AcpError | AdapterError>;
}

/**
 * The three phrases of a worker's log that Hercule looks for. Each is a
 * dependency on the wording of `agy`, or of Google's reply that `agy` logs,
 * and a release that words it differently breaks the check that reads it. The
 * log also holds the account's email address. Its text never leaves
 * `readWorkerLogSignals`, and nothing of it leaves the runner.
 *
 * A line of the log has a header (level letter, date, time, thread id and
 * `file:line]`) and then the message. The first two phrases must start or
 * be the whole message, so that a line that only mentions them, such as one
 * that echoes a path, does not count.
 *
 * `FILE_STORAGE_MESSAGE` is what a worker writes when it keeps its login in
 * the file of the Harness Home. It shows that the process uses this account's
 * login and not the machine's keychain. It is the whole message.
 */
const FILE_STORAGE_MESSAGE = "Using file-based token storage because SSH session detected";

/**
 * The start of the message a worker writes when `agy` could not reach Google
 * to check an expired login. `agy` answers that case exactly as it answers a
 * missing login, so this line is the only way to tell them apart. The reason
 * follows it on the same line.
 */
const NETWORK_ERROR_MESSAGE_START = "keyringAuth: token validation failed due to network error";

/** The header of a log line, such as `I1125 16:54:06.115838      87 file.go:176] `. */
const LOG_LINE_HEADER = /^[IWEF]\d{4} \d{2}:\d{2}:\d{2}\.\d+ +\d+ \S+:\d+\] /;

/** Returns the message of a log line, or undefined for a line that has no header. */
const readLogMessage = (line: string): string | undefined => {
  const header = LOG_LINE_HEADER.exec(line);
  return header === null ? undefined : line.slice(header[0].length).trimEnd();
};

/**
 * The reason in the 403 reply of Google that a worker logs when Google holds
 * the account until it is verified. Measured on a held account: the key and
 * the value in quotes, as in the JSON of the reply.
 */
const HELD_BY_GOOGLE_PHRASE = /"reason":\s*"VALIDATION_REQUIRED"/;

/** The most bytes of one worker log that are read. A line that comes later is not found. */
const LOG_LIMIT = 1024 * 1024;

/** The name of the front process's own log. `agy` writes each worker's log to `<LOG_NAME>.<pid>`. */
const LOG_NAME = "agy.log";

/** The start of the name of a log folder, directly in the Harness Home. */
const LOG_FOLDER_PREFIX = "hercule-log-";

/**
 * How long a failed start waits for the last words of the process on stderr.
 * A process that has exited has ended its stderr at once. A descendant that
 * keeps the pipe open must not hold up the failure.
 */
const STDERR_WAIT = Duration.seconds(1);

/** The number of lines from the end of stderr that a failed start repeats. */
const STDERR_LINES = 5;

/**
 * Returns the environment of an `agy` process of this account: the context's
 * environment without the variables `agy` reads settings and credentials from,
 * and with the two variables below.
 *
 * - The variables starting with `GEMINI_`, `GOOGLE_` and `AGY_` are removed,
 *   because `agy` can sign in with an API key or with the machine's
 *   application default credentials, and nothing of the runner's own may
 *   stand in for the account's login.
 * - `SSH_CONNECTION` makes `agy` keep its login in a file of the Harness
 *   Home, which is what separates accounts on one machine, and open no
 *   browser. Without it `agy` uses one keychain entry for the whole machine.
 * - `AGY_CLI_DISABLE_AUTO_UPDATE` must be exactly `true`. The value `1` has no
 *   effect, and `agy` then replaces its own binary in the background.
 *
 * - `TMPDIR` is `tempFolder` when one is given. In its `default` mode `agy`
 *   lets the agent write under the system's temporary folder without asking,
 *   and `agy` finds that folder through `$TMPDIR`. Pointing it at a private
 *   folder (`makeAgyTempFolder`) makes that folder the only place the agent
 *   writes to unasked. The sign-in and `agy --version` run no tools, so they
 *   pass no folder and keep the runner's own `TMPDIR`.
 *
 * `HOME` stays: `agy` writes nothing below it when it is given `--gemini-dir`
 * and `--log-file`.
 */
const buildAgyEnv = (
  ctx: HarnessRunnerContext,
  tempFolder?: string,
): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(ctx.env)) {
    if (!/^(GEMINI_|GOOGLE_|AGY_)/.test(name)) env[name] = value;
  }
  env["SSH_CONNECTION"] = "127.0.0.1 0 127.0.0.1 0";
  env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true";
  if (tempFolder !== undefined) env["TMPDIR"] = tempFolder;
  return env;
};

/**
 * Returns the flags that tie an `agy` process to one account and one log:
 * where `agy` keeps everything, the folder in it, and the log file. Without
 * `--log-file` `agy` keeps its log in the Harness Home for good, with the
 * account's email address in it.
 */
const buildAccountFlags = (home: string, logFolder: string): ReadonlyArray<string> => [
  "--gemini-dir",
  home,
  "--app-data-dir",
  APP_DATA_DIR,
  "--log-file",
  join(logFolder, LOG_NAME),
];

/**
 * Makes an empty folder for the log of the sign-in, readable by the runner's
 * user only (mode 0700), directly in the Harness Home, and returns its path.
 * The login removes it when it ends. Throws when the folder cannot be made.
 *
 * The folder is in the Harness Home, not in the system's temporary folder,
 * because the `agy` processes of an account keep nothing outside its Harness
 * Home.
 */
const createLoginLogFolder = (home: string): string => mkdtempSync(join(home, LOG_FOLDER_PREFIX));

/**
 * Makes an empty folder with `mkdtemp` at `prefix`, readable by the runner's
 * user only (mode 0700), and removes it with everything in it when the scope
 * closes. A failed removal is logged as a warning with the reason the
 * operating system gave and nothing of the folder's contents. Fails with an
 * `AdapterFailed` that names `what` when the folder cannot be made. A runner
 * that crashes leaves the folder behind, and nothing removes it later.
 */
const makeScopedFolder = (
  prefix: string,
  what: string,
): Effect.Effect<string, AdapterFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => mkdtempSync(prefix),
      catch: (error) =>
        buildAdapterFailed(
          `Could not make ${what} for ${ANTIGRAVITY_NAME} on this runner: ${describeFileFailure(error)}`,
        ),
    }),
    (folder) =>
      Effect.tryPromise(() => rm(folder, { recursive: true, force: true })).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Could not remove ${what} of ${ANTIGRAVITY_NAME}: ${describeFileFailure(error.cause)}`,
          ),
        ),
      ),
  );

/**
 * Makes an empty folder for the log of a session or probe process, like
 * `createLoginLogFolder`, and removes it when the scope closes (see
 * `makeScopedFolder`).
 */
const makeSessionLogFolder = (home: string): Effect.Effect<string, AdapterFailed, Scope.Scope> =>
  makeScopedFolder(join(home, LOG_FOLDER_PREFIX), "a log folder");

/**
 * Makes the temporary folder of one `agy` process and removes it with
 * everything in it when the scope closes, so the agent's temporary files end
 * with the process. `buildAgyEnv` hands it to `agy` as `TMPDIR`, which is
 * what makes it the only folder the agent may write to without asking.
 *
 * The path is short on purpose: programs the agent runs create Unix sockets
 * below `TMPDIR`, and a socket path of more than about 104 bytes fails on
 * macOS, where the system's temporary folder is already long.
 */
const makeAgyTempFolder = (): Effect.Effect<string, AdapterFailed, Scope.Scope> =>
  makeScopedFolder(join(tmpdir(), "hercule-agy-"), "a temporary folder");

/**
 * Builds the command that signs the account in. `agy` prints a link, reads one
 * code from stdin and exits: with 0 when it signed in, with a non-zero code
 * when the code was refused. The exit alone decides (`endsAtExit`).
 *
 * The command logs to a folder of its own in the Harness Home, which is the
 * command's `scratchFolder`. The caller must start the command, which removes
 * the folder when the login ends. Throws when the folder cannot be made.
 */
export const buildLoginCommand = (ctx: HarnessRunnerContext, binary: string): LoginCommand => {
  const logFolder = createLoginLogFolder(ctx.home);
  return {
    command: [binary, "acp", "--login", ...buildAccountFlags(ctx.home, logFolder)],
    env: buildAgyEnv(ctx),
    endsAtExit: true,
    scratchFolder: logFolder,
  };
};

/**
 * Returns the version `agy --version` prints, or null when the command fails
 * or prints nothing. Never fails: a missing binary is an ordinary state. The
 * version needs no login, so an account that is not signed in reports it too.
 */
export const readAgyVersion = (
  run: Run,
  ctx: HarnessRunnerContext,
  binary: string,
): Effect.Effect<string | null> =>
  Effect.map(run([binary, "--version"], buildAgyEnv(ctx)), (ran) => {
    if (ran.code !== 0) return null;
    const version = truncateFact(ran.stdout.trim());
    return version === "" ? null : version;
  });

/**
 * Checks whether `session/new` or `session/resume` was refused because the
 * account is not signed in: the error -32000, "Authentication required".
 */
const isSignInRequired = (error: AcpError): boolean =>
  error.reason === "refused" &&
  error.code === -32000 &&
  (error.harnessMessage ?? "").includes("Authentication required");

/**
 * Checks whether `session/resume` was refused because `agy` has no such
 * conversation, for example because its files are gone: the error -32603 with
 * text that starts "Failed to read session" (measured on a real `agy`). This
 * is a dependency on the wording of `agy`.
 */
const isConversationMissing = (error: AcpError): boolean =>
  error.reason === "refused" &&
  error.code === -32603 &&
  (error.harnessMessage ?? "").includes("Failed to read session");

/**
 * Messages for an account that lists models but has no plan. Google holds an
 * account for verification when its reply says so (`HELD_BY_GOOGLE_PHRASE`).
 * Then `authenticate` gives no plan, `agy` lists the free models, and every
 * prompt answers "Verification Required". With no plan and no such reply, the
 * cause is not known, so the message names what the user can check.
 */
const HELD_BY_GOOGLE_MESSAGE = `Google is holding this account until it is verified ("Verify your account to continue."), so ${ANTIGRAVITY_NAME} cannot use it. Sign in to this Google account in a browser and follow Google's steps; Google explains them at https://support.google.com/accounts?p=al_alert. The sign-in in Hercule is fine and need not be repeated.`;
const NO_PLAN_MESSAGE = `${ANTIGRAVITY_NAME} reported no plan for this account, so it cannot be used. Check this runner's network, then sign in to this Google account in a browser to see whether Google asks for anything.`;

/**
 * Checks that the account that opened a conversation can be used, from the
 * plan `authenticate` gave, the model catalog built from the settings of
 * `session/new` or `session/resume`, and whether Google holds the account
 * (`OpenedConversation.isHeldByGoogle`). Returns the plan name when it can,
 * and the failure that says why when it cannot. The cases look alike from
 * outside, and the user must do something different in each:
 *
 * - No model is listed: `agy` could not reach Google, or Google refused the
 *   login. With a token that has not expired yet, `agy` answers `authenticate`
 *   without asking Google, so the sign-in looks fine.
 * - No plan, and Google holds the account (`HELD_BY_GOOGLE_MESSAGE`).
 *   Signing in again does not help.
 * - No plan, and no sign that Google holds it (`NO_PLAN_MESSAGE`).
 */
export const checkAccountUsable = (
  planLabel: string | undefined,
  models: ReadonlyArray<ModelDescriptor>,
  isHeldByGoogle: boolean,
): Result.Result<string, AdapterFailed> => {
  if (models.length === 0) {
    return Result.fail(
      buildAdapterFailed(
        `${ANTIGRAVITY_NAME} listed no models for this account. The runner may be offline, or Google may have refused the sign-in.`,
      ),
    );
  }
  if (planLabel === undefined) {
    return Result.fail(
      buildAdapterFailed(isHeldByGoogle ? HELD_BY_GOOGLE_MESSAGE : NO_PLAN_MESSAGE),
    );
  }
  return Result.succeed(planLabel);
};

const decodePlan = Schema.decodeUnknownOption(
  Schema.Struct({
    antigravity: Schema.Struct({ tier: Schema.Struct({ name: Schema.String }) }),
  }),
);

/**
 * Returns the plan name in the `_meta` of an `authenticate` reply. Returns
 * undefined when the reply has no plan, has it in another shape, or names it
 * with an empty text.
 */
const readPlanLabel = (meta: unknown): string | undefined => {
  const plan = decodePlan(meta);
  if (Option.isNone(plan)) return undefined;
  const label = truncateFact(plan.value.antigravity.tier.name.trim());
  return label === "" ? undefined : label;
};

const decodeSystemPromptCapability = Schema.decodeUnknownOption(
  Schema.Struct({
    antigravity: Schema.Struct({ systemPrompt: Schema.Struct({ append: Schema.Literal(true) }) }),
  }),
);

/**
 * Checks that the `_meta` of the reply to `initialize` says `agy` takes a
 * system prompt that is added to its own (`antigravity.systemPrompt.append` is
 * true). Anything else, including no `_meta`, is no.
 */
const acceptsAddedSystemPrompt = (meta: unknown): boolean =>
  Option.isSome(decodeSystemPromptCapability(meta));

/** What the worker logs of one `agy` process show. See `readWorkerLogSignals`. */
interface WorkerLogSignals {
  /** The file names of the worker logs, such as `agy.log.4000`. A worker is new when its name is not in an earlier read. */
  readonly workers: ReadonlyArray<string>;
  /** Whether every worker log holds the file-storage line. True when there are no worker logs. */
  readonly allUseOwnLogin: boolean;
  /** Whether a worker log holds the network error line. */
  readonly hasNetworkError: boolean;
  /** Whether a worker log holds Google's reason for holding the account. */
  readonly isHeldByGoogle: boolean;
}

/**
 * Reads the log of every worker process of the `agy` that logs in `folder`
 * (at most 1 MiB of each) and returns only what the logs show: which workers
 * there are, and the three phrases. `agy` starts one worker per session. The
 * front process's own log, `agy.log`, is not a worker's. Fails with an
 * `AdapterFailed` when the folder or a log cannot be read, or a log is not a
 * regular file.
 *
 * A line after the first 1 MiB of a log is not found. See `readRegularFile`
 * for how a log is opened.
 */
const readWorkerLogSignals = (folder: string): Effect.Effect<WorkerLogSignals, AdapterFailed> =>
  Effect.tryPromise({
    try: async () => {
      const prefix = `${LOG_NAME}.`;
      const workers = (await readdir(folder))
        .filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
        .sort();
      let allUseOwnLogin = true;
      let hasNetworkError = false;
      let isHeldByGoogle = false;
      for (const name of workers) {
        const { text } = await readRegularFile(join(folder, name), LOG_LIMIT);
        const lines = text.split("\n");
        const messages = lines.map(readLogMessage);
        if (!messages.some((message) => message === FILE_STORAGE_MESSAGE)) allUseOwnLogin = false;
        if (messages.some((message) => message?.startsWith(NETWORK_ERROR_MESSAGE_START))) {
          hasNetworkError = true;
        }
        if (lines.some((line) => HELD_BY_GOOGLE_PHRASE.test(line))) isHeldByGoogle = true;
      }
      return { workers, allUseOwnLogin, hasNetworkError, isHeldByGoogle };
    },
    catch: (error) =>
      buildAdapterFailed(
        `Could not read the log of ${ANTIGRAVITY_NAME} on this runner: ${describeFileFailure(error)}`,
      ),
  });

/**
 * Reads the stderr of `child` as it arrives. Returns what the last lines were
 * and a promise that resolves when stderr has ended. A pipe nobody reads fills
 * up, and the process then blocks, so it is read from the start, until the
 * process ends.
 */
const drainStderr = (
  child: Pick<FramedChild, "stderr">,
): { readonly lastLines: () => string; readonly ended: Promise<void> } => {
  const lines: Array<string> = [];
  const ended = (async () => {
    try {
      for await (const line of child.stderr) {
        if (line.trim() === "") continue;
        lines.push(truncateFact(line.trim()));
        if (lines.length > STDERR_LINES) lines.shift();
      }
    } catch {
      // A stderr that fails has nothing more to say.
    }
  })();
  return { lastLines: () => lines.join(" "), ended };
};

/**
 * Sends `authenticate` and returns the reply. Fails with the error `failOpening`
 * builds for any failure, except the refusal that tells the user to run
 * `agy acp --login`: the error -32603 with that text. `agy` gives that exact
 * reply for no login, a login Google refused, and an expired login with no
 * network. The worker logs in `folder` tell them apart (see
 * `readWorkerLogSignals`):
 *
 * - A log with the network error: an `AdapterFailed` asking the user to check
 *   the network.
 * - No worker log at all: an `AdapterFailed` that says the reason is unknown,
 *   because with no log nothing separates the cases, and "not signed in" would
 *   send the user to a sign-in they may not need.
 * - Otherwise `HarnessLoginMissing`.
 */
const authenticateAccount = (
  connection: AcpConnection,
  folder: string,
  failOpening: (error: AcpError) => Effect.Effect<never, AdapterError>,
) =>
  connection.authenticate("oauth-personal").pipe(
    Effect.catch((error) =>
      error.reason === "refused" &&
      error.code === -32603 &&
      (error.harnessMessage ?? "").includes("agy acp --login")
        ? Effect.flatMap(readWorkerLogSignals(folder), (signals) => {
            if (signals.workers.length === 0) {
              return Effect.fail(
                buildAdapterFailed(
                  `Could not tell why ${ANTIGRAVITY_NAME} refused the sign-in of this account. Sign in again on this runner. If this keeps happening, check the runner's log.`,
                ),
              );
            }
            return Effect.fail(
              signals.hasNetworkError
                ? buildAdapterFailed(
                    `${ANTIGRAVITY_NAME} could not reach Google to check the sign-in of this account. Check the network of this runner.`,
                  )
                : buildHarnessLoginMissing(ANTIGRAVITY_NAME),
            );
          })
        : failOpening(error),
    ),
  );

/**
 * Starts the `agy` process of an account and signs it in over ACP. Returns the
 * open connection, the account's plan name and the two ways to open a
 * conversation (`SignedInAgy`). `options.purpose` says what the process is for,
 * so that the caller never passes a flag of `agy` itself:
 *
 * - A session in `full-access` starts `agy` with `--dangerously-skip-permissions`.
 *   No other Access Mode does.
 * - A session needs `agy` to take the system prompt as an addition to its own
 *   (`antigravity.systemPrompt.append` in the reply to `initialize`). That is
 *   checked before `authenticate`, so a build of `agy` without it fails with
 *   the same message whether or not the account is signed in. A probe sends
 *   no system prompt and does not check it.
 * - A session whose request names additional directories needs `agy` to take
 *   them. This check comes right after the one above. The request is the one
 *   `newConversation` and `resumeConversation` send, so the check is always
 *   about what is sent. A probe's request has only the working folder and no
 *   MCP servers.
 *
 * Fails with:
 *
 * - `HarnessLoginMissing` when the Harness Home has no login file (nothing is
 *   spawned), or when `agy` says there is no usable login, or Google refused
 *   the one there is.
 * - `HarnessNotInstalled` when the binary does not exist, and `AdapterFailed`
 *   when the Harness Home's login file is not a regular file, when `agy`
 *   cannot be run, cannot be reached over ACP, or cannot reach Google to check
 *   the login, when the reason for a refused sign-in cannot be told, when its
 *   answer is not one of these, and when the process does not use this
 *   account's own login, or (for a session) when `agy` does not report that
 *   it takes an added system prompt, or (for a session whose request has
 *   additional directories) that it takes additional directories.
 *
 * The process runs in `options.cwd`, with its own log in a private folder of
 * the Harness Home. When the scope closes, the connection is closed first, then
 * the process is stopped and awaited, and then its temporary folder and its
 * log folder are removed. The temporary folder is the process's `TMPDIR`: it
 * is the only folder the agent may write to without asking, and the agent's
 * temporary files end with the process (`makeAgyTempFolder`). A
 * failure leaves what was started in place until the scope closes, so the
 * caller runs this in a scope that closes on failure.
 *
 * `agy` answers an `authenticate` it refuses with the same words whether there
 * is no login, Google refused it, or the machine is offline while the access
 * token has expired. Only the process's log tells the last case apart.
 *
 * Without `--process-per-session` `agy` would serve every conversation from
 * one worker, so each worker is checked as it starts: `authenticate`,
 * `session/new` and `session/resume` each start one, and the call that started
 * it is accepted only when its worker log is new and every worker log shows
 * the account's own login. The log of the worker that `authenticate` started
 * alone is not proof for a worker that came later.
 */
export const openSignedInAgy = (
  spawn: AgySpawn,
  ctx: HarnessRunnerContext,
  binary: string,
  options: {
    readonly cwd: string;
    readonly handlers: AcpHandlers;
    readonly purpose: AgyPurpose;
  },
): Effect.Effect<SignedInAgy, AdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    if ((yield* readLoginFile(ctx.home)) === undefined)
      return yield* Effect.fail(buildHarnessLoginMissing(ANTIGRAVITY_NAME));

    // What `agy` is asked in every conversation of this process.
    const request: NewSessionRequest =
      options.purpose.kind === "session"
        ? options.purpose.request
        : { cwd: options.cwd, mcpServers: [] };

    if (options.purpose.kind === "session") {
      yield* resetOwnedHomePaths(ctx.home);
    }

    const folder = yield* makeSessionLogFolder(ctx.home);
    const command = [
      binary,
      "acp",
      "--process-per-session",
      ...(options.purpose.kind === "session" && options.purpose.accessMode === "full-access"
        ? ["--dangerously-skip-permissions"]
        : []),
      ...buildAccountFlags(ctx.home, folder),
    ];
    const tempFolder = yield* makeAgyTempFolder();
    const env = buildAgyEnv(ctx, tempFolder);
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () => spawn(command, env, options.cwd),
        catch: (error) =>
          isExecutableNotFound(error, { binary, cwd: options.cwd })
            ? buildHarnessNotInstalled(ANTIGRAVITY_NAME)
            : buildStartFailure(ANTIGRAVITY_NAME, describeError(error)),
      }),
      (spawned) => stopChild(spawned),
    );
    const stderr = drainStderr(child);

    // Covers the failures of opening the connection and of `authenticate`, the
    // two calls made while the process may still be starting up. A connection
    // that closed then means the process died, and its last words on stderr
    // are the best reason there is. Later calls report their own errors.
    const failOpening = (error: AcpError): Effect.Effect<never, AdapterError> =>
      Effect.gen(function* () {
        if (error.reason === "closed") {
          yield* Effect.timeoutOption(
            Effect.promise(() => stderr.ended),
            STDERR_WAIT,
          );
        }
        const lastLines = stderr.lastLines();
        return yield* Effect.fail(
          buildStartFailure(
            ANTIGRAVITY_NAME,
            error.reason === "closed" && lastLines !== ""
              ? `${error.message} Its last output on stderr was: ${lastLines}`
              : error.message,
          ),
        );
      });

    const connection = yield* openAcpConnection({
      pipes: child,
      clientVersion: VERSION,
      handlers: options.handlers,
    }).pipe(Effect.catch(failOpening));

    if (options.purpose.kind === "session" && !acceptsAddedSystemPrompt(connection.harness.meta)) {
      return yield* Effect.fail(
        buildAdapterFailed(
          `${ANTIGRAVITY_NAME} did not confirm that it takes the instructions of a Hercule session, so Hercule does not start a session with it. This build was tested with agy ${ANTIGRAVITY_VERSION}: if another version is installed, install the tested one on this runner.`,
        ),
      );
    }

    // One check per optional field of the request that `agy` must announce
    // support for.
    if (
      options.purpose.kind === "session" &&
      request.additionalDirectories !== undefined &&
      !connection.harness.acceptsAdditionalDirectories
    ) {
      return yield* Effect.fail(
        buildAdapterFailed(
          `${ANTIGRAVITY_NAME} did not confirm that it takes a session's skills folder (\`additionalDirectories\`), so Hercule does not start a session with it. This build was tested with agy ${ANTIGRAVITY_VERSION}: if another version is installed, install the tested one on this runner.`,
        ),
      );
    }

    if (
      options.purpose.kind === "session" &&
      request.mcpServers.length > 0 &&
      !connection.harness.acceptsHttpMcpServers
    ) {
      return yield* Effect.fail(
        buildAdapterFailed(
          `${ANTIGRAVITY_NAME} did not confirm that it takes MCP servers over HTTP (\`acceptsHttpMcpServers\`), so Hercule does not start a session with it. This build was tested with agy ${ANTIGRAVITY_VERSION}: if another version is installed, install the tested one on this runner.`,
        ),
      );
    }

    const reply = yield* authenticateAccount(connection, folder, failOpening);

    /**
     * Requires that a worker started after `workersBefore` was read uses the
     * account's own login, and that every worker does. Fails with an
     * `AdapterFailed` otherwise. Returns whether Google holds the account.
     */
    const requireFreshOwnLogin = (workersBefore: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const signals = yield* readWorkerLogSignals(folder);
        const hasNewWorker = signals.workers.some((name) => !workersBefore.has(name));
        if (!hasNewWorker || !signals.allUseOwnLogin) {
          return yield* Effect.fail(
            buildAdapterFailed(
              `${ANTIGRAVITY_NAME} did not confirm that it uses this account's own login, so Hercule does not use it. This build was tested with agy ${ANTIGRAVITY_VERSION}: if another version is installed, install the tested one on this runner.`,
            ),
          );
        }
        return signals.isHeldByGoogle;
      });
    yield* requireFreshOwnLogin(new Set());

    /**
     * Runs the call that opens a conversation, and requires proof for the
     * worker it started: a worker log that was not there before the call. The
     * logs are read before each call, not after the last success, because a
     * refused call leaves a worker log too (measured on `agy` 1.5.15: a
     * refused `session/resume` starts a worker, and its log shows file
     * storage). Without that, the log of a refused call would pass for the
     * worker of the next one. `afterReply` runs when the call has answered, in
     * the same step that cannot be interrupted, before the check. Returns the
     * call's reply with whether Google holds the account.
     */
    const openConversation = <A>(
      call: Effect.Effect<A, AcpError>,
      afterReply: (reply: A) => Effect.Effect<void, AdapterError>,
    ): Effect.Effect<readonly [A, boolean], AcpError | AdapterError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const workersBefore = new Set((yield* restore(readWorkerLogSignals(folder))).workers);
          const answer = yield* restore(call).pipe(
            Effect.catch((error) =>
              Effect.fail(
                isSignInRequired(error) ? buildHarnessLoginMissing(ANTIGRAVITY_NAME) : error,
              ),
            ),
          );
          yield* afterReply(answer);
          const isHeldByGoogle = yield* restore(requireFreshOwnLogin(workersBefore));
          return [answer, isHeldByGoogle] as const;
        }),
      );

    return {
      connection,
      planLabel: readPlanLabel(reply.meta),
      newConversation: (onReply) =>
        Effect.map(
          openConversation(connection.newSession(request), (opened) =>
            onReply === undefined ? Effect.void : onReply(opened.nativeSessionId),
          ),
          ([opened, isHeldByGoogle]) => ({
            id: opened.nativeSessionId,
            settings: opened,
            isHeldByGoogle,
          }),
        ),
      resumeConversation: (nativeSessionId, onReply) =>
        Effect.map(
          openConversation(connection.resumeSession({ ...request, nativeSessionId }), () =>
            onReply === undefined ? Effect.void : onReply(nativeSessionId),
          ).pipe(
            Effect.catch((error) =>
              error._tag === "AcpError" && isConversationMissing(error)
                ? Effect.fail(
                    new ResumeTranscriptMissing({
                      message: `The conversation of this session is gone from this runner, so ${ANTIGRAVITY_NAME} cannot resume it. Start a new thread to continue the work.`,
                    }),
                  )
                : Effect.fail(error),
            ),
          ),
          ([settings, isHeldByGoogle]) => ({
            id: nativeSessionId,
            settings,
            isHeldByGoogle,
          }),
        ),
    };
  });
