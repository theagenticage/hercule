/**
 * The subscriptions a run holds: one for each signal trigger of its plan.
 *
 * The runs domain opens them when a run starts and ends them when it ends,
 * inside the transaction that writes the run, so a live run and its
 * subscriptions never disagree. No grant is checked here: every caller is the
 * run engine, acting for an operation that has already checked its own grant.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Subscription, WorkflowDefinition } from "@hercule/contract";
import { currentStampOrSystem } from "../actor";
import { composeRecord } from "./records";
import { subscriptionRepository } from "./repository";
import { expandEventSelector } from "./targets";

/** The end reason of a subscription whose run has ended. */
const RUN_ENDED = "the run that held this subscription has ended";

const make = Effect.gen(function* () {
  const subscriptions = yield* subscriptionRepository;

  return {
    /**
     * Opens one subscription for each signal trigger of the plan, held by the
     * run. Its condition is the trigger's Event Selector expanded into CEL.
     * The correlation is not part of the condition: it compares the event
     * with the run's own values, which the run engine evaluates when a
     * condition matches.
     */
    open: (runId: string, plan: WorkflowDefinition, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        // The run starts through an operation, a trigger or a rerun, and the
        // actor stamp is whoever started it; a trigger has no actor behind it.
        const actor = yield* currentStampOrSystem;
        for (const trigger of plan.triggers ?? []) {
          if (trigger.kind !== "signal") continue;
          yield* subscriptions.insert({
            holder: { kind: "run", id: runId },
            target: { kind: "signal", triggerId: trigger.id },
            condition: expandEventSelector(trigger.on),
            at,
            actor,
          });
        }
      }),

    /** Ends every live subscription the run holds. Does nothing if it holds none. */
    end: (runId: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* subscriptions.endHeldBy(
          { kind: "run", id: runId },
          { at, reason: RUN_ENDED, actor: yield* currentStampOrSystem },
        );
      }),

    /** Returns the run's live subscriptions, oldest first, as the API returns them. */
    list: (runId: string): Effect.Effect<ReadonlyArray<Subscription>, SqlError> =>
      Effect.map(subscriptions.listLiveHeldBy({ kind: "run", id: runId }), (live) =>
        live.map(composeRecord),
      ),
  };
});

/**
 * Builds the run-held subscription writes. Each method joins the caller's
 * transaction.
 */
export const runHeldSubscriptions: Effect.Effect<
  Effect.Success<typeof make>,
  never,
  SqlClient.SqlClient
> = make;
