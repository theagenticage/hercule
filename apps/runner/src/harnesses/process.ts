/**
 * Spawns the processes adapters run. Adapters take these functions as a seam,
 * so a test can check what an adapter would run (above all, the vendor
 * installer) without running it.
 */
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AgySpawn } from "./antigravity";
import type { AppServerSpawn } from "./codex";
import type { LoginChild, LoginSpawn, LoginSpawnOptions } from "./login";
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
 * Checks whether a spawn failed because the executable does not exist. Bun
 * throws an error with code `ENOENT` for three different causes, and the
 * error does not tell which one it was:
 *
 * - the executable is missing,
 * - the working directory is missing,
 * - the executable is a script whose interpreter is missing, such as
 *   `#!/usr/bin/env node` on a PATH without node.
 *
 * So the answer is `true` only for `ENOENT` when the executable itself does
 * not exist and the working directory is `null` (the spawn sets none) or
 * exists. Otherwise the harness is present but cannot run, and the caller says
 * so. `spawn.binary` is the path of the executable and `spawn.cwd` the working
 * directory the spawn set. The files are checked only after a spawn has failed, so a successful
 * spawn pays nothing.
 */
export const isExecutableNotFound = (
  error: unknown,
  spawn: { readonly binary: string; readonly cwd: string | null },
): boolean =>
  error instanceof Error &&
  "code" in error &&
  error.code === "ENOENT" &&
  !existsSync(spawn.binary) &&
  (spawn.cwd === null || existsSync(spawn.cwd));

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

/**
 * The longest line, in characters, that `splitLines` accepts. The largest
 * legitimate lines are Codex tool results that carry base64 images, a few
 * megabytes each. 64 MiB is far above that and still stops a harness that
 * never sends a newline from filling the runner's memory.
 */
export const MAX_LINE_LENGTH = 64 * 1024 * 1024;

/**
 * Splits a stream into lines and returns them in order, without the newline
 * (a `\r` before it stays). A trailing partial line is held back until its
 * newline arrives, and is returned at the end of the stream. Each chunk is
 * searched for a newline once, and the pieces of a partial line are joined once
 * when it completes, so a long line in many chunks costs time linear in its
 * length.
 *
 * The iterator fails with an error that names `MAX_LINE_LENGTH` when a line
 * grows past it. The Codex and pi readers treat a failing iterator like a
 * closed pipe and drop the cause; the ACP connection ends with the error text.
 */
export const splitLines = (stream: ReadableStream<Uint8Array>): AsyncIterable<string> =>
  (async function* () {
    // The pieces of the line being read, and their total length.
    let pieces: Array<string> = [];
    let pendingLength = 0;
    const failTooLong = (): never => {
      throw new Error(
        `A line from the process is longer than ${MAX_LINE_LENGTH} characters, the limit for one line.`,
      );
    };
    for await (const chunk of decodeStream(stream)) {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        if (newline === -1) break;
        const piece = chunk.slice(start, newline);
        if (pendingLength + piece.length > MAX_LINE_LENGTH) failTooLong();
        yield pieces.length === 0 ? piece : [...pieces, piece].join("");
        pieces = [];
        pendingLength = 0;
        start = newline + 1;
      }
      if (start < chunk.length) {
        const rest = start === 0 ? chunk : chunk.slice(start);
        pendingLength += rest.length;
        if (pendingLength > MAX_LINE_LENGTH) failTooLong();
        pieces.push(rest);
      }
    }
    if (pendingLength > 0) yield pieces.join("");
  })();

/**
 * Returns a stream of the text the callbacks push, and the functions that push
 * and end it. Chunks pushed before anyone reads are kept.
 */
