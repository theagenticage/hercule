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
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import type { AcpConnection, AcpHandlers, NewSessionRequest, PromptContent } from "@hercule/acp";
import { MCP_GATEWAY_ENTRY_NAME, SteerRefused } from "@hercule/protocol";
import type {
  AccessMode,
  AdapterError,
  AnswerNotDelivered,
  ApprovalDecision,
  ExitReason,
  HarnessEvent,
  QuestionAnswers,
  SendResult,
  SessionBinding,
  SessionSpec,
} from "@hercule/protocol";
import {
  buildInputNotWritten,
  buildAdapterFailed,
  buildHarnessNotInstalled,
  buildHarnessProtocolError,
  buildInputStopped,
  buildModelChangeLost,
  buildModelChangeRefused,
  buildSessionNotRunning,
  buildSessionStopping,
  buildStartFailure,
} from "../adapter-error-builders";
import { SESSION_TOKEN_VARIABLE } from "../../credentials/helper";
import { readAttachmentBase64 } from "../attachments";
import type { AdapterTurnInput, LocalAttachment, SessionStartContext } from "../index";
import { buildEnvelope } from "../normalize";
import { joinInstructions } from "../prompt";
import { escapeControlCharacters } from "../../report";
import type { ResolvedSkillReference } from "../../skills";
import { truncateFact, truncateMessage } from "../text";
import { ANTIGRAVITY_NAME, checkAccountUsable, chooseAgyMode, openSignedInAgy } from "./agy";
import type { AgySeam } from "./agy";
import { buildAgyPrompt } from "./skill-prompt";
import { buildShadowedSkillsWarning, stageAgySkills } from "./skills";
import {
  createConfigChange,
  describeSetting,
  withDeadline,
  type ApplyFailure,
  type ConfigChange,
  type ConfigOptions,
} from "./config-change";
import { buildPlanFilePaths } from "./harness-home";
import { buildModelCatalog, findSelectOption } from "./model-catalog";
import {
  buildNormalizerState,
  buildProcessEndEvents,
  closeTurn,
  hideSecret,
  holdTurn,
  makeEventSecretHider,
  normalizeUnhandled,
  normalizeUpdate,
  readSyntheticTurnId,
  releaseTurn,
} from "./normalize";
import type { NormalizerState } from "./normalize";
import { buildQuestionNotOpen, CANCELLED_APPROVAL, CANCELLED_QUESTION } from "./requests";
import { cancelOrphanApproval, cancelOrphanQuestion, startTurn } from "./turn";
import type { Turn } from "./turn";

/** How long `session/cancel` may take to be acknowledged when the session asks `agy` to stop output that has no input. */
const CANCEL_DEADLINE = Duration.seconds(3);

/** How long a start waits for `agy` to report that it is in the mode that was set (spec 06 section 8.1). */
const MODE_CONFIRMATION_DEADLINE = Duration.seconds(5);

/**
 * How long everything before the prompt of an input may take together: reading
 * the images and changing the model. It stays under the 10 seconds after which
 * the controller gives an input up.
 */
const PREPARATION_BUDGET = Duration.seconds(8);

/**
 * How long a synthetic turn (output `agy` sent with no input) may stay open
 * without any update from `agy`. A text chunk opens one, and only a later
 * update closes it, so without this bound the controller would see the session
 * busy for ever after the last chunk.
 */
const SYNTHETIC_TURN_QUIET_LIMIT = Duration.seconds(10);

/** How long an exit waits for the Turn to report its end once the process is gone. */
const TURN_END_WAIT = Duration.seconds(5);

