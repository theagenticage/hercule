/**
 * The delivery of signal raises: turns each raise the intake routing table
 * wrote into a signal (spec 10 §9.2).
 *
 * For each pending raise, oldest event first:
 *
 * 1. It runs the plugin's `build` outside any transaction, because `build`
 *    may call the source.
 * 2. It binds the draft's actions to the plugin and to the signal's
 *    Connection, adds the core's own actions (Done, and one Hand to an agent
 *    per workflow that takes the kind), and checks the whole signal against
 *    the contract.
 * 3. When `build` fails, or its draft does not pass the check, it writes the
 *    signal from the event instead: the event's title and author, no body,
 *    and the core's actions only. The signal keeps the error, and a
 *    `core.signal-build-failed` decision tells the user, once until they
 *    dismiss it.
 * 4. In one transaction, it writes the signal, withdraws the older open
 *    signal of the same kind on the same thread, which the new one replaces,
 *    and deletes the raise.
 *
 * A raise whose signal already exists is deleted without a second signal:
 * the controller stopped between the commit and the delete, or the event was
 * routed again. Each raise is handled on its own, so one that fails is logged
 * and stays pending for the next tick, and the next raise still goes out.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  countJsonBytes,
  DONE_ACTION_ID,
  formatIssue,
  listSchemaIssues,
  MAX_SIGNAL_BYTES,
  Signal,
  type BoundAction,
  type Event,
  type Issue,
  type NotificationSubject,
  type SignalMatch,
  Validation,
} from "@hercule/contract";
import { SYSTEM_ACTOR } from "../../../actor";
import { BoundOperations } from "../../../bound-actions";
import type { ConnectionTypes } from "../../../connections";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../../../db";
import { AuditLog, readPipelineEvent } from "../../../events";
import { evaluateExpression } from "../../../expressions";
import { Notifier } from "../../../notifications";
import {
  PluginHost,
  signalBuilds,
  type RegisteredSignalKind,
  type SignalDraftContent,
} from "../../../plugins";
import {
  buildHandToActions,
  listCollisionIssues,
  signalRepository,
  type PendingRaise,
} from "../../../signals";
import { workflowRepository } from "../../../workflows";
import { absorbFailures } from "../../absorbing";
import { buildEvaluationContext, type Delivery } from "../event-router";

/** The outcome a replaced signal keeps. */
const REPLACED_OUTCOME = "Replaced by a newer one";

/** The reason a build-failed decision is withdrawn with once a build of its kind works again. */
const BUILD_WORKS_AGAIN = "a later signal of this kind was built";

/** The content of a signal: what `build` returned, or what the event alone gives. */
interface SignalContent {
  readonly title: string;
  readonly asker?: string;
  readonly place?: string;
  readonly priority: Signal["priority"];
  readonly blocks: ReadonlyArray<unknown>;
  readonly actions: ReadonlyArray<BoundAction>;
}

/**
 * Returns the content of a signal written from its event alone: the event's
 * title, or the kind's label when the event has none, and the event's author
 * as the asker. It has no body and none of the plugin's actions.
 */
const buildEnvelope = (kind: RegisteredSignalKind, event: Event): SignalContent => ({
  title: event.title === null || event.title === "" ? kind.label : event.title,
  ...(event.author === null || event.author === "" ? {} : { asker: event.author }),
  priority: kind.priority,
  blocks: [],
  actions: [],
});

/**
 * Binds a draft's actions to the plugin that built them and to the signal's
 * Connection, so a plugin can bind neither another plugin's action nor
 * another Connection.
 */
const bindDraftActions = (
  kind: RegisteredSignalKind,
  draft: SignalDraftContent,
  connectionId: string,
): ReadonlyArray<BoundAction> =>
  draft.actions.map(({ action, input, ...answer }) => ({
    ...answer,
    operation: { op: `${kind.pluginId}/${action}`, connectionId, input },
  }));

