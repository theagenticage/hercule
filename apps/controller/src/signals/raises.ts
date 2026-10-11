/**
 * Raising a plugin's signal from a pending raise: the step after the intake
 * routing table decided, in the router's transaction, that an event raises a
 * signal (spec 10 §9.2).
 *
 * For one pending raise, `SignalRaises.raise`:
 *
 * 1. runs the plugin's `build` outside any transaction, because `build` may
 *    call the source;
 * 2. binds the draft's actions to the plugin and to the signal's Connection,
 *    adds the core's own actions (Done, and one Hand to an agent per workflow
 *    that takes the kind), and checks the whole signal against the contract;
 * 3. when `build` fails, times out or throws, or its draft does not pass the
 *    check, writes the signal from the event instead: the event's title and
 *    author, no body, and the core's actions only. The signal keeps the
 *    error, and a `core.signal-build-failed` decision tells the user, once
 *    until they dismiss it;
 * 4. in one transaction, deletes the raise, writes the signal, and withdraws
 *    the older open signals of the same kind on the same thread, which the
 *    new one replaces.
 *
 * The controller daemon's signal raise delivery calls it for each pending
 * raise, oldest event first.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DONE_ACTION_ID,
  formatIssue,
  type BoundAction,
  type Event,
  type NotificationSubject,
  type Signal,
  type SignalMatch,
  type WorkflowDefinition,
} from "@hercule/contract";
import { PluginError, type SignalDraft } from "@hercule/plugin-host";
import { SYSTEM_ACTOR } from "../actor";
import { BoundOperations } from "../bound-actions";
import { connectionRepository, type ConnectionTypes } from "../connections";
import { mintUuid, nowIso, uuidToString, withTransaction } from "../db";
import { AuditLog, readPipelineEvent } from "../events";
import { buildEvaluationContext, evaluateExpression, formatExpressionValue } from "../expressions";
import { Notifier } from "../notifications";
import {
  PluginHost,
  signalBuilds,
  summarizeCause,
  truncateMessage,
  type RegisteredSignalKind,
} from "../plugins";
import { buildHandToActions, checkSignalFits, listOwnActionIssues } from "./actions";
import { signalRepository, type PendingRaise } from "./repository";

/** The outcome a replaced signal keeps. */
const REPLACED_OUTCOME = "Replaced by a newer one";

/** The reason a build-failed decision is withdrawn with once a build of its kind works again. */
const BUILD_WORKS_AGAIN = "a later signal of this kind was built";

/**
 * The longest match value a signal keeps, in characters. A match value is
 * compared whole by an Ignore Rule, so a longer one is left out rather than
 * cut. A path that returns a whole body would otherwise make the signal
 * larger than `MAX_SIGNAL_BYTES`.
 */
const MAX_MATCH_VALUE_LENGTH = 1024;

/** The workflows whose Hand to an agent actions a signal may get. */
type EnabledWorkflows = ReadonlyArray<{
  readonly id: string;
  readonly definition: WorkflowDefinition;
}>;

/**
 * What came of the plugin's `build` for one signal:
 *
 * - `built`: the signal was written from the draft;
 * - `failed`: `build` failed, or its draft did not fit, and `message` says why;
 * - `skipped`: the plugin is no longer active, so `build` did not run.
 */
type BuildResult =
  | { readonly _tag: "built" }
  | { readonly _tag: "failed"; readonly message: string }
  | { readonly _tag: "skipped" };

/** What a signal shows: what `build` returned, or what the event alone gives. */
interface SignalContent {
  readonly title: string;
  readonly asker?: string | undefined;
  readonly place?: string | undefined;
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
  draft: SignalDraft,
  connectionId: string,
): ReadonlyArray<BoundAction> =>
  draft.actions.map(({ action, input, ...answer }) => ({
    ...answer,
    operation: { op: `${kind.pluginId}/${action}`, connectionId, input },
  }));

/**
 * Returns the value of each of the kind's match fields for the event, as
 * text. A field is left out, with a log line, when its path fails, returns a
 * list or a map, or returns text longer than `MAX_MATCH_VALUE_LENGTH`. A
 * field whose path returns nothing is left out without one. An Ignore Rule
 * on a field that was left out never matches the signal.
 */
