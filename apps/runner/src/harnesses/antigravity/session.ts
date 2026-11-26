/**
 * One running `agy` session: starts the process, opens or resumes its
 * conversation, sets the model, thinking level and mode, and then runs one Turn
 * per input (spec 06 sections 4.2, 6.2, 8.1 and 10.5). The adapter keeps one of
 * these per Hercule session and does nothing but route calls to it.
 *
 * The session owns what must never overlap:
 *
 * - at most one input is prepared or running at a time, because `agy` takes one
 *   prompt at a time and cannot steer (the controller queues what arrives
 *   meanwhile);
 * - the exit happens exactly once, with the first reason that asks for it.
 *
 * Time is measured on Effect's clock, so tests run the deadlines on a `TestClock`.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { AcpError } from "@hercule/acp";
import type {
  AcpConnection,
  AcpHandlers,
  ApprovalOutcome,
  ElicitationReply,
  PromptContent,
  PromptReply,
  SessionSettings,
} from "@hercule/acp";
import { SteerRefused } from "@hercule/protocol";
import type {
  AccessMode,
  AdapterError,
  AnswerNotDelivered,
  ApprovalDecision,
  ExitReason,
  HarnessEvent,
  HarnessProtocolError,
  ModelChangeRefused,
  ModelSelection,
  QuestionAnswers,
  SendResult,
  SessionBinding,
  SessionSpec,
} from "@hercule/protocol";
import {
  buildInputNotWritten,
  buildAdapterFailed,
  buildAnswerNotDelivered,
  buildHarnessNotInstalled,
  buildHarnessProtocolError,
  buildInputStopped,
  buildModelChangeLost,
  buildModelChangeRefused,
  buildSessionNotRunning,
  buildSessionStopping,
  buildStartFailure,
} from "../adapter-error-builders";
import { formatModelArgument } from "../account";
import { readAttachmentBase64 } from "../attachments";
import { buildUserMessage } from "../events";
import type { AdapterTurnInput, LocalAttachment, SessionStartContext } from "../index";
import { buildEnvelope } from "../normalize";
import { buildHarnessPrompt, joinInstructions } from "../prompt";
import { truncateMessage } from "../text";
import {
  ANTIGRAVITY_NAME,
  checkAccountUsable,
  findAgyHooksFile,
  openSignedInAgy,
  readAgyModeId,
} from "./agy";
import type { AgySeam } from "./agy";
import { APP_DATA_DIR } from "./harness-home";
import { buildModelCatalog } from "./model-catalog";
import {
  buildNormalizingState,
  closeProcess,
  closeTurn,
  describeRequestItem,
  findRequestOwner,
  holdTurn,
  markDeclined,
  normalizeUnhandled,
  normalizeUpdate,
  openTurn,
  readSyntheticTurnId,
  releaseTurn,
} from "./normalize";
import type { Normalizing } from "./normalize";
import { startTurn } from "./turn";
import type { Turn } from "./turn";

/**
 * How long one call that changes the model, level or mode may take. ACP's own
 * limit is 30 seconds, which is longer than the controller waits for an input
 * (`SESSION_INPUT_DEADLINE`, 10 seconds).
 */
const CONFIG_DEADLINE = Duration.seconds(3);

/** How long a start waits for `agy` to report that it is in the mode that was set (spec 06 section 8.1). */
const MODE_CONFIRMATION_DEADLINE = Duration.seconds(5);

/**
 * How long everything before the prompt of an input may take together: reading
 * the images and changing the model. It stays under the 10 seconds after which
 * the controller gives an input up.
 */
const PREPARATION_BUDGET = Duration.seconds(8);

/** How long an exit waits for the Turn to report its end once the process is gone. */
const TURN_END_WAIT = Duration.seconds(5);

/** The names the user knows the Access Modes by. */
const ACCESS_MODE_NAMES: Readonly<Record<AccessMode, string>> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

const CANCELLED_APPROVAL: ApprovalOutcome = { outcome: "cancelled" };
const CANCELLED_QUESTION: ElicitationReply = { action: "cancel" };

