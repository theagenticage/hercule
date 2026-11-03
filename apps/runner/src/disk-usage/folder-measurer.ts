/**
 * Measures one folder in a child process at a low priority. The child is the
 * `measure-disk-usage` verb of this same binary (see `measure-main.ts`).
 * A walk of a big folder reads every file's metadata, so it runs in its own
 * process: the runner keeps its own priority, and a stuck walk is killed
 * by its PID instead of being left to run in the daemon.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { locateCompiledBinary } from "@hercule/home";
import type { FolderUsage } from "./walker";

/** How long one walk may run before it is killed. */
export const MEASURE_DEADLINE: Duration.Duration = Duration.minutes(10);

/** What a walk that passed its deadline reports. It names the default deadline, which is the only one a user can meet. */
export const DEADLINE_MESSAGE = "Measuring took longer than 10 minutes";

/** The most the child may print on stdout. Its answer is one short line. */
const MAX_STDOUT_BYTES = 4096;

/** The most of the child's stderr that is kept for the error text. */
const MAX_STDERR_BYTES = 2048;

/** A walk failed: the child reported an error, could not start, or passed its deadline. */
export class MeasuringFailed extends Schema.TaggedError<MeasuringFailed>()("MeasuringFailed", {
  message: Schema.String,
}) {}

/** Measures a folder and returns its space. Fails with `MeasuringFailed`. */
export type MeasureFolder = (folder: string) => Effect.Effect<FolderUsage, MeasuringFailed>;

export interface FolderMeasurerOptions {
  /** Defaults to `MEASURE_DEADLINE`. Tests set a shorter one. */
  readonly deadline?: Duration.Duration;
  /**
   * Returns the command that measures `folder`. Defaults to this binary's
   * `measure-disk-usage` verb, run under `nice` and, on Linux, `ionice`.
   * Tests pass their own command.
   */
  readonly buildCommand?: (folder: string) => ReadonlyArray<string>;
}

/**
 * Returns the command that runs the walker on `folder`: this executable (and
 * the entry script, when running from source rather than the compiled binary),
 * the verb, and the folder, behind `nice -n 19` and, on Linux, `ionice -c 3`.
 * Each wrapper replaces itself with the next command, so the PID the runner
 * holds is the walker's own and a kill reaches it. The command is an argument
 * list, never a shell line, so a folder name needs no quoting.
 */
export const buildWalkerCommand = (
  folder: string,
  options: { readonly withIonice: boolean },
): ReadonlyArray<string> => [
  "nice",
  "-n",
  "19",
  ...(options.withIonice ? ["ionice", "-c", "3"] : []),
  process.execPath,
  ...(locateCompiledBinary() === undefined ? [Bun.main] : []),
  "measure-disk-usage",
  folder,
];

/** Reads `stream` until it ends or `limit` bytes are read. `truncated` is true when more was waiting. */
const readAtMost = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return {
    text: Buffer.concat(chunks).subarray(0, limit).toString("utf8"),
    truncated: length > limit,
  };
};

const decodeUsage = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      freesBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
);

/**
 * Runs `command` and returns the usage it prints. Kills the process, by the
 * PID it started, when the deadline passes or when the caller stops waiting,
 * and waits for it to exit so no zombie is left.
 */
const runWalker = (
  command: ReadonlyArray<string>,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<FolderUsage> =>
  (async () => {
    const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const kill = (): void => {
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", kill);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, deadlineMs);
    try {
      const [stdout, stderr] = await Promise.all([
        readAtMost(child.stdout, MAX_STDOUT_BYTES).then((read) => {
          // A walker that floods its output is not printing a number.
          if (read.truncated) kill();
          return read;
        }),
        readAtMost(child.stderr, MAX_STDERR_BYTES),
      ]);
      await child.exited;
      if (timedOut) throw new Error(DEADLINE_MESSAGE);
      if (child.exitCode !== 0)
        throw new Error(
          stderr.text.trim() || `The walker exited with code ${String(child.exitCode)}`,
        );
      const usage = decodeUsage(stdout.text);
      if (usage._tag === "Failure")
        throw new Error("The walker printed something that is not a disk usage");
      return usage.success;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (child.exitCode === null) kill();
      await child.exited;
    }
  })();

/**
 * Returns a `MeasureFolder`. The returned function starts one child per call,
 * so callers decide how many run at once. On Linux, when `ionice` is not
 * installed, the walker runs under `nice` alone and the runner's log says so,
 * once.
 */
export const makeFolderMeasurer = (options: FolderMeasurerOptions = {}): MeasureFolder => {
  const deadlineMs = Duration.toMillis(options.deadline ?? MEASURE_DEADLINE);
  const withIonice = process.platform === "linux" && Bun.which("ionice") !== null;
  const warnMissingIonice =
    process.platform === "linux" && !withIonice
      ? Effect.logWarning(
          "ionice is not installed, so disk usage walks run under nice only and may slow the disk for sessions",
        )
      : Effect.void;
  let warned = false;
  return (folder) =>
    Effect.gen(function* () {
      if (!warned) {
        warned = true;
        yield* warnMissingIonice;
      }
      const command = options.buildCommand?.(folder) ?? buildWalkerCommand(folder, { withIonice });
      return yield* Effect.tryPromise({
        try: (signal) => runWalker(command, deadlineMs, signal),
        catch: (error) =>
          new MeasuringFailed({ message: error instanceof Error ? error.message : String(error) }),
      });
    });
};
