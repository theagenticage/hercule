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
import { ANTIGRAVITY_NAME, checkAccountUsable, openSignedInAgy, readAgyModeId } from "./agy";
import type { AgySeam } from "./agy";
import { APP_DATA_DIR } from "./harness-home";
import { buildModelCatalog } from "./model-catalog";
import {
  buildNormalizingState,
  closeProcess,
  closeTurn,
  describeRequestItem,
  hasOpenSyntheticTurn,
  holdTurn,
  markDeclined,
  normalizeUnhandled,
  normalizeUpdate,
  openTurn,
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
   *   preparation, and `AdapterFailed` when an image cannot be read or the
   *   preparation takes longer than its budget.
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
    /** The mode `agy` is in, as far as its updates and its first reply say. */
    let currentMode: string | undefined;
    /** The mode the start asked for and `agy` confirmed. Undefined in `full-access`, which has no mode to guard. */
    let guardedMode: string | undefined;
    let isStarted = false;
    /** The mode a start waits for, with the signal that `agy` reported it. */
    let modeWatch:
      | { readonly modeId: string; readonly confirmed: Deferred.Deferred<void> }
      | undefined;
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
          if (turn !== undefined) yield* Effect.timeoutOption(turn.ended, TURN_END_WAIT);
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
      if (modeWatch?.modeId === modeId) {
        Deferred.doneUnsafe(modeWatch.confirmed, Effect.void);
        return;
      }
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
          const item =
            request.toolCallId == null
              ? undefined
              : describeRequestItem(normalizing, request.toolCallId);
          const turn = readRunningTurn();
          if (item === undefined || turn === undefined || turn.id !== item.turnId) {
            warnOrphan("a question", request.toolCallId);
            return Effect.succeed(CANCELLED_QUESTION);
          }
          return turn.openQuestion(request, item);
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

    const start = Effect.gen(function* () {
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
        const options = yield* withConfigDeadline(
          connection.setConfigOption(conversation.id, "model", model),
          `switch to the model ${spec.modelSelection.model}`,
        ).pipe(
          Effect.mapError((error) =>
            buildStartConfigFailure(`the model ${spec.modelSelection.model}`, error),
          ),
        );
        heldModel = readCurrentValue(options, "model") ?? model;
        heldEffort = readCurrentValue(options, "thought_level");
      }
      if (effort !== undefined && heldEffort !== effort) {
        const options = yield* withConfigDeadline(
          connection.setConfigOption(conversation.id, "thought_level", effort),
          `switch to the level ${effort}`,
        ).pipe(Effect.mapError((error) => buildStartConfigFailure(`the level ${effort}`, error)));
        heldEffort = readCurrentValue(options, "thought_level") ?? effort;
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
        currentMode = modes.currentModeId;
        if (currentMode !== modeId) {
          // `agy` reported the new mode before the reply to `session/set_mode` in one recording and after it in another, so the watch starts first.
          const confirmed = Deferred.makeUnsafe<void>();
          modeWatch = { modeId, confirmed };
          const switched = yield* connection.setMode(conversation.id, modeId).pipe(
            Effect.andThen(Deferred.await(confirmed)),
            Effect.timeoutOption(MODE_CONFIRMATION_DEADLINE),
            Effect.mapError(() => modeFailure),
          );
          modeWatch = undefined;
          if (Option.isNone(switched)) return yield* Effect.fail(modeFailure);
        }
        guardedMode = modeId;
      }

      // From here to the monitor nothing waits, so no update slips in between.
      isStarted = true;
      emitEvents([{ _tag: "session.started", ...buildBase() }]);
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
     * request is in flight and after one that was not answered, so the next
     * input sets it again. A refusal puts back what was held before the request.
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
          const options = yield* withConfigDeadline(
            connection.setConfigOption(nativeId, "model", model),
            `switch to the model ${selection.model}`,
          ).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (error.reason === "refused") applied = before;
              }),
            ),
            Effect.mapError((error) =>
              buildChangeFailure(`switch to the model ${selection.model}`, error),
            ),
          );
          held = {
            model: readCurrentValue(options, "model") ?? model,
            effort: readCurrentValue(options, "thought_level"),
          };
          applied = held;
          if (stopping || generation !== inputGeneration)
            return yield* Effect.fail(buildInputStopped());
        }
        if (effort !== undefined && held.effort !== effort) {
          const before = held;
          applied = undefined;
          const options = yield* withConfigDeadline(
            connection.setConfigOption(nativeId, "thought_level", effort),
            `switch to the level ${effort}`,
          ).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (error.reason === "refused") applied = before;
              }),
            ),
            Effect.mapError((error) => buildChangeFailure(`switch to the level ${effort}`, error)),
          );
          applied = {
            model: held.model,
            effort: readCurrentValue(options, "thought_level") ?? effort,
          };
        }
      });

    /** Reads the images and sets the model: everything before the prompt can be sent. Returns the prompt. */
    const prepareInput = (
      input: AdapterTurnInput,
      inputGeneration: number,
    ): Effect.Effect<ReadonlyArray<PromptContent>, AdapterError> =>
      Effect.gen(function* () {
        const images = yield* readImages(input.attachments ?? []);
        if (input.modelSelection !== undefined) {
          yield* selectModel(input.modelSelection, inputGeneration);
        }
        const text: PromptContent = { type: "text", text: buildHarnessPrompt(input) };
        return [text, ...images];
      }).pipe(
        Effect.timeoutOption(PREPARATION_BUDGET),
        Effect.flatMap((prepared) =>
          Option.isSome(prepared)
            ? Effect.succeed(prepared.value)
            : Effect.fail(
                buildAdapterFailed(
                  `Preparing the input for ${ANTIGRAVITY_NAME} took too long, so it was not sent.`,
                ),
              ),
        ),
      );

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
        if (stopping || generation !== inputGeneration) {
          abandonPreparation();
          return yield* Effect.fail(buildInputStopped());
        }
        if (Exit.isFailure(prepared)) {
          abandonPreparation();
          return yield* Effect.failCause(prepared.cause);
        }

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
          { turnId, prompt: prepared.value },
        ).pipe(Scope.provide(scope));
        preparing = false;
        return { turnId, delivery: "opened" } satisfies SendResult;
      });

    const interrupt: AgySession["interrupt"] = Effect.suspend(() => {
      // An input still being prepared is void from now on.
      generation += 1;
      const turn = readRunningTurn();
      if (turn === undefined) {
        // Output with no prompt open has a synthetic turn. Stopping it asks `agy` to stop, and waits for nothing.
        if (!hasOpenSyntheticTurn(state)) return Effect.void;
        return withConfigDeadline(connection.cancel(nativeId), "cancel").pipe(
          Effect.catch((error) =>
            Effect.logWarning(`session/cancel was not sent: ${error.message}`),
          ),
          Effect.andThen(Effect.sync(() => emitEvents(closeTurn(state, { state: "interrupted" })))),
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