/** What `agy` holds as the model and the thinking level, as it reported them. Undefined fields are not known. */
interface AppliedSelection {
  /** The model as `agy` names it: the account's model argument applied to the model id. */
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

/** A running session, as the adapter uses it. */
export interface AgySession {
  readonly binding: SessionBinding;
  /**
   * Runs the input as a new Turn and returns once its prompt was handed to the
   * connection, not when `agy` replied. Fails with:
   *
   * - `SessionNotRunning` when the session is stopping or has exited;
   * - `SteerRefused` while a Turn runs or another input is being prepared,
   *   because `agy` cannot steer: the controller queues the input. Nothing
   *   changes before this failure;
   * - `ModelChangeRefused` when `agy` refuses the model or level of the input,
   *   and `HarnessProtocolError` when it is not known whether it took them;
   * - `InputNotDelivered` when an interrupt or a stop came during the
   *   preparation, or when writing the prompt to `agy` failed. No Turn is
   *   opened then;
   * - `HarnessProtocolError` when the budget ran out while the prompt was being
   *   written, so it is not known whether `agy` got it;
   * - `AdapterFailed` when an image cannot be read or the preparation takes
   *   longer than its budget.
   */
  readonly send: (input: AdapterTurnInput) => Effect.Effect<SendResult, AdapterError>;
  /** Interrupts the running Turn, or the input being prepared. Does nothing when neither exists. */
  readonly interrupt: Effect.Effect<void>;
  /** Decides an approval Request of the running Turn. Does nothing when no such Request is open. */
  readonly decide: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>;
  /** Answers a question Request of the running Turn. Fails with `AnswerNotDelivered` when it cannot. */
  readonly answer: (
    requestId: string,
    answers: QuestionAnswers,
  ) => Effect.Effect<void, AnswerNotDelivered>;
  /**
   * Ends the session: cancels the open Requests, closes the process, waits for
   * the Turn to end and emits `session.exited` with `reason`. Returns when the
   * exit is complete. Does nothing more when the session already exits, and
   * then the first reason stays.
   */
  readonly stop: (reason: ExitReason) => Effect.Effect<void>;
  /** Completes once `session.exited` was emitted, whatever caused it. */
  readonly exited: Effect.Effect<void>;
}

/** Returns the value a `select` config option currently has, or undefined when there is no such option. */
const readCurrentValue = (
  options: SessionSettings["configOptions"],
  id: string,
): string | undefined => {
  const option = options.find((candidate) => candidate.id === id);
  return option?.type === "select" ? option.currentValue : undefined;
};

/** What a reply to a change of a setting says about the setting. */
type ChangeOutcome =
  | { readonly kind: "confirmed" }
  | { readonly kind: "other"; readonly named: string }
  | { readonly kind: "unconfirmed" };

/**
 * Compares the value a reply (or an update that came before it) names for a
 * setting with the value that was asked for. A reply that names nothing is
 * `unconfirmed`, never taken as the requested value.
 */
const judgeChange = (requested: string, named: string | undefined): ChangeOutcome => {
  if (named === undefined) return { kind: "unconfirmed" };
  return named === requested ? { kind: "confirmed" } : { kind: "other", named };
};

/** Returns the effort level the selection asks for, or undefined when it asks for none. */
const readEffort = (selection: ModelSelection): string | undefined => {
  const effort = selection.options["effort"];
  return typeof effort === "string" && effort !== "" ? effort : undefined;
};

/** Returns the text the session's `agy` appends to its system prompt, or undefined when there is none. */
const buildInstructions = (ctx: SessionStartContext, spec: SessionSpec): string | undefined =>
  joinInstructions([
    ctx.herculeTool.orientation,
    spec.systemPrompt,
    spec.coordination,
    spec.memory,
  ]);

/**
 * Runs an ACP call that changes a setting of the conversation, and fails with
 * a `timed-out` `AcpError` when `agy` does not answer within `CONFIG_DEADLINE`.
 */
const withConfigDeadline = <A>(
  call: Effect.Effect<A, AcpError>,
  what: string,
): Effect.Effect<A, AcpError> =>
  Effect.flatMap(Effect.timeoutOption(call, CONFIG_DEADLINE), (answered) =>
    Option.isSome(answered)
      ? Effect.succeed(answered.value)
      : Effect.fail(
          new AcpError({
            reason: "timed-out",
            message: `${ANTIGRAVITY_NAME} did not answer the request to ${what} in time.`,
          }),
        ),
  );

/** Returns the failure of a start when `agy` refuses or does not answer a request to change a setting. */
const buildStartConfigFailure = (what: string, error: AcpError) =>
  buildAdapterFailed(
    `${ANTIGRAVITY_NAME} did not accept ${what}, so the session was not started: ${error.harnessMessage ?? error.message}`,
  );

/**
 * Returns the failure of an input whose model or level change did not work.
 * A refusal keeps the session on its model. A closed connection or a missing
 * answer leaves it unknown whether the change happened.
 */
const buildChangeFailure = (
  change: string,
  error: AcpError,
): ModelChangeRefused | HarnessProtocolError => {
  if (error.reason === "refused") {
    return buildModelChangeRefused(ANTIGRAVITY_NAME, change, error.harnessMessage ?? error.message);
  }
  if (error.reason === "closed") return buildModelChangeLost(ANTIGRAVITY_NAME, error.message);
  return buildHarnessProtocolError(
    `${ANTIGRAVITY_NAME} did not acknowledge the request to ${change} in time, so it may or may not have happened and the input was not sent: ${error.message}`,
  );
};

/** Returns the failure of an input whose model or level change `agy` did not confirm, so it is not known what `agy` holds. */
const buildUnconfirmedChange = (change: string): HarnessProtocolError =>
  buildHarnessProtocolError(
    `${ANTIGRAVITY_NAME} did not confirm the request to ${change}, so it may or may not have happened and the input was not sent.`,
  );

/**
 * Starts `agy` for one session and returns it ready for its first input, with
 * `session.started` emitted. `scope` is the session's own: closing it stops the
 * process, which a finished session or a failed start does. Every event the
 * session reports goes through `emit`, in order.
 *
 * Follows spec 06 section 10.5: the process is opened and signed in, then the
 * conversation is created (or resumed with `spec.continue`), the account is
 * checked, the model and level are set, and the mode is set and confirmed.
 * Nothing is prompted before all of that has passed. Fails with:
 *
 * - `HarnessNotInstalled` when `ctx.binary` is missing, and the failures of
 *   `openSignedInAgy` for the process and its sign-in;
 * - `ResumeTranscriptMissing` when `agy` has no such conversation to resume;
 * - `AdapterFailed` when the account cannot be used, when `agy` does not
 *   accept the model or level, when `agy` does not confirm the mode within 5
 *   seconds, or when any other call fails.
 *
 * A start that fails before `session.started` leaves no event. Dies when
 * `spec.continue` asks for a fork or `ctx.cwd` is missing, because the plugin
 * declares fork unsupported and a session always has a working folder.
 */
export const startAgySession = (
  seam: AgySeam,
  sessionId: string,
  spec: SessionSpec,
  ctx: SessionStartContext,
  emit: (events: ReadonlyArray<HarnessEvent>) => void,
): Effect.Effect<AgySession, AdapterError, Scope.Scope> =>
  Effect.gen(function* () {
    const binary = ctx.binary;
    if (binary === undefined) return yield* Effect.fail(buildHarnessNotInstalled(ANTIGRAVITY_NAME));
    const cwd = ctx.cwd;
    if (cwd === null)
      return yield* Effect.die(new Error("A session starts with a working folder."));
    if (spec.continue?.mode === "fork") {
      return yield* Effect.die(new Error("Antigravity declares fork unsupported."));
    }

    const scope = yield* Scope.Scope;
    // The process has a scope of its own, so that a stop can close it while the
    // Turn, which lives in the session's scope, still reports its end.
    const processScope = yield* Scope.fork(scope, "sequential");
    const services = yield* Effect.context<never>();
    /** Runs `effect` from a callback of the connection, which is not in a fiber. */
    const runDetached = (effect: Effect.Effect<void>): void => {
      void Effect.runForkWith(services)(Effect.annotateLogs(effect, { sessionId }));
    };

    // What the handlers and the session's methods share.
    let normalizing: Normalizing | undefined;
    /** Undefined until `agy` replies to the call that opens the conversation. */
    let nativeSessionId: string | undefined;
    let replayedUpdates = 0;
    let current: Turn | undefined;
    let preparing = false;
    /** Grows at every interrupt and stop, so an input that was prepared before it knows it is void. */
    let generation = 0;
    let stopping = false;
    let hasExited = false;
    let exitReason: ExitReason | undefined;
    const exitedSignal = Deferred.makeUnsafe<void>();
    /** The latest mode `agy` reported, in an update or in the reply that opened the conversation. A report is never replaced by an older one. */
    let currentMode: string | undefined;
    /** Wakes the start that waits for the mode, whenever `agy` reports one. */
    let modeChanged: Deferred.Deferred<void> | undefined;
    /** The latest value `agy` reported for each setting in a `config_option_update`. */
    const reportedSettings = new Map<string, string>();
    /** The mode the start asked for and `agy` confirmed. Undefined in `full-access`, which has no mode to guard. */
    let guardedMode: string | undefined;
    let isStarted = false;
    let applied: AppliedSelection | undefined;

    const buildBase = (toolCallId?: string) =>
      buildEnvelope(sessionId, {
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
      });

    const emitEvents = (events: ReadonlyArray<HarnessEvent>): void => {
      if (events.length > 0) emit(events);
    };

    /** The Turn of an input that is running, which is one that has not started to end. */
    const readRunningTurn = (): Turn | undefined =>
      current !== undefined && !current.hasEnded() ? current : undefined;

    // ---- Exit ----

    /**
     * Ends the session once: the first reason wins, and a later call waits for
     * that exit. `stopTurn` is false when the process ended by itself, so the
     * Turn reports that as a failure instead of an interrupt.
     */
    const exitSession = (
      reason: ExitReason,
      options: { readonly stopTurn: boolean } = { stopTurn: true },
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        stopping = true;
        generation += 1;
        if (exitReason !== undefined) return Deferred.await(exitedSignal);
        exitReason = reason;
        const turn = readRunningTurn();
        const procedure = Effect.gen(function* () {
          if (turn !== undefined && options.stopTurn) yield* turn.stop;
          yield* Scope.close(processScope, Exit.void);
          if (turn !== undefined) {
            // A Turn that does not end by itself is ended here, so no event of it follows `session.exited`.
            const ended = yield* Effect.timeoutOption(turn.ended, TURN_END_WAIT);
            if (Option.isNone(ended)) yield* turn.abandon;
          }
          if (normalizing !== undefined) emitEvents(closeProcess(normalizing));
          emitEvents([{ _tag: "session.exited", ...buildBase(), reason }]);
          hasExited = true;
          Deferred.doneUnsafe(exitedSignal, Effect.void);
        });
        // A fiber of the session's scope runs it, so a caller that is interrupted cannot leave the exit half done.
        return Effect.forkIn(procedure, scope).pipe(Effect.andThen(Deferred.await(exitedSignal)));
      });

    /**
     * Ends the process of a Turn that did not answer `session/cancel`. Marks
     * the session as stopping before anything else, so no input starts on it.
     */
    const endUnresponsive = (turnId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (stopping) return Effect.void;
        stopping = true;
        emitEvents([
          {
            _tag: "runtime.error",
            ...buildBase(),
            turnId,
            class: "unresponsive",
            message: "Antigravity did not stop, so Hercule ended its process.",
          },
        ]);
        return exitSession("process_exit");
      });

