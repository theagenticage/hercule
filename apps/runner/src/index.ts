/**
 * The runner role: a daemon that dials the controller and hosts sessions, and
 * the one command that turns a machine into one.
 *
 * This module's import graph must never reach the controller, the DB engine,
 * the plugin host, or the web bundle.
 *
 * `hydra runner join` belongs to this role rather than to the CLI because
 * everything it writes - `runner.json` and the storage directory - is the
 * runner's own; `hydra runner` then holds the connection that join made
 * possible. `hydra runner --local` is the same daemon with an enrolment
 * handshake in front of it, for the child a controller spawns beside itself.
 *
 * Both daemon forms stop on a signal rather than being killed by it: the
 * connection's scope closes on the way out, which is where the runner tells its
 * controller it is going. A runner that vanished would read as unreachable for
 * a minute; one that said goodbye reads as offline at once.
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

/** How the runner ends, in the same vocabulary the CLI uses. */
const EXIT = { failed: 1, usage: 2 } as const;

const USAGE = [
  "usage: hydra runner",
  "       hydra runner --local",
  "       hydra runner join <controller-url> --token <token>",
].join("\n");

/**
 * The stop request, as something a daemon can be raced against.
 *
 * Both signals mean the same thing, and the handlers stay installed until the
 * scope that put them there closes, which is after the connection has been let
 * go of: a second signal otherwise reaches Bun's default disposition and kills
 * the process mid-goodbye.
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
 * Runs a daemon until it fails or the process is asked to stop. A daemon that
 * returns on its own has failed: holding the connection is all it does.
 *
 * Everything it logs goes to stderr. A runner's stdout is a channel, not a
 * console: the controller that spawned this one reads a line off it and has to
 * be able to tell that line from whatever the daemon had to say.
 */
const hold = async (work: Effect.Effect<void, { readonly message: string }>): Promise<void> => {
  const outcome = await Effect.runPromise(
    Effect.result(
      Effect.scoped(
        Effect.flatMap(untilStopped, (stopped) => Effect.raceFirst(work, stopped)),
      ).pipe(Effect.provideService(Logger.LogToStderr, true)),
    ),
  );
  if (outcome._tag === "Failure") {
    console.error(`hydra: ${outcome.failure.message}`);
    process.exitCode = EXIT.failed;
  }
};

/** Refuses the line, saying how it should have read. */
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
    // A daemon takes no flags but `--local`, so anything else on the line is a
    // typo, and starting a daemon is the wrong answer to one.
    const unknown = rest.find((token) => token !== "--local");
    if (unknown !== undefined) {
      misuse(`unknown runner option \`${unknown}\``);
      return;
    }
    // The supervised child the controller spawns takes its enrolment off stdin
    // before it dials; everything after that is the ordinary daemon.
    return await hold(verb === "--local" ? local(home) : daemon(home));
  }
  if (verb !== "join") {
    misuse(`unknown runner command \`${verb}\``);
    return;
  }

  const args = rest.slice(1);
  const flag = args.indexOf("--token");
  const token = flag < 0 ? undefined : args[flag + 1];
  // Whatever is left once the flag and its value are struck out is the URL, and
  // there is exactly one of those, so a stray flag is refused rather than
  // ignored.
  const targets = flag < 0 ? args : args.filter((_, at) => at !== flag && at !== flag + 1);
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
    Effect.result(
      join({
        controllerUrl,
        token,
        home: resolveHomePath(options.success.home, process.env),
      }),
    ),
  );

  if (outcome._tag === "Failure") {
    console.error(`hydra: ${outcome.failure.message}`);
    process.exitCode = EXIT.failed;
    return;
  }
  console.log(`This machine joined as ${outcome.success.name}.`);
  console.log(`Its credential is in ${outcome.success.configPath}.`);
}