const createTextStream = (): {
  readonly stream: AsyncIterable<string>;
  readonly push: (text: string) => void;
  readonly end: () => void;
} => {
  const chunks: Array<string> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    stream: (async function* () {
      for (;;) {
        while (chunks.length > 0) yield chunks.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
    push: (text) => {
      chunks.push(text);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
  };
};

/**
 * Spawns a login process. Unlike `runProcess`, a login is read from and written to while it runs.
 *
 * With `options.terminal` the process runs in a pseudo-terminal: its one
 * output stream, which holds the escape sequences a terminal needs, is
 * returned as `stdout`, and `stderr` is empty. Without it, the process gets
 * plain pipes.
 */
export const spawnLogin: LoginSpawn = (command, env, options): LoginChild => {
  if (options?.terminal !== undefined) return spawnLoginInTerminal(command, env, options);
  const child = Bun.spawn([...command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
  });
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

/** How long to wait after a login process exits before ending its output. */
const TERMINAL_DRAIN_MS = 100;

const spawnLoginInTerminal = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  options: LoginSpawnOptions,
): LoginChild => {
  const output = createTextStream();
  const decoder = new TextDecoder();
  const child = Bun.spawn([...command], {
    env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    terminal: {
      cols: options.terminal!.cols,
      rows: options.terminal!.rows,
      data: (_terminal, bytes) => {
        output.push(decoder.decode(bytes, { stream: true }));
      },
      // The terminal reports its end after the last chunk of output.
      exit: () => {
        output.end();
      },
    },
  });
  // A killed child may never report the end of its terminal. The short wait
  // lets a terminal that does report it deliver its last output first.
  void child.exited.then(() => {
    setTimeout(() => {
      output.end();
      child.terminal?.close();
    }, TERMINAL_DRAIN_MS);
  });
  const silence: AsyncIterable<string> = (async function* () {})();
  return {
    stdout: output.stream,
    stderr: silence,
    write: (value) => {
      child.terminal?.write(value);
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
  /** Sends a signal to this child only. Without an argument it sends SIGTERM. */
  readonly kill: (signal?: StopSignal) => void;
  readonly exited: Promise<number>;
}

/**
 * A `FramedChild` whose `write` returns a promise that rejects when the line
 * could not be written to the process's stdin.
 */
export interface CheckedFramedChild extends Omit<FramedChild, "write"> {
  readonly write: (text: string) => Promise<void>;
}

/** The two signals the runner sends to stop a harness: a polite request, then a certain end. */
export type StopSignal = "SIGTERM" | "SIGKILL";

/**
 * How long a harness gets to exit after SIGTERM before `stopChild` sends it
 * SIGKILL. A text generation finishes only after its harness has exited, and
 * the controller holds the call's slot for 5 seconds past the 60 second
 * deadline (`SLOT_HOLD_MS`). The runner's own deadline starts when the call
 * arrives and the harness is stopped at the end of it, so a grace of 2 seconds
 * keeps the whole stop, SIGTERM and then SIGKILL, well inside those 5 seconds.
 */
export const STOP_GRACE: Duration.Duration = Duration.seconds(2);

/**
 * Stops a child process and waits until it has exited. Sends SIGTERM, waits up
 * to `grace` for the exit, and then sends SIGKILL to the same child and waits
 * for the exit without a limit: SIGKILL cannot be ignored, and the caller must
 * not count the process as gone while it runs. Never fails.
 *
 * A text generation uses this to release its runner slot and remove its
 * scratch folder only after the harness is really gone. Sessions use it too:
 * the Antigravity adapter stops its process with it, and the Codex and pi
 * adapters use it as part of stopping theirs.
 */
export const stopChild = (
  child: Pick<FramedChild, "kill" | "exited">,
  grace: Duration.Duration = STOP_GRACE,
): Effect.Effect<void> => {
  const signal = (name: StopSignal): Effect.Effect<void> =>
    Effect.sync(() => {
      try {
        child.kill(name);
      } catch {
        // The child has already exited, so there is nothing left to stop.
      }
    });
  const exited = Effect.promise(() => child.exited.then(noop, noop));
  return Effect.gen(function* () {
    yield* signal("SIGTERM");
    if (Option.isSome(yield* Effect.timeoutOption(exited, grace))) return;
    yield* signal("SIGKILL");
    yield* exited;
  });
};

const noop = (): void => undefined;

/** Starts a harness process with piped stdin, stdout and stderr. */
const startFramedProcess = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string | null | undefined,
) =>
  Bun.spawn([...command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
    ...(cwd === undefined || cwd === null ? {} : { cwd }),
  });

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
  const child = startFramedProcess(command, env, cwd);
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
    kill: (signal) => {
      child.kill(signal);
    },
    exited: child.exited,
  };
};

/**
 * Spawns a line-framed harness whose `write` reports failure: it returns a
 * promise that resolves once the line is written and flushed, and rejects when
 * that fails. `spawnFramed` cannot do this, so a reply to a dead process looks
 * written.
 *
 * Bun's stdin sink reports a dead process in two ways:
 *
 * - When the process is alive but closed its stdin, `write` rejects with EPIPE.
 * - When the process has exited, Bun closes the sink, and `write` resolves with
 *   `true` instead of a byte count and `flush` with `undefined`, and nothing
 *   throws. A successful write resolves with the number of bytes.
 */
export const spawnCheckedFramed = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  cwd?: string | null,
): CheckedFramedChild => {
  const child = startFramedProcess(command, env, cwd);
  return {
    stdout: splitLines(child.stdout),
    stderr: splitLines(child.stderr),
    write: async (text) => {
      const written: unknown = await child.stdin.write(text);
      await child.stdin.flush();
      if (typeof written !== "number") {
        throw new Error("The process has exited, so its stdin is closed.");
      }
    },
    end: () => {
      void child.stdin.end();
    },
    kill: (signal) => {
      child.kill(signal);
    },
    exited: child.exited,
  };
};

/** Spawns Codex's app-server, which is ended by killing it rather than by closing its stdin. */
export const spawnAppServer: AppServerSpawn = spawnFramed;

export const spawnPi: PiSpawn = spawnFramed;

export const spawnAgy: AgySpawn = spawnCheckedFramed;
