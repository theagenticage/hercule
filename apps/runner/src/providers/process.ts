/**
 * How an adapter runs something on the machine it is on.
 *
 * A seam rather than a direct call, because what an adapter runs - the vendor's
 * install script above all - is the thing a test most needs to state without
 * running it.
 */
import * as Effect from "effect/Effect";

/** How a process ended, and everything it said. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Run = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
) => Effect.Effect<Ran>;

/**
 * A process on this machine. A command that could not be started reads as one
 * that exited badly and said why: an adapter has the same thing to report
 * either way, and a missing binary is an ordinary state of a machine.
 */
export const runProcess: Run = (command, env) =>
  Effect.tryPromise({
    try: async (signal) => {
      // Copied because Bun's types take a mutable array, and an adapter's
      // command is a constant it must keep.
      const child = Bun.spawn([...command], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      // Giving up on the answer is not giving up on the process: a deadline that
      // left the installer running would leave one behind on every attempt.
      signal.addEventListener("abort", () => {
        child.kill();
      });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;
      return { code: child.exitCode ?? 1, stdout, stderr };
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  }).pipe(Effect.catch((message) => Effect.succeed({ code: 1, stdout: "", stderr: message })));
