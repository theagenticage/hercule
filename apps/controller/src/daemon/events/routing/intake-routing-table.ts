/**
 * The routing table for Intake: one route per active event source that
 * declares signal kinds. It raises a plugin's signals from the source's
 * events and ends them, as spec 10 §9.2 describes.
 *
 * The route takes only an event the source's plugin ingested through one of
 * its Connections. An event emitted by hand with the same kind neither
 * raises nor ends a signal, because nothing vouches that it happened at the
 * source.
 *
 * For each such event, in the router's transaction, the route:
 *
 * 1. checks the event against the `ends` of each signal kind. An end whose
 *    event kind and condition match resolves the kind's open signals on the
 *    event's thread, drops the raises of that thread still waiting for the
 *    step after the commit, and records the end, so the same raises are not
 *    written again when their events are routed again;
 * 2. runs the `rule` of each signal kind that lists the event's kind in
 *    `from`. A `yes` or an `undecided` writes a pending raise, unless a later
 *    event already ended the kind on the thread. The signal raise delivery
 *    turns the raise into a signal after the commit, because the plugin's
 *    `build` may call the source.
 *
 * The ends run before the rules, so an event that both ends a signal and
 * raises a new one on the same thread leaves the new one open.
 *
 * This table is last in the router's list. The known-work check reads the
 * session inputs and run steps the earlier tables wrote for the same event in
 * the same transaction.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event, SignalResolution } from "@hercule/contract";
import { SYSTEM_ACTOR } from "../../../actor";
import { connectionRepository } from "../../../connections";
import { nowIso } from "../../../db";
import { AuditLog } from "../../../events";
import { applyIntakeOverrides, NO_INTAKE_OVERRIDES, PluginIntake } from "../../../intake-settings";
import {
  evaluateExpression,
  formatExpressionValue,
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
import { signalRepository, truncateOutcome } from "../../../signals";
import type { Route, RoutingTable } from "../event-router";

/** One route per active event source that declares signal kinds. */
export const intakeRoutingTable: Effect.Effect<
  RoutingTable,
  never,
  SqlClient.SqlClient | PluginHost | PluginIntake | AuditLog
> = Effect.gen(function* () {
  const host = yield* PluginHost;
  const pluginIntake = yield* PluginIntake;
  const connections = yield* connectionRepository;
  const signals = yield* signalRepository;
  const inputs = yield* inputRepository;
  const runs = yield* runRepository;
  const audit = yield* AuditLog;

  /**
   * Returns the routes for one pass. The compiled expressions, the logged
   * failures and the Intake settings read for each Connection live as long as
   * the pass, so each is worked out once per pass, not once per event.
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
        expression: string,
        context: EvaluationContext,
      ): Effect.Effect<unknown, ExpressionError> =>
        Effect.gen(function* () {
          let program = compiled.get(expression);
          if (program === undefined) {
            program = yield* parseExpression(expression);
            compiled.set(expression, program);
          }
          return yield* evaluateExpression(program, context);
        });

      /** Evaluates an expression that must return a string, such as a thread or an outcome. */
      const evaluateText = (
        expression: string,
        context: EvaluationContext,
      ): Effect.Effect<string, ExpressionError> =>
        Effect.flatMap(evaluate(expression, context), (value) =>
          typeof value === "string" && value !== ""
            ? Effect.succeed(value)
            : Effect.fail(
                new ExpressionError({
                  message: `it returned ${formatExpressionValue(value)} where a non-empty string was expected`,
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
      const absorbExpressionError = (
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
      const endSignalsOnThread = (
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
          const outcome = truncateOutcome(yield* evaluateText(matched.outcome, context));
          yield* signals.deleteRaisesOnThreadBefore(
            event.connectionId,
            threadRef,
            kind.kind,
            event.id,
          );
          yield* signals.recordThreadEnd(event.connectionId, threadRef, kind.kind, event.id);
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
       * `yes` or an `undecided`. No raise is written when:
       *
       * - the kind does not name the user and a Subscription already
       *   received the event, because a session or a run is handling it;
       * - a later event already ended the kind on the event's thread, so
       *   the question was answered. This happens when the event is routed
       *   again, such as after enrichment.
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
                message: `the rule returned ${formatExpressionValue(decision)}, where "yes", "no" or "undecided" was expected`,
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
          if (
            yield* signals.hasThreadEndAfter(event.connectionId, threadRef, kind.kind, event.id)
          ) {
            return;
          }
          yield* signals.insertRaise({
            eventId: event.id,
            kind: kind.kind,
            decision,
            connectionId: event.connectionId,
            threadRef,
          });
        });

      const switchedOnKinds = new Map<string, ReadonlySet<string>>();

      /**
       * Returns the names of the source's signal kinds that are switched on
       * for the event's Connection: the Connection's own choice, else the
       * plugin's, else the default. A Connection deleted since the event was
       * ingested has no choices, so the plugin's level applies.
       *
       * The answer is read once per plugin and Connection in a pass and kept
       * for the rest of it. The pass is one transaction, so no settings change
       * can land in the middle of it. The next pass reads again, so a change
       * applies from the next pass without a restart.
       */
      const readSwitchedOnSignalKinds = (
        source: RegisteredEventSource,
        event: Event & { readonly connectionId: string },
      ): Effect.Effect<ReadonlySet<string>, SqlError> =>
        Effect.gen(function* () {
          const key = JSON.stringify([source.pluginId, event.connectionId]);
          const known = switchedOnKinds.get(key);
          if (known !== undefined) return known;
          const pluginLevel = yield* pluginIntake.read(source.pluginId);
          const connection = yield* connections.one(event.connectionId);
          const settings = applyIntakeOverrides(
            pluginLevel,
            Option.isSome(connection) ? connection.value.intake : NO_INTAKE_OVERRIDES,
            "connection",
          );
          const switchedOn = new Set(
            settings.signalKinds.filter((kind) => kind.on).map((kind) => kind.kind),
          );
          switchedOnKinds.set(key, switchedOn);
          return switchedOn;
        });

      const buildRoute = (source: RegisteredEventSource): Route => ({
        admits: (event) =>
          event.source === source.pluginId &&
          event.connectionId !== null &&
          source.kinds.has(event.kind),
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
              yield* absorbExpressionError(
                kind,
                "end check",
                endSignalsOnThread(kind, fromConnection, context),
              );
            }
            const raisable = source.signalKinds.filter((kind) => kind.from.includes(event.kind));
            if (raisable.length === 0) return;
            const switchedOn = yield* readSwitchedOnSignalKinds(source, fromConnection);
            for (const kind of raisable) {
              if (!switchedOn.has(kind.kind)) continue;
              yield* absorbExpressionError(kind, "rule", runRule(kind, fromConnection, context));
            }
          }),
        recordEvaluationFailure: () => Effect.void,
        clearEvaluationFailure: () => Effect.void,
      });

      return sources.map(buildRoute);
    });

  return { prepare };
});
