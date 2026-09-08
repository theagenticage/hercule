/**
 * What a transaction announces once it has committed.
 *
 * A change is worth telling anyone about only when it is durable, so nothing
 * announces from inside a write. A caller records what it changed while the
 * transaction runs, `withTransaction` hands the list on after the commit, and a
 * transaction that rolls back throws its list away with everything else it did.
 * That is one seam rather than one call per service method, and it cannot
 * announce a change that never happened.
 *
 * The list is per transaction and per fiber: it is provided into the effect the
 * transaction wraps, so two transactions running at once cannot see each
 * other's, and a nested transaction joins the outer list because a savepoint
 * release is not a commit.
 *
 * A change recorded outside any transaction is announced at once: the statement
 * that made it was its own transaction and has already committed.
 *
 * The listener is optional. A controller with no live socket - a migration run,
 * a repository test - provides none, and then there is nobody to tell.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { InvalidateKind, MutableLiveTopic, TapItem } from "@hydra/contract";

/**
 * One thing a committed transaction changed, or - for `tap` - one thing that
 * was never a transaction at all: a token delta is announced the instant it is
 * reported, because it is never written anywhere for a commit to make durable.
 */
export type Change =
  | {
      readonly _tag: "record";
      readonly topic: MutableLiveTopic;
      readonly id: string;
      readonly kind: InvalidateKind;
    }
  | { readonly _tag: "event" }
  | { readonly _tag: "transcript"; readonly sessionId: string }
  | { readonly _tag: "tap"; readonly sessionId: string; readonly item: TapItem };

/** Whoever wants to hear what the last transaction changed. */
export interface AfterCommitListener {
  readonly publish: (changes: ReadonlyArray<Change>) => Effect.Effect<void>;
}

export class AfterCommit extends Context.Service<AfterCommit, AfterCommitListener>()(
  "hydra/controller/db/AfterCommit",
) {}

/** The list the transaction in progress is filling. */
class Pending extends Context.Service<Pending, { readonly changes: Array<Change> }>()(
  "hydra/controller/db/Pending",
) {}

const publishNow = (changes: ReadonlyArray<Change>): Effect.Effect<void> =>
  changes.length === 0
    ? Effect.void
    : Effect.flatMap(
        Effect.serviceOption(AfterCommit),
        Option.match({
          onNone: () => Effect.void,
          onSome: (listener) => listener.publish(changes),
        }),
      );

/** Records a change to announce once the transaction it is part of commits. */
export const announce = (change: Change): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.serviceOption(Pending),
    Option.match({
      onNone: () => publishNow([change]),
      onSome: (pending) =>
        Effect.sync(() => {
          pending.changes.push(change);
        }),
    }),
  );

/**
 * Runs an effect with a list of its own, and announces that list afterwards.
 * An effect already running inside such a list adds to it instead, so the
 * announcement belongs to the outermost transaction, the one that commits.
 */
export const announcing = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.serviceOption(Pending),
    Option.match({
      onNone: () =>
        Effect.gen(function* () {
          const changes: Array<Change> = [];
          const value = yield* Effect.provideService(effect, Pending, { changes });
          // Uninterruptible, because the write is already durable: a client
          // hanging up here would otherwise leave a change nobody is ever told
          // about and a screen stale until it is reloaded.
          yield* Effect.uninterruptible(publishNow(changes));
          return value;
        }),
      onSome: (outer) =>
        // A savepoint that rolls back has changed nothing either, so whatever
        // it added to the outer list is taken off again.
        Effect.suspend(() => {
          const before = outer.changes.length;
          return Effect.onError(effect, () =>
            Effect.sync(() => {
              outer.changes.length = before;
            }),
          );
        }),
    }),
  );
