/**
 * The controller role: the always-on brain behind `hercule serve`.
 *
 * Boots (`./bootstrap.ts`), prints where things are, starts listening, and
 * stays up until the service is stopped. SIGINT and SIGTERM both mean the same
 * thing:
 *
 * - stop accepting connections;
 * - let the requests already in flight finish;
 * - close the database;
 * - exit with code 0.
 *
 * A connection that is meant to stay open, such as a client watching a Live
 * Topic, would keep that drain waiting for ever, so the drain has a deadline
 * and prints a message when it reaches it.
 *
 * The listener forks the work that runs in the background beside it (the
 * controller daemon's drivers and the provider probes), so a future scheduler
 * adds a step there rather than changing this structure.
 */
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import type * as Scope from "effect/Scope";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { BootstrapConfig } from "./config";
import { bootWith, type BootError, type BootOutcome } from "./bootstrap";
import { bodyLimits, operationLayers, buildPerimeterWarning, serve, webBundle } from "./http";
import { LOCAL_RUNNER } from "./runners";

export { boot, bootWith, hashToken, buildSetupUrl } from "./bootstrap";
export type { BootError, BootOptions, BootOutcome, ControllerServices } from "./bootstrap";

/**
 * Returns one clear line describing a boot failure, for stderr. No stack, no
 * Effect internals.
 *
 * Exported so the wording can be tested on its own: it is the only thing a
 * failing `hercule serve` ever prints.
 */
export function explain(error: BootError): string {
  switch (error._tag) {
    case "InvalidOptionError":
      return `${error.option}: ${error.message}`;
    case "ConfigFileError":
      return `${error.path} ${error.message}`;
    case "HerculeHomeError":
      return `Cannot ${error.action} ${error.path}: ${String(error.cause)}`;
    default:
      return error.message;
  }
}

/**
 * Prints what the operator needs to know once the controller is up.
 *
 * The setup URL is only useful when there is a web app to open it in. A build
 * that embeds no web app serves only the API, so the same address would return
 * 404; that operator needs the command that builds the web app instead.
 */
export function report(outcome: BootOutcome, webApp: boolean): void {
  const { paths, setupUrl } = outcome;
  if (setupUrl === undefined) {
    console.log(`Hercule is set up. Home ${paths.home}, database ${paths.databaseFile}.`);
    return;
  }
  if (!webApp) {
    console.log("Hercule is not set up yet, and this build embeds no web app to set it up in.");
    console.log("Run `pnpm build:binary` to build one, then start Hercule again.");
    console.log(`The setup URL is in ${paths.setupUrlFile}, and \`hercule setup-url\` prints it.`);
    return;
  }
  console.log("Open this URL to finish setting up Hercule:");
  console.log(`  ${setupUrl}`);
  console.log(`It is also in ${paths.setupUrlFile}, and \`hercule setup-url\` prints it.`);
}

/** The message a second signal during the drain prints, instead of killing the process. */
export const STILL_STOPPING = "Still stopping Hercule; the requests in flight are finishing.";

/** The message the drain prints when it stops waiting for the connections still open. */
export const STILL_OPEN = "Connections were still open; Hercule stopped anyway.";

/**
 * How long the drain waits before the process stops regardless.
 *
 * A client watching a Live Topic keeps its socket open for as long as its tab
 * is open, and the listener's drain waits for every open connection, so a
 * controller anybody is watching would otherwise never finish stopping.
 * Stopping early loses nothing: every committed write is already durable, and
 * a request in flight has these ten seconds to finish.
 */
const DRAIN_DEADLINE_MS = 10_000;

/**
 * Installs the SIGINT and SIGTERM handlers, and returns an effect that
 * completes when the first of those signals arrives.
 *
 * Both signals mean the same thing. The handlers stay installed for the whole
 * shutdown: they use `process.on`, not `process.once`, and are removed only
 * when the scope that installed them closes, which is after the listener has
 * drained and the database is closed. Otherwise a second SIGTERM would reach
 * Bun's default handler and kill the process during the drain, dropping the
 * requests in flight and leaving a dirty write-ahead log behind. Every signal
 * after the first prints a message and is otherwise ignored.
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
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (!stopped.openUnsafe()) {
        console.log(STILL_STOPPING);
        return;
      }
      deadline = setTimeout(() => {
        console.log(STILL_OPEN);
        process.exit(0);
      }, DRAIN_DEADLINE_MS);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return { stopped, stop, clear: () => clearTimeout(deadline) };
  }),
  ({ stop, clear }) =>
    Effect.sync(() => {
      clear();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }),
).pipe(Effect.map(({ stopped }) => stopped.await));

/**
 * Runs everything after the boot: starts listening, prints the report, and
 * keeps the listener open until the process is asked to stop. The scope closes
 * on the way out, which stops the server; the database closes after this
 * returns.
 */
const listen = (outcome: BootOutcome, stopped: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const bootstrap = yield* BootstrapConfig;
    const bundle = yield* webBundle;
    yield* serve(bundle);

    const warning = buildPerimeterWarning(bootstrap.bindHost, bootstrap.bindPort);
    if (warning !== undefined) console.warn(`hercule: ${warning}`);
    console.log(`Hercule is listening on http://${bootstrap.bindHost}:${bootstrap.bindPort}.`);
    report(outcome, bundle !== undefined);

    yield* stopped;
    console.log("Stopping Hercule.");
    // Before the listener stops: the local runner says goodbye over its socket
    // to this controller, and a controller that had already stopped listening
    // would treat that as a machine that disappeared.
    if (outcome.localRunner !== undefined) yield* outcome.localRunner.stop;
  }).pipe(Effect.provide(operationLayers));

export async function run(argv: readonly string[]): Promise<void> {
  // The signal handlers are installed outside the boot and removed only once
  // the database is closed, so every signal that arrives during the shutdown
  // still reaches Hercule's handler rather than Bun's default one.
  const program = Effect.scoped(
    Effect.flatMap(untilStopped, (stopped) =>
      bootWith({ argv, env: process.env, localRunner: LOCAL_RUNNER }, (outcome) =>
        Effect.gen(function* () {
          const bootstrap = yield* BootstrapConfig;
          return yield* Effect.scoped(
            listen(outcome, stopped).pipe(
              Effect.provide(
                BunHttpServer.layer({
                  hostname: bootstrap.bindHost,
                  port: bootstrap.bindPort,
                  ...bodyLimits,
                }),
              ),
            ),
          );
        }),
      ),
    ),
  );

  const outcome = await Effect.runPromise(program.pipe(Effect.result)).catch((defect: unknown) => {
    // A defect is a bug, not a boot failure, but it is still printed as one line.
    console.error(`hercule: ${String(defect)}`);
    process.exitCode = 1;
    return undefined;
  });

  if (outcome === undefined) return;
  if (outcome._tag === "Failure") {
    console.error(`hercule: ${explain(outcome.failure)}`);
    process.exitCode = 1;
  }
}
