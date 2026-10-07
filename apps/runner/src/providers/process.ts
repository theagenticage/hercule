/**
 * Spawns the processes adapters run. Adapters take these functions as a seam,
 * so a test can check what an adapter would run (above all, the vendor
 * installer) without running it.
 */
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
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
 * Runs a command to completion and returns its exit code and output. Never
 * fails: a command that cannot start returns exit code 1 with the error in
 * `stderr`, because a missing binary is an ordinary state.
 */
export const runProcess: Run = (command, env) =>
  Effect.tryPromise({
    try: async (signal) => {
      // Copy the command, because Bun's types expect a mutable array and an
      // adapter's command is a constant.
      const child = Bun.spawn([...command], {
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      // When the caller gives up, for example on a deadline, kill the process
      // too. Otherwise every timed-out attempt would leave an installer running.
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
 * Returns the ids of the processes that hold `file` open: from `lsof` on
 * macOS, and from each process's open files under `/proc` on Linux. A process
 * whose open files cannot be read, such as one of another user, is left out,
 * and a file that does not exist is held by none.
 */
const listProcessesHolding = (file: string): Effect.Effect<ReadonlyArray<number>> => {
  if (process.platform === "darwin") {
    // lsof exits with 1 when no process holds the file, which is not an error
    // here. Its full path is used because a runner's PATH may leave out
    // /usr/sbin, where macOS keeps it.
    return runProcess(["/usr/sbin/lsof", "-t", file], process.env).pipe(
      Effect.map((ran) =>
        ran.stdout
          .split("\n")
          .filter((line) => line !== "")
          .map(Number),
      ),
    );
  }
  return Effect.sync(() => {
    let target: string;
    try {
      target = realpathSync(file);
    } catch {
      // A file that does not exist is held by no process.
      return [];
    }
    return readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .filter((pid) => {
        try {
          const dir = `/proc/${pid}/fd`;
          return readdirSync(dir).some((fd) => readlinkSync(`${dir}/${fd}`) === target);
        } catch {
          return false;
        }
      })
      .map(Number);
  });
};

/**
 * Kills, with SIGKILL, every process that holds `file` open. Does nothing when
 * the file does not exist. The pi adapter uses this to end what an agent's
 * bash calls left running once the agent's pi has exited, because each of
 * those processes holds the agent's file open.
 */
export const killProcessesHolding = (file: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    // A holder can start another process between the listing and the kill, and
    // the new one holds the file too. So list again after each round of kills,
    // until no process holds it. Three rounds end any ordinary process tree.
    for (let round = 0; round < 3; round += 1) {
      const holders = yield* listProcessesHolding(file);
      if (holders.length === 0) return;
      for (const pid of holders) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The process has already exited.
        }
      }
    }
  });

const decodeStream = (stream: ReadableStream<Uint8Array>): AsyncIterable<string> => {
  const decoder = new TextDecoder();
  return (async function* () {
    for await (const chunk of stream) yield decoder.decode(chunk, { stream: true });
  })();
};

/** Splits a stream into lines, holding back a trailing partial line until it is complete. */
const splitLines = (stream: ReadableStream<Uint8Array>): AsyncIterable<string> =>
  (async function* () {
    let buffered = "";
    for await (const chunk of decodeStream(stream)) {
      buffered += chunk;
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      yield* parts;
    }
    if (buffered !== "") yield buffered;
  })();

/**
 * Spawns a login process. Unlike `runProcess`, a login is read from and written to while it runs.
 */
export const spawnLogin: LoginSpawn = (command, env): LoginChild => {
  const child = Bun.spawn([...command], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  return {
    stdout: decodeStream(child.stdout),
    stderr: decodeStream(child.stderr),
    write: (value) => {
      // Write and flush without waiting: the vendor's response arrives on stdout
      // or stderr, not as the result of the write.
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
 * A harness process the runner talks to one line at a time, in both
 * directions. It is read while it runs, and ended either by closing its stdin
 * or by killing it. Each adapter uses only the parts it needs.
 */
export interface FramedChild {
  readonly write: (text: string) => void;
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  /** Closes stdin, which ends a harness that exits at end of input. */
  readonly end: () => void;
  readonly kill: () => void;
  readonly exited: Promise<number>;
}

/** Spawns a line-framed harness. Shared by the Codex and pi adapters. */
const spawnFramed = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  /**
   * The directory the harness runs in, for a harness that takes it from its
   * process rather than from a command-line option. When it is left out, the
   * child inherits the runner's own directory, and a session would write its
   * files wherever the daemon was started.
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
    stdout: splitLines(child.stdout),
    stderr: splitLines(child.stderr),
    write: (text) => {
      // Write and flush without waiting: the response arrives on stdout,
      // matched by the frame's id, not as the result of the write.
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

/** Spawns Codex's app-server, which is ended by killing it rather than by closing its stdin. */
export const spawnAppServer: AppServerSpawn = spawnFramed;

export const spawnPi: PiSpawn = spawnFramed;
