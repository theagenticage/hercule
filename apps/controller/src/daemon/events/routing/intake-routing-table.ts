/**
 * The routing table for Intake: one route per active event source that
 * declares signal kinds. It raises a plugin's signals from the source's
 * events and ends them, as spec 10 §9.2 describes.
 *
 * For each event from one of the source's Connections, in the router's
 * transaction, the route:
 *
 * 1. checks the event against the `ends` of each signal kind. An end whose
 *    event kind and condition match resolves the kind's open signals on the
 *    event's thread, and drops the raises of that thread still waiting for
 *    the step after the commit;
 * 2. runs the `rule` of each signal kind that lists the event's kind in
 *    `from`. A `yes` or an `undecided` writes a pending raise, which the
 *    signal raise delivery turns into a signal after the commit, because the
 *    plugin's `build` may call the source.
 *
 * The ends run before the rules, so an event that both ends a signal and
 * raises a new one on the same thread leaves the new one open.
 *
 * This table is last in the router's list. The known-work check reads the
 * session inputs and run steps the earlier tables wrote for the same event in
 * the same transaction.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MAX_SIGNAL_OUTCOME_LENGTH, type Event, type SignalResolution } from "@hercule/contract";
import { SYSTEM_ACTOR } from "../../../actor";
import { nowIso } from "../../../db";
import { AuditLog } from "../../../events";
import {
  evaluateExpression,
  parseExpression,
  ExpressionError,
  type CompiledExpression,
  type EvaluationContext,
} from "../../../expressions";
import {
  PluginHost,
  type RegisteredEventSource,
  type RegisteredSignalKind,
} from "../../../plugins";
import { runRepository } from "../../../runs";
import { inputRepository } from "../../../sessions";
import { signalRepository } from "../../../signals";
import type { Route, RoutingTable } from "../event-router";

/**
 * Cuts an end's outcome line to the length a resolution stores, ending it
 * with "…" when it was longer.
 */
export const cutOutcome = (outcome: string): string =>
  outcome.length <= MAX_SIGNAL_OUTCOME_LENGTH
    ? outcome
    : `${outcome.slice(0, MAX_SIGNAL_OUTCOME_LENGTH - 1)}…`;

/** One route per active event source that declares signal kinds. */
export const intakeRoutingTable: Effect.Effect<
  RoutingTable,
  never,
  SqlClient.SqlClient | PluginHost | AuditLog
