/**
 * The stdio the vendored client reads and writes, built from the pipes of the
 * harness. It imports nothing from the vendored client: the `Stdio` it returns
 * is the one the client expects.
 */
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import type { AcpPipes } from "./types";
import type { RefusedRequest, WireMemory } from "./wire";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const buildPlatformError = (
  method: "read" | "write",
  description: string,
): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: "Unknown", module: "AcpConnection", method, description });

/**
 * Returns a stdio that reads the lines of `pipes.stdout` and writes to
 * `pipes.write`.
 *
 * - Each line read goes through `wire.noteLineRead` before the client sees it.
 *   A line that ends the connection never reaches the client. A line that is
 *   only reported goes to `report` and on to the client.
 * - Reading stops as soon as `connectionEnded` completes, so nothing the
 *   harness sends after the end reaches a handler.
 * - Each line the client writes goes through `wire.noteLineWritten`, and then
 *   to the harness. `onRefusedRequest` runs for an error the client wrote in
 *   answer to a request of the harness.
 * - `end` runs with the reason when reading or writing fails. A failed write
 *   fails the client's writer, which ends its connection.
 */
export const createHarnessStdio = (options: {
  readonly pipes: AcpPipes;
  readonly wire: WireMemory;
  readonly connectionEnded: Effect.Effect<unknown>;
  readonly end: (message: string) => void;
  readonly report: (reason: string, payload: unknown) => Effect.Effect<void>;
  readonly onRefusedRequest: (refused: RefusedRequest) => Effect.Effect<void>;
}): Stdio.Stdio => {
  const { pipes, wire, connectionEnded, end, report, onRefusedRequest } = options;
  return Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromAsyncIterable(pipes.stdout, (cause) => {
      // The exception of a pipe may hold text of the harness.
      const description = wire.quoteHarnessText(String(cause));
      end(`The harness's output failed: ${description}`);
      return buildPlatformError("read", description);
    }).pipe(
      Stream.filterEffect((line) => {
        const problem = wire.noteLineRead(line);
        if (problem === undefined) return Effect.succeed(true);
        if (problem.endsConnection) {
          end(problem.reason);
          return Effect.succeed(false);
        }
        return report(problem.reason, wire.getLastLineRead().message).pipe(Effect.as(true));
      }),
      Stream.map((line) => encoder.encode(`${line}\n`)),
      Stream.interruptWhen(connectionEnded),
    ),
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) => {
        const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
        const refused = wire.noteLineWritten(text);
        return Effect.try({
          try: () => pipes.write(text),
          catch: (cause) => {
            const description = wire.quoteHarnessText(String(cause));
            end(`Could not write to the harness: ${description}`);
            return buildPlatformError("write", description);
          },
        }).pipe(
          Effect.andThen(() => (refused === undefined ? Effect.void : onRefusedRequest(refused))),
        );
      }),
    stderr: () => Sink.drain,
  });
};
