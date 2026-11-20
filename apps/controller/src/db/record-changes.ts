/**
 * A second listener for committed changes, for in-process code that follows
 * the records other domains write: it learns that a record changed, then reads
 * the record itself.
 *
 * It receives only `{ topic, id }` for each `record` change, the small part
 * every such listener needs. The live topics keep their own listener
 * (`AfterCommit`) and are not touched by this one.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
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
 * calls `publish` while it still holds the writer.
 *
 * A subscriber that is slow or fails never touches the committed change or
 * the other subscribers. A subscriber reads the record fresh, so a change it
 * reads late or twice does no harm.
 */
export class RecordChanges extends Context.Service<
  RecordChanges,
  {
    /**
     * Offers the `record` changes in the list to every subscriber, and
     * ignores the other kinds and the changes that only moved a session's
     * counts.
     */
    readonly publish: (changes: ReadonlyArray<Change>) => Effect.Effect<void>;
    /**
     * Subscribes for the life of the scope. Take from the subscription with
     * `PubSub.takeAll`, which waits for the next change and takes every change
     * published since. A subscription sees only what is published after it is
     * made, so subscribe before reading the state that changes are applied to.
     */
    readonly subscribe: Effect.Effect<PubSub.Subscription<RecordChange>, never, Scope.Scope>;
  }
>()("hercule/controller/db/RecordChanges") {}

const make = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<RecordChange>();
  return RecordChanges.of({
    publish: (committed) => {
      const records: Array<RecordChange> = [];
      for (const change of committed) {
        if (change._tag !== "record") continue;
        if (change.topic === "session" && change.countsOnly === true) continue;
        records.push({ topic: change.topic, id: change.id });
      }
      return records.length === 0
        ? Effect.void
        : Effect.asVoid(PubSub.publishAll(changes, records));
    },
    subscribe: PubSub.subscribe(changes),
  });
});

/** Provides `RecordChanges`. */
export const RecordChangesLayer: Layer.Layer<RecordChanges> = Layer.effect(RecordChanges)(make);
