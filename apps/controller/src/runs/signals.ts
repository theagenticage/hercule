/**
 * Signal triggers: what a run does when an event matches the subscription of
 * one of its signal triggers.
 *
 * The subscription's condition, the trigger's Event Selector, is all the event
 * router checks. Whether the event belongs to this run is the trigger's
 * correlation: an expression over the event and an expression over the run,
 * which must give equal values. Only the run can evaluate its side, so the
 * router hands every match here.
 *
 * A match that correlates writes a pending step record for the trigger,
 * holding the signal's output. The run's execution then completes that record
 * and routes the run, as if a step had completed (see `engine.ts`). So the
 * routing pass that matched the event only writes a row, and never waits on
 * a run.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event, WorkflowDefinition } from "@hercule/contract";
import { afterCommit, nowIso } from "../db";
import {
  evaluateExpression,
  evaluateMapping,
  ExpressionError,
  type EvaluationContext,
} from "../expressions";
import { runRepository } from "./repository";
import { buildRunContext } from "./run-context";
import { isUnfinished } from "./step-records";

type SignalTrigger = Extract<
  NonNullable<WorkflowDefinition["triggers"]>[number],
  { kind: "signal" }
>;

/** An event that matched the subscription of a run's signal trigger. */
export interface SignalMatch {
  readonly runId: string;
  readonly triggerId: string;
  readonly event: Event;
  /** What the subscription's condition was evaluated against: the event without its raw payload. */
  readonly context: EvaluationContext;
}

/**
 * Converts a correlation value to the form two values are compared in with
 * `===`, or returns `undefined` for a value that is neither a string nor a
 * number:
 *
 * - a string stays as it is;
 * - a whole number becomes a `BigInt`;
 * - any other number stays a JS number.
 *
 * The evaluator returns an integer as a `BigInt`, and a number read from the
 * context as a JS number, so `7` and `7.0` must meet as the same `BigInt`. An
 * integer is never converted to a JS number, because a JS number holds an
 * integer exactly only up to 2^53, and two ids above that would compare
 * equal.
 */
const normalizeCorrelationValue = (value: unknown): string | bigint | number | undefined => {
  switch (typeof value) {
    case "string":
    case "bigint":
      return value;
    case "number":
      return Number.isInteger(value) ? BigInt(value) : value;
    default:
      return undefined;
  }
};

/**
 * Evaluates one side of a trigger's correlation, and returns its value in the
 * form `normalizeCorrelationValue` gives. Fails with `ExpressionError`, naming
 * the trigger and the side, when the expression cannot be evaluated or gives
 * something other than a string or a number.
 */
const evaluateCorrelationSide = (
  trigger: SignalTrigger,
  side: "event" | "run",
  context: EvaluationContext,
): Effect.Effect<string | bigint | number, ExpressionError> =>
  Effect.gen(function* () {
    const site = `The ${side} side of the correlation of the signal trigger ${trigger.id}`;
    const value = yield* Effect.mapError(
      evaluateExpression(trigger.correlation[side], context),
      (error) =>
        new ExpressionError({
          message: `${site} could not be evaluated: ${error.message}`,
          ...(error.isUnresolvedReference === true ? { isUnresolvedReference: true } : {}),
        }),
    );
    const normalized = normalizeCorrelationValue(value);
    if (normalized === undefined) {
      return yield* Effect.fail(
        new ExpressionError({
          message: `${site} gave a value that is neither a string nor a number, so it cannot be compared`,
        }),
      );
    }
    return normalized;
  });

/**
 * Builds `recordSignalMatch`. `executeInBackground` is called with the run's
 * id once a new signal record commits; the engine passes the function that
 * hands the run's execution to the Run Executor, which wakes a run that is
 * waiting for its next signal.
 */
export const makeSignalMatching = (
  executeInBackground: (runId: string) => void,
): Effect.Effect<
  {
    readonly recordSignalMatch: (
      match: SignalMatch,
    ) => Effect.Effect<void, ExpressionError | SqlError>;
  },
  never,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const runs = yield* runRepository;

    return {
      /**
       * Records an event that matched the subscription of a run's signal
       * trigger, inside the caller's transaction. When the event correlates
       * with the run, it writes a pending step record for the trigger, holding
       * the signal's output, and wakes the run once the transaction commits.
       *
       * Nothing is written when:
       *
       * - the run has ended, because its signals no longer matter;
       * - the run side of the correlation reads a value the run does not have
       *   yet, such as the output of a step that has not completed. The
       *   signal cannot be for this run until the run has that value;
       * - the two sides give different values. A string never equals a
       *   number;
       * - the event already fired this trigger in this run, because the
       *   event was routed again after it was enriched.
       *
       * Fails with `ExpressionError` when either side of the correlation, or
       * one of the trigger's outputs, cannot be evaluated. The event router
       * then records the error on the subscription's health.
       *
       * The signal's output is the trigger's `outputs` mapping evaluated
       * against the event, or the whole event without its raw payload when
       * the trigger has no mapping.
       */
      recordSignalMatch: (match: SignalMatch): Effect.Effect<void, ExpressionError | SqlError> =>
        Effect.gen(function* () {
          const found = yield* runs.read(match.runId);
          if (Option.isNone(found) || !isUnfinished(found.value.status)) return;
          const run = found.value;
          const trigger = (run.plan.triggers ?? []).find(
            (candidate): candidate is SignalTrigger =>
              candidate.kind === "signal" && candidate.id === match.triggerId,
          );
          // The subscription was opened from this run's frozen plan, so its
          // trigger is always there.
          if (trigger === undefined) {
            return yield* Effect.die(
              `run ${match.runId} holds a subscription for the signal trigger ${match.triggerId}, which its plan does not have`,
            );
          }
          const eventValue = yield* evaluateCorrelationSide(trigger, "event", match.context);
          const runValue = yield* Effect.result(
            evaluateCorrelationSide(trigger, "run", buildRunContext(run)),
          );
          if (Result.isFailure(runValue)) {
            if (runValue.failure.isUnresolvedReference === true) return;
            return yield* Effect.fail(runValue.failure);
          }
          if (runValue.success !== eventValue) return;
          const output =
            trigger.outputs === undefined
              ? (match.context["event"] as Schema.Json)
              : ((yield* evaluateMapping(trigger.outputs, match.context, "output")) as Schema.Json);
          const inserted = yield* runs.insertSignalStep(
            run.id,
            { triggerId: trigger.id, eventId: match.event.id, output },
            yield* nowIso,
          );
          if (inserted) yield* afterCommit(() => executeInBackground(run.id));
        }),
    };
  });