    const endForModeChange = (from: string | undefined, to: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (stopping) return Effect.void;
        stopping = true;
        const turn = readRunningTurn();
        emitEvents([
          {
            _tag: "runtime.error",
            ...buildBase(),
            ...(turn === undefined ? {} : { turnId: turn.id }),
            class: "mode_changed",
            message: truncateMessage(
              `Antigravity changed its own permission mode from ${from ?? "unknown"} to ${to}, so Hercule stopped it.`,
            ),
          },
        ]);
        return exitSession("crash");
      });

    // ---- What `agy` sends ----

    const handleModeUpdate = (modeId: string): void => {
      const previous = currentMode;
      currentMode = modeId;
      if (modeChanged !== undefined) Deferred.doneUnsafe(modeChanged, Effect.void);
      if (isStarted && guardedMode !== undefined && modeId !== guardedMode) {
        runDetached(endForModeChange(previous ?? guardedMode, modeId));
      }
    };

    const warnOrphan = (what: string, toolCallId: string | null | undefined): void => {
      emitEvents([
        {
          _tag: "runtime.warning",
          ...buildBase(toolCallId ?? undefined),
          message: `Antigravity asked ${what} that no running turn owns, so Hercule cancelled it.`,
        },
      ]);
    };

    const handlers: AcpHandlers = {
      onSessionUpdate: (notification) => {
        if (hasExited) return;
        // Before the reply that opens the conversation, an update is part of a resume's replay.
        if (normalizing === undefined) {
          replayedUpdates += 1;
          return;
        }
        if (notification.nativeSessionId !== nativeSessionId) {
          runDetached(
            Effect.logWarning(
              `${ANTIGRAVITY_NAME} sent an update for another conversation, so it was dropped.`,
            ),
          );
          return;
        }
        if (notification.update.sessionUpdate === "current_mode_update") {
          handleModeUpdate(notification.update.currentModeId);
          return;
        }
        if (notification.update.sessionUpdate === "config_option_update") {
          for (const id of ["model", "thought_level"]) {
            const value = readCurrentValue(notification.update.configOptions, id);
            if (value !== undefined) reportedSettings.set(id, value);
          }
        }
        emitEvents(normalizeUpdate(normalizing, notification));
      },
      onApprovalRequest: (request) =>
        Effect.suspend(() => {
          if (normalizing === undefined || request.nativeSessionId !== nativeSessionId) {
            runDetached(
              Effect.logWarning(
                `${ANTIGRAVITY_NAME} asked for approval for a conversation this session does not hold, so it was cancelled.`,
              ),
            );
            return Effect.succeed(CANCELLED_APPROVAL);
          }
          const item = describeRequestItem(
            normalizing,
            request.toolCall.toolCallId,
            request.toolCall,
          );
          const turn = readRunningTurn();
          if (item === undefined || turn === undefined || turn.id !== item.turnId) {
            // A call that is shown as cancelled, not as failed, because nobody ran it.
            markDeclined(normalizing, request.toolCall.toolCallId);
            warnOrphan("for approval of a call", request.toolCall.toolCallId);
            return Effect.succeed(CANCELLED_APPROVAL);
          }
          return turn.openApproval(request, item);
        }),
      onElicitation: (request) =>
        Effect.suspend(() => {
          if (
            normalizing === undefined ||
            (request.nativeSessionId !== undefined && request.nativeSessionId !== nativeSessionId)
          ) {
            runDetached(
              Effect.logWarning(
                `${ANTIGRAVITY_NAME} asked a question for a conversation this session does not hold, so it was cancelled.`,
              ),
            );
            return Effect.succeed(CANCELLED_QUESTION);
          }
          const owner =
            request.toolCallId == null
              ? undefined
              : findRequestOwner(normalizing, request.toolCallId);
          const turn = readRunningTurn();
          if (owner === undefined || turn === undefined || turn.id !== owner.turnId) {
            warnOrphan("a question", request.toolCallId);
            return Effect.succeed(CANCELLED_QUESTION);
          }
          return turn.openQuestion(request, owner);
        }),
      onUnhandledMessage: (message) => {
        if (hasExited) return;
        if (normalizing === undefined) {
          replayedUpdates += 1;
          return;
        }
        emitEvents(normalizeUnhandled(normalizing, message));
      },
    };

    // ---- The start ----

    /**
     * Waits until the latest mode `agy` reported is `modeId`, then arms the
     * drift guard in the same step, so a report that follows is already
     * checked. A contrary report that comes before the wait ends keeps it
     * waiting.
     */
    const awaitMode = (modeId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (currentMode !== modeId) {
          const changed = Deferred.makeUnsafe<void>();
          modeChanged = changed;
          yield* Deferred.await(changed);
        }
        modeChanged = undefined;
        guardedMode = modeId;
      });

    const start = Effect.gen(function* () {
      // In full access nothing is asked anyway, so a repository's hooks add no power.
      const hooksFile =
        spec.accessMode === "full-access" ? undefined : yield* findAgyHooksFile(cwd);
      if (hooksFile !== undefined) {
        return yield* Effect.fail(
          buildAdapterFailed(
            `This repository has Antigravity hooks in ${hooksFile}. Hooks can approve actions by themselves and run the repository's own code, and Hercule cannot turn them off, so the session was not started. Remove the file, or start the thread in Full access.`,
          ),
        );
      }
      const agy = yield* openSignedInAgy(seam.spawn, ctx, binary, {
        cwd,
        handlers,
        purpose: { kind: "session", accessMode: spec.accessMode },
      }).pipe(Scope.provide(processScope));
      const connection: AcpConnection = agy.connection;

      const instructions = buildInstructions(ctx, spec);
      const request = {
        cwd,
        // The MCP Gateway is handed to `agy` by a later change.
        mcpServers: [],
        ...(instructions === undefined
          ? {}
          : { meta: { antigravity: { systemPrompt: { append: instructions } } } }),
      };
      // From the reply on, updates are the session's own. Before it, they are a resume's replay.
      const startReading = (id: string) =>
        Effect.sync(() => {
          nativeSessionId = id;
          normalizing = buildNormalizingState({
            sessionId,
            nativeSessionId: id,
            brainFolder: `${ctx.home}/${APP_DATA_DIR}/brain`,
          });
        });
      const conversation = yield* (
        spec.continue === undefined
          ? agy.newConversation(request, startReading)
          : agy.resumeConversation(
              { ...request, nativeSessionId: spec.continue.nativeSessionId },
              startReading,
            )
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "AcpError" ? buildStartFailure(ANTIGRAVITY_NAME, error.message) : error,
        ),
      );
      const { settings } = conversation;
      const state = normalizing;
      if (state === undefined)
        return yield* Effect.die(new Error("The conversation was not read."));
      if (replayedUpdates > 0) {
        yield* Effect.logInfo(
          `Dropped ${replayedUpdates} updates that ${ANTIGRAVITY_NAME} replayed while it resumed the conversation.`,
        ).pipe(Effect.annotateLogs({ sessionId }));
      }

      const usable = checkAccountUsable(
        agy.planLabel,
        buildModelCatalog(settings),
        conversation.isHeldByGoogle,
      );
      if (Result.isFailure(usable)) return yield* Effect.fail(usable.failure);

      // The model and level come first, and only when `agy` does not already have them.
      const model = formatModelArgument(ctx.modelArgument, spec.modelSelection.model);
      const effort = readEffort(spec.modelSelection);
      let heldModel = readCurrentValue(settings.configOptions, "model");
      let heldEffort = readCurrentValue(settings.configOptions, "thought_level");
      if (heldModel !== model) {
        reportedSettings.delete("model");
        const options = yield* withConfigDeadline(
          connection.setConfigOption(conversation.id, "model", model),
          `switch to the model ${spec.modelSelection.model}`,
        ).pipe(
          Effect.mapError((error) =>
            buildStartConfigFailure(`the model ${spec.modelSelection.model}`, error),
          ),
        );
        const named = readCurrentValue(options, "model") ?? reportedSettings.get("model");
        const outcome = judgeChange(model, named);
        if (outcome.kind !== "confirmed") {
          return yield* Effect.fail(
            buildAdapterFailed(
              `${ANTIGRAVITY_NAME} did not confirm the model ${spec.modelSelection.model}${outcome.kind === "other" ? `: it reports ${outcome.named}` : ""}, so the session was not started.`,
            ),
          );
        }
        heldModel = model;
        heldEffort =
          readCurrentValue(options, "thought_level") ?? reportedSettings.get("thought_level");
      }
      if (effort !== undefined && heldEffort !== effort) {
        reportedSettings.delete("thought_level");
        const options = yield* withConfigDeadline(
          connection.setConfigOption(conversation.id, "thought_level", effort),
          `switch to the level ${effort}`,
        ).pipe(Effect.mapError((error) => buildStartConfigFailure(`the level ${effort}`, error)));
        const named =
          readCurrentValue(options, "thought_level") ?? reportedSettings.get("thought_level");
        const outcome = judgeChange(effort, named);
        if (outcome.kind !== "confirmed") {
          return yield* Effect.fail(
            buildAdapterFailed(
              `${ANTIGRAVITY_NAME} did not confirm the level ${effort}${outcome.kind === "other" ? `: it reports ${outcome.named}` : ""}, so the session was not started.`,
            ),
          );
        }
        heldEffort = effort;
      }
      applied = { model: heldModel, effort: heldEffort };

      // Then the mode. `full-access` has none: it is a flag of the process.
      const modeId = readAgyModeId(spec.accessMode);
      if (modeId !== undefined) {
        const modeFailure = buildAdapterFailed(
          `${ANTIGRAVITY_NAME} did not switch to ${ACCESS_MODE_NAMES[spec.accessMode]}. Pick another access mode.`,
        );
        const modes = settings.modes;
        // A missing list is "not known", never "none", and neither lets a session start.
        if (modes === undefined || !modes.availableModes.some((mode) => mode.id === modeId)) {
          return yield* Effect.fail(modeFailure);
        }
        // An update that came since the reply is newer than the reply's snapshot.
        currentMode ??= modes.currentModeId;
        if (currentMode !== modeId) {
          yield* connection.setMode(conversation.id, modeId).pipe(
            Effect.andThen(awaitMode(modeId)),
            Effect.timeoutOption(MODE_CONFIRMATION_DEADLINE),
            Effect.mapError(() => modeFailure),
            Effect.flatMap((confirmed) =>
              Option.isNone(confirmed) ? Effect.fail(modeFailure) : Effect.void,
            ),
          );
        } else {
          guardedMode = modeId;
        }
      }

      // From here to the monitor nothing waits, so no update slips in between.
      isStarted = true;
      emitEvents([{ _tag: "session.started", ...buildBase() }]);
      // A resumed conversation was warned about when it first started.
      if (spec.autoCompaction === false && spec.continue === undefined) {
        emitEvents([
          {
            _tag: "runtime.warning",
            ...buildBase(),
            message:
              "Antigravity compacts its context by itself, and Hercule cannot turn that off or see it.",
          },
        ]);
      }
      yield* Effect.forkIn(
        Effect.flatMap(connection.awaitClosed, () =>
          exitSession("process_exit", { stopTurn: false }),
        ),
        scope,
      );
      return { connection, state, nativeId: conversation.id };
    }).pipe(Effect.onError(() => Scope.close(processScope, Exit.void)));

    const { connection, state, nativeId } = yield* start;

    // ---- Inputs ----

    const readImages = (
      attachments: ReadonlyArray<LocalAttachment>,
    ): Effect.Effect<ReadonlyArray<PromptContent>, AdapterError> =>
      Effect.forEach(attachments, (attachment) =>
        readAttachmentBase64(attachment).pipe(
          Effect.map((data): PromptContent => ({
            type: "image",
            mimeType: attachment.mimeType,
            data,
          })),
          Effect.mapError(buildAdapterFailed),
        ),
      );

    /**
     * Changes the model and level to the ones the input asks for, when `agy`
     * does not hold them. What `agy` holds is `applied`: it is unknown while a
     * request is in flight and after one that was not confirmed, so the next
     * input sets it again. A refusal puts back what was held before the
     * request. A reply (or an update before it) must name the requested value:
     * another value is a refusal, no value is a change that is not confirmed.
     * A model that was confirmed stays recorded when its level fails.
     */
    const selectModel = (
      selection: ModelSelection,
      inputGeneration: number,
    ): Effect.Effect<void, AdapterError> =>
      Effect.gen(function* () {
        const model = formatModelArgument(ctx.modelArgument, selection.model);
        const effort = readEffort(selection);
        let held = applied;
        if (held?.model !== model) {
          const before = held;
          applied = undefined;
          reportedSettings.delete("model");
          const change = `switch to the model ${selection.model}`;
          const options = yield* withConfigDeadline(
            connection.setConfigOption(nativeId, "model", model),
            change,
          ).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (error.reason === "refused") applied = before;
              }),
            ),
            Effect.mapError((error) => buildChangeFailure(change, error)),
          );
          const named = readCurrentValue(options, "model") ?? reportedSettings.get("model");
          const reportedEffort =
            readCurrentValue(options, "thought_level") ?? reportedSettings.get("thought_level");
          const outcome = judgeChange(model, named);
          if (outcome.kind === "other") {
            applied = { model: outcome.named, effort: reportedEffort };
            return yield* Effect.fail(
              buildModelChangeRefused(
                ANTIGRAVITY_NAME,
                change,
                `${ANTIGRAVITY_NAME} reports the model ${outcome.named} instead.`,
              ),
            );
          }
          if (outcome.kind === "unconfirmed") {
            return yield* Effect.fail(buildUnconfirmedChange(change));
          }
          held = { model, effort: reportedEffort };
          applied = held;
          if (stopping || generation !== inputGeneration)
            return yield* Effect.fail(buildInputStopped());
        }
        if (effort !== undefined && held.effort !== effort) {
          const before = held;
          applied = { model: held.model, effort: undefined };
          reportedSettings.delete("thought_level");
          const change = `switch to the level ${effort}`;
          const options = yield* withConfigDeadline(
            connection.setConfigOption(nativeId, "thought_level", effort),
            change,
          ).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (error.reason === "refused") applied = before;
              }),
            ),
            Effect.mapError((error) => buildChangeFailure(change, error)),
          );
          const named =
            readCurrentValue(options, "thought_level") ?? reportedSettings.get("thought_level");
          const outcome = judgeChange(effort, named);
          if (outcome.kind === "other") {
            applied = { model: held.model, effort: outcome.named };
            return yield* Effect.fail(
              buildModelChangeRefused(
                ANTIGRAVITY_NAME,
                change,
                `${ANTIGRAVITY_NAME} reports the level ${outcome.named} instead.`,
              ),
            );
          }
          if (outcome.kind === "unconfirmed") {
            return yield* Effect.fail(buildUnconfirmedChange(change));
          }
          applied = { model: held.model, effort };
        }
      });

    /**
     * Reads the images, sets the model, and writes the prompt to `agy`. Returns
     * the effect that waits for the prompt's reply, once the line was written.
     * Fails with `InputNotDelivered` when the write failed, which proves `agy`
     * did not get the prompt, and with `HarnessProtocolError` when the budget
     * ran out while the write was pending, which leaves it unknown.
     */
    const prepareInput = (
      input: AdapterTurnInput,
      inputGeneration: number,
    ): Effect.Effect<Effect.Effect<PromptReply, AcpError>, AdapterError> =>
      Effect.suspend(() => {
        let isHandingOver = false;
        return Effect.gen(function* () {
          const images = yield* readImages(input.attachments ?? []);
          // An interrupt that came while the images were read voids the input before anything is written to `agy`.
          if (stopping || generation !== inputGeneration) {
            return yield* Effect.fail(buildInputStopped());
          }
          if (input.modelSelection !== undefined) {
            yield* selectModel(input.modelSelection, inputGeneration);
          }
          const text: PromptContent = { type: "text", text: buildHarnessPrompt(input) };
          isHandingOver = true;
          return yield* connection.sendPrompt(nativeId, [text, ...images]).pipe(
            Effect.mapError((error) => {
              isHandingOver = false;
              return buildInputNotWritten(ANTIGRAVITY_NAME, error.message);
            }),
          );
        }).pipe(
          Effect.timeoutOption(PREPARATION_BUDGET),
          Effect.flatMap((prepared) =>
            Option.isSome(prepared)
              ? Effect.succeed(prepared.value)
              : Effect.fail(
                  isHandingOver
                    ? buildHarnessProtocolError(
                        `${ANTIGRAVITY_NAME} did not take the input in time, so it may or may not have arrived.`,
                      )
                    : buildAdapterFailed(
                        `Preparing the input for ${ANTIGRAVITY_NAME} took too long, so it was not sent.`,
                      ),
                ),
          ),
        );
      });

    const send: AgySession["send"] = (input) =>
      Effect.gen(function* () {
        if (stopping) {
          return yield* Effect.fail(hasExited ? buildSessionNotRunning() : buildSessionStopping());
        }
        if (readRunningTurn() !== undefined || preparing) {
          return yield* Effect.fail(
            new SteerRefused({
              message: `${ANTIGRAVITY_NAME} cannot take input in the middle of a turn. The input stays queued and runs when this turn ends.`,
            }),
          );
        }
        // Admission is reserved here, before the first wait, so a second input is refused while this one is prepared.
        const inputGeneration = generation;
        preparing = true;
        holdTurn(state);
        const abandonPreparation = (): void => {
          preparing = false;
          emitEvents(releaseTurn(state));
        };

        const prepared = yield* Effect.exit(prepareInput(input, inputGeneration)).pipe(
          Effect.onInterrupt(() => Effect.sync(abandonPreparation)),
        );
        if (Exit.isFailure(prepared)) {
          abandonPreparation();
          if (stopping || generation !== inputGeneration)
            return yield* Effect.fail(buildInputStopped());
          return yield* Effect.failCause(prepared.cause);
        }
        // The prompt is written, but a process that is going away reports no Turn.
        if (stopping) {
          abandonPreparation();
          return yield* Effect.fail(buildInputStopped());
        }

        // The Turn opens only now: a prompt that could not be written leaves no Turn at all. What `agy` sent meanwhile is held, and replays into the Turn.
        const turnId = crypto.randomUUID();
        emitEvents(openTurn(state, turnId));
        emitEvents(
          buildUserMessage({
            sessionId,
            turnId,
            text: input.text,
            attachments: input.attachments,
            senderSessionId: input.senderSessionId,
            steered: false,
            harnessRefs: { nativeSessionId: nativeId },
          }),
        );
        current = yield* startTurn(
          {
            sessionId,
            nativeSessionId: nativeId,
            connection,
            normalizing: state,
            emit: emitEvents,
          },
          { turnId, firstReply: prepared.value },
        ).pipe(Scope.provide(scope));
        preparing = false;
        // An interrupt that came while the prompt was being written found no Turn, so it is applied now.
        if (generation !== inputGeneration) runDetached(interrupt);
        return { turnId, delivery: "opened" } satisfies SendResult;
      });

    const interrupt: AgySession["interrupt"] = Effect.suspend(() => {
      // An input still being prepared is void from now on.
      generation += 1;
      const turn = readRunningTurn();
      if (turn === undefined) {
        // Output with no prompt open has a synthetic turn. Stopping it asks `agy` to stop, and waits for nothing.
        const syntheticTurnId = readSyntheticTurnId(state);
        if (syntheticTurnId === undefined) return Effect.void;
        // The wait lets an input open its own Turn, which this interrupt must not close.
        return withConfigDeadline(connection.cancel(nativeId), "cancel").pipe(
          Effect.catch((error) =>
            Effect.logWarning(`session/cancel was not sent: ${error.message}`),
          ),
          Effect.andThen(
            Effect.sync(() =>
              emitEvents(closeTurn(state, { state: "interrupted", turnId: syntheticTurnId })),
            ),
          ),
        );
      }
      return Effect.flatMap(turn.interrupt, (result) =>
        result === "unresponsive" ? endUnresponsive(turn.id) : Effect.void,
      );
    });

    const decide: AgySession["decide"] = (requestId, decision) =>
      Effect.suspend(() => {
        const turn = readRunningTurn();
        if (turn === undefined) return Effect.void;
        return Effect.flatMap(turn.decide(requestId, decision), (result) =>
          result === "unresponsive" ? endUnresponsive(turn.id) : Effect.void,
        );
      });

    const answer: AgySession["answer"] = (requestId, answers) =>
      Effect.suspend(() => {
        const turn = readRunningTurn();
        return turn === undefined
          ? Effect.fail(
              buildAnswerNotDelivered(
                "This question is not open anymore. Nothing was sent to Antigravity.",
              ),
            )
          : turn.answer(requestId, answers);
      });

    return {
      binding: { sessionId, nativeSessionId: nativeId, providerAccountId: spec.providerAccountId },
      send,
      interrupt,
      decide,
      answer,
      stop: (reason) => exitSession(reason),
      exited: Deferred.await(exitedSignal),
    } satisfies AgySession;
  });
