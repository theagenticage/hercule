/**
 * The line-framed JSON protocol pi speaks over stdio: a command per line in,
 * a response or an event per line out. Hydra owns the codec because pi answers
 * a command with a `response` frame carrying the command's own name and an
 * `id` it echoes, and writes everything else - events and its own complaints -
 * down the same pipe.
 *
 * A line that is not a response is handed on raw rather than decoded: what a
 * line means is the normalizer's business, and a line that is not JSON at all
 * is one of the cases it reports.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { FramedChild } from "../process";

/**
 * pi's stdio, framed: one item per line, because a frame split over two reads
 * is not a frame. `end` closes stdin, which is pi's own cue to flush its
 * transcript and leave.
 */
export type PiChild = FramedChild;

export type PiSpawn = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  /** The session's own directory: pi reads and writes files relative to it. */
  cwd: string | null,
) => PiChild;

export interface PiRpc {
  /**
   * Sends one command and waits for the response pi files under its id,
   * failing with what pi said when it refused.
   */
  readonly send: (
    command: Record<string, unknown>,
  ) => Effect.Effect<Record<string, unknown>, string>;
  /** Reads pi until it stops talking; nothing is answered before it runs. */
  readonly pump: Effect.Effect<void>;
}

/**
 * How long a command to pi waits. Five seconds, which is short because every
 * command here is local: a write to a process on this machine and its answer
 * off the same pipe, never a request to a model. The runner handles session
 * frames in the order they arrived rather than concurrently, so one pi that
 * stops answering would otherwise hold up every session on the machine, pings
 * included.
 */
export const RPC_DEADLINE: Duration.Duration = Duration.seconds(5);

const GONE = "pi stopped talking";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const rpcOver = (
  child: PiChild,
  /**
   * One line that was not an answer to a command, decoded where it could be:
   * the reader would otherwise decode every line a second time, and a turn is
   * thousands of them. A line that is not JSON at all arrives undecoded.
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
    // A bare `null` is valid JSON and no frame at all: read on as one, it is an
    // event with no type, and the reader would die on the line rather than
    // skip it.
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
        const id = `hydra-${next++}`;
        const settled = Deferred.makeUnsafe<Record<string, unknown>, string>();
        // Registered before the write, because pi can answer inside it, and
        // taken back out again when the write is what failed.
        pending.set(id, settled);
        try {
          child.write(`${JSON.stringify({ ...command, id })}\n`);
        } catch (error) {
          pending.delete(id);
          return Effect.fail(describe(error));
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
          // A pipe that threw mid-read is a peer that has gone, same as one
          // that ended, and the commands waiting on it must hear so either way.
        }
        if (signal.aborted) return;
        abandon();
        resume(Effect.void);
      })();
    }),
  };
};
