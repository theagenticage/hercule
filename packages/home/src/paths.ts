/**
 * Where Hercule keeps things on a machine: the Hercule Home layout.
 *
 * Pure path computation, with no filesystem access and no Effect services,
 * because every role resolves a home and only the controller may link
 * controller state:
 *
 * - the dispatcher routes on `--home`;
 * - the CLI reads `<home>/setup-url`;
 * - the runner reads `<home>/runner/`;
 * - the controller and the runner write their logs into `<home>/logs/`;
 * - the controller opens the database.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
 * Returns the path of this process's Hercule Home: `--home` takes precedence
 * over `HERCULE_HOME`, which takes precedence over `~/.hercule`. A relative
 * path is resolved against the working directory, so the result is always
 * absolute.
 */
export function resolveHomePath(
  homeOption: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const chosen = homeOption ?? env["HERCULE_HOME"];
  return chosen === undefined || chosen === ""
    ? join(homedir(), DEFAULT_HOME_NAME)
    : resolve(chosen);
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

/** Returns the directory where the controller and the runner write their rotated process logs. */
export function locateLogsDir(home: string): string {
  return join(home, "logs");
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
