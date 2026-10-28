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
import * as Schema from "effect/Schema";
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

/**
 * The failure of `send` when pi answered the command with an error. pi read
 * the command and refused it, so the command did not take effect. `message`
 * is pi's own error text.
 */
export class PiRefusedCommand extends Schema.TaggedError<PiRefusedCommand>()("PiRefusedCommand", {
  message: Schema.String,
}) {}

/**
 * The failure of `send` when pi exited, or closed its output, before it
 * answered. It is not known whether pi acted on the command first.
 */
export class PiExited extends Schema.TaggedError<PiExited>()("PiExited", {
  message: Schema.String,
}) {}

/**
 * The failure of `send` when the command could not be written to pi. It is
 * not known whether pi acted on the command.
 */
export class PiUnreachable extends Schema.TaggedError<PiUnreachable>()("PiUnreachable", {
  message: Schema.String,
}) {}

/**
 * The failure of `send` when pi did not respond within the command's
 * deadline. Pi may be busy rather than gone, and it is not known whether it
 * acted on the command.
 */
export class PiTimedOut extends Schema.TaggedError<PiTimedOut>()("PiTimedOut", {
  message: Schema.String,
}) {}

/** Every failure of `send`, told apart by `_tag`. */
export type PiRpcFailure = PiRefusedCommand | PiExited | PiUnreachable | PiTimedOut;

export interface PiRpc {
  /**
   * Sends one command and waits for pi's response with the same id. Returns
   * the response frame. Fails with `PiRefusedCommand` when pi answers with an
   * error, `PiExited` when pi exits before it answers, `PiUnreachable` when
   * the write fails, and `PiTimedOut` when pi does not answer in time. Only
   * `PiRefusedCommand` proves that the command did not take effect.
   */
  readonly send: (
    command: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, PiRpcFailure>;
  /**
   * Reads pi's stdout until it closes. No response reaches `send` until this
   * is running.
   */
  readonly pump: Effect.Effect<void>;
}

/**
 * How long `send` waits for pi's response to any command. The runner handles
 * a session's frames one at a time, in order, so a pi that stops responding
 * would otherwise block every later frame of its session.
 *
 * Most commands only change pi's own state: a write to a process on this
 * machine and a response on the same pipe. `prompt` is the exception. pi
 * (0.85.1, `AgentSession.prompt`) acknowledges it only after its preflight,
 * and the preflight can wait on a model: when the context is nearly full it
 * first compacts it, which asks the model for a summary. `set_model` can wait
 * on the network too, to refresh an expired login. When that takes longer
 * than this deadline, the input fails with `HarnessProtocolError` and the
 * session keeps running.
 *
 * The deadline must stay inside the controller's `SESSION_INPUT_DEADLINE`
 * (10 seconds). The controller stops waiting for an input after that, puts it
 * back in the queue, and ignores a later answer. A runner that waited longer
 * would report a failure the controller has dropped, and the requeued input
 * would run again. A longer wait for a slow preflight needs a way to settle
 * an input whose delivery is unknown, which a follow-up has to add.
 */
export const RPC_DEADLINE: Duration.Duration = Duration.seconds(5);

/** The message of the `PiExited` failure: pi exited, or closed its output, before it responded. */
const PI_GONE = "pi exited or closed its output";

/** Returns the message of an error, or the text of any other thrown value. */
export const describeError = (error: unknown): string =>
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
  const pending = new Map<string, Deferred.Deferred<Record<string, unknown>, PiRpcFailure>>();
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
        : Effect.fail(
            new PiRefusedCommand({
              message:
                typeof frame["error"] === "string"
                  ? frame["error"]
                  : "pi rejected the command without giving a reason",
            }),
          ),
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
      Deferred.doneUnsafe(waiting, Effect.fail(new PiExited({ message: PI_GONE })));
    }
  };

  return {
    send: (command) =>
      Effect.suspend(() => {
        if (gone) return Effect.fail(new PiExited({ message: PI_GONE }));
        const id = `hercule-${next++}`;
        const settled = Deferred.makeUnsafe<Record<string, unknown>, PiRpcFailure>();
        // Register the waiter before writing, because pi can respond before
        // `write` returns. Remove it again if the write itself fails.
        pending.set(id, settled);
        try {
          child.write(`${JSON.stringify({ ...command, id })}\n`);
        } catch (error) {
          pending.delete(id);
          return Effect.fail(new PiUnreachable({ message: describeError(error) }));
        }
        return Deferred.await(settled).pipe(
          Effect.timeoutOrElse({
            duration: RPC_DEADLINE,
            orElse: () =>
              Effect.fail(
                new PiTimedOut({
                  message: `pi did not answer ${String(command["type"])} within ${Duration.format(RPC_DEADLINE)}`,
                }),
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