const buildMatch = (kind: RegisteredSignalKind, event: Event): Effect.Effect<SignalMatch> =>
  Effect.gen(function* () {
    const context = buildEvaluationContext(event);
    const match: Record<string, string> = {};
    for (const field of kind.matchFields) {
      const leftOut = (why: string) =>
        Effect.logWarning(
          `The match field ${field.name} of the signal kind ${kind.kind} ${why}, so the signal was written without it`,
        );
      const value = yield* Effect.result(evaluateExpression(field.path, context));
      if (Result.isFailure(value)) {
        yield* leftOut(`failed: ${value.failure.message}`);
        continue;
      }
      const found = value.success;
      if (found === null || found === undefined) continue;
      if (
        typeof found !== "string" &&
        typeof found !== "number" &&
        typeof found !== "bigint" &&
        typeof found !== "boolean"
      ) {
        yield* leftOut(`returned ${formatExpressionValue(found)}, which is not text`);
        continue;
      }
      const text = String(found);
      if (text.length > MAX_MATCH_VALUE_LENGTH) {
        yield* leftOut(`returned ${text.length} characters, more than ${MAX_MATCH_VALUE_LENGTH}`);
        continue;
      }
      match[field.name] = text;
    }
    return match;
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const host = yield* PluginHost;
  const signals = yield* signalRepository;
  const connections = yield* connectionRepository;
  const builds = yield* signalBuilds;
  const notifier = yield* Notifier;
  const audit = yield* AuditLog;
  const operations = yield* BoundOperations;

  /**
   * Puts together the signal a raise writes, with the content given, and
   * checks it against the contract. Returns the signal, typed. Fails with
   * `Validation` when it does not fit.
   */
  const assembleSignal = (signal: {
    readonly id: string;
    readonly raise: PendingRaise;
    readonly content: SignalContent;
    readonly core: ReadonlyArray<BoundAction>;
    readonly match: SignalMatch;
    readonly createdAt: string;
    readonly buildError?: string | undefined;
  }) =>
    checkSignalFits({
      id: signal.id,
      kind: signal.raise.kind,
      origin: {
        type: "event",
        eventId: signal.raise.eventId,
        connectionId: signal.raise.connectionId,
        threadRef: signal.raise.threadRef,
        // The rule asked for the Screener, and no Screener exists yet, so the
        // signal is raised anyway: a missed question costs more than one the
        // user marks Done.
        ...(signal.raise.decision === "undecided"
          ? { notScreened: { reason: "no-screener" } }
          : {}),
      },
      title: signal.content.title,
      ...(signal.content.asker === undefined ? {} : { asker: signal.content.asker }),
      ...(signal.content.place === undefined ? {} : { place: signal.content.place }),
      priority: signal.content.priority,
      blocks: signal.content.blocks,
      actions: [...signal.content.actions, ...signal.core],
      match: signal.match,
      ...(signal.buildError === undefined
        ? {}
        : { buildError: { message: signal.buildError, at: signal.createdAt } }),
      status: "open",
      createdAt: signal.createdAt,
    });

  /**
   * Runs the plugin's `build` and returns the signal from its draft. Fails
   * with a `PluginError` naming the problem when `build` fails or its draft
   * does not fit a signal.
   */
  const buildFromDraft = (
    raise: PendingRaise,
    kind: RegisteredSignalKind,
    event: Event,
    parts: Omit<Parameters<typeof assembleSignal>[0], "content">,
  ): Effect.Effect<Signal, PluginError | SqlError> =>
    Effect.gen(function* () {
      const connection = yield* connections.one(raise.connectionId);
      if (Option.isNone(connection)) {
        return yield* Effect.fail(new PluginError({ message: "the Connection is gone" }));
      }
      const draft = yield* Effect.mapError(
        builds.run(kind, event, connection.value),
        (error) => new PluginError({ message: `build failed: ${error.message}` }),
      );
      const own = bindDraftActions(kind, draft, raise.connectionId);
      const doesNotFit = (issues: ReadonlyArray<Parameters<typeof formatIssue>[0]>) =>
        new PluginError({
          message: `the draft build returned does not fit a signal: ${issues.map(formatIssue).join("; ")}`,
        });
      const issues = yield* Effect.provideService(
        listOwnActionIssues(own, parts.core),
        BoundOperations,
        operations,
      );
      if (issues.length > 0) return yield* Effect.fail(doesNotFit(issues));
      return yield* Effect.mapError(
        assembleSignal({
          ...parts,
          content: { ...draft, priority: draft.priority ?? kind.priority, actions: own },
        }),
        (refusal) => doesNotFit(refusal.error.details.issues),
      );
    });

  /**
   * Writes the signal in one transaction: deletes the raise, inserts the
   * signal, withdraws the older open signals of the kind on the thread, which
   * the new one replaces, and records the build's failure or its recovery.
   *
   * Writes nothing when, by the time the transaction runs:
   *
   * - the raise is gone, because an end on its thread dropped it while
   *   `build` ran;
   * - the event's signal of this kind already exists;
   * - an open signal on the thread was raised from a later event. That
   *   signal is newer, so it stays, and the raise is dropped.
   */
  const writeSignal = (
    raise: PendingRaise,
    kind: RegisteredSignalKind,
    signal: Signal,
    build: BuildResult,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        if (!(yield* signals.deleteRaise(raise.eventId, raise.kind))) {
          return yield* Effect.logInfo(
            `The raise of a ${raise.kind} signal from the event ${raise.eventId} was dropped while its signal was built, so the signal was not written`,
          );
        }
        if (yield* signals.hasSignalForEvent(raise.eventId, raise.kind)) return;
        const open = yield* signals.listOpenOnThread(
          raise.connectionId,
          raise.threadRef,
          raise.kind,
        );
        if (open.some((other) => other.eventId > raise.eventId)) return;
        yield* signals.insert(signal, [raise.eventId]);
        yield* audit.append({
          kind: "signal.raised",
          actor: SYSTEM_ACTOR,
          record: { topic: "signal", id: signal.id },
          payload: { signalId: signal.id, kind: signal.kind },
          at: signal.createdAt,
        });
        for (const old of open) {
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
        if (build._tag === "built") {
          yield* notifier.withdrawDecisionsAbout(
            subject,
            BUILD_WORKS_AGAIN,
            "core.signal-build-failed",
          );
        } else if (build._tag === "failed") {
          yield* notifier.createCoreNotification(
            {
              kind: "core.signal-build-failed",
              title: `${kind.pluginDisplayName} could not build a "${kind.label}" signal`,
              body: `The signal was written from its event alone, without its body or ${kind.pluginDisplayName}'s answers. The error: ${build.message}`,
              subject: [{ kind: "plugin", id: kind.pluginId }, ...subject],
              eventId: raise.eventId,
              actions: [{ id: "dismiss", label: "Dismiss", operation: null }],
            },
            { unlessOpenAbout: subject },
          );
        }
      }),
    );

  /** Deletes a raise that has nothing to raise, with a log line saying why. */
  const dropRaise = (raise: PendingRaise, why: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* Effect.logWarning(
        `The raise of a ${raise.kind} signal from the event ${raise.eventId} was dropped, because ${why}`,
      );
      yield* signals.deleteRaise(raise.eventId, raise.kind);
    });

  /**
   * Writes the signal from the event alone. When even that signal does not
   * fit the contract, it tries again without the match values, and when it
   * still does not fit, it drops the raise with a log line.
   */
  const writeFromEvent = (
    raise: PendingRaise,
    kind: RegisteredSignalKind,
    event: Event,
    parts: Omit<Parameters<typeof assembleSignal>[0], "content" | "buildError">,
    build: Exclude<BuildResult, { readonly _tag: "built" }>,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const envelope = {
        ...parts,
        content: buildEnvelope(kind, event),
        buildError: build._tag === "failed" ? build.message : undefined,
      };
      const signal = yield* assembleSignal(envelope).pipe(
        Effect.catch(() =>
          Effect.andThen(
            Effect.logWarning(
              `The ${raise.kind} signal from the event ${raise.eventId} does not fit with its match values, so it was written without them`,
            ),
            assembleSignal({ ...envelope, match: {} }),
          ),
        ),
        Effect.option,
      );
      if (Option.isNone(signal)) {
        return yield* dropRaise(raise, "even the signal written from its event does not fit");
      }
      yield* writeSignal(raise, kind, signal.value, build);
    });

  return {
    /** Lists the pending raises, oldest event first. */
    listPending: (): Effect.Effect<ReadonlyArray<PendingRaise>, SqlError> =>
      signals.listPendingRaises(),

    /**
     * Turns one pending raise into a signal, as the module comment describes,
     * and deletes the raise. `workflows` are the enabled workflows, read once
     * by the caller for all the raises it handles.
     *
     * A raise with nothing to raise is deleted without a signal, and a log
     * line says why: its event, its kind or its Connection is gone, or even
     * the signal written from its event does not fit the contract. A raise
     * whose signal already exists is deleted without a second signal: the
     * controller stopped between the commit and the delete, or the event was
     * routed again.
     *
     * Fails only on a database error, and the raise then stays pending for
     * the next try. A failure of `build`, including a defect, never fails it.
     */
    raise: (raise: PendingRaise, workflows: EnabledWorkflows): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        if (yield* signals.hasSignalForEvent(raise.eventId, raise.kind)) {
          yield* signals.deleteRaise(raise.eventId, raise.kind);
          return;
        }
        const event = yield* readPipelineEvent(sql, raise.eventId);
        if (Option.isNone(event)) return yield* dropRaise(raise, "the event is gone");
        const kind = yield* host.findSignalKind(raise.kind);
        if (Option.isNone(kind)) return yield* dropRaise(raise, "no plugin declares the kind");
        if (Option.isNone(yield* connections.one(raise.connectionId))) {
          return yield* dropRaise(raise, "its Connection is gone");
        }

        const id = uuidToString(mintUuid());
        const parts = {
          id,
          raise,
          core: [
            ...buildHandToActions(id, raise.kind, workflows),
            { id: DONE_ACTION_ID, label: "Done", operation: null },
          ],
          match: yield* buildMatch(kind.value, event.value),
          createdAt: yield* nowIso,
        };

        // The rule decided while the plugin was active. When the plugin has
        // stopped since, its code no longer runs, so the signal is written
        // from its event. That is not the plugin's mistake, so there is no
        // build error to report.
        const status = yield* host.status(kind.value.pluginId);
        if (Option.exists(status, (current) => current._tag === "active")) {
          // A defect in `build` or in the checks is the plugin's problem, so
          // it is reported like any failed build. An interruption, because
          // the controller is stopping, and a database error pass on, so the
          // raise stays pending for the next try.
          const built = yield* buildFromDraft(raise, kind.value, event.value, parts).pipe(
            Effect.map((signal) => Result.succeed(signal)),
            Effect.catchTag("PluginError", (error) =>
              Effect.succeed(Result.fail(truncateMessage(error.message))),
            ),
            Effect.catchDefect((defect) =>
              Effect.succeed(
                Result.fail(truncateMessage(`build failed: ${summarizeCause(Cause.die(defect))}`)),
              ),
            ),
          );
          if (Result.isSuccess(built)) {
            return yield* writeSignal(raise, kind.value, built.success, { _tag: "built" });
          }
          yield* Effect.logWarning(
            `The ${raise.kind} signal from the event ${raise.eventId} was written from its event, because ${built.failure}`,
          );
          return yield* writeFromEvent(raise, kind.value, event.value, parts, {
            _tag: "failed",
            message: built.failure,
          });
        }
        yield* writeFromEvent(raise, kind.value, event.value, parts, { _tag: "skipped" });
      }),
  };
});

/**
 * Raising a plugin's signals from the raises the intake routing table
 * writes. The controller daemon's signal raise delivery drives it.
 */
export class SignalRaises extends Context.Service<SignalRaises, Effect.Success<typeof make>>()(
  "hercule/controller/signals/SignalRaises",
) {}

export const SignalRaisesLayer: Layer.Layer<
  SignalRaises,
  never,
  SqlClient.SqlClient | PluginHost | ConnectionTypes | BoundOperations | Notifier | AuditLog
> = Layer.effect(SignalRaises)(make);
