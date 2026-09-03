import { VERSION } from "./version";

export type Role = "controller" | "runner" | "cli";

/** What every role entrypoint exports. Daemon roles return a promise. */
type RoleModule = { run: (argv: readonly string[]) => void | Promise<void> };

/**
 * One binary, three roles. Each role is a separate entrypoint reached by a
 * dynamic import, so starting as a runner never evaluates the controller's
 * module graph (spec 15 sections 2 and 3).
 */
const ROLE_ENTRYPOINTS: Record<Role, () => Promise<RoleModule>> = {
  controller: () => import("@hydra/controller"),
  runner: () => import("@hydra/runner"),
  cli: () => import("@hydra/cli"),
};

/**
 * `--home <dir>` and `-c key=value` are global options: they may precede the
 * verb (spec 15 section 2). Returns the index of the verb.
 *
 * Both options also take their value glued to the flag, so the number of tokens
 * to skip depends on the form. The dispatcher only needs to find the verb; the
 * role parses the options for real (`parseGlobalOptions`, apps/controller
 * config), and reads them from the arguments it is handed. The two agree by
 * this rule and are kept apart deliberately: the dispatcher must not pull a
 * role's module graph in to route to it.
 */
function verbIndex(argv: readonly string[]): number {
  let i = 0;
  for (; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--home" || token === "-c") i += 1;
    else if (!token.startsWith("--home=") && !(token.startsWith("-c") && token.length > 2)) break;
  }
  return i;
}

/**
 * Which role owns this invocation, and the arguments that role receives.
 *
 * `hydra serve` is the controller and `hydra runner` / `hydra runner --local`
 * are the runner daemon. Every other verb, `hydra runner join` and
 * `hydra runner create-join-token` included, is the CLI (spec 15 section 2).
 * The role keeps the global options; only the verb is consumed.
 */
function route(argv: readonly string[]): { role: Role; args: readonly string[] } {
  const i = verbIndex(argv);
  const withoutVerb = [...argv.slice(0, i), ...argv.slice(i + 1)];
  const subcommand = argv[i + 1];
  switch (argv[i]) {
    case "serve":
      return { role: "controller", args: withoutVerb };
    case "runner":
      // The daemon forms take no subcommand; `runner join`, `runner
      // set-controller` and `runner create-join-token` are ops CLI verbs.
      return subcommand === undefined || subcommand.startsWith("-")
        ? { role: "runner", args: withoutVerb }
        : { role: "cli", args: argv };
    default:
      return { role: "cli", args: argv };
  }
}

export async function dispatch(argv: readonly string[]): Promise<void> {
  if (argv[verbIndex(argv)] === "--version") {
    console.log(VERSION);
    return;
  }
  const { role, args } = route(argv);
  const entrypoint = await ROLE_ENTRYPOINTS[role]();
  await entrypoint.run(args);
}

export { spawnHydra } from "./spawn";
export { VERSION };
