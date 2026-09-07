/**
 * The runner role. This module's import graph must never reach the controller,
 * the DB engine, the plugin host, or the web bundle.
 *
 * `join` belongs to this role rather than to the CLI because everything it
 * writes is the runner's own.
 *
 * Both daemon forms stop on a signal rather than being killed by it: the
 * connection's scope closes on the way out, which is where the runner says it is
 * going. A runner that vanished reads as unreachable for a minute instead.
 */
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Logger from "effect/Logger";
import type * as Scope from "effect/Scope";
import { Result } from "effect";
import { parseGlobalOptions, resolveHomePath } from "@hydra/home";
import { daemon } from "./daemon";
import { join } from "./join";
import { local } from "./local";
import { providerLogins } from "./providers";
import { setController } from "./set-controller";

/** The same vocabulary the CLI uses. */
const EXIT = { failed: 1, usage: 2 } as const;

const USAGE = [
  "usage: hydra runner",
  "       hydra runner --local",
  "       hydra runner join <controller-url> --token <token> [--reserved]",
  "       hydra runner set-controller <controller-url>",
].join("\n");

/**
 * The handlers stay installed until the scope that put them there closes, which
 * is after the connection is let go of: a second signal would otherwise reach
 * Bun's default disposition and kill the process mid-goodbye.
 */
const untilStopped: Effect.Effect<Effect.Effect<void>, never, Scope.Scope> = Effect.acquireRelease(
  Effect.sync(() => {
    const stopped = Latch.makeUnsafe(false);
    const stop = (): void => {
      stopped.openUnsafe();
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
 * A daemon that returns on its own has failed: holding the connection is all it
 * does. Everything it logs goes to stderr, because a runner's stdout is a
 * channel the spawning controller reads one line off.
 */
const hold = async (work: Effect.Effect<void, { readonly message: string }>): Promise<void> => {
  const outcome = await Effect.runPromise(
    Effect.result(
      Effect.scoped(
        Effect.flatMap(untilStopped, (stopped) => Effect.raceFirst(work, stopped)),
      ).pipe(
        // A vendor login blocked on stdin is a child of this process that will
        // not notice the process has gone, and it is holding a prompt for a
        // credential.
        Effect.ensuring(providerLogins.stopAll),
        Effect.provideService(Logger.LogToStderr, true),
      ),
    ),
  );
  if (outcome._tag === "Failure") {
    console.error(`hydra: ${outcome.failure.message}`);
    process.exitCode = EXIT.failed;
  }
};

const misuse = (reason: string): void => {
  console.error(`hydra: ${reason}`);
  console.error(USAGE);
  process.exitCode = EXIT.usage;
};

export async function run(argv: readonly string[]): Promise<void> {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    console.error(`hydra: ${options.failure.option}: ${options.failure.message}`);
    process.exitCode = EXIT.usage;
    return;
  }
  const rest = options.success.rest;
  const verb = rest[0];

  if (verb === undefined || verb.startsWith("-")) {
    const home = resolveHomePath(options.success.home, process.env);
    // Anything else is a typo, and starting a daemon is the wrong answer to one.
    const unknown = rest.find((token) => token !== "--local");
    if (unknown !== undefined) {
      misuse(`unknown runner option \`${unknown}\``);
      return;
    }
    return await hold(verb === "--local" ? local(home) : daemon(home));
  }
  if (verb !== "join" && verb !== "set-controller") {
    misuse(`unknown runner command \`${verb}\``);
    return;
  }

  const args = rest.slice(1);
  const home = resolveHomePath(options.success.home, process.env);

  if (verb === "set-controller") {
    if (args.length !== 1) {
      misuse("set-controller takes one controller URL");
      return;
    }
    const outcome = await Effect.runPromise(
      Effect.result(setController({ home, controllerUrl: args[0]! })),
    );
    if (outcome._tag === "Failure") {
      console.error(`hydra: ${outcome.failure.message}`);
      process.exitCode = EXIT.failed;
      return;
    }
    console.log(`This runner now looks for its controller at ${outcome.success}.`);
    return;
  }

  const flag = args.indexOf("--token");
  const token = flag < 0 ? undefined : args[flag + 1];
  const named = flag < 0 ? args : args.filter((_, at) => at !== flag && at !== flag + 1);
  const reserved = named.includes("--reserved");
  // What is left once the flags and the token are struck out is the URL, so a
  // stray flag is refused rather than ignored.
  const targets = named.filter((value) => value !== "--reserved");
  const controllerUrl = targets[0];
  if (controllerUrl === undefined) {
    misuse("join needs the controller's URL");
    return;
  }
  if (targets.length > 1) {
    misuse("join takes one controller URL");
    return;
  }
  if (token === undefined || token === "") {
    misuse("join needs --token <token>");
    return;
  }

  const outcome = await Effect.runPromise(
    Effect.result(join({ controllerUrl, token, home, reserved })),
  );

  if (outcome._tag === "Failure") {
    console.error(`hydra: ${outcome.failure.message}`);
    process.exitCode = EXIT.failed;
    return;
  }
  console.log(`This machine joined as ${outcome.success.name}.`);
  console.log(`Its credential is in ${outcome.success.configPath}.`);
}
