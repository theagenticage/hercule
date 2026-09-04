/**
 * The controller role: the always-on brain behind `hydra serve`.
 *
 * Boot (`./bootstrap.ts`), say where things are, bind, and stay up until the
 * unit is stopped. SIGINT and SIGTERM both mean the same thing: stop accepting,
 * let the requests already in flight finish, close the database, exit 0.
 *
 * The runner socket and the schedulers are later tickets; each adds a step
 * beside the listener rather than changing this shape.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { BootstrapConfig } from "./config";
import { AuthLayer } from "./auth";
import { bootWith, type BootError, type BootOutcome } from "./bootstrap";
import { perimeterWarning, serve } from "./http";
import { SetupLayer } from "./setup";

export { boot, bootWith, hashToken, setupUrl } from "./bootstrap";
export type { BootError, BootOptions, BootOutcome, ControllerServices } from "./bootstrap";

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

/** What the operator reads once the controller is up. */
export function report(outcome: BootOutcome): void {
  const { paths, setupUrl } = outcome;
  if (setupUrl === undefined) {
    console.log(`Hydra is set up. Home ${paths.home}, database ${paths.databaseFile}.`);
    return;
  }
  console.log("Open this URL to finish setting up Hydra:");
  console.log(`  ${setupUrl}`);
  console.log(`It is also in ${paths.setupUrlFile}, and \`hydra setup-url\` prints it.`);
}

/**
 * Resolves when the unit is asked to stop. Both signals are the same request,
 * and the handlers come off again when the fiber is interrupted, so a test can
 * run this more than once in one process.
 */
const untilStopped = Effect.callback<void>((resume) => {
  const stop = (): void => resume(Effect.void);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return Effect.sync(() => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  });
});

/**
 * Everything after the boot: bind, report, and hold the listener open until the
 * process is asked to stop. The scope closes on the way out, which stops the
 * server and, once this returns, closes the database.
 */
const listen = (outcome: BootOutcome) =>
  Effect.gen(function* () {
    const bootstrap = yield* BootstrapConfig;
    yield* serve;

    const warning = perimeterWarning(bootstrap.bindHost, bootstrap.bindPort);
    if (warning !== undefined) console.warn(`hydra: ${warning}`);
    console.log(`Hydra is listening on http://${bootstrap.bindHost}:${bootstrap.bindPort}.`);
    report(outcome);

    yield* untilStopped;
    console.log("Stopping Hydra.");
  }).pipe(Effect.provide(Layer.mergeAll(SetupLayer, AuthLayer)));

export async function run(argv: readonly string[]): Promise<void> {
  const program = bootWith({ argv, env: process.env }, (outcome) =>
    Effect.gen(function* () {
      const bootstrap = yield* BootstrapConfig;
      return yield* Effect.scoped(
        listen(outcome).pipe(
          Effect.provide(
            BunHttpServer.layer({ hostname: bootstrap.bindHost, port: bootstrap.bindPort }),
          ),
        ),
      );
    }),
  );

  const outcome = await Effect.runPromise(program.pipe(Effect.result)).catch((defect: unknown) => {
    // A defect is a bug, not a boot failure; it still has to read as one line.
    console.error(`hydra: ${String(defect)}`);
    process.exitCode = 1;
    return undefined;
  });

  if (outcome === undefined) return;
  if (outcome._tag === "Failure") {
    console.error(`hydra: ${explain(outcome.failure)}`);
    process.exitCode = 1;
  }
}
