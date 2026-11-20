/**
 * The long-lived server-sent event responses of the gateway: the GET stream of
 * a stateful MCP session and the `subscriptions/listen` response of the
 * stateless era. Each is a stream the gateway can write `list_changed` to and
 * end, while the HTTP response drains it.
 */
import type * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { encodeServerSentEvent, SERVER_SENT_KEEPALIVE } from "./protocol";

/** How often a stream with nothing to say sends a comment. Bun's idle timeout is 255 seconds. */
const KEEPALIVE_INTERVAL = Duration.seconds(30);

/** One open response the gateway can write to. */
export interface OpenStream {
  /** The stateful MCP session this stream belongs to, or `undefined` for a `subscriptions/listen` response. */
  readonly mcpSessionId: string | undefined;
  /**
   * The fingerprint of the tool list this stream was last told about, or
   * `undefined` before it was told. `list_changed` is decided per stream
   * against it, so a client's own `tools/list` never hides a change from
   * another client of the same token.
   */
  told: string | undefined;
  /** Queues `list_changed` on the stream. Does nothing once the stream has ended, or for a listen that did not ask for it. */
  readonly notifyListChanged: Effect.Effect<void>;
  /** Ends the stream: queues the closing message, if any, and completes the response body. */
  readonly end: Effect.Effect<void>;
}

/** How a stream is built. */
export interface StreamSpec {
  readonly mcpSessionId: string | undefined;
  /** The message that tells the client the list changed, or `undefined` when the client did not ask for it. */
  readonly listChanged?: unknown;
  /** Messages sent before everything else, such as the acknowledgement of a listen. */
  readonly opening: ReadonlyArray<unknown>;
  /** The message sent when the gateway ends the stream, such as the result of a listen. */
  readonly closing?: unknown;
  /**
   * Checks that the stream may open and adds it to the Session Token's open
   * streams. Runs when the response body is first read, before any message is
   * queued. Returns `false` when it may not open any more (the token ended,
   * the controller froze, the MCP session ended), and then the body is empty.
   */
  readonly admit: (stream: OpenStream) => Effect.Effect<boolean>;
  /** Removes an admitted stream again, when the response ends for any reason. */
  readonly release: (stream: OpenStream) => Effect.Effect<void>;
}

/**
 * Builds the body of a server-sent event response. The stream is admitted
 * when the response starts to be read, because only then do the token, the
 * phase and the MCP session decide whether it may exist. It then queues its
 * opening messages and one `list_changed`, so a change between the client's
 * last `tools/list` and the stream's start is not missed. It sends a comment
 * every 30 seconds and is released when the response ends, whether the client
 * left or the gateway ended it.
 */
export const buildServerSentBody = (spec: StreamSpec): Stream.Stream<Uint8Array> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const send = (message: unknown) => Queue.offer(queue, encodeServerSentEvent(message));
      const stream: OpenStream = {
        mcpSessionId: spec.mcpSessionId,
        told: undefined,
        notifyListChanged:
          spec.listChanged === undefined ? Effect.void : Effect.asVoid(send(spec.listChanged)),
        end: Effect.gen(function* () {
          if (spec.closing !== undefined) yield* send(spec.closing);
          yield* Queue.end(queue);
        }),
      };
      const admitted = yield* Effect.acquireRelease(spec.admit(stream), (wasAdmitted) =>
        wasAdmitted ? spec.release(stream) : Effect.void,
      );
      if (!admitted) return Stream.empty;
      for (const message of spec.opening) yield* send(message);
      yield* stream.notifyListChanged;
      return Stream.fromQueue(queue).pipe(
        Stream.merge(
          Stream.tick(KEEPALIVE_INTERVAL).pipe(Stream.map(() => SERVER_SENT_KEEPALIVE)),
          { haltStrategy: "left" },
        ),
      );
    }),
  );
