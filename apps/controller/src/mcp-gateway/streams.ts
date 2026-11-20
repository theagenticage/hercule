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
  /** Queues `list_changed` on the stream. Does nothing once the stream has ended. */
  readonly notifyListChanged: Effect.Effect<void>;
  /** Ends the stream: queues the closing message, if any, and completes the response body. */
  readonly end: Effect.Effect<void>;
}

/** How a stream is built. */
export interface StreamSpec {
  readonly mcpSessionId: string | undefined;
  /** The message that tells the client the list changed. */
  readonly listChanged: unknown;
  /** Messages sent before everything else, such as the acknowledgement of a listen. */
  readonly opening: ReadonlyArray<unknown>;
  /** The message sent when the gateway ends the stream, such as the result of a listen. */
  readonly closing?: unknown;
  /** Adds the stream to the Session Token's open streams. Runs before the first message is queued. */
  readonly register: (stream: OpenStream) => Effect.Effect<void>;
  /** Removes it again, when the response ends for any reason. */
  readonly unregister: (stream: OpenStream) => Effect.Effect<void>;
}

/**
 * Builds the body of a server-sent event response. The stream is registered
 * when the response starts to be read, then queues its opening messages and
 * one `list_changed`, so a change between the client's last `tools/list` and
 * the stream's start is not missed. It sends a comment every 30 seconds and
 * is unregistered when the response ends, whether the client left or the
 * gateway ended it.
 */
export const buildServerSentBody = (spec: StreamSpec): Stream.Stream<Uint8Array> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const send = (message: unknown) => Queue.offer(queue, encodeServerSentEvent(message));
      const stream: OpenStream = {
        mcpSessionId: spec.mcpSessionId,
        notifyListChanged: Effect.asVoid(send(spec.listChanged)),
        end: Effect.gen(function* () {
          if (spec.closing !== undefined) yield* send(spec.closing);
          yield* Queue.end(queue);
        }),
      };
      yield* spec.register(stream);
      for (const message of spec.opening) yield* send(message);
      yield* stream.notifyListChanged;
      return Stream.fromQueue(queue).pipe(
        Stream.merge(
          Stream.tick(KEEPALIVE_INTERVAL).pipe(Stream.map(() => SERVER_SENT_KEEPALIVE)),
          { haltStrategy: "left" },
        ),
        Stream.ensuring(spec.unregister(stream)),
      );
    }),
  );
