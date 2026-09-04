/**
 * The controller role: the always-on brain behind `hydra serve`.
 *
 * Boot (`./bootstrap.ts`), say where things are, bind, and stay up until the
 * unit is stopped. SIGINT and SIGTERM both mean the same thing: stop accepting,
 * let the requests already in flight finish, close the database, exit 0.
 *
 * The runner socket and the schedulers are not implemented yet; each adds a
 * step beside the listener rather than changing this shape.
 */
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { BootstrapConfig } from "./config";
import { AuthLayer } from "./auth";
import { bootWith, type BootError, type BootOutcome } from "./bootstrap";
import { ApiKeysLayer } from "./credentials";
import { MAX_REQUEST_BODY_BYTES, perimeterWarning, serve, webBundle } from "./http";
import { ControllerLayer } from "./identity";
import { SecretLayer } from "./secrets";
import { ProfilesLayer } from "./permissions";
import { SettingsOperationsLayer } from "./settings";
import { SetupLayer } from "./setup";
import { TaskServiceLayer } from "./tasks";
import { UserLayer } from "./users";

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

/**
 * What the operator reads once the controller is up.
 *
 * The setup URL is a URL only where there is a web app to open it in. A build
 * that embeds none serves the API alone, so the same address would answer 404;
 * what that operator needs is the command that builds one.
 */
export function report(outcome: BootOutcome, webApp: boolean): void {
  const { paths, setupUrl } = outcome;
  if (setupUrl === undefined) {
    console.log(`Hydra is set up. Home ${paths.home}, database ${paths.databaseFile}.`);
    return;
  }
  if (!webApp) {
    console.log("Hydra is not set up yet, and this build embeds no web app to set it up in.");
    console.log("Run `pnpm build:binary` to build one, then start Hydra again.");
    console.log(`The setup URL is in ${paths.setupUrlFile}, and \`hydra setup-url\` prints it.`);
    return;
  }
  console.log("Open this URL to finish setting up Hydra:");
  console.log(`  ${setupUrl}`);
  console.log(`It is also in ${paths.setupUrlFile}, and \`hydra setup-url\` prints it.`);
}

/** What a second signal during the drain prints, instead of killing the process. */
export const STILL_STOPPING = "Still stopping Hydra; the requests in flight are finishing.";

/**
 * The stop request, as something the boot can wait on.
 *
 * Both signals mean the same thing, and the handlers stay installed for the
 * whole shutdown - `process.on`, not `process.once`, and they come off only
 * when the scope that installed them closes, which is after the listener has
 * drained and the database is closed. A second SIGTERM would otherwise reach
 * Bun's default disposition and kill the process mid-drain, dropping the
 * requests in flight and leaving a dirty write-ahead log behind. Every signal
 * after the first says so and is ignored.
 *
 * Scoped, so a test can run this more than once in one process.
 */
export const untilStopped: Effect.Effect<
  Effect.Effect<void>,
  never,
  Scope.Scope
> = Effect.acquireRelease(
  Effect.sync(() => {
    const stopped = Latch.makeUnsafe(false);
    const stop = (): void => {
      if (!stopped.openUnsafe()) console.log(STILL_STOPPING);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return { stopped, stop };
  }),
  ({ stop }) =>
    Effect.sync(() => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }),
).pipe(Effect.map(({ stopped }) => stopped.await));

/**
 * Everything after the boot: bind, report, and hold the listener open until the
 * process is asked to stop. The scope closes on the way out, which stops the
 * server and, once this returns, closes the database.
 */
const listen = (outcome: BootOutcome, stopped: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const bootstrap = yield* BootstrapConfig;
    const bundle = yield* webBundle;
    yield* serve(bundle);

    const warning = perimeterWarning(bootstrap.bindHost, bootstrap.bindPort);
    if (warning !== undefined) console.warn(`hydra: ${warning}`);
    console.log(`Hydra is listening on http://${bootstrap.bindHost}:${bootstrap.bindPort}.`);
    report(outcome, bundle !== undefined);

    yield* stopped;
    console.log("Stopping Hydra.");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SetupLayer,
        AuthLayer,
        ApiKeysLayer,
        UserLayer,
        SecretLayer,
        ControllerLayer,
        SettingsOperationsLayer,
        ProfilesLayer,
        TaskServiceLayer,
      ),
    ),
  );

export async function run(argv: readonly string[]): Promise<void> {
  // The signal handlers are installed outside the boot and come off only once
  // the database is closed, so every signal that arrives during the shutdown
  // still lands on Hydra rather than on Bun's default disposition.
  const program = Effect.scoped(
    Effect.flatMap(untilStopped, (stopped) =>
      bootWith({ argv, env: process.env }, (outcome) =>
        Effect.gen(function* () {
          const bootstrap = yield* BootstrapConfig;
          return yield* Effect.scoped(
            listen(outcome, stopped).pipe(
              Effect.provide(
                BunHttpServer.layer({
                  hostname: bootstrap.bindHost,
                  port: bootstrap.bindPort,
                  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
                }),
              ),
            ),
          );
        }),
      ),
    ),
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
