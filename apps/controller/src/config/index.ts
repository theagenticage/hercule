import { Context, Effect, Layer, Result } from "effect";
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

/** The usage line of `hercule serve`. `--force-unseal` is disaster recovery after a promotion. */
const USAGE = "usage: hercule serve [--home <dir>] [-c key=value] [--force-unseal]";

/** The flags `hercule serve` takes besides the global options. */
export class ServeFlags extends Context.Service<
  ServeFlags,
  {
    /** Clears the seal a promotion left, so this machine serves again (spec 03 section 8.3). */
    readonly forceUnseal: boolean;
  }
>()("hercule/controller/config/ServeFlags") {}

/**
 * Parses the arguments the global options left over into the serve flags.
 * Fails on any other argument: booting anyway would silently ignore it.
 */
const parseServeFlags = (
  rest: ReadonlyArray<string>,
): Result.Result<ServeFlags["Service"], InvalidOptionError> => {
  let forceUnseal = false;
  for (const arg of rest) {
    if (arg === "--force-unseal") {
      forceUnseal = true;
      continue;
    }
    return Result.fail(
      new InvalidOptionError({
        option: arg,
        message: `hercule serve takes no arguments; ${USAGE}`,
      }),
    );
  }
  return Result.succeed({ forceUnseal });
};

/**
 * Resolves the Hercule Home and the bootstrap config, creates the home layout,
 * and returns a layer that provides both, with the serve flags. Fails with a
 * `ConfigError`.
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
): Layer.Layer<HerculeHome | BootstrapConfig | ServeFlags, ConfigError> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const options = yield* Effect.fromResult(parseGlobalOptions(argv));
      const flags = yield* Effect.fromResult(parseServeFlags(options.rest));

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
        Layer.succeed(ServeFlags, flags),
      );
    }),
  );
