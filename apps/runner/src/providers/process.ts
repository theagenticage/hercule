/**
 * A seam so a test can state what an adapter runs - the vendor installer above
 * all - without running it.
 */
import * as Effect from "effect/Effect";
import type { AppServerChild, AppServerSpawn } from "./codex/rpc";
import type { LoginChild, LoginSpawn } from "./login";

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
 * A command that could not start reads as one that exited badly and said why: a
 * missing binary is an ordinary state.
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

const decoded = (stream: ReadableStream<Uint8Array>): AsyncIterable<string> => {
  const decoder = new TextDecoder();
  return (async function* () {
    for await (const chunk of stream) yield decoder.decode(chunk, { stream: true });
  })();
};

/** One item per line, with the trailing partial line held back until it ends. */
const lined = (stream: ReadableStream<Uint8Array>): AsyncIterable<string> =>
  (async function* () {
    let buffered = "";
    for await (const chunk of decoded(stream)) {
      buffered += chunk;
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      yield* parts;
    }
    if (buffered !== "") yield buffered;
  })();

/** Unlike a run, a login is read and written while it lives. */
export const spawnLogin: LoginSpawn = (command, env): LoginChild => {
  const child = Bun.spawn([...command], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  return {
    stdout: decoded(child.stdout),
    stderr: decoded(child.stderr),
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

/** The app-server is a conversation, not a run: framed, and read while it lives. */
export const spawnAppServer: AppServerSpawn = (command, env): AppServerChild => {
  const child = Bun.spawn([...command], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  return {
    stdout: lined(child.stdout),
    stderr: lined(child.stderr),
    write: (text) => {
      // Written and flushed without waiting: the answer comes back on stdout
      // under the frame's own id, not from the write.
      void child.stdin.write(text);
      void child.stdin.flush();
    },
    kill: () => {
      child.kill();
    },
    exited: child.exited,
  };
};
