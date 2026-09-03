import { VERSION } from "./version";

/**
 * One binary, three roles. Each role is a separate entrypoint reached by a
 * dynamic import, so starting as a runner never evaluates the controller's
 * module graph (spec 15 sections 2 and 3).
 */
const ROLE_ENTRYPOINTS = {
  controller: () => import("@hydra/controller"),
  runner: () => import("@hydra/runner"),
  cli: () => import("@hydra/cli"),
} as const;

export type Role = keyof typeof ROLE_ENTRYPOINTS;

/**
 * Which role owns this invocation, and the arguments that role receives.
 *
 * `hydra serve ...` is the controller, `hydra runner ...` is the runner
 * daemon, and every other verb is the CLI (spec 15 section 2).
 */
export function route(argv: readonly string[]): { role: Role; args: readonly string[] } {
  switch (argv[0]) {
    case "serve":
      return { role: "controller", args: argv.slice(1) };
    case "runner":
      return { role: "runner", args: argv.slice(1) };
    default:
      return { role: "cli", args: argv };
  }
}

export async function dispatch(argv: readonly string[]): Promise<void> {
  if (argv[0] === "--version") {
    console.log(VERSION);
    return;
  }
  const { role, args } = route(argv);
  const entrypoint = await ROLE_ENTRYPOINTS[role]();
  entrypoint.run(args);
}

export { spawnHydra } from "./spawn";
export { VERSION };
