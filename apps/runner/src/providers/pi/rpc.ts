/**
 * The client for pi's RPC mode: JSON over stdio, one command per line in, one
 * response or event per line out. pi replies to a command with a `response`
 * frame that echoes the command's `id`, and writes everything else - events
 * and its own error output - to the same pipe. This module matches responses
 * to the commands waiting for them and passes every other line on.
 *
 * Other lines are passed on without being interpreted: the normalizer decides
 * what they mean, and it also reports lines that are not JSON at all.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { FramedChild } from "../process";

/**
 * pi's stdio, split into lines, because a frame split across two reads cannot
 * be parsed. `end` closes stdin, which tells pi to flush its transcript and
 * exit.
 */
export type PiChild = FramedChild;

export type PiSpawn = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  /** The session's working directory: pi resolves relative file paths against it. */
  cwd: string | null,
) => PiChild;

export interface PiRpc {
  /**
   * Sends one command and waits for pi's response with the same id. Returns
   * the response frame. Fails with pi's error message when pi rejects the
   * command, and with a message of its own when pi exits or does not respond
   * in time.
   */
  readonly send: (
    command: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, string>;
  /**
   * Reads pi's stdout until it closes. No response reaches `send` until this
   * is running.
   */
  readonly pump: Effect.Effect<void>;
}

/**
 * How long `send` waits for pi's response. Five seconds is enough because every
 * command is local: a write to a process on this machine and a response on the
 * same pipe, never a request to a model. The runner handles session frames one
 * at a time, in order, so a pi that stops responding would otherwise block
 * every session on the machine, pings included.
 */
export const RPC_DEADLINE: Duration.Duration = Duration.seconds(5);

const GONE = "pi exited or closed its output";

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const makeRpc = (
  child: PiChild,
  /**
   * Called with each line that is not a response to a command, together with
   * the parsed JSON. Passing the parsed value saves the caller from parsing
   * every line a second time, and a turn has thousands of lines. For a line
   * that is not JSON, `frame` is undefined.
   */
  onLine: (line: string, frame: unknown) => void,
): PiRpc => {
  const pending = new Map<string, Deferred.Deferred<Record<string, unknown>, string>>();
  let next = 1;
  let gone = false;

  const settle = (frame: Record<string, unknown>): void => {
    const id = frame["id"];
    const waiting = typeof id === "string" ? pending.get(id) : undefined;
    if (waiting === undefined || typeof id !== "string") return;
    pending.delete(id);
    Deferred.doneUnsafe(
      waiting,
      frame["success"] === true
        ? Effect.succeed(frame)
        : Effect.fail(typeof frame["error"] === "string" ? frame["error"] : GONE),
    );
  };

  const deliver = (line: string): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      onLine(line, undefined);
      return;
    }
    // A bare `null` is valid JSON but not a frame. Reading `type` from it on
    // the next line would throw and stop the reader, so skip it.
    if (frame === null) return;
    if (typeof frame !== "object" || (frame as Record<string, unknown>)["type"] !== "response") {
      onLine(line, frame);
      return;
    }
    settle(frame as Record<string, unknown>);
  };

  const abandon = (): void => {
    gone = true;
    for (const [id, waiting] of pending) {
      pending.delete(id);
      Deferred.doneUnsafe(waiting, Effect.fail(GONE));
    }
  };

  return {
    send: (command) =>
      Effect.suspend(() => {
        if (gone) return Effect.fail(GONE);
        const id = `hercule-${next++}`;
        const settled = Deferred.makeUnsafe<Record<string, unknown>, string>();
        // Register the waiter before writing, because pi can respond before
        // `write` returns. Remove it again if the write itself fails.
        pending.set(id, settled);
        try {
          child.write(`${JSON.stringify({ ...command, id })}\n`);
        } catch (error) {
          pending.delete(id);
          return Effect.fail(describeError(error));
        }
        return Deferred.await(settled).pipe(
          Effect.timeoutOrElse({
            duration: RPC_DEADLINE,
            orElse: () =>
              Effect.fail(
                `pi did not answer ${String(command["type"])} within ${Duration.format(RPC_DEADLINE)}`,
              ),
          }),
          Effect.ensuring(Effect.sync(() => void pending.delete(id))),
        );
      }),

    pump: Effect.callback<void>((resume, signal) => {
      void (async () => {
        try {
          for await (const line of child.stdout) {
            if (signal.aborted) return;
            if (line.trim() !== "") deliver(line);
          }
        } catch {
          // A pipe that throws while reading means pi is gone, just like a pipe
          // that ends. Either way, the commands still waiting must fail.
        }
        if (signal.aborted) return;
        abandon();
        resume(Effect.void);
      })();
    }),
  };
};
