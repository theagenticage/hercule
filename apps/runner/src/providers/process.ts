/**
 * A seam so a test can state what an adapter runs - the vendor installer above
 * all - without running it.
 */
import * as Effect from "effect/Effect";
import type { AppServerSpawn } from "./codex";
import type { LoginChild, LoginSpawn } from "./login";
import type { PiSpawn } from "./pi";

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

/**
 * A harness spoken to line by line: framed both ways, read while it lives, and
 * ended either by closing its stdin or by killing it. Each adapter takes the
 * half of this it uses.
 */
export interface FramedChild {
  readonly write: (text: string) => void;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  /** The end of the conversation, for a harness that leaves on end-of-input. */
  readonly end: () => void;
  readonly kill: () => void;
  readonly exited: Promise<number>;
}

/** One spawner for both: a conversation, not a run. */
const spawnFramed = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  /**
   * Where the harness runs, for one that takes it from its process rather than
   * from a command. Left out, the child inherits the runner's own directory,
   * which is a session writing its files wherever the daemon happens to live.
   */
  cwd?: string | null,
): FramedChild => {
  const child = Bun.spawn([...command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
    ...(cwd === undefined || cwd === null ? {} : { cwd }),
  });
  return {
    stdout: lined(child.stdout),
    stderr: lined(child.stderr),
    write: (text) => {
      // Written and flushed without waiting: the answer comes back on stdout
      // under the frame's own id, not from the write.
      void child.stdin.write(text);
      void child.stdin.flush();
    },
    end: () => {
      void child.stdin.end();
    },
    kill: () => {
      child.kill();
    },
    exited: child.exited,
  };
};

/** Codex's app-server, which is ended by killing it rather than by its stdin. */
export const spawnAppServer: AppServerSpawn = spawnFramed;

export const spawnPi: PiSpawn = spawnFramed;
