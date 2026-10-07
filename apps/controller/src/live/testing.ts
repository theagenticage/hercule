/**
 * Test helpers for Live Topics, for tests that hold a subscription through
 * the `LiveTopics` service rather than over the socket.
 */
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type { MutableLiveTopic } from "@hercule/contract";
import { LiveTopics, type LiveQueue } from "./topics";

/**
 * Opens a subscription to a mutable topic, takes its first message, and
 * returns the subscription's queue. Every mutable subscription opens with a
 * push that says every record may have changed. That push is the same
 * whatever the test does, so a test that reads the queue afterwards sees
 * only the pushes its own changes caused.
 */
export const subscribeSkippingFirstPush = (
  topic: MutableLiveTopic,
): Effect.Effect<LiveQueue, never, LiveTopics | Scope.Scope> =>
  Effect.gen(function* () {
    const topics = yield* LiveTopics;
    const queue = yield* topics.subscribe(topic);
    yield* Effect.orDie(Queue.take(queue));
    return queue;
  });
