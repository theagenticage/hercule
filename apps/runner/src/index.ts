/**
 * The runner role: a daemon that dials the controller and hosts sessions, and
 * the one command that turns a machine into one.
 *
 * This module's import graph must never reach the controller, the DB engine,
 * the plugin host, or the web bundle.
 *
 * The daemon itself is not built yet. What is here is `hydra runner join`,
 * which belongs to this role rather than to the CLI because everything it
 * writes - `runner.json` and the storage directory - is the runner's own.
 */
import * as Effect from "effect/Effect";
import { Result } from "effect";
import { parseGlobalOptions, resolveHomePath } from "@hydra/home";
import { join } from "./join";

/** How the runner ends, in the same vocabulary the CLI uses. */
const EXIT = { failed: 1, usage: 2 } as const;

const USAGE = "usage: hydra runner join <controller-url> --token <token>";

const NOT_YET = "the runner daemon is not built yet.";

/** The value of `--token`, or nothing when the flag is absent or bare. */
const tokenOf = (argv: ReadonlyArray<string>): string | undefined => {
  const flag = argv.indexOf("--token");
  return flag < 0 ? undefined : argv[flag + 1];
};

/** Everything on the line that is neither a flag nor a flag's value. */
const positionals = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const rest: Array<string> = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--token") i++;
    else if (!token.startsWith("-")) rest.push(token);
  }
  return rest;
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
    // `hydra runner` and `hydra runner --local`, the two daemon forms the
    // dispatcher routes here; they gain their behaviour with the socket.
    console.error(`hydra: ${NOT_YET}`);
    process.exitCode = EXIT.failed;
    return;
  }
  if (verb !== "join") {
    misuse(`unknown runner command \`${verb}\``);
    return;
  }

  const [, ...targets] = positionals(rest);
  const controllerUrl = targets[0];
  const token = tokenOf(rest);
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
