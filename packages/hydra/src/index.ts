import { parseGlobalOptions } from "@hydra/home";
import { VERSION } from "@hydra/home/version";
import { Result } from "effect";

export type Role = "controller" | "runner" | "cli";

/** What every role entrypoint exports. Daemon roles return a promise. */
type RoleModule = { run: (argv: readonly string[]) => void | Promise<void> };

/**
 * One binary, three roles. Each role is a separate entrypoint reached by a
 * dynamic import, so starting as a runner never evaluates the controller's
 * module graph.
 */
const ROLE_ENTRYPOINTS: Record<Role, () => Promise<RoleModule>> = {
  controller: () => import("@hydra/controller"),
  runner: () => import("@hydra/runner"),
  cli: () => import("@hydra/cli"),
};

/**
 * Which role owns this invocation, and the arguments that role receives.
 *
 * `hydra serve` is the controller; `hydra runner`, `hydra runner --local`,
 * `hydra runner join` and `hydra runner set-controller` are the runner. Every
 * other verb, `hydra runner join-token create` included, is the CLI. The role
 * keeps the global options; only the verb is consumed.
 *
 * `--home <dir>` and `-c key=value` may precede the verb, so the verb is
 * wherever `parseGlobalOptions` found it - the same parser the role runs on the
 * same line, rather than a second copy of the rule here.
 */
function route(
  argv: readonly string[],
  options: { readonly rest: ReadonlyArray<string>; readonly verbIndex: number },
): { role: Role; args: readonly string[] } {
  const withoutVerb = [...argv.slice(0, options.verbIndex), ...argv.slice(options.verbIndex + 1)];
  const subcommand = options.rest[1];
  switch (options.rest[0]) {
    case "serve":
      return { role: "controller", args: withoutVerb };
    case "runner":
      // A bridge for as long as `hydra runner` names the daemon as well as the
      // noun: help for either is one screen, and the CLI is what renders it.
      if (subcommand === "--help" || subcommand === "-h") return { role: "cli", args: argv };
      // The daemon forms take no subcommand, and `join` and `set-controller`
      // write the runner's own files rather than calling an operation; the
      // rest, `runner join-token create` among them, are CLI verbs.
      return subcommand === undefined ||
        subcommand.startsWith("-") ||
        subcommand === "join" ||
        subcommand === "set-controller"
        ? { role: "runner", args: withoutVerb }
        : { role: "cli", args: argv };
    default:
      return { role: "cli", args: argv };
  }
}

export async function dispatch(argv: readonly string[]): Promise<void> {
  const parsed = parseGlobalOptions(argv);
  if (Result.isFailure(parsed)) {
    // A malformed global option cannot be routed on: the verb's position
    // depends on how many tokens the option took.
    console.error(`hydra: ${parsed.failure.option}: ${parsed.failure.message}`);
    process.exitCode = 1;
    return;
  }
  if (parsed.success.rest[0] === "--version") {
    console.log(VERSION);
    return;
  }
  const { role, args } = route(argv, parsed.success);
  const entrypoint = await ROLE_ENTRYPOINTS[role]();
  await entrypoint.run(args);
}

export { spawnHydra } from "./spawn";
export { VERSION };