/** The names the user knows the Access Modes by. */
const ACCESS_MODE_NAMES: Readonly<Record<AccessMode, string>> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/** A running session, as the adapter uses it. */
export interface AgySession {
  readonly binding: SessionBinding;
  /**
   * Runs the input as a new Turn and returns once the handoff of its prompt is proven, not when `agy`
   * replied. Fails with:
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
   * - `HarnessProtocolError` when it is not known whether `agy` got the prompt:
   *   the budget ran out while it was written, the connection ended meanwhile,
   *   or the caller was interrupted meanwhile. Only one prompt may be on the
   *   wire, so the session then ends its process (`runtime.error`, exit
   *   `crash`) and the next input resumes it;
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

/**
 * Returns the text the session's `agy` appends to its system prompt, or
 * undefined when there is none. The parts come in this order (spec 06 section
 * 9.3): the orientation, the session's system prompt, the user's own
 * instructions (undefined when there are none), the skill of the Hercule tool,
 * the coordination text and the memory.
 */
const buildInstructions = (
  ctx: SessionStartContext,
  spec: SessionSpec,
  userInstructions: string | undefined,
): string | undefined =>
  joinInstructions([
    ctx.herculeTool.orientation,
    spec.systemPrompt,
    userInstructions,
    ctx.herculeTool.skill,
    spec.coordination,
    spec.memory,
  ]);

/** Removes the session token from text. */
type HideInText = (text: string) => string;

/** Returns text `agy` sent, escaped and cut, for a message the user reads. */
const escapeReportedText = (text: string): string => truncateFact(escapeControlCharacters(text));

/** Returns the failure of a start when the model or level change did not work. */
const buildStartConfigFailure = (failure: ApplyFailure, hideInText: HideInText) => {
  const what = describeSetting(failure.change);
  switch (failure.kind) {
    case "failed":
      return buildAdapterFailed(
        `${ANTIGRAVITY_NAME} did not accept ${what}, so the session was not started: ${hideInText(failure.error.harnessMessage ?? failure.error.message)}`,
      );
    case "other":
      return buildAdapterFailed(
        `${ANTIGRAVITY_NAME} did not confirm ${what}: it reports ${escapeReportedText(hideInText(failure.named))}, so the session was not started.`,
      );
    case "unconfirmed":
      return buildAdapterFailed(
        `${ANTIGRAVITY_NAME} did not confirm ${what}, so the session was not started.`,
      );
  }
};

/**
 * Returns the failure of an input whose model or level change did not work, or
 * of one that was interrupted between the two. A refusal keeps the session on
 * its model. A closed connection or a missing answer leaves it unknown whether
 * the change happened, and so does a reply that names no value.
 */
const buildInputConfigFailure = (
  outcome: ApplyFailure | { readonly kind: "cancelled" },
  hideInText: HideInText,
): AdapterError => {
  if (outcome.kind === "cancelled") return buildInputStopped();
  const change = `switch to ${describeSetting(outcome.change)}`;
  switch (outcome.kind) {
    case "failed": {
      const { error } = outcome;
      if (error.reason === "refused") {
        return buildModelChangeRefused(
          ANTIGRAVITY_NAME,
          change,
          hideInText(error.harnessMessage ?? error.message),
        );
      }
      if (error.reason === "closed")
        return buildModelChangeLost(ANTIGRAVITY_NAME, hideInText(error.message));
      return buildHarnessProtocolError(
        `${ANTIGRAVITY_NAME} did not acknowledge the request to ${change} in time, so it may or may not have happened and the input was not sent: ${hideInText(error.message)}`,
      );
    }
    case "other":
      return buildModelChangeRefused(
        ANTIGRAVITY_NAME,
        change,
        `${ANTIGRAVITY_NAME} reports the ${outcome.change.kind} ${escapeReportedText(hideInText(outcome.named))} instead.`,
      );
    case "unconfirmed":
      return buildHarnessProtocolError(
        `${ANTIGRAVITY_NAME} did not confirm the request to ${change}, so it may or may not have happened and the input was not sent.`,
      );
  }
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
    const accessMode = spec.accessMode;
    // Narrowed here, so everything below sees an Access Mode that `agy` has a mode for or none.
    if (accessMode === "auto") {
      return yield* Effect.die(new Error("Antigravity declares the Access Mode auto unsupported."));
    }
    const cwd = ctx.cwd;
    if (cwd === null)
      return yield* Effect.die(new Error("A session starts with a working folder."));
    if (spec.continue?.mode === "fork") {
      return yield* Effect.die(new Error("Antigravity declares fork unsupported."));
    }

    // The token is read once. It goes to `agy` in the MCP servers' headers, over stdin, and `agy` may echo it, so every event is cleaned of it (`emitEvents`).
    const token = ctx.env[SESSION_TOKEN_VARIABLE];
    // The controller gives every session of a native harness exactly one entry, the Hercule tools. An empty list means the runner dropped it or the controller is older. Another name would mean a server of the repository stands in for it, so both fail the start.
    if (ctx.mcpServers.length !== 1 || ctx.mcpServers[0]?.name !== MCP_GATEWAY_ENTRY_NAME) {
      return yield* Effect.fail(
        buildAdapterFailed(
          `${ANTIGRAVITY_NAME} could not start, because Hercule's tools were not given to this session as the one MCP server named "${MCP_GATEWAY_ENTRY_NAME}" (it was given ${ctx.mcpServers.length === 0 ? "none" : ctx.mcpServers.map(({ name }) => `"${name}"`).join(", ")}). Update the controller and the runner to the same version.`,
        ),
      );
    }
    if (token === undefined || token === "") {
      return yield* Effect.fail(
        buildAdapterFailed(
          `${ANTIGRAVITY_NAME} could not start, because the session has no session token to give the Hercule tools.`,
        ),
      );
    }
    const mcpServers = ctx.mcpServers.map(({ name, url }) => ({
      name,
      url,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    }));
    const hideEventSecret = makeEventSecretHider(token);
    /** Hides the token in text from `agy` that goes into a message for the user. */
    const hideInText = (text: string): string => hideSecret(text, token);

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
    let normalizing: NormalizerState | undefined;
    /** Undefined until `agy` replies to the call that opens the conversation. */
    let nativeSessionId: string | undefined;
    let current: Turn | undefined;
    /** True while an input's images are read and its model is changed, before its Turn exists. The handoff of its prompt belongs to the Turn. */
    let preparing = false;
    /** Grows at every interrupt and stop, so an input that was prepared before it knows it is void. */
    let generation = 0;
    let stopping = false;
    let exitReason: ExitReason | undefined;
    const exitedSignal = Deferred.makeUnsafe<void>();
    /** The latest mode `agy` reported, in an update or in the reply that opened the conversation. A report is never replaced by an older one. */
    let currentMode: string | undefined;
    /** Wakes the start that waits for the mode, whenever `agy` reports one. */
    let modeChanged: Deferred.Deferred<void> | undefined;
    /** The mode the start asked for and `agy` confirmed. Undefined in `full-access`, which has no mode to guard. */
    let guardedMode: string | undefined;
    let isStarted = false;
    /** The model and level of the conversation. Undefined until the start has read the conversation. */
    let config: ConfigChange | undefined;
    /** The wait that closes an open synthetic turn when `agy` goes quiet. */
    let syntheticTurnBound: Fiber.Fiber<void> | undefined;

    const buildBase = (toolCallId?: string) =>
      buildEnvelope(sessionId, {
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
        ...(toolCallId === undefined ? {} : { toolCallId }),
      });

    /**
     * Starts the wait that closes the open synthetic turn, and ends the wait
     * before it. Every update from `agy` and every emit goes through here, so
     * the wait starts over at each one and runs out only after
     * `SYNTHETIC_TURN_QUIET_LIMIT` with no update. With no synthetic turn open,
     * no wait is left running.
     */
    const boundSyntheticTurn = (): void => {
      if (syntheticTurnBound !== undefined) {
        runDetached(Fiber.interrupt(syntheticTurnBound));
        syntheticTurnBound = undefined;
      }
      if (normalizing === undefined || isExited()) return;
      const state = normalizing;
      const turnId = readSyntheticTurnId(state);
      if (turnId === undefined) return;
      syntheticTurnBound = Effect.runForkWith(services)(
        Effect.sleep(SYNTHETIC_TURN_QUIET_LIMIT).pipe(
          Effect.andThen(
            Effect.sync(() => {
              syntheticTurnBound = undefined;
              // Only the turn this wait was started for: a newer turn must stay open.
              emitEvents(closeTurn(state, { state: "completed", turnId }));
            }),
          ),
        ),
      );
    };

    /** Publishes events. Nothing is published before the start is ready, so a failed start leaves no event. */
    const emitEvents = (events: ReadonlyArray<HarnessEvent>): void => {
      if (!isStarted) return;
      const hidden = hideEventSecret(events);
      if (hidden.length > 0) emit(hidden);
      boundSyntheticTurn();
    };

    const isExited = (): boolean => Deferred.isDoneUnsafe(exitedSignal);

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
        const procedure = Effect.gen(function* () {
          const runningTurn = readRunningTurn();
          if (runningTurn !== undefined && options.stopTurn) yield* runningTurn.stop;
          yield* Scope.close(processScope, Exit.void);
          if (runningTurn !== undefined) {
            // A Turn that does not end by itself is ended here, so no event of it follows `session.exited`.
            const ended = yield* Effect.timeoutOption(runningTurn.ended, TURN_END_WAIT);
            if (Option.isNone(ended)) yield* runningTurn.abandon;
          }
          if (normalizing !== undefined) emitEvents(buildProcessEndEvents(normalizing));
          emitEvents([{ _tag: "session.exited", ...buildBase(), reason }]);
          Deferred.doneUnsafe(exitedSignal, Effect.void);
        });
        // A fiber of the session's scope runs it, so a caller that is interrupted cannot leave the exit half done.
        return Effect.forkIn(procedure, scope).pipe(Effect.andThen(Deferred.await(exitedSignal)));
      });

    /**
     * Ends the process of a Turn that did not answer `session/cancel`. Marks
     * the session as stopping before anything else, so no input starts on it.
     */
    const stopUnresponsiveProcess = (turnId: string): Effect.Effect<void> =>
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

    /**
     * Ends the process when it is not known whether `agy` got a prompt: it may
     * be running it, and a second prompt would break the one-prompt-at-a-time
     * rule. Marks the session as stopping before anything else.
     */
    const endForUnknownDelivery = (): void => {
      if (stopping) return;
      stopping = true;
      emitEvents([
        {
          _tag: "runtime.error",
          ...buildBase(),
          class: "delivery_unknown",
          message:
            "Antigravity did not confirm that it took the message, so Hercule ended its process. Your next message resumes the session.",
        },
      ]);
      runDetached(exitSession("crash"));
    };

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
              `Antigravity changed its own permission mode from ${from === undefined ? "unknown" : escapeReportedText(from)} to ${escapeReportedText(to)}, so Hercule stopped it.`,
            ),
          },
        ]);
        return exitSession("crash");
      });

    // ---- What `agy` sends ----

    const recordReportedMode = (modeId: string): void => {
      const previous = currentMode;
      currentMode = modeId;
      if (modeChanged !== undefined) Deferred.doneUnsafe(modeChanged, Effect.void);
      if (isStarted && guardedMode !== undefined && modeId !== guardedMode) {
        runDetached(endForModeChange(previous ?? guardedMode, modeId));
      }
    };

    /** Records the mode that `agy` reports as the `mode` config option, in an update or in the reply to a change of a setting. */
    const recordModeOfReply = (options: ConfigOptions): void => {
      const modeId = findSelectOption(options, "mode")?.currentValue;
      if (modeId !== undefined) recordReportedMode(modeId);
    };

    const handlers: AcpHandlers = {
      onSessionUpdate: (notification) => {
        if (isExited()) return;
        // Before the reply that opens the conversation, an update is part of a resume's replay and is dropped. A mode report is the exception: the mode must not be lost.
        if (normalizing === undefined) {
          if (notification.update.sessionUpdate === "current_mode_update") {
            recordReportedMode(notification.update.currentModeId);
          }
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
          recordReportedMode(notification.update.currentModeId);
          return;
        }
        if (notification.update.sessionUpdate === "config_option_update") {
          // The mode in this notification is not read: it lags and can name a stale mode. In
          // `packages/acp/src/recordings/modes.jsonl` an update names `accept-edits` after
          // `set_mode default` was sent and before `current_mode_update default`, so reading
          // it would stop a healthy session. The reply to our own config call is reliable.
          config?.observe(notification.update.configOptions);
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
          const turn = readRunningTurn();
          return turn === undefined
            ? Effect.succeed(cancelOrphanApproval(normalizing, emitEvents, request))
            : turn.openApproval(request);
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
          const turn = readRunningTurn();
          return turn === undefined
            ? Effect.succeed(cancelOrphanQuestion(normalizing, emitEvents, request))
            : turn.openQuestion(request);
        }),
      onUnhandledMessage: (message) => {
        if (isExited()) return;
        if (normalizing === undefined) return;
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
      // Staged before the process exists, so a failure here spawns nothing. A
      // resume stages again: every start has a fresh session skills folder.
      const staged = yield* stageAgySkills(ctx);
      const skillsFolder = staged?.folder;
      const instructions = buildInstructions(ctx, spec, ctx.userMaterial?.instructions);
      // Built before `agy` opens, because `openSignedInAgy` checks that `agy`
      // takes what the request uses. A field that needs `agy` to announce
      // support for it gets its check there.
      const request: NewSessionRequest = {
        cwd,
        ...(skillsFolder === undefined ? {} : { additionalDirectories: [skillsFolder] }),
        mcpServers,
        ...(instructions === undefined
          ? {}
          : { meta: { antigravity: { systemPrompt: { append: instructions } } } }),
      };
      const agy = yield* openSignedInAgy(seam.spawn, ctx, binary, {
        cwd,
        handlers,
        purpose: { kind: "session", accessMode, request },
      }).pipe(
        Scope.provide(processScope),
        // The message holds what `agy` wrote on stderr, which may echo the token.
        Effect.mapError((error) =>
          error._tag === "AdapterFailed" ? buildAdapterFailed(hideInText(error.message)) : error,
        ),
      );
      const connection: AcpConnection = agy.connection;

      // From the reply on, updates are the session's own. Before it, they are a resume's replay.
      const startReading = (id: string) =>
        Effect.sync(() => {
          nativeSessionId = id;
          // After a resume the reply's mode is the truth: a mode seen in the replay before it is stale.
          if (spec.continue !== undefined) currentMode = undefined;
          normalizing = buildNormalizerState({
            sessionId,
            nativeSessionId: id,
            planFilePaths: buildPlanFilePaths(ctx.home, id),
          });
          // Output that comes before the start is ready is held, so a failed start publishes nothing.
          holdTurn(normalizing);
        });
      const conversation = yield* (
        spec.continue === undefined
          ? agy.newConversation(startReading)
          : agy.resumeConversation(spec.continue.nativeSessionId, startReading)
      ).pipe(
        Effect.mapError((error) =>
          error._tag === "AcpError"
            ? buildStartFailure(ANTIGRAVITY_NAME, hideInText(error.message))
            : error,
        ),
      );
      const { settings } = conversation;
      const state = normalizing;
      if (state === undefined)
        return yield* Effect.die(new Error("The conversation was not read."));

      const usable = checkAccountUsable(
        agy.planLabel,
        buildModelCatalog(settings),
        conversation.isHeldByGoogle,
      );
      if (Result.isFailure(usable)) return yield* Effect.fail(usable.failure);

      // The model and level come first, and only when `agy` does not already have them.
      const configChange = createConfigChange(
        connection,
        conversation.id,
        ctx.modelArgument,
        settings.configOptions,
        recordModeOfReply,
      );
      config = configChange;
      const applied = yield* configChange.apply(spec.modelSelection, () => false);
      if (applied.kind === "cancelled") {
        return yield* Effect.die(new Error("A start never cancels the change of its model."));
      }
      if (applied.kind !== "applied")
        return yield* Effect.fail(buildStartConfigFailure(applied, hideInText));

      // Then the mode. `full-access` has none: it is a flag of the process.
      const modeId = chooseAgyMode(accessMode);
      if (modeId !== undefined) {
        const modeFailure = buildAdapterFailed(
          `${ANTIGRAVITY_NAME} did not switch to ${ACCESS_MODE_NAMES[accessMode]}. Pick another access mode.`,
        );
        const modes = settings.modes;
        // A missing list is "not known", never "none", and neither lets a session start.
        if (modes === undefined || !modes.availableModes.some((mode) => mode.id === modeId)) {
          return yield* Effect.fail(modeFailure);
        }
        // An update that came since the reply is newer than the reply's snapshot.
        currentMode ??= modes.currentModeId;
        // A resume always sets the mode, because it is the only way to learn that `agy` kept it. `agy` sends no update when the mode does not change, and `awaitMode` then ends at once.
        if (currentMode !== modeId || spec.continue !== undefined) {
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
        // An update that came while the start waited may have moved the mode again. Nothing waits between this check and `session.started`.
        if (currentMode !== modeId) return yield* Effect.fail(modeFailure);
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
      // What the user's instructions lost, so the user knows what `agy` does not see.
      for (const warning of ctx.userMaterial?.warnings ?? []) {
        emitEvents([
          { _tag: "runtime.warning", ...buildBase(), message: truncateMessage(warning) },
        ]);
      }
      if (staged !== undefined && staged.shadowed.length > 0) {
        emitEvents([
          {
            _tag: "runtime.warning",
            ...buildBase(),
            message: buildShadowedSkillsWarning(staged.shadowed),
          },
        ]);
      }
      // What `agy` sent while the start was prepared is now output with no input.
      emitEvents(releaseTurn(state));
      yield* Effect.forkIn(
        Effect.flatMap(connection.awaitClosed, () =>
          exitSession("process_exit", { stopTurn: false }),
        ),
        scope,
      );
      return { connection, state, nativeId: conversation.id, configChange };
    }).pipe(Effect.onError(() => Scope.close(processScope, Exit.void)));

    const { connection, state, nativeId, configChange } = yield* start;

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

    /** Whether an interrupt or a stop came after the input `inputGeneration` was admitted, which voids it. */
    const isVoided = (inputGeneration: number): boolean =>
      stopping || generation !== inputGeneration;

    /**
     * Reads the images, sets the model and builds the prompt, and returns the
     * prompt for `agy`, the Skill References its text translated, the names of
     * the ones that got no pointer line, and the part of `PREPARATION_BUDGET`
     * that is left for the handoff of the prompt. Building the prompt reads the
     * skill files with synchronous calls, so the budget cannot interrupt them:
     * they only count toward the time spent. Fails with
     * `InputNotDelivered` when an interrupt or a stop voids the input, with the
     * failures of the model change, and with `AdapterFailed` when an image cannot
     * be read or the budget runs out.
     */
    const prepareInput = (
      input: AdapterTurnInput,
      inputGeneration: number,
    ): Effect.Effect<
      {
        readonly prompt: ReadonlyArray<PromptContent>;
        readonly skillReferences: ReadonlyArray<ResolvedSkillReference>;
        readonly skippedSkills: ReadonlyArray<string>;
        readonly handoffBudget: Duration.Duration;
      },
      AdapterError
    > =>
      Effect.gen(function* () {
        const images = yield* readImages(input.attachments ?? []);
        // An interrupt that came while the images were read voids the input before anything is written to `agy`.
        if (isVoided(inputGeneration)) return yield* Effect.fail(buildInputStopped());
        if (input.modelSelection !== undefined) {
          const changed = yield* configChange.apply(input.modelSelection, () =>
            isVoided(inputGeneration),
          );
          if (changed.kind !== "applied")
            return yield* Effect.fail(buildInputConfigFailure(changed, hideInText));
        }
        const { text, skillReferences, skipped } = buildAgyPrompt(input);
        // The last wait before the write is over, so an interrupt that came during it is checked here.
        if (isVoided(inputGeneration)) return yield* Effect.fail(buildInputStopped());
        return {
          prompt: [{ type: "text", text } as const, ...images],
          skillReferences,
          skippedSkills: skipped,
        };
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
        Effect.timed,
        Effect.map(([elapsed, prepared]) => ({
          ...prepared,
          handoffBudget: Duration.subtract(PREPARATION_BUDGET, elapsed),
        })),
      );

    const send: AgySession["send"] = (input) =>
      Effect.gen(function* () {
        if (stopping) {
          return yield* Effect.fail(isExited() ? buildSessionNotRunning() : buildSessionStopping());
        }
        if (readRunningTurn() !== undefined || preparing) {
          return yield* Effect.fail(
            new SteerRefused({
              message: `${ANTIGRAVITY_NAME} cannot take input in the middle of a turn. The input stays queued and runs when this turn ends.`,
            }),
          );
        }
        // Admission is reserved here, before the first wait, so a second input is refused while this one is prepared.
        // The output of `agy` is held from the same moment: until the handoff of the prompt is proven, new output may belong to this input, so no synthetic turn may open for it.
        const inputGeneration = generation;
        preparing = true;
        holdTurn(state);

        // Uninterruptible except the two waits, so an interrupt can never leave the admission taken or a Turn unread.
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const prepared = yield* Effect.exit(restore(prepareInput(input, inputGeneration)));
            if (Exit.isFailure(prepared)) {
              preparing = false;
              // No Turn will take the held output, so it is shown as output with no input.
              emitEvents(releaseTurn(state));
              if (Cause.hasInterrupts(prepared.cause) || !isVoided(inputGeneration)) {
                return yield* Effect.failCause(prepared.cause);
              }
              return yield* Effect.fail(buildInputStopped());
            }
            // The Turn reserves the place for the input and writes its prompt. It is
            // published only when `agy` is known to have the prompt, so a prompt that
            // could not be written leaves no Turn at all.
            const turn = yield* startTurn(
              {
                sessionId,
                nativeSessionId: nativeId,
                connection,
                normalizing: state,
                emit: emitEvents,
                onDeliveryUnknown: endForUnknownDelivery,
              },
              { input, ...prepared.value },
            ).pipe(Scope.provide(scope));
            current = turn;
            preparing = false;
            const handoff = yield* Effect.exit(restore(Deferred.await(turn.handoff)));
            if (Exit.isFailure(handoff)) {
              // The caller is gone while `agy` may be reading the prompt, so no other prompt may follow on this process.
              if (!Deferred.isDoneUnsafe(turn.handoff)) endForUnknownDelivery();
              return yield* Effect.failCause(handoff.cause);
            }
            const outcome = handoff.value;
            // A proven handoff opens the input even when a stop came meanwhile: failing it would let the controller send it again. The stop then ends the Turn as interrupted.
            if (outcome.kind === "proven")
              return { turnId: turn.id, delivery: "opened" } satisfies SendResult;
            if (outcome.kind === "unknown")
              return yield* Effect.fail(buildHarnessProtocolError(hideInText(outcome.message)));
            return yield* Effect.fail(
              isVoided(inputGeneration)
                ? buildInputStopped()
                : buildInputNotWritten(ANTIGRAVITY_NAME, hideInText(outcome.message)),
            );
          }),
        );
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
        return withDeadline(connection.cancel(nativeId), CANCEL_DEADLINE, "cancel").pipe(
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
        result === "unresponsive" ? stopUnresponsiveProcess(turn.id) : Effect.void,
      );
    });

    const decide: AgySession["decide"] = (requestId, decision) =>
      Effect.suspend(() => {
        const turn = readRunningTurn();
        if (turn === undefined) return Effect.void;
        return Effect.flatMap(turn.decide(requestId, decision), (result) =>
          result === "unresponsive" ? stopUnresponsiveProcess(turn.id) : Effect.void,
        );
      });

    const answer: AgySession["answer"] = (requestId, answers) =>
      Effect.suspend(() => {
        const turn = readRunningTurn();
        return turn === undefined
          ? Effect.fail(buildQuestionNotOpen())
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
