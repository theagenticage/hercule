/**
 * Process logs: where a Hercule process writes its own log lines.
 *
 * Each process writes its own file under `<home>/logs/`: the controller writes
 * `controller.log`, and every runner, the controller's local runner included,
 * writes `runner.log`. A process that writes its own file can rotate it
 * itself, so the logs stay bounded whoever started the process: a terminal, a
 * service unit or the controller. A supervisor that collected the output
 * would need its own rotation on every platform.
 *
 * A log line never goes to stdout. The local runner's stdout carries the line
 * it announces itself with to the controller, and a service unit discards
 * stdout. When stderr is a terminal, every line is also shown there, so
 * `hercule serve` in a terminal still shows what it logs.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as EffectLogLevel from "effect/LogLevel";
import * as References from "effect/References";
import { locateLogsDir, type LogLevel } from "@hercule/home";
import { openRotatingFile } from "./rotating-file";

/** The size at which a log file is rotated: 10 MiB. */
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;

/** The Effect log level each `log.level` value stands for. */
const EFFECT_LOG_LEVELS = {
  fatal: "Fatal",
  error: "Error",
  warn: "Warn",
  info: "Info",
  debug: "Debug",
  trace: "Trace",
} as const satisfies Record<LogLevel, EffectLogLevel.LogLevel>;

/**
 * Returns a layer that sends every log line of the program it is provided to
 * into `<home>/logs/<role>.log`, and echoes it to stderr when stderr is a
 * terminal.
 *
 * The layer:
 *
 * - creates `<home>/logs` with mode 0700, and sets that mode on an existing
 *   folder;
 * - opens the log file with mode 0600 and closes it when the layer's scope
 *   closes;
 * - rotates the file at `MAX_LOG_FILE_BYTES`, keeping five old files;
 * - writes one logfmt line per entry;
 * - replaces every other logger, so nothing reaches stdout;
 * - drops entries below `level`.
 *
 * Opening the folder or the file can fail, and the process cannot run without
 * its log, so that failure is a defect with the filesystem error in it.
 */
export function processLogLayer(options: {
  readonly home: string;
  readonly role: "controller" | "runner";
  readonly level: LogLevel;
}): Layer.Layer<never> {
  const logsDir = locateLogsDir(options.home);
  const path = join(logsDir, `${options.role}.log`);

  const fileLogger = Effect.acquireRelease(
    Effect.sync(() => {
      mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      // `mode` applies only when the folder is created, and the edge installer
      // creates it with the default mode.
      chmodSync(logsDir, 0o700);
      return openRotatingFile(path, MAX_LOG_FILE_BYTES);
    }),
    (file) => Effect.sync(() => file.close()),
  ).pipe(
    Effect.map((file) =>
      Logger.map(Logger.formatLogFmt, (line) => {
        try {
          file.append(`${line}\n`);
        } catch (error) {
          // A logger that throws fails whichever operation logged, so a full
          // disk would break requests that have nothing to do with logging.
          // The line is reported on stderr instead, which a service unit
          // keeps in `<role>.stderr.log`.
          process.stderr.write(`hercule: cannot write to ${path}: ${String(error)}\n`);
        }
      }),
    ),
  );

  // `consolePretty` colours by whether stdout is a terminal, and the echo goes
  // to stderr, so the colours follow stderr here.
  const loggers =
    process.stderr.isTTY === true
      ? [fileLogger, Logger.consolePretty({ colors: true })]
      : [fileLogger];

  return Layer.mergeAll(
    Logger.layer(loggers),
    // Only the echo writes to the console, and this sends it to stderr.
    Layer.succeed(Logger.LogToStderr, true),
    Layer.succeed(References.MinimumLogLevel, EFFECT_LOG_LEVELS[options.level]),
  );
}
