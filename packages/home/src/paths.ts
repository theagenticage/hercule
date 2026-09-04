/**
 * Where Hydra keeps things on a machine: the Hydra Home layout (spec 15
 * section 5).
 *
 * Pure path arithmetic, no filesystem and no Effect services, because three
 * roles resolve a home and only one of them may link controller state: the
 * dispatcher routes on `--home`, the CLI reads `<home>/setup-url`, the runner
 * reads `<home>/runner/`, and the controller opens the database (spec 15
 * section 3).
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Every path in a Hydra Home, absolute. `dataDir` is the resolved `data.dir`
 * bootstrap key, so it is the only member that can point outside the home, and
 * the only part that moves with a promotion (spec 15 section 5).
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

/** The default Hydra Home, used when neither `--home` nor `HYDRA_HOME` is set. */
export const DEFAULT_HOME_NAME = ".hydra";

/** The controller's one SQLite database, inside the Data Root (spec 15 sections 5 and 10). */
export const DATABASE_FILE_NAME = "hydra.db";

/**
 * Where this process's Hydra Home is: `--home` beats `HYDRA_HOME` beats
 * `~/.hydra` (spec 15 sections 5 and 6). Relative paths resolve against the
 * working directory; the result is always absolute.
 */
export function resolveHomePath(
  homeOption: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const chosen = homeOption ?? env["HYDRA_HOME"];
  return chosen === undefined || chosen === ""
    ? join(homedir(), DEFAULT_HOME_NAME)
    : resolve(chosen);
}

/** Where `config.toml` lives; known before any config has been read. */
export function configFileIn(home: string): string {
  return join(home, "config.toml");
}

/** Where the CLI credential file lives; mode 0600, `{ url, apiKey }` (spec 15 section 5). */
export function credentialsFileIn(home: string): string {
  return join(home, "credentials.json");
}

/** Where `setup-url` lives; known without reading any config (spec 15 section 7). */
export function setupUrlFileIn(home: string): string {
  return join(home, "setup-url");
}

/** The home layout for a home directory and an already-resolved Data Root. */
export function homePaths(home: string, dataDir: string): HomePaths {
  const resolvedDataDir = isAbsolute(dataDir) ? dataDir : resolve(home, dataDir);
  return {
    home,
    configFile: configFileIn(home),
    credentialsFile: credentialsFileIn(home),
    dataDir: resolvedDataDir,
    databaseFile: join(resolvedDataDir, DATABASE_FILE_NAME),
    runnerDir: join(home, "runner"),
    logsDir: join(home, "logs"),
    backupsDir: join(home, "backups"),
    tlsDir: join(home, "tls"),
    setupUrlFile: setupUrlFileIn(home),
    masterKeyFile: join(home, "master.key"),
  };
}
