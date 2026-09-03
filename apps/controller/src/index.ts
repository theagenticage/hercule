/**
 * The controller role: the always-on brain behind `hydra serve`.
 *
 * This is the whole of `hydra serve` for now: boot, report, exit. There is
 * nothing to keep running yet - the public API, the runner socket and the
 * schedulers are later tickets, and each of them adds a step after the boot
 * sequence rather than changing it.
 */
import * as Effect from "effect/Effect";
import { boot, type BootError } from "./bootstrap";

export { boot, hashToken, setupUrl, type BootError, type BootOutcome } from "./bootstrap";

/**
 * One clear line per failure, on stderr. No stack, no Effect internals.
 *
 * Exported so the wording is testable on its own: it is the only thing a
 * failing `hydra serve` ever shows.
 */
export function explain(error: BootError): string {
  switch (error._tag) {
    case "InvalidOptionError":
      return `${error.option}: ${error.message}`;
    case "ConfigFileError":
      return `${error.path} ${error.message}`;
    case "HydraHomeError":
      return `Cannot ${error.action} ${error.path}: ${String(error.cause)}`;
    default:
      return error.message;
  }
}

export async function run(argv: readonly string[]): Promise<void> {
  const outcome = await Effect.runPromise(
    boot({ argv, env: process.env }).pipe(Effect.result),
  ).catch((defect: unknown) => {
    // A defect is a bug, not a boot failure; it still has to read as one line.
    console.error(`hydra: ${String(defect)}`);
    process.exitCode = 1;
    return undefined;
  });

  if (outcome === undefined) return;
  if (outcome._tag === "Failure") {
    console.error(`hydra: ${explain(outcome.failure)}`);
    process.exitCode = 1;
    return;
  }

  const { paths, setupUrl } = outcome.success;
  if (setupUrl === undefined) {
    console.log(`Hydra is set up. Home ${paths.home}, database ${paths.databaseFile}.`);
    return;
  }
  console.log("Open this URL to finish setting up Hydra:");
  console.log(`  ${setupUrl}`);
  console.log(`It is also in ${paths.setupUrlFile}, and \`hydra setup-url\` prints it.`);
}
