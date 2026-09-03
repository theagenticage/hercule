import { Effect, Layer } from "effect";
import { parseGlobalOptions } from "./args";
import { BootstrapConfig, defaults, loadConfigFile, resolveConfig } from "./bootstrap";
import type { ConfigError } from "./errors";
import {
  configFileIn,
  createDirectory,
  createLayout,
  homePaths,
  HydraHome,
  resolveHomePath,
} from "./home";

export * from "./args";
export * from "./bootstrap";
export * from "./errors";
export * from "./home";
export { formatToml, parseToml } from "./toml";

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
      const home = resolveHomePath(options.home, env);
      const homeDefaults = defaults(home);

      // The home must exist before `config.toml` can be written into it; the
      // rest of the layout waits until `data.dir` is known, so a configured
      // Data Root elsewhere leaves no stray `<home>/data` behind.
      yield* createDirectory(home);
      const file = yield* loadConfigFile(configFileIn(home), homeDefaults);
      const config = yield* resolveConfig({
        overrides: options.overrides,
        env,
        file,
        defaults: homeDefaults,
      });

      const paths = homePaths(home, config.dataDir);
      yield* createLayout(paths);

      return Layer.mergeAll(
        Layer.succeed(HydraHome, HydraHome.of(paths)),
        Layer.succeed(BootstrapConfig, config),
      );
    }),
  );
