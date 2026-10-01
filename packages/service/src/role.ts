/**
 * Chooses what a bare `hercule service install` runs: `hercule serve` on the
 * controller machine, `hercule runner` on a machine that only runs a runner
 * (spec 15 section 4).
 *
 * `hercule runner join` does not ask: it installs the runner role itself.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import {
  buildHomePaths,
  loadBootstrapConfig,
  locateRunnerDir,
  type ConfigFileError,
  type ConfigValueError,
} from "@hercule/home";
import type { ServiceRole } from "./unit";

/** The role chosen for a Hercule Home, with the reason as the end of a sentence. */
export interface ChosenRole {
  readonly role: ServiceRole;
  readonly reason: string;
}

/**
 * Returns the role a unit should run for a Hercule Home, and why. Fails with
 * `ConfigFileError` or `ConfigValueError` when the Home's `config.toml` cannot
 * be used.
 *
 * - A controller database in the Home means the controller machine: `serve`.
 *   This wins over a `runner.json`, because the controller's local runner
 *   writes one too.
 * - A `runner.json` and no controller database means a runner-only machine.
 * - Anything else is a machine that has not run Hercule yet, and `serve`
 *   starts a controller there.
 *
 * The database is located with `config.toml` alone, without `-c` flags or
 * environment variables, because the unit sees only `config.toml`. The
 * controller URL in `runner.json` is never consulted: a runner may well dial
 * a controller on its own machine.
 */
export const chooseServiceRole = (
  home: string,
): Effect.Effect<ChosenRole, ConfigFileError | ConfigValueError> =>
  Effect.map(loadBootstrapConfig({ home, overrides: [], env: {} }), (config): ChosenRole => {
    if (existsSync(buildHomePaths(home, config.dataDir).databaseFile)) {
      return { role: "serve", reason: "this Home holds a controller database" };
    }
    if (existsSync(join(locateRunnerDir(home), "runner.json"))) {
      return { role: "runner", reason: "this Home holds a runner.json and no controller database" };
    }
    return { role: "serve", reason: "this Home holds no runner.json" };
  });
