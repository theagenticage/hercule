import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Context, Effect } from "effect";
import { HydraHomeError } from "./errors";

/**
 * Hydra Home: the one directory holding everything Hydra keeps on a machine.
 * Only `dataDir` (the Data Root) moves with promotion (spec 15 section 5).
 *
 * Every path is absolute. `dataDir` is the resolved `data.dir` bootstrap key,
 * so it is the only member that can point outside the home.
 */
export class HydraHome extends Context.Service<
  HydraHome,
  {
    readonly home: string;
    readonly configFile: string;
    readonly dataDir: string;
    readonly runnerDir: string;
    readonly logsDir: string;
    readonly backupsDir: string;
    readonly tlsDir: string;
    readonly setupUrlFile: string;
    readonly masterKeyFile: string;
  }
>()("hydra/controller/config/HydraHome") {}

/** The default Hydra Home, used when neither `--home` nor `HYDRA_HOME` is set. */
export const DEFAULT_HOME_NAME = ".hydra";

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

/** The home layout for a home directory and an already-resolved Data Root. */
export function homePaths(home: string, dataDir: string): HydraHome["Service"] {
  return {
    home,
    configFile: configFileIn(home),
    dataDir: isAbsolute(dataDir) ? dataDir : resolve(home, dataDir),
    runnerDir: join(home, "runner"),
    logsDir: join(home, "logs"),
    backupsDir: join(home, "backups"),
    tlsDir: join(home, "tls"),
    setupUrlFile: join(home, "setup-url"),
    masterKeyFile: join(home, "master.key"),
  };
}

/** Create one directory and its parents. Idempotent. */
export const createDirectory = Effect.fn("createDirectory")(function* (path: string) {
  yield* Effect.try({
    try: () => mkdirSync(path, { recursive: true }),
    catch: (cause) => new HydraHomeError({ path, cause }),
  });
});

/**
 * Create every directory of the layout (spec 15 section 5). Idempotent: an
 * existing home keeps everything already in it.
 */
export const createLayout = Effect.fn("createLayout")(function* (paths: HydraHome["Service"]) {
  const directories = [
    paths.home,
    paths.dataDir,
    paths.runnerDir,
    paths.logsDir,
    paths.backupsDir,
    paths.tlsDir,
  ];
  for (const directory of directories) {
    yield* createDirectory(directory);
  }
});
