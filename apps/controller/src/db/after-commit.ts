/**
 * Collects the changes a transaction makes and announces them once it has
 * committed.
 *
 * A change is worth announcing only once it is durable, so nothing announces
 * from inside a write. Instead:
 *
 * - a caller records what it changed while the transaction runs;
 * - `withTransaction` publishes the list after the commit;
 * - a transaction that rolls back throws its list away with everything else.
 *
 * This is one mechanism rather than one call per service method, and it can
 * never announce a change that did not happen.
 *
 * Each transaction has its own list, provided into the effect the transaction
 * wraps, so two transactions running at once cannot see each other's changes.
 * A nested transaction adds to the outer list, because releasing a savepoint is
 * not a commit.
 *
 * A change recorded outside any transaction is announced at once. Every write
 * to the database happens inside a transaction, so such a change is not a
 * database change: it is a `tap`, which is never written to the database.
 *
 * The listener is optional. A controller with no live socket, such as a
 * migration run or a repository test, provides none, and then nothing is
 * published.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { InvalidateKind, MutableLiveTopic, TapItem } from "@hercule/contract";
import type { SubagentId } from "@hercule/protocol";

/**
 * One thing a committed transaction changed. The exception is `tap`: a token
 * delta is never written to the database, so it is announced as soon as it is
 * reported, with no transaction involved.
 *
 * - A `record` change with `countsOnly` changed nothing about the record but
 *   its counts: its Token Usage and, for a session, its tool calls, or for a
 *   workflow, how many runs a trigger used of its spawn bound and how many
 *   events it holds. These counts can change with almost every event, so the
 *   change is sent at a slower pace than other changes.
 * - A `record` change on the `session` topic names the conversation the
 *   session answers, or `null` for a session in none, so the push can tell a
 *   client which conversations it touches. A session's conversation is set
 *   when the session is created and never changes, so two changes to one
 *   session can never disagree about it.
 * - A `transcript` change names the agent whose transcript grew: the
 *   session's own when `subagentId` is absent, otherwise that subagent's.
 */
export type Change =
  | {
      readonly _tag: "record";
      readonly topic: Exclude<MutableLiveTopic, "session">;
      readonly id: string;
      readonly kind: InvalidateKind;
      readonly countsOnly?: true;
    }
  | {
      readonly _tag: "record";
      readonly topic: "session";
      readonly id: string;
      readonly conversationId: string | null;
      readonly kind: InvalidateKind;
      readonly countsOnly?: true;
    }
  | { readonly _tag: "event" }
  | { readonly _tag: "transcript"; readonly sessionId: string; readonly subagentId?: SubagentId }
  | { readonly _tag: "tap"; readonly sessionId: string; readonly item: TapItem };

/**
 * Receives the changes of each committed transaction.
 *
 * `publish` must never wait on a write. `withTransaction` runs it after it has
 * given the writer back, but `withFinalTransaction` (`./writes.ts`) runs it
 * while the writer is still held, so a `publish` that waited for a write would
 * wait for itself.
 */
export interface AfterCommitListener {
  readonly publish: (changes: ReadonlyArray<Change>) => Effect.Effect<void>;
}

export class AfterCommit extends Context.Service<AfterCommit, AfterCommitListener>()(
  "hercule/controller/db/AfterCommit",
) {}

/** The changes and settle callbacks collected by the transaction in progress. */
class Pending extends Context.Service<
  Pending,
  { readonly changes: Array<Change>; readonly settles: Array<() => void> }
>()("hercule/controller/db/Pending") {}

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

/**
 * Records a change to announce once the transaction it is part of commits.
 * Outside a transaction it publishes the change at once, which only suits a
 * change that is not stored in the database, such as a `tap`.
 */
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
 * Runs `settle` once the transaction it is part of commits, and not at all if
 * that transaction rolls back.
 *
 * Use it for in-process state that a write makes stale, such as a cache of a
 * row's old value. Clearing the cache inside the transaction would leave a gap
 * in which a concurrent reader still sees the old row and caches it again, and
 * nothing would clear it a second time.
 *
 * A settle recorded outside any transaction runs at once. No database write
 * is pending then, because every write happens inside a transaction, so there
 * is no commit to wait for.
 */
export const afterCommit = (settle: () => void): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.serviceOption(Pending),
    Option.match({
      onNone: () => Effect.sync(settle),
      onSome: (pending) =>
        Effect.sync(() => {
          pending.settles.push(settle);
        }),
    }),
  );

/**
 * Runs an effect with its own list of changes, then runs the settle callbacks
 * and publishes the changes. An effect that already runs inside such a list
 * adds to the outer list instead, so only the outermost transaction, the one
 * that commits, publishes.
 *
 * The caller runs it uninterruptibly (`withTransaction` does), so an interrupt
 * cannot land between the commit and the settle callbacks. Whether the writer
 * is still held while they run depends on the caller; see
 * {@link AfterCommitListener}.
 */
export const withAnnouncements = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.serviceOption(Pending),
    Option.match({
      onNone: () =>
        Effect.gen(function* () {
          const changes: Array<Change> = [];
          const settles: Array<() => void> = [];
          const value = yield* Effect.provideService(effect, Pending, { changes, settles });
          // The settle callbacks run first, so a listener can never read state
          // the commit has made stale.
          for (const settle of settles) settle();
          yield* publishNow(changes);
          return value;
        }),
      onSome: (outer) =>
        // A savepoint that rolls back has changed nothing, so remove whatever
        // it added to the outer lists.
        Effect.suspend(() => {
          const changes = outer.changes.length;
          const settles = outer.settles.length;
          return Effect.onError(effect, () =>
            Effect.sync(() => {
              outer.changes.length = changes;
              outer.settles.length = settles;
            }),
          );
        }),
    }),
  );