> = Effect.gen(function* () {
  const host = yield* PluginHost;
  const signals = yield* signalRepository;
  const inputs = yield* inputRepository;
  const runs = yield* runRepository;
  const audit = yield* AuditLog;

  /**
   * Returns the routes for one pass. The compiled expressions and the logged
   * failures live as long as the pass, so each expression is parsed once per
   * pass and each failure is logged once per pass, not once per event.
   */
  const prepare = (): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
    Effect.gen(function* () {
      const sources = (yield* host.listActiveEventSources()).filter(
        (source) => source.signalKinds.length > 0,
      );
      const compiled = new Map<string, CompiledExpression>();
      const logged = new Set<string>();

      /** Evaluates one of a kind's expressions against the event. */
      const evaluate = (
        source: string,
        context: EvaluationContext,
      ): Effect.Effect<unknown, ExpressionError> =>
        Effect.gen(function* () {
          let program = compiled.get(source);
          if (program === undefined) {
            program = yield* parseExpression(source);
            compiled.set(source, program);
          }
          return yield* evaluateExpression(program, context);
        });

      /** Evaluates an expression that must return a string, such as a thread or an outcome. */
      const evaluateText = (
        source: string,
        context: EvaluationContext,
      ): Effect.Effect<string, ExpressionError> =>
        Effect.flatMap(evaluate(source, context), (value) =>
          typeof value === "string" && value !== ""
            ? Effect.succeed(value)
            : Effect.fail(
                new ExpressionError({
                  message: `it returned ${JSON.stringify(value)} where a non-empty string was expected`,
                }),
              ),
        );

      /**
       * Runs one kind's step for an event, and logs its failure instead of
       * passing it on, so one kind's broken expression never stops the
       * other kinds. The host checked every expression when the plugin
       * loaded, so a failure here comes from an event the plugin's author
       * did not foresee, and the plugin's author is the one to read it.
       */
      const logFailure = (
        kind: RegisteredSignalKind,
        step: string,
        effect: Effect.Effect<void, ExpressionError | SqlError>,
      ): Effect.Effect<void, SqlError> =>
        Effect.catchTag(effect, "ExpressionError", (error) => {
          const key = `${kind.kind} ${step}`;
          if (logged.has(key)) return Effect.void;
          logged.add(key);
          return Effect.logWarning(
            `The ${step} of the signal kind ${kind.kind} failed, so it was skipped for this event: ${error.message}`,
          );
        });

      /**
       * Ends the kind's open signals on the event's thread when one of its
       * ends matches the event. Only a signal raised from an earlier event
       * ends: rerouting an event must not end the signal the same event, or
       * a later one, raised.
       */
      const checkEnds = (
        kind: RegisteredSignalKind,
        event: Event & { readonly connectionId: string },
        context: EvaluationContext,
      ): Effect.Effect<void, ExpressionError | SqlError> =>
        Effect.gen(function* () {
          const ends = kind.ends.filter((end) => end.eventKind === event.kind);
          if (ends.length === 0) return;
          let matched: (typeof ends)[number] | undefined;
          for (const end of ends) {
            if (end.condition === undefined || (yield* evaluate(end.condition, context)) === true) {
              matched = end;
              break;
            }
          }
          if (matched === undefined) return;
          const threadRef = yield* evaluateText(kind.threadRef, context);
          const outcome = cutOutcome(yield* evaluateText(matched.outcome, context));
          yield* signals.deleteRaisesOnThreadBefore(
            event.connectionId,
            threadRef,
            kind.kind,
            event.id,
          );
          const open = yield* signals.listOpenOnThread(event.connectionId, threadRef, kind.kind);
          for (const signal of open.filter((candidate) => candidate.eventId < event.id)) {
            const resolution: SignalResolution = {
              kind: matched.resolution,
              ...(matched.actionId === undefined ? {} : { actionId: matched.actionId }),
              eventId: event.id,
              outcome,
              actor: SYSTEM_ACTOR,
              origin: "core",
              at: yield* nowIso,
            };
            if (!(yield* signals.resolve(signal.id, resolution))) continue;
            yield* audit.append({
              kind: matched.resolution === "decided" ? "signal.decided" : "signal.withdrawn",
              actor: SYSTEM_ACTOR,
              record: { topic: "signal", id: signal.id },
              payload: { signalId: signal.id, eventId: event.id, outcome },
              at: resolution.at,
            });
          }
        });

      /**
       * Runs the kind's rule on the event, and writes a pending raise for a
       * `yes` or an `undecided`. A kind that does not name the user is not
       * raised when a Subscription already received the event, because a
       * session or a run is handling it.
       */
      const runRule = (
        kind: RegisteredSignalKind,
        event: Event & { readonly connectionId: string },
        context: EvaluationContext,
      ): Effect.Effect<void, ExpressionError | SqlError> =>
        Effect.gen(function* () {
          const decision = yield* evaluate(kind.rule, context);
          if (decision === "no") return;
          if (decision !== "yes" && decision !== "undecided") {
            return yield* Effect.fail(
              new ExpressionError({
                message: `the rule returned ${JSON.stringify(decision)}, where "yes", "no" or "undecided" was expected`,
              }),
            );
          }
          if (
            !kind.namesYou &&
            ((yield* inputs.hasInputForEvent(event.id)) || (yield* runs.hasStepForEvent(event.id)))
          ) {
            return;
          }
          const threadRef = yield* evaluateText(kind.threadRef, context);
          yield* signals.insertRaise({
            eventId: event.id,
            kind: kind.kind,
            decision,
            connectionId: event.connectionId,
            threadRef,
            createdAt: yield* nowIso,
          });
        });

      const buildRoute = (source: RegisteredEventSource): Route => ({
        admits: (event) => event.connectionId !== null && source.kinds.has(event.kind),
        condition: undefined,
        // A route here has no health of its own. Each failure belongs to one
        // signal kind, not to the route, and is logged as it happens, so the
        // router has nothing to record or clear.
        hasEvaluationError: false,
        writeOnMatch: (event, context) =>
          Effect.gen(function* () {
            // `admits` lets through only an event with a Connection.
            const fromConnection = event as Event & { readonly connectionId: string };
            for (const kind of source.signalKinds) {
              yield* logFailure(kind, "end check", checkEnds(kind, fromConnection, context));
            }
            for (const kind of source.signalKinds) {
              if (!kind.from.includes(event.kind)) continue;
              yield* logFailure(kind, "rule", runRule(kind, fromConnection, context));
            }
          }),
        recordEvaluationFailure: () => Effect.void,
        clearEvaluationFailure: () => Effect.void,
      });

      return sources.map(buildRoute);
    });

  return { prepare };
});
