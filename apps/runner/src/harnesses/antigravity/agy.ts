/**
 * How a process of Google's `agy` is started for one account, and whose login
 * it uses. Every `agy` process of an account (login, version, probe, session)
 * is built here, so that all of them get the same environment and none of
 * them can run as another account.
 */
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { openAcpConnection } from "@hercule/acp";
import type { AcpConnection, AcpError, AcpHandlers } from "@hercule/acp";
import { VERSION } from "@hercule/home/version";
import { HarnessLoginMissing } from "@hercule/protocol";
import type { AdapterError } from "@hercule/protocol";
import { describeError } from "../../report";
import {
  buildAdapterFailed,
  buildHarnessNotInstalled,
  buildHarnessNotRunnable,
  buildStartFailure,
} from "../adapter-error-builders";
import type { HarnessRunnerContext } from "../index";
import type { LoginCommand } from "../login";
import { isExecutableNotFound, stopChild } from "../process";
import type { FramedChild, Run } from "../process";
import { describeFileFailure } from "../session-files";
import { truncateFact } from "../text";
import { APP_DATA_DIR, hasTokenFile, makeScratchFolder } from "./harness-home";

/** The name the user knows the harness by. */
export const ANTIGRAVITY_NAME = "Antigravity";

/** Spawns an `agy` process in the folder `cwd`. */
export type AgySpawn = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
) => FramedChild;

/** An open connection to the `agy` process of an account that is signed in. */
export interface SignedInAgy {
  readonly connection: AcpConnection;
  /** The name of the account's plan, such as "Antigravity Starter Quota". Undefined when `agy` gave none. */
  readonly planLabel: string | undefined;
}

/**
 * The two lines of the process's own log that Hercule reads, and nothing else
 * in it. The log also holds the account's email address. It is never read,
 * and nothing of the log leaves the runner.
 *
 * - `FILE_STORAGE_LINE` is written by a worker that keeps its login in the
 *   file of the Harness Home. It shows that the process uses this account's
 *   login and not the machine's keychain.
 * - `NETWORK_ERROR_LINE` is written when `agy` could not reach Google to check
 *   an expired login. `agy` answers that case exactly as it answers a missing
 *   login, so this line is the only way to tell them apart.
 */
const FILE_STORAGE_LINE = "Using file-based token storage because SSH session detected";
const NETWORK_ERROR_LINE = "token validation failed due to network error";

/** The most bytes of one worker log that are read. A line that comes later is not found. */
const LOG_LIMIT = 1024 * 1024;

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
 * `HOME` stays: `agy` writes nothing below it when it is given `--gemini-dir`
 * and `--log-file`.
 */
const buildAgyEnv = (ctx: HarnessRunnerContext): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(ctx.env)) {
    if (!/^(GEMINI_|GOOGLE_|AGY_)/.test(name)) env[name] = value;
  }
  env["SSH_CONNECTION"] = "127.0.0.1 0 127.0.0.1 0";
  env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true";
  return env;
};

/**
 * Builds the command that signs the account in. `agy` prints a link, reads the
 * code from stdin, and on a wrong code prints "couldn't log in: ..." on
 * stdout and exits with 1.
 */
export const buildLoginCommand = (ctx: HarnessRunnerContext, binary: string): LoginCommand => ({
  command: [binary, "acp", "--login", "--gemini-dir", ctx.home, "--app-data-dir", APP_DATA_DIR],
  env: buildAgyEnv(ctx),
  refusal: /^couldn't log in:/,
});

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

/** Builds the failure for an account with no usable login in its Harness Home. */
export const buildNotSignedIn = (): HarnessLoginMissing =>
  new HarnessLoginMissing({ message: `${ANTIGRAVITY_NAME} is not signed in on this runner.` });

/**
 * Checks whether `session/new` or `session/resume` was refused because the
 * account is not signed in: the error -32000, "Authentication required".
 */
export const isSignInRequired = (error: AcpError): boolean =>
  error.reason === "refused" &&
  error.code === -32000 &&
  (error.harnessMessage ?? "").includes("Authentication required");

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

/** The name of the process's own log. `agy` writes each worker's log to `<LOG_NAME>.<pid>`. */
const LOG_NAME = "agy.log";

/**
 * Reads the log of every worker process of the `agy` that logs in `folder`,
 * and returns the text of each (at most 1 MiB of it). `agy` starts one worker
 * per session. The front process's own log, `agy.log`, is not a worker's.
 * Fails with an `AdapterFailed` when the folder or a log cannot be read, or a
 * log is not a regular file.
 *
 * A log is opened without following a link, and without blocking, so that
 * nothing put in its place can send the read elsewhere or hang it.
 */
