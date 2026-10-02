/**
 * Runs a program on this Mac, such as the Hercule binary, the user's login
 * shell or git, and waits for it to exit.
 */
import { spawn } from "node:child_process";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
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
 * How long `runProgram` keeps reading a program's output after the program
 * has exited. Output still in the pipes arrives within milliseconds, but a
 * process the program left running can hold the pipes open for good.
 */
const OUTPUT_TIME_LIMIT_AFTER_EXIT = "200 millis";

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
 * Returns one line about why a program, `programName` such as `Git`, failed
 * in `exit`: the last line it wrote to stderr, or, when it wrote none, its
 * exit code or that a signal stopped it.
 */
export const describeFailedExit = (exit: ProgramExit, programName: string): string =>
  readLastErrorLine(exit.stderr) ??
  (exit.exitCode === null
    ? `${programName} was stopped by a signal before it finished.`
    : `${programName} exited with code ${String(exit.exitCode)} and wrote no error.`);

/**
 * Returns a copy of the environment `env` without any variable whose name
 * starts with `prefix`, such as `GIT_`.
 */
export const removeVariablesWithPrefix = (
  env: NodeJS.ProcessEnv,
  prefix: string,
): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith(prefix)));

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
 * own, with no terminal, and the group's id is the program's PID.
 *
 * Once the program exits, its output is read for at most
 * `OUTPUT_TIME_LIMIT_AFTER_EXIT` more, and then the whole group is killed
 * with SIGKILL. So a process the program started and left running cannot
 * keep the effect waiting by holding the output pipes open, and nothing the
 * program started outlives it. Interrupting the effect kills the group the
 * same way; SIGKILL, because an interactive shell ignores SIGTERM.
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

    let stopped = false;
    let outputTimer: NodeJS.Timeout | undefined;
    /** Kills the program's process group and stops reading its output. Does nothing the second time. */
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(outputTimer);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Every process of the group has already exited.
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };

    // Node emits `error`, and maybe no `exit`, when the program could not be
    // started.
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (stopped) return;
      stop();
      resume(Effect.fail(new ProgramNotStarted({ code: error.code, message: error.message })));
    });
    child.on("exit", (exitCode) => {
      if (stopped) return;
      const finish = () => {
        if (stopped) return;
        stop();
        resume(Effect.succeed({ exitCode, stdout, stderr }));
      };
      // Node emits `close` once every process holding the pipes has closed
      // them, which is at once unless the program left a process running.
      child.on("close", finish);
      outputTimer = setTimeout(finish, Duration.toMillis(OUTPUT_TIME_LIMIT_AFTER_EXIT));
    });
    return Effect.sync(stop);
  });
