/**
 * The Your work read: `signal.queryYourWork` returns the open Tasks that
 * belong to a signal on To do (spec 10 section 9.5; spec 11, `signal`).
 *
 * It is a service of its own, like `TaskTracking`, so `SignalService` does not
 * grow a second dependency on Task rows. It reads signals through the signal
 * repository and Tasks through the task repository.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Forbidden, SignalYourWork, Unauthenticated, YourWorkTask } from "@hercule/contract";
import { requireGrant } from "../actor";
import { nowIso } from "../db";
import { taskRepository } from "../tasks";
import { signalRepository } from "./repository";

const make = Effect.gen(function* () {
  const signals = yield* signalRepository;
  const tasks = yield* taskRepository;

  return {
    /**
     * Returns Your work: the open Tasks (status `open` or `in-progress`, not
     * deleted) whose provenance carries the thread ref of a signal on To do
     * (open, not snoozed). Each Task appears once, with the ids of the To do
     * signals it belongs to, in ascending order. The Tasks are ordered by
     * `updatedAt`, newest first, then by id. It is worked out on every read
     * and never stored.
     *
     * The caller needs `signal.read` and `task.read`: the rows hold both a
     * signal's id and a Task's title, so signal access alone must not reveal a
     * Task. Any caller that holds both may read it, a session included, because
     * it can already read the same facts from `signal.query` and `task.query`.
     *
     * It is two statements: the thread refs of the To do signals, then the
     * open Tasks that carry those refs. Neither loads a signal's blocks or a
     * Task's description or provenance, so the work follows the To do list and
     * the Tasks that match it, not the Tasks there are. It opens no
     * transaction, so both run on the read-only connection and never wait for a
     * writer. The two are not an atomic snapshot: a signal resolved between
     * them still counts, and the push that change makes brings the next read.
     */
    query: (): Effect.Effect<SignalYourWork, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("signal.queryYourWork");
        yield* requireGrant("task.query");
        const toDo = yield* signals.listToDoThreads(yield* nowIso);
        const signalIdsByRef = new Map<string, Array<string>>();
        for (const { signalId, threadRef } of toDo) {
          signalIdsByRef.set(threadRef, [...(signalIdsByRef.get(threadRef) ?? []), signalId]);
        }
        const found = yield* tasks.listOpenOnRefs([...signalIdsByRef.keys()]);
        const signalIdsByTask = new Map<string, Set<string>>();
        for (const task of found) {
          const signalIds = signalIdsByTask.get(task.id) ?? new Set<string>();
          for (const signalId of signalIdsByRef.get(task.ref) ?? []) signalIds.add(signalId);
          signalIdsByTask.set(task.id, signalIds);
        }
        const titled = new Map(found.map((task) => [task.id, task]));
        return {
          tasks: [...titled.values()]
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
            .map((task): YourWorkTask => ({
              id: task.id,
              title: task.title,
              status: task.status,
              updatedAt: task.updatedAt,
              signalIds: [...signalIdsByTask.get(task.id)!].toSorted(),
            })),
        };
      }),
  };
});

/** The Your work read. */
export class YourWork extends Context.Service<YourWork, Effect.Success<typeof make>>()(
  "hercule/controller/signals/YourWork",
) {}

export const YourWorkLayer: Layer.Layer<YourWork, never, SqlClient.SqlClient> =
  Layer.effect(YourWork)(make);
