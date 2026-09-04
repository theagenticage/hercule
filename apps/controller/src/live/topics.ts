/**
 * What the controller holds for the clients watching a Live Topic.
 *
 * One queue per subscription, grouped by topic. A subscription is taken out for
 * the length of the caller's scope and given back when that scope closes, which
 * is what the client ending its stream and the socket dropping both come down
 * to, so a connection that goes away leaves nothing behind.
 *
 * Nothing writes into these queues yet; a topic's publisher arrives with the
 * records it announces.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type { LiveMessage, LiveTopic } from "@hydra/contract";

const make = Effect.sync(() => {
  const watchers = new Map<LiveTopic, Set<Queue.Queue<LiveMessage>>>();

  const watchersOf = (topic: LiveTopic): Set<Queue.Queue<LiveMessage>> => {
    const existing = watchers.get(topic);
    if (existing !== undefined) return existing;
    const created = new Set<Queue.Queue<LiveMessage>>();
    watchers.set(topic, created);
    return created;
  };

  return {
    /** A subscription to one topic, held for the length of the current scope. */
    subscribe: (topic: LiveTopic): Effect.Effect<Queue.Dequeue<LiveMessage>, never, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.map(Queue.make<LiveMessage>(), (queue) => {
          watchersOf(topic).add(queue);
          return queue;
        }),
        (queue) =>
          Effect.andThen(
            Effect.sync(() => {
              const set = watchers.get(topic);
              if (set === undefined) return;
              set.delete(queue);
              if (set.size === 0) watchers.delete(topic);
            }),
            Queue.shutdown(queue),
          ),
      ),

    /** How many subscriptions this controller is holding for a topic. */
    subscriberCount: (topic: LiveTopic): Effect.Effect<number> =>
      Effect.sync(() => watchers.get(topic)?.size ?? 0),
  };
});

/** The Live Topics this controller is serving. */
export class LiveTopics extends Context.Service<LiveTopics, Effect.Success<typeof make>>()(
  "hydra/controller/live/LiveTopics",
) {}

export const LiveTopicsLayer: Layer.Layer<LiveTopics> = Layer.effect(LiveTopics)(make);
