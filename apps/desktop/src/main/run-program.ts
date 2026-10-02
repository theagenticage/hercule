/**
 * Runs a program on this Mac, such as the Hercule binary, the user's login
 * shell or git, and waits for it to exit.
 */
import { spawn } from "node:child_process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** How a program exited, and what it wrote. */
export interface ProgramExit {
  /** The program's exit code, or null when a signal stopped it. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The error `runProgram` fails with when the program could not be started.
 * `code` is the system's error code, such as `ENOENT` when there is no file
 * at the program's path.
 */
export class ProgramNotStarted extends Data.TaggedError("ProgramNotStarted")<{
  readonly code: string | undefined;
  readonly message: string;
}> {}

/**
 * Returns the last line a program wrote to stderr, `stderr`, without the
 * spaces around it, or undefined when it wrote none. A program that fails
 * usually writes why on its last line.
 */
export const readLastErrorLine = (stderr: string): string | undefined =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "");

/**
 * Runs the program at `file` with `args`, without a shell, and returns how it
 * exited once it has. Fails with ProgramNotStarted when the program could not
 * be started. A program that exits with an error code succeeds: the caller
 * reads its exit code.
 *
 * - `env` is the program's whole environment. When `file` is a bare name, it
 *   is looked up on `env.PATH`.
 * - `cwd` is the folder the program runs in; by default, main's.
 *
 * The program's stdin is closed, so a program that asks a question gets no
 * answer and cannot wait for one. The program runs in a process group of its
 * own, with no terminal. Interrupting the returned effect kills that group,
 * whose id is the program's PID, with SIGKILL: an interactive shell ignores
 * SIGTERM, and the group includes what the program started.
 */
export const runProgram = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly env: NodeJS.ProcessEnv; readonly cwd?: string },
): Effect.Effect<ProgramExit, ProgramNotStarted> =>
  Effect.callback<ProgramExit, ProgramNotStarted>((resume) => {
    const child = spawn(file, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Node emits `close` after `error` too, so the effect resumes once, there.
    let startError: NodeJS.ErrnoException | undefined;
    child.on("error", (error: NodeJS.ErrnoException) => {
      startError = error;
    });
    child.on("close", (exitCode) => {
      resume(
        startError === undefined
          ? Effect.succeed({ exitCode, stdout, stderr })
          : Effect.fail(
              new ProgramNotStarted({ code: startError.code, message: startError.message }),
            ),
      );
    });
    return Effect.sync(() => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group has already exited.
      }
    });
  });
