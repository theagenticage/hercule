/**
 * The user's `PATH`, as their login shell sets it. A Mac app inherits
 * launchd's minimal `PATH`, and the Service Unit records the `PATH` of the
 * command that installs it (spec 15 §4). Without the user's own, the runner
 * would find no `claude`, `codex` or `git`.
 */
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { runProgram } from "./run-program";

/** The error the read fails with. `reason` is one sentence a user can read. */
export class LoginShellPathError extends Data.TaggedError("LoginShellPathError")<{
  readonly reason: string;
}> {}

/** How long the login shell may take to start and print its environment. */
const SHELL_TIME_LIMIT = "5 seconds";

/** The user's login shell. */
export class LoginShell extends Context.Service<
  LoginShell,
  {
    /**
     * Returns the `PATH` the user's login shell sets. Fails with
     * LoginShellPathError, saying why, when it cannot be read; there is no
     * other `PATH` to fall back on, because the Service Unit must not
     * record one the user does not have.
     */
    readonly readPath: Effect.Effect<string, LoginShellPathError>;
  }
>()("hercule/desktop/LoginShell") {}

/**
 * Returns the text between the first and the last `marker` in `output`, or
 * null when `output` holds fewer than two markers.
 */
export const findBetweenMarkers = (output: string, marker: string): string | null => {
  const start = output.indexOf(marker);
  const end = output.lastIndexOf(marker);
  return start === -1 || end === start ? null : output.slice(start + marker.length, end);
};

/**
 * Returns the value of `PATH` in `environment`, the output of `env -0`: one
 * `NAME=value` entry per variable, each ending with a NUL character. Returns
 * null when `environment` holds no `PATH`.
 *
 * NUL is the one character no value can hold, so a value with a line break
 * in it cannot pass for another variable.
 */
export const findPathVariable = (environment: string): string | null =>
  environment
    .split("\0")
    .find((entry) => entry.startsWith("PATH="))
    ?.slice("PATH=".length) ?? null;

/**
 * Reads `PATH` from the shell at `shell`, run as a login, interactive shell:
 * `<shell> -ilc <command>`. Many `PATH` lines live in `.zshrc`, which only an
 * interactive zsh reads.
 *
 * The command runs `/usr/bin/env -0`, which prints the environment the shell
 * passes to programs, so `PATH` arrives as the colon-separated list every
 * program reads. Printing `$PATH` itself would not do: fish expands it to a
 * list separated by spaces. The environment is printed between two copies of
 * a marker no startup file prints, so whatever the startup files print, such
 * as a greeting, is dropped. The shell's stdin is closed, so a startup file
 * that asks a question gets no answer, and the shell is stopped after
 * `SHELL_TIME_LIMIT`, so one that hangs cannot hang the start.
 *
 * Fails with LoginShellPathError when the shell cannot be started, exits
 * with an error, prints no marked `PATH` or an empty one, or runs longer
 * than `SHELL_TIME_LIMIT`.
 */
export const readLoginShellPath = (shell: string): Effect.Effect<string, LoginShellPathError> =>
  Effect.gen(function* () {
    const marker = `__PATH_${randomUUID()}__`;
    const exit = yield* runProgram(
      shell,
      ["-ilc", `printf '%s' '${marker}'; /usr/bin/env -0; printf '%s' '${marker}'`],
      { env: process.env },
    ).pipe(
      Effect.mapError(
        (error) =>
          new LoginShellPathError({
            reason: `Your login shell, ${shell}, could not be started: ${error.message}`,
          }),
      ),
      Effect.timeoutOrElse({
        duration: SHELL_TIME_LIMIT,
        orElse: () =>
          Effect.fail(
            new LoginShellPathError({
              reason: `Your login shell, ${shell}, did not print your PATH within ${String(Duration.toSeconds(SHELL_TIME_LIMIT))} seconds. Check that its startup files do not wait for input.`,
            }),
          ),
      }),
    );
    if (exit.exitCode !== 0) {
      return yield* new LoginShellPathError({
        reason: `Your login shell, ${shell}, exited with code ${String(exit.exitCode)} while it printed your PATH.`,
      });
    }
    const environment = findBetweenMarkers(exit.stdout, marker);
    const path = environment === null ? null : findPathVariable(environment);
    if (path === null || path === "") {
      return yield* new LoginShellPathError({
        reason: `Your login shell, ${shell}, did not print your PATH.`,
      });
    }
    return path;
  });

/**
 * The service on the user's login shell: `$SHELL`, or the shell of the
 * user's account when `SHELL` is not set, as for an app opened from the
 * Finder. Each call reads `PATH` again.
 */
export const LoginShellLayer: Layer.Layer<LoginShell> = Layer.succeed(LoginShell)({
  readPath: Effect.suspend(() =>
    // macOS gives every account a shell; zsh is its default.
    readLoginShellPath(process.env.SHELL ?? userInfo().shell ?? "/bin/zsh"),
  ),
});
