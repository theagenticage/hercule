/**
 * Where Hercule keeps things on a machine: the Hercule Home layout.
 *
 * Pure path computation, with no filesystem access and no Effect services,
 * because every role resolves a home and only the controller may link
 * controller state:
 *
 * - the dispatcher routes on `--home`;
 * - the CLI reads `<home>/setup-url`;
 * - the runner reads `<home>/runner/`, and `hercule service install` checks
 *   it for a `runner.json`;
 * - the controller and the runner write their logs into `<home>/logs/`;
 * - the controller opens the database.
 *
 * It also decides whether a command may use the default Home: inside a
 * session, a command that acts on a Home must be given one by name.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Result } from "effect";
import { InvalidOptionError, type Env } from "./args";

/**
 * Every path in a Hercule Home, absolute. `dataDir` is the resolved `data.dir`
 * bootstrap key, so it is the only member that can point outside the home, and
 * the only part that moves with a promotion.
 */
export interface HomePaths {
  readonly home: string;
  readonly configFile: string;
  readonly credentialsFile: string;
  readonly dataDir: string;
  readonly databaseFile: string;
  readonly runnerDir: string;
  readonly logsDir: string;
  readonly backupsDir: string;
  readonly tlsDir: string;
  readonly setupUrlFile: string;
  readonly masterKeyFile: string;
}

/** The default Hercule Home, used when neither `--home` nor `HERCULE_HOME` is set. */
export const DEFAULT_HOME_NAME = ".hercule";

/** The file name of the controller's SQLite database, inside the Data Root. */
export const DATABASE_FILE_NAME = "hercule.db";

/**
 * Returns the Home that `--home` or `HERCULE_HOME` names, in that order of
 * precedence, or `undefined` when neither names one. An empty value names no
 * Home. An empty `--home` does not fall through to `HERCULE_HOME`.
 */
function readNamedHome(homeOption: string | undefined, env: Env): string | undefined {
  const chosen = homeOption ?? env["HERCULE_HOME"];
  return chosen === "" ? undefined : chosen;
}

/**
 * Returns the path of this process's Hercule Home: `--home` takes precedence
 * over `HERCULE_HOME`, which takes precedence over `~/.hercule`. A relative
 * path is resolved against the working directory, so the result is always
 * absolute.
 */
export function resolveHomePath(homeOption: string | undefined, env: Env): string {
  const named = readNamedHome(homeOption, env);
  return named === undefined ? join(homedir(), DEFAULT_HOME_NAME) : resolve(named);
}

/** Returns true when the runner started this process inside a session. */
export const isInSession = (env: Env): boolean => env["HERCULE_SESSION"] === "1";

/**
 * Returns the Home a command acts on: the Home it writes, such as the one
 * `hercule serve` creates, or the Home whose Service Unit it manages. The path
 * is the one `resolveHomePath` returns. Fails with `InvalidOptionError` when
 * the process runs inside a session and neither `--home` nor `HERCULE_HOME`
 * names a Home.
 *
 * A session never gets `HERCULE_HOME` from its runner (spec 06 section 9.3),
 * so inside a session the default Home is a guess. On the user's own machine
 * that guess is their live Home, even when the session's own controller runs
 * on a scratch Home. An agent that starts a controller or a runner to test
 * something must name a scratch Home instead.
 */
export function resolveHomePathToActOn(
  homeOption: string | undefined,
  env: Env,
): Result.Result<string, InvalidOptionError> {
  const home = resolveHomePath(homeOption, env);
  if (isInSession(env) && readNamedHome(homeOption, env) === undefined) {
    return Result.fail(
      new InvalidOptionError({
        option: "--home",
        message: `this command runs inside a Hercule session, where the default Home (${home}) may be the user's live one. Name a scratch Home with --home <dir> or HERCULE_HOME.`,
      }),
    );
  }
  return Result.succeed(home);
}

/** Returns the path of `config.toml`, which is known before any config has been read. */
export function locateConfigFile(home: string): string {
  return join(home, "config.toml");
}

/** Returns the path of the CLI credential file (mode 0600, holding `{ url, apiKey }`). */
export function locateCredentialsFile(home: string): string {
  return join(home, "credentials.json");
}

/** Returns the directory where the runner keeps its own state: `runner.json` and its storage directories. */
export function locateRunnerDir(home: string): string {
  return join(home, "runner");
}

/** Returns the path of `runner.json`, the credential a runner receives when it joins. */
export function locateRunnerFile(home: string): string {
  return join(locateRunnerDir(home), "runner.json");
}

/** Returns the directory where the controller and the runner write their rotated process logs. */
export function locateLogsDir(home: string): string {
  return join(home, "logs");
}

/** The two roles that run as long-lived processes and write a process log. */
export type DaemonRole = "controller" | "runner";

/** Returns the path of the log file the controller or a runner writes: `<home>/logs/<role>.log`. */
export function locateProcessLogFile(home: string, role: DaemonRole): string {
  return join(locateLogsDir(home), `${role}.log`);
}

/**
 * Returns the path a service unit appends the process's standard error to:
 * `<home>/logs/<role>.stderr.log`.
 */
export function locateStderrLogFile(home: string, role: DaemonRole): string {
  return join(locateLogsDir(home), `${role}.stderr.log`);
}

/** Returns the path of `setup-url`, which is known without reading any config. */
export function locateSetupUrlFile(home: string): string {
  return join(home, "setup-url");
}

/** Builds the home layout for a home directory and an already-resolved Data Root. */
export function buildHomePaths(home: string, dataDir: string): HomePaths {
  const resolvedDataDir = isAbsolute(dataDir) ? dataDir : resolve(home, dataDir);
  return {
    home,
    configFile: locateConfigFile(home),
    credentialsFile: locateCredentialsFile(home),
    dataDir: resolvedDataDir,
    databaseFile: join(resolvedDataDir, DATABASE_FILE_NAME),
    runnerDir: locateRunnerDir(home),
    logsDir: locateLogsDir(home),
    backupsDir: join(home, "backups"),
    tlsDir: join(home, "tls"),
    setupUrlFile: locateSetupUrlFile(home),
    masterKeyFile: join(home, "master.key"),
  };
}
