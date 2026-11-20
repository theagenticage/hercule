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
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type { MutableLiveTopic } from "@hercule/contract";
import type { Change } from "./after-commit";

/** Names one record that a committed transaction changed. */
export interface RecordChange {
  readonly topic: MutableLiveTopic;
  readonly id: string;
}

/**
 * Fans the changed records of each committed transaction out to its
 * subscribers.
 *
 * Like `AfterCommitListener.publish`, `publish` never waits: every subscriber
 * has an unbounded queue of these small items, and `withFinalTransaction`
 * calls `publish` while it still holds the writer. A subscriber's queue holds
 * only the topics the subscriber asked for, so a follower of two topics does
 * not collect every other record change of the controller.
 *
 * A subscriber that is slow or fails never touches the committed change or
 * the other subscribers. A subscriber reads the record fresh, so a change it
 * reads late or twice does no harm.
 */
export class RecordChanges extends Context.Service<
  RecordChanges,
  {
    /**
     * Offers the `record` changes in the list to every subscriber that asked
     * for their topic, and ignores the other kinds and the changes that only
     * moved a session's counts.
     */
    readonly publish: (changes: ReadonlyArray<Change>) => Effect.Effect<void>;
    /**
     * Subscribes to the changes of these topics for the life of the scope.
     * Take from the returned queue with `Queue.takeAll`, which waits for the
     * next change and takes every change published since. A subscription sees
     * only what is published after it is made, so subscribe before reading the
     * state that changes are applied to.
     */
    readonly subscribe: (
      topics: ReadonlyArray<MutableLiveTopic>,
    ) => Effect.Effect<Queue.Dequeue<RecordChange>, never, Scope.Scope>;
  }
>()("hercule/controller/db/RecordChanges") {}

interface Subscriber {
  readonly topics: ReadonlySet<MutableLiveTopic>;
  readonly queue: Queue.Queue<RecordChange>;
}

const make = Effect.sync(() => {
  const subscribers = new Set<Subscriber>();
  return RecordChanges.of({
    publish: (committed) => {
      const records: Array<RecordChange> = [];
      for (const change of committed) {
        if (change._tag !== "record") continue;
        if (change.topic === "session" && change.countsOnly === true) continue;
        records.push({ topic: change.topic, id: change.id });
      }
      return Effect.forEach(
        [...subscribers],
        ({ topics, queue }) => {
          const wanted = records.filter((record) => topics.has(record.topic));
          return wanted.length === 0 ? Effect.void : Queue.offerAll(queue, wanted);
        },
        { discard: true },
      );
    },
    subscribe: (topics) =>
      Effect.gen(function* () {
        const subscriber: Subscriber = {
          topics: new Set(topics),
          queue: yield* Queue.unbounded<RecordChange>(),
        };
        subscribers.add(subscriber);
        yield* Effect.addFinalizer(() =>
          Effect.andThen(
            Effect.sync(() => subscribers.delete(subscriber)),
            Queue.shutdown(subscriber.queue),
          ),
        );
        return subscriber.queue;
      }),
  });
});

/** Provides `RecordChanges`. */
export const RecordChangesLayer: Layer.Layer<RecordChanges> = Layer.effect(RecordChanges)(make);