export const signalRaiseDelivery: Effect.Effect<
  Delivery,
  never,
  SqlClient.SqlClient | PluginHost | ConnectionTypes | BoundOperations | Notifier | AuditLog
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const host = yield* PluginHost;
  const signals = yield* signalRepository;
  const workflows = yield* workflowRepository;
  const builds = yield* signalBuilds;
  const operations = yield* BoundOperations;
  const notifier = yield* Notifier;
  const audit = yield* AuditLog;

  /**
   * Checks each draft action's operation as a signal's answer, and that no
   * action takes the id or the label of a core action. Returns every issue
   * found.
   */
  const checkDraftActions = (
    own: ReadonlyArray<BoundAction>,
    core: ReadonlyArray<BoundAction>,
  ): Effect.Effect<ReadonlyArray<Issue>, SqlError> =>
    Effect.gen(function* () {
      const issues: Array<Issue> = [...listCollisionIssues(own, core)];
      for (const [index, action] of own.entries()) {
        // `bindDraftActions` gives every draft action an operation.
        const operation = action.operation!;
        const refusal = yield* operations
          .check("signal.answer", operation, action.field, ["actions", String(index)])
          .pipe(
            Effect.as(undefined),
            Effect.catchIf(
              (error) => error instanceof Validation,
              (error) => Effect.succeed(error),
            ),
          );
        if (refusal !== undefined) issues.push(...refusal.error.details.issues);
      }
      return issues;
    });

  /**
   * Checks a signal against the contract: its schema, and its size as JSON.
   * Returns every issue found.
   */
  const checkSignal = (signal: Signal): Effect.Effect<ReadonlyArray<Issue>> =>
    Effect.map(Effect.result(Schema.encodeEffect(Signal)(signal)), (encoded) => {
      if (Result.isFailure(encoded)) return listSchemaIssues(encoded.failure.issue);
      return countJsonBytes(encoded.success) > MAX_SIGNAL_BYTES
        ? [{ path: [], message: `the signal is larger than ${MAX_SIGNAL_BYTES} bytes of JSON` }]
        : [];
    });

  /**
   * Returns the value of each of the kind's match fields for the event, as
   * text. A field whose path fails, returns nothing, or returns a list or a
   * map, is left out, so an Ignore Rule on that field never matches the
   * signal.
   */
  const buildMatch = (kind: RegisteredSignalKind, event: Event): Effect.Effect<SignalMatch> =>
    Effect.gen(function* () {
      const context = buildEvaluationContext(event);
      const match: Record<string, string> = {};
      for (const field of kind.matchFields) {
        const value = yield* Effect.result(evaluateExpression(field.path, context));
        if (Result.isFailure(value)) {
          yield* Effect.logWarning(
            `The match field ${field.name} of the signal kind ${kind.kind} failed, so the signal was written without it: ${value.failure.message}`,
          );
        } else if (typeof value.success === "string") {
          match[field.name] = value.success;
        } else if (
          typeof value.success === "number" ||
          typeof value.success === "bigint" ||
          typeof value.success === "boolean"
        ) {
          match[field.name] = String(value.success);
        } else if (value.success !== null && value.success !== undefined) {
          yield* Effect.logWarning(
            `The match field ${field.name} of the signal kind ${kind.kind} returned ${JSON.stringify(value.success)}, which is not text, so the signal was written without it`,
          );
        }
      }
      return match;
    });

  /** Builds the signal a raise writes, with the content given. */
  const buildSignal = (
    id: string,
    raise: PendingRaise,
    content: SignalContent,
    core: ReadonlyArray<BoundAction>,
    match: SignalMatch,
    createdAt: string,
    buildError: string | undefined,
  ): Signal =>
    ({
      id,
      kind: raise.kind,
      origin: {
        type: "event",
        eventId: raise.eventId,
        connectionId: raise.connectionId,
        threadRef: raise.threadRef,
        // The rule asked for the Screener, and no Screener exists yet, so the
        // signal is raised anyway: a missed question costs more than one the
        // user marks Done.
        ...(raise.decision === "undecided" ? { notScreened: { reason: "no-screener" } } : {}),
      },
      title: content.title,
      ...(content.asker === undefined ? {} : { asker: content.asker }),
      ...(content.place === undefined ? {} : { place: content.place }),
      priority: content.priority,
      blocks: content.blocks,
      actions: [...content.actions, ...core],
      match,
      ...(buildError === undefined ? {} : { buildError: { message: buildError, at: createdAt } }),
      status: "open",
      createdAt,
    }) as Signal;

  /**
   * Builds the signal for a raise: from the plugin's draft when the plugin
   * is active and its draft passes every check, otherwise from the event.
   * Returns the signal, and the error that sent it to the event, when one
   * did.
   */
  const buildRaisedSignal = (
    raise: PendingRaise,
    kind: RegisteredSignalKind,
    event: Event,
  ): Effect.Effect<{ readonly signal: Signal; readonly buildError?: string }, SqlError> =>
    Effect.gen(function* () {
      const id = uuidToString(mintUuid());
      const core: ReadonlyArray<BoundAction> = [
        ...buildHandToActions(id, raise.kind, yield* workflows.listEnabledDefinitions()),
        { id: DONE_ACTION_ID, label: "Done", operation: null },
      ];
      const match = yield* buildMatch(kind, event);
      const createdAt = yield* nowIso;
      const envelope = buildEnvelope(kind, event);
      const fromEnvelope = (buildError: string | undefined) => ({
        signal: buildSignal(id, raise, envelope, core, match, createdAt, buildError),
        ...(buildError === undefined ? {} : { buildError }),
      });

      const status = yield* host.status(kind.pluginId);
      if (!Option.exists(status, (current) => current._tag === "active")) {
        // The rule decided while the plugin was active, and the plugin
        // stopped since. Its code no longer runs, so the signal is written
        // from its event. This is not the plugin's mistake, so there is no
        // build error to report.
        return fromEnvelope(undefined);
      }

      const draft = yield* Effect.result(builds.run(kind, event, raise.connectionId));
      if (Result.isFailure(draft)) {
        if (draft.failure._tag === "PluginError") {
          return fromEnvelope(`build failed: ${draft.failure.message}`);
        }
        return yield* Effect.fail(draft.failure);
      }
      const own = bindDraftActions(kind, draft.success, raise.connectionId);
      const content: SignalContent = {
        ...draft.success,
        priority: draft.success.priority ?? kind.priority,
        actions: own,
      };
      const signal = buildSignal(id, raise, content, core, match, createdAt, undefined);
      const issues = [...(yield* checkDraftActions(own, core)), ...(yield* checkSignal(signal))];
      if (issues.length > 0) {
        return fromEnvelope(
          `the draft build returned does not fit a signal: ${issues.map(formatIssue).join("; ")}`,
        );
      }
      return { signal };
    });

  /**
   * Writes the signal in one transaction: withdraws the older open signals
   * of the kind on the thread, which the new one replaces, inserts the new
   * one, records the build's failure or its recovery, and deletes the raise.
   */
  const writeSignal = (
    raise: PendingRaise,
    kind: RegisteredSignalKind,
    signal: Signal,
    buildError: string | undefined,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        // Another pass may have written it while `build` ran.
        if (yield* signals.hasSignalForEvent(raise.kind, raise.eventId)) {
          return yield* signals.deleteRaise(raise.eventId, raise.kind);
        }
        const replaced = yield* signals.listOpenOnThread(
          raise.connectionId,
          raise.threadRef,
          raise.kind,
        );
        yield* signals.insert(signal, [raise.eventId]);
        yield* audit.append({
          kind: "signal.raised",
          actor: SYSTEM_ACTOR,
          record: { topic: "signal", id: signal.id },
          payload: { signalId: signal.id, kind: signal.kind },
          at: signal.createdAt,
        });
        for (const old of replaced) {
          const resolved = yield* signals.resolve(old.id, {
            kind: "withdrawn",
            eventId: raise.eventId,
            outcome: REPLACED_OUTCOME,
            actor: SYSTEM_ACTOR,
            origin: "core",
            at: signal.createdAt,
          });
          if (!resolved) continue;
          yield* signals.recordReplacement(old.id, signal.id);
          yield* audit.append({
            kind: "signal.withdrawn",
            actor: SYSTEM_ACTOR,
            record: { topic: "signal", id: old.id },
            payload: { signalId: old.id, eventId: raise.eventId, outcome: REPLACED_OUTCOME },
            at: signal.createdAt,
          });
        }
        const subject: ReadonlyArray<NotificationSubject> = [{ kind: "signalKind", id: kind.kind }];
        if (buildError === undefined) {
          yield* notifier.withdrawDecisionsAbout(subject, BUILD_WORKS_AGAIN);
        } else {
          yield* notifier.createCoreNotification(
            {
              kind: "core.signal-build-failed",
              title: `${kind.pluginDisplayName} could not build a "${kind.label}" signal`,
              body: `The signal was written from its event alone, without its body or ${kind.pluginDisplayName}'s answers. The error: ${buildError}`,
              subject: [{ kind: "plugin", id: kind.pluginId }, ...subject],
              eventId: raise.eventId,
              actions: [{ id: "dismiss", label: "Dismiss", operation: null }],
            },
            { unlessOpenAbout: subject },
          );
        }
        yield* signals.deleteRaise(raise.eventId, raise.kind);
      }),
    );

  /** Turns one pending raise into a signal, or drops it when it has nothing to raise. */
  const deliverRaise = (raise: PendingRaise): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (yield* signals.hasSignalForEvent(raise.kind, raise.eventId)) {
        return yield* signals.deleteRaise(raise.eventId, raise.kind);
      }
      const event = yield* readPipelineEvent(sql, raise.eventId);
      const kind = yield* host.findSignalKind(raise.kind);
      if (Option.isNone(event) || Option.isNone(kind)) {
        yield* Effect.logWarning(
          `The raise of a ${raise.kind} signal from the event ${raise.eventId} was dropped: ${Option.isNone(event) ? "the event is gone" : "no plugin declares the kind"}`,
        );
        return yield* signals.deleteRaise(raise.eventId, raise.kind);
      }
      const built = yield* buildRaisedSignal(raise, kind.value, event.value);
      if (built.buildError !== undefined) {
        yield* Effect.logWarning(
          `The ${raise.kind} signal from the event ${raise.eventId} was written from its event, because ${built.buildError}`,
        );
      }
      yield* writeSignal(raise, kind.value, built.signal, built.buildError);
    });

  return {
    name: "signal raises",
    deliverWaiting: (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (const raise of yield* signals.listPendingRaises()) {
          yield* absorbFailures(
            `Raising the ${raise.kind} signal from the event ${raise.eventId} failed`,
            deliverRaise(raise),
          );
        }
      }),
  };
});
