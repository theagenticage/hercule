/**
 * How an adapter runs something on the machine it is on.
 *
 * A seam rather than a direct call, because what an adapter runs - the vendor's
 * install script above all - is the thing a test most needs to state without
 * running it.
 */
import * as Effect from "effect/Effect";
import type { LoginChild, LoginSpawn } from "./login";

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

/**
 * A login on this machine. Unlike a run, it is read and written while it lives:
 * the vendor prints a URL, waits on stdin, and only then decides how it went.
 */
export const spawnLogin: LoginSpawn = (command, env): LoginChild => {
  const child = Bun.spawn([...command], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  const text = (stream: ReadableStream<Uint8Array>): AsyncIterable<string> => {
    const decoder = new TextDecoder();
    return (async function* () {
      for await (const chunk of stream) yield decoder.decode(chunk, { stream: true });
    })();
  };
  return {
    stdout: text(child.stdout),
    stderr: text(child.stderr),
    write: (value) => {
      // Written and flushed without waiting: the vendor is reading a line and
      // the answer comes back on the pipes, not from the write.
      void child.stdin.write(value);
      void child.stdin.flush();
    },
    kill: () => {
      child.kill();
    },
    exited: child.exited,
  };
};
