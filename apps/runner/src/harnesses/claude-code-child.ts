/**
 * Starts the Claude Code CLI on behalf of the SDK and keeps hold of the child
 * process, so a text generation can stop that exact process and wait until it
 * has exited. Imports only types from the vendor SDK.
 *
 * The SDK cannot do this itself. Its `Query.return()` closes the CLI's stdin,
 * waits up to 2 seconds for the exit, and then gives up waiting while its own
 * timers go on to send SIGTERM and, 5 seconds after that, SIGKILL. So the
 * promise settles at about 2 seconds, and the process can live until about 7
 * seconds.
 */
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import { stopChild } from "./process";

type Listener = Parameters<EventEmitter["on"]>[1];

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export interface ChildOwner {
  /**
   * The SDK's `spawnClaudeCodeProcess` option: starts the CLI and remembers the
   * child. Throws when the process cannot be started, for example when the
   * binary does not exist.
   */
  readonly spawn: (options: SpawnOptions) => SpawnedProcess;
  /**
   * Stops the child this owner started and completes once it has exited.
   * Does nothing when no child was started. Sends SIGTERM, then SIGKILL after
   * the grace of `stopChild`. Never fails.
   */
  readonly stop: Effect.Effect<void>;
}

/**
 * Creates an owner for one CLI process. The process is started as the SDK
 * starts it itself: same command, arguments, directory, environment and abort
 * signal, with stdin and stdout piped.
 *
 * The CLI's error output is discarded. A text generation's failure message is
 * stored in the audit log and shown in Settings, and error output can hold a
 * credential or quote the input, so an exit error carries only the SDK's
 * exit code message.
 */
export const createChildOwner = (): ChildOwner => {
  let child: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;

  const spawn = ({ command, args, cwd, env, signal }: SpawnOptions): SpawnedProcess => {
    let started: Bun.Subprocess<"pipe", "pipe", "ignore">;
    try {
      started = Bun.spawn([command, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env,
        signal,
        ...(cwd === undefined ? {} : { cwd }),
      });
    } catch (error) {
      // The SDK's own start reports a failed start with this prefix.
      throw new Error(
        `Failed to spawn Claude Code process: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    child = started;

    const events = new EventEmitter();
    void started.exited.then(() => {
      events.emit("exit", started.exitCode, started.signalCode);
    });

    return {
      stdin: new Writable({
        write: (chunk: Uint8Array | string, _encoding, done) => {
          // A write to a CLI that has already exited fails. The SDK listens
          // for the stream's error and treats it as the end of the CLI.
          Promise.resolve(started.stdin.write(chunk))
            .then(() => started.stdin.flush())
            .then(
              () => {
                done();
              },
              (error: unknown) => {
                done(toError(error));
              },
            );
        },
        final: (done) => {
          Promise.resolve(started.stdin.end()).then(
            () => {
              done();
            },
            (error: unknown) => {
              done(toError(error));
            },
          );
        },
      }),
      // Bun's stream and Node's differ only in their types.
      stdout: Readable.fromWeb(started.stdout as NodeReadableStream<Uint8Array>),
      get killed() {
        return started.killed;
      },
      get exitCode() {
        return started.exitCode;
      },
      get signalCode() {
        // Bun reports a signal that has no name, such as a Linux real-time
        // signal, by its number. The SDK's type allows names only, but the
        // SDK only checks whether the value is null, so a number passes
        // through unchanged.
        return started.signalCode as NodeJS.Signals | null;
      },
      kill: (name) => {
        try {
          started.kill(name);
          return true;
        } catch {
          return false;
        }
      },
      on: (event: "exit" | "error", listener: Listener) => {
        events.on(event, listener);
      },
      once: (event: "exit" | "error", listener: Listener) => {
        events.once(event, listener);
      },
      off: (event: "exit" | "error", listener: Listener) => {
        events.off(event, listener);
      },
    };
  };

  return {
    spawn,
    stop: Effect.suspend(() => {
      const owned = child;
      if (owned === undefined) return Effect.void;
      return stopChild({
        kill: (name) => {
          owned.kill(name);
        },
        exited: owned.exited,
      });
    }),
  };
};
