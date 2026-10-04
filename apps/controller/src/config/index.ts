import { Effect, Layer } from "effect";
import {
  BootstrapConfig,
  locateConfigFile,
  buildHomePaths,
  InvalidOptionError,
  loadBootstrapConfig,
  parseGlobalOptions,
  resolveHomePathToActOn,
  writeDefaultConfigFile,
} from "@hercule/home";
import type { ConfigError } from "./errors";
import { createDirectory, createLayout, HerculeHome } from "./home";

// The home functions and the bootstrap config live in `@hercule/home`, which
// the CLI and the runner link too; a controller module imports them from here.
export {
  BootstrapConfig,
  locateConfigFile,
  DATABASE_FILE_NAME,
  DEFAULT_HOME_NAME,
  buildHomePaths,
  InvalidOptionError,
  parseGlobalOptions,
  locateSetupUrlFile,
  type GlobalOptions,
  type HomePaths,
} from "@hercule/home";
export * from "./errors";
export * from "./home";

/** The usage line of `hercule serve`, which takes no arguments of its own. */
const USAGE = "usage: hercule serve [--home <dir>] [-c key=value]";

/**
 * Resolves the Hercule Home and the bootstrap config, creates the home layout,
 * and returns a layer that provides both. Fails with a `ConfigError`.
 *
 * This is step 1 of first run (spec 15 section 7) and the first thing every
 * controller boot does. `argv` and `env` are passed in rather than read from
 * the process, so a test can use a temporary home exactly the way the binary
 * uses the real one. Nothing here touches the database, because the home
 * functions are shared with the runner, which links no controller state (spec
 * 15 section 3).
 */
export const layer = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): Layer.Layer<HerculeHome | BootstrapConfig, ConfigError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const options = yield* Effect.fromResult(parseGlobalOptions(argv));
      // Anything the global options did not consume is an argument `hercule
      // serve` does not have. Booting anyway would silently ignore it.
      const unknown = options.rest[0];
      if (unknown !== undefined) {
        return yield* new InvalidOptionError({
          option: unknown,
          message: `hercule serve takes no arguments; ${USAGE}`,
        });
      }

      const home = yield* Effect.fromResult(resolveHomePathToActOn(options.home, env));
      const configFile = locateConfigFile(home);

      // The home must exist before `config.toml` can be written into it; the
      // rest of the layout waits until `data.dir` is known, so a configured
      // Data Root elsewhere leaves no stray `<home>/data` behind.
      yield* createDirectory(home);
      yield* writeDefaultConfigFile(configFile);
      const config = yield* loadBootstrapConfig({ home, overrides: options.overrides, env });

      const paths = buildHomePaths(home, config.dataDir);
      yield* createLayout(paths);

      return Layer.mergeAll(
        Layer.succeed(HerculeHome, HerculeHome.of(paths)),
        Layer.succeed(BootstrapConfig, config),
      );
    }),
  );
