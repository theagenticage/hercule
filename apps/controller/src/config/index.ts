import { Effect, Layer } from "effect";
import {
  configFileIn,
  homePaths,
  InvalidOptionError,
  parseGlobalOptions,
  resolveHomePath,
} from "@hydra/home";
import { BootstrapConfig, loadConfigFile, resolveConfig } from "./bootstrap";
import type { ConfigError } from "./errors";
import { createDirectory, createLayout, HydraHome } from "./home";

// The pure home pieces live in `@hydra/home`, which the CLI and the runner link
// too; a controller module reaches them through here.
export {
  configFileIn,
  DATABASE_FILE_NAME,
  DEFAULT_HOME_NAME,
  homePaths,
  InvalidOptionError,
  parseGlobalOptions,
  resolveHomePath,
  setupUrlFileIn,
  type GlobalOptions,
  type HomePaths,
} from "@hydra/home";
export * from "./bootstrap";
export * from "./errors";
export * from "./home";
export { formatToml, parseToml } from "./toml";

/** What `hydra serve` accepts; it takes no arguments of its own. */
const USAGE = "usage: hydra serve [--home <dir>] [-c key=value]";

/**
 * Resolve the Hydra Home and the bootstrap config, and create the home layout.
 *
 * Step 1 of first run (spec 15 section 7) and the first thing every controller
 * boot does. `argv` and `env` are passed in rather than read off the process,
 * so a test drives a temporary home exactly the way the binary drives the real
 * one. Nothing here touches the database: the runner resolves its home through
 * the same code, and the runner links no controller state (spec 15 section 3).
 */
export const layer = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): Layer.Layer<HydraHome | BootstrapConfig, ConfigError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const options = yield* Effect.fromResult(parseGlobalOptions(argv));
      // Everything the global options did not claim is an argument `hydra
      // serve` does not have. Booting anyway would silently ignore it.
      const unknown = options.rest[0];
      if (unknown !== undefined) {
        return yield* new InvalidOptionError({
          option: unknown,
          message: `hydra serve takes no arguments; ${USAGE}`,
        });
      }

      const home = resolveHomePath(options.home, env);
      const configFile = configFileIn(home);

      // The home must exist before `config.toml` can be written into it; the
      // rest of the layout waits until `data.dir` is known, so a configured
      // Data Root elsewhere leaves no stray `<home>/data` behind.
      yield* createDirectory(home);
      const file = yield* loadConfigFile(configFile);
      const config = yield* resolveConfig({
        overrides: options.overrides,
        env,
        file,
        configFile,
      });

      const paths = homePaths(home, config.dataDir);
      yield* createLayout(paths);

      return Layer.mergeAll(
        Layer.succeed(HydraHome, HydraHome.of(paths)),
        Layer.succeed(BootstrapConfig, config),
      );
    }),
  );