const readWorkerLogs = (folder: string): Effect.Effect<ReadonlyArray<string>, AdapterError> =>
  Effect.tryPromise({
    try: async () => {
      const prefix = `${LOG_NAME}.`;
      const names = (await readdir(folder)).filter(
        (name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)),
      );
      const texts: Array<string> = [];
      for (const name of names) {
        const file = await open(
          join(folder, name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (!(await file.stat()).isFile()) throw new Error("it is not a regular file");
          const buffer = Buffer.alloc(LOG_LIMIT);
          let length = 0;
          while (length < LOG_LIMIT) {
            const { bytesRead } = await file.read(buffer, length, LOG_LIMIT - length, null);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          texts.push(buffer.toString("utf8", 0, length));
        } finally {
          await file.close();
        }
      }
      return texts;
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
  child: FramedChild,
): { readonly lastLines: () => string; readonly ended: Promise<void> } => {
  const lines: Array<string> = [];
  const ended = (async () => {
    try {
      for await (const line of child.stderr) {
        if (line.trim() === "") continue;
        lines.push(line.trim());
        if (lines.length > STDERR_LINES) lines.shift();
      }
    } catch {
      // A stderr that fails has nothing more to say.
    }
  })();
  return { lastLines: () => lines.join(" "), ended };
};

/**
 * Starts the `agy` process of an account and signs it in over ACP. Returns the
 * open connection and the account's plan name. Fails with:
 *
 * - `HarnessLoginMissing` when the Harness Home has no token file (nothing is
 *   spawned), or when `agy` says there is no usable login, or Google refused
 *   the one there is.
 * - `HarnessNotInstalled` when the binary does not exist, and `AdapterFailed`
 *   when it cannot be run, when `agy` cannot be reached over ACP, when it
 *   cannot reach Google to check the login, when its answer is not one of
 *   these, and when the process does not use this account's own login.
 *
 * The process runs in `options.cwd`, with its own log in a private folder of
 * the Harness Home. When the scope closes, the connection is closed first, then
 * the process is stopped and awaited, and then the log folder is removed. A
 * failure leaves what was started in place until the scope closes, so the
 * caller runs this in a scope that closes on failure.
 *
 * `agy` answers an `authenticate` it refuses with the same words whether there
 * is no login, Google refused it, or the machine is offline while the access
 * token has expired. Only the process's log tells the last case apart.
 */
export const openSignedInAgy = (
  spawn: AgySpawn,
  ctx: HarnessRunnerContext,
  binary: string,
  options: { readonly cwd: string; readonly handlers: AcpHandlers },
): Effect.Effect<SignedInAgy, AdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!(yield* hasTokenFile(ctx.home))) return yield* Effect.fail(buildNotSignedIn());

    const folder = yield* makeScratchFolder(ctx.home);
    const command = [
      binary,
      "acp",
      "--process-per-session",
      "--gemini-dir",
      ctx.home,
      "--app-data-dir",
      APP_DATA_DIR,
      "--log-file",
      join(folder, LOG_NAME),
    ];
    const env = buildAgyEnv(ctx);
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () => spawn(command, env, options.cwd),
        catch: (error) =>
          isExecutableNotFound(error, { binary, cwd: options.cwd })
            ? buildHarnessNotInstalled(ANTIGRAVITY_NAME)
            : buildHarnessNotRunnable(ANTIGRAVITY_NAME, describeError(error)),
      }),
      (spawned) => stopChild(spawned),
    );
    const stderr = drainStderr(child);

    // A connection that closed means the process died, and its last words on
    // stderr are the best reason there is.
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

    const reply = yield* connection
      .authenticate("oauth-personal")
      .pipe(
        Effect.catch((error) =>
          error.reason === "refused" && (error.harnessMessage ?? "").includes("agy acp --login")
            ? Effect.flatMap(readWorkerLogs(folder), (logs) =>
                Effect.fail(
                  logs.some((log) => log.includes(NETWORK_ERROR_LINE))
                    ? buildAdapterFailed(
                        `${ANTIGRAVITY_NAME} could not reach Google to check the sign-in of this account. Check the network of this runner.`,
                      )
                    : buildNotSignedIn(),
                ),
              )
            : failOpening(error),
        ),
      );

    const workerLogs = yield* readWorkerLogs(folder);
    if (workerLogs.length === 0 || !workerLogs.every((log) => log.includes(FILE_STORAGE_LINE))) {
      return yield* Effect.fail(
        buildAdapterFailed(
          `${ANTIGRAVITY_NAME} is signed in, but not with a login of this account.`,
        ),
      );
    }

    return { connection, planLabel: readPlanLabel(reply.meta) };
  });
