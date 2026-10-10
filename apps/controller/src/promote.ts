/**
 * The `hercule promote` entrypoint: parses its arguments and runs the
 * promotion on this machine (`./promotion/promote.ts`).
 *
 * It is a role of its own rather than a verb of `hercule serve`: it must not
 * boot a controller, because a boot would create a new identity and Master
 * Key in the Home that the transfer needs empty. With `--no-service`, the
 * controller is started in this process once the old controller has switched.
 */
import { createInterface } from "node:readline";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { Result } from "effect";
import {
  buildHomePaths,
  loadBootstrapConfig,
  locateCompiledBinary,
  parseGlobalOptions,
  resolveHomePathToActOn,
} from "@hercule/home";
import { makeSupervisorLayer } from "@hercule/service";
import { promote } from "./promotion/promote";
import { readErrorMessage } from "./promotion/receive";
import { defaultBackend } from "./secrets";

/**
 * The same exit codes the CLI uses, and the shell's code for a process that
 * Ctrl-C stopped.
 */
const EXIT = { failed: 1, usage: 2, stopped: 130 } as const;

const USAGE =
  "usage: hercule promote --from <url> --token <token> [--address <url>] [--yes] [--no-service]";

const HELP = [
  USAGE,
  "",
  "Makes this machine the controller: pulls the data of the controller at --from",
  "into this machine's empty Hercule Home, seals the old controller, and tells its",
  "runners to reconnect here. Then installs the service unit that keeps this",
  "controller running.",
  "",
  "  --from <url>       The old controller's URL",
  "  --token <token>    The token `hercule controller promotion-token create` printed",
  "  --address <url>    The URL runners reach this machine at (default: bind.host and",
  "                     bind.port from config.toml)",
  "  --yes              Skip the confirmation",
  "  --no-service       Install no service unit; run the controller in this terminal",
].join("\n");

const VALUE_FLAGS = ["--from", "--token", "--address"] as const;
const SWITCHES = ["--yes", "--no-service"] as const;

type PromoteArgs = {
  readonly from: string;
  readonly token: string;
  readonly address: string | undefined;
  readonly yes: boolean;
  readonly noService: boolean;
};

/** Parses the arguments after `promote`, or returns why they are wrong. */
const parsePromoteArgs = (args: ReadonlyArray<string>): PromoteArgs | string => {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if ((VALUE_FLAGS as ReadonlyArray<string>).includes(arg)) {
      const value = args[at + 1];
      if (value === undefined || value === "") return `${arg} needs a value`;
      values.set(arg, value);
      at += 1;
    } else if ((SWITCHES as ReadonlyArray<string>).includes(arg)) {
      switches.add(arg);
    } else {
      return `unknown promote argument \`${arg}\``;
    }
  }
  const from = values.get("--from");
  const token = values.get("--token");
  if (from === undefined) return "promote needs --from <url>";
  if (token === undefined) return "promote needs --token <token>";
  return {
    from,
    token,
    address: values.get("--address"),
    yes: switches.has("--yes"),
    noService: switches.has("--no-service"),
  };
};

/**
 * Asks the user to type yes, and returns whether they did. Ctrl-C or the end
 * of input closes the prompt without an answer, which counts as no.
 */
const askToProceed: Effect.Effect<boolean> = Effect.callback<boolean>((resume) => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  // Only the first answer counts, so the close that follows a typed answer changes nothing.
  prompt.once("close", () => resume(Effect.succeed(false)));
  prompt.question("Promote this machine? Type yes to continue: ", (answer) => {
    resume(Effect.succeed(["yes", "y"].includes(answer.trim().toLowerCase())));
    prompt.close();
  });
  return Effect.sync(() => prompt.close());
});

/**
 * Runs `effect` and returns its exit. The first SIGINT or SIGTERM interrupts
 * it, so a promotion that has spent its token settles both machines before
 * the process ends. A second signal reaches the default handler, which ends
 * the process at once.
 */
const runUntilStopped = async <A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> => {
  const fiber = Effect.runFork(effect);
  const stop = (): void => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    Effect.runFork(Fiber.interrupt(fiber));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await Effect.runPromise(Fiber.await(fiber));
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
};

const reportMisuse = (reason: string): void => {
  console.error(`hercule: ${reason}`);
  console.error(USAGE);
  process.exitCode = EXIT.usage;
};

export async function run(argv: readonly string[]): Promise<void> {
  const options = parseGlobalOptions(argv);
  if (Result.isFailure(options)) {
    reportMisuse(`${options.failure.option}: ${options.failure.message}`);
    return;
  }
  const rest = options.success.rest;
  if (rest[0] === "--help" || rest[0] === "-h") {
    console.log(HELP);
    return;
  }
  const args = parsePromoteArgs(rest);
  if (typeof args === "string") {
    reportMisuse(args);
    return;
  }
  // A script has no one to answer the question, so it would wait for ever.
  if (!args.yes && process.stdin.isTTY !== true) {
    reportMisuse("promote asks for confirmation, and there is no terminal to ask on: add --yes");
    return;
  }
  const home = resolveHomePathToActOn(options.success.home, process.env);
  if (Result.isFailure(home)) {
    reportMisuse(`${home.failure.option}: ${home.failure.message}`);
    return;
  }
  const { overrides } = options.success;

  const exit = await runUntilStopped(
    Effect.gen(function* () {
      const config = yield* loadBootstrapConfig({
        home: home.success,
        overrides,
        env: process.env,
      });
      yield* promote({
        from: args.from,
        token: args.token,
        address: args.address,
        paths: buildHomePaths(home.success, config.dataDir),
        bindHost: config.bindHost,
        bindPort: config.bindPort,
        backend: defaultBackend,
        confirm: args.yes ? undefined : askToProceed,
        service: args.noService
          ? undefined
          : {
              request: {
                role: "serve",
                home: home.success,
                overrides,
                env: process.env,
                program: locateCompiledBinary(),
              },
              supervisor: makeSupervisorLayer(process.env),
            },
        out: (line) => console.log(line),
      });
    }),
  );
  if (Exit.isFailure(exit)) {
    if (Cause.hasInterruptsOnly(exit.cause)) {
      console.error("hercule: promote was stopped");
      process.exitCode = EXIT.stopped;
      return;
    }
    const failure = Cause.squash(exit.cause);
    console.error(`hercule: ${readErrorMessage(failure)}`);
    process.exitCode = EXIT.failed;
    return;
  }
  if (args.noService) {
    const controller = await import("./index");
    await controller.run([
      "--home",
      home.success,
      ...overrides.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
    ]);
  }
}
