/**
 * A second listener for committed changes, for in-process code that follows
 * the records other domains write: it learns that a record changed, then reads
 * the record itself.
 *
 * It receives only `{ topic, id }` for each `record` change, the small part
 * every such listener needs. Nothing calls it directly: the one `AfterCommit`
 * the controller provides (`LiveTopicsLayer`) publishes each committed change
 * to the live topics and to this service.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { MutableLiveTopic } from "@hercule/contract";
import type { Change } from "./after-commit";

/** Names one record that a committed transaction changed. */
export interface RecordChange {
  readonly topic: MutableLiveTopic;
  readonly id: string;
}

/** What a subscriber holds: the records changed since it last took them. */
export interface RecordChangeSubscription {
  /**
   * Waits until a change is pending, then returns every pending record and
   * forgets them. A record that changed several times since the last take is
   * returned once.
   */
  readonly takePending: Effect.Effect<ReadonlyArray<RecordChange>>;
}

/**
 * Fans the changed records of each committed transaction out to its
 * subscribers.
 *
 * Like `AfterCommitListener.publish`, `publish` never waits: it adds the
 * records to each subscriber's set of pending records and wakes the
 * subscriber, and `withFinalTransaction` calls it while it still holds the
 * writer. A subscriber's set holds only the topics the subscriber asked for,
 * and one entry per record however often the record changed, so a subscriber
 * that is busy collects at most the records that exist.
 *
 * A subscriber that is slow or fails never touches the committed change or
 * the other subscribers. A subscriber reads the record fresh, so a change it
 * reads late or twice does no harm.
 */
export class RecordChanges extends Context.Service<
  RecordChanges,
  {
    /**
     * Adds the `record` changes in the list to every subscriber that asked
     * for their topic, and ignores the other kinds and the changes that only
     * moved a session's counts.
     */
    readonly publish: (changes: ReadonlyArray<Change>) => Effect.Effect<void>;
    /**
     * Subscribes to the changes of these topics for the life of the scope. A
     * subscription sees only what is published after it is made, so subscribe
     * before reading the state that changes are applied to.
     */
    readonly subscribe: (
      topics: ReadonlyArray<MutableLiveTopic>,
    ) => Effect.Effect<RecordChangeSubscription, never, Scope.Scope>;
  }
>()("hercule/controller/db/RecordChanges") {}

interface Subscriber {
  readonly topics: ReadonlySet<MutableLiveTopic>;
  readonly pending: Map<string, RecordChange>;
  /** Open while `pending` may hold a record. */
  readonly wake: Latch.Latch;
}

const make = Effect.sync(() => {
  const subscribers = new Set<Subscriber>();
  return RecordChanges.of({
    publish: (committed) =>
      Effect.sync(() => {
        for (const change of committed) {
          if (change._tag !== "record") continue;
          if (change.topic === "session" && change.countsOnly === true) continue;
          for (const { topics, pending, wake } of subscribers) {
            if (!topics.has(change.topic)) continue;
            pending.set(`${change.topic}/${change.id}`, { topic: change.topic, id: change.id });
            wake.openUnsafe();
          }
        }
      }),
    subscribe: (topics) =>
      Effect.gen(function* () {
        const subscriber: Subscriber = {
          topics: new Set(topics),
          pending: new Map(),
          wake: Latch.makeUnsafe(false),
        };
        subscribers.add(subscriber);
        yield* Effect.addFinalizer(() => Effect.sync(() => void subscribers.delete(subscriber)));
        return {
          // Closing the wake and emptying the set is one synchronous step, so a
          // record published after it opens the wake again and is never lost.
          takePending: Effect.andThen(
            subscriber.wake.await,
            Effect.sync(() => {
              subscriber.wake.closeUnsafe();
              const records = [...subscriber.pending.values()];
              subscriber.pending.clear();
              return records;
            }),
          ),
        };
      }),
  });
});

/** Provides `RecordChanges`. */
export const RecordChangesLayer: Layer.Layer<RecordChanges> = Layer.effect(RecordChanges)(make);
