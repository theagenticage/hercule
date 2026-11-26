/**
 * Runs one Turn of an Antigravity session. ACP has no turn, so a Turn is built
 * here from one `session/prompt` and its reply, plus one more prompt for each
 * round of denied calls (spec 06 section 6.5). The Turn owns:
 *
 * - the prompt in flight, so two prompts are never in flight at once;
 * - the Requests `agy` opens while the prompt runs, from the moment they open
 *   until their reply is written, and the Turn does not end before every one
 *   of them was resolved;
 * - the interrupt, and what the Turn ends as (spec 06 sections 6.2 and 10.5).
 *
 * Translating a decision or answers into the ACP reply stays in `requests.ts`,
 * and the events of items and usage come from `normalize.ts`.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type {
  AcpConnection,
  AcpError,
  ApprovalOutcome,
  ApprovalRequest,
  ElicitationReply,
  ElicitationRequest,
  PromptContent,
  PromptReply,
} from "@hercule/acp";
import type {
  AnswerNotDelivered,
  ApprovalDecision,
  HarnessEvent,
  QuestionAnswers,
  TurnState,
} from "@hercule/protocol";
import { buildAnswerNotDelivered } from "../adapter-error-builders";
import { buildEnvelope } from "../normalize";
import { truncateFact, truncateMessage } from "../text";
import {
  addPromptUsage,
  closeTurn,
  markDeclined,
  type Normalizing,
  type RequestItem,
  type RequestOwner,
} from "./normalize";
import {
  buildApprovalOutcome,
  buildElicitationReply,
  readApprovalDecisions,
  readQuestionForm,
  type QuestionForm,
} from "./requests";

/** How long `agy` has to answer `session/cancel` with the reply to the prompt (spec 06 section 10.5). */
const INTERRUPT_DEADLINE = Duration.seconds(5);

/** How long a reply may take to be written to `agy` before it counts as not written. */
const REPLY_WRITE_DEADLINE = Duration.seconds(5);

/** A tool name that may appear in the follow-up prompt. Anything else could carry text meant for the model. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_]{1,64}$/;

const CANCELLED_APPROVAL: ApprovalOutcome = { outcome: "cancelled" };
const CANCELLED_QUESTION: ElicitationReply = { action: "cancel" };

/** An error that ends a Turn: the `class` of its `runtime.error`, and the message for the user. */
interface TurnError {
  readonly class: string;
  readonly message: string;
}

/** Why a Turn fails for each stop reason ACP defines besides `end_turn` and `cancelled`. */
const STOP_REASON_FAILURES: Readonly<Record<string, string | undefined>> = {
  max_tokens: "The model reached its output limit, so Antigravity ended the turn.",
  max_turn_requests: "Antigravity reached its limit of model requests for one turn.",
  refusal: "The model refused to go on, so Antigravity ended the turn.",
};

/** What a Turn needs from its session. */
export interface TurnContext {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly connection: Pick<AcpConnection, "sendPrompt" | "cancel">;
  readonly normalizing: Normalizing;
  /** Publishes events on the session's stream, in order. */
  readonly emit: (events: ReadonlyArray<HarnessEvent>) => void;
}

/** How an interrupt ended: `agy` answered `session/cancel` in time, or it did not. */
export type InterruptResult = "stopped" | "unresponsive";

export interface Turn {
  readonly id: string;
  /**
   * Opens an approval Request of this Turn and waits for its decision. Returns
   * the ACP outcome to send to `agy`: the user's decision, or `cancelled` when
   * the Turn is interrupted before or while it waits.
   */
  readonly openApproval: (
    request: ApprovalRequest,
    item: RequestItem,
  ) => Effect.Effect<ApprovalOutcome>;
  /**
   * Opens a question Request of this Turn and waits for its answers. Returns
   * the ACP reply to send: the answers, or `cancel` when the form cannot be
   * read or the Turn is interrupted.
   */
  readonly openQuestion: (
    request: ElicitationRequest,
    owner: RequestOwner,
  ) => Effect.Effect<ElicitationReply>;
  /**
   * Applies the user's decision to an open approval. Does nothing when the
   * Request is not an open approval. The decision `cancel` also interrupts the
   * Turn, and then the result is the interrupt's: the caller must stop the
   * process when it is `unresponsive`. Every other decision gives `decided`.
   */
  readonly decide: (
    requestId: string,
    decision: ApprovalDecision,
  ) => Effect.Effect<"decided" | InterruptResult>;
  /**
   * Delivers the user's answers to an open question. Fails with
   * `AnswerNotDelivered` when no such question is open, when the answers
   * cannot be turned into a reply (the question stays open), or when the reply
   * could not be written to `agy` (the question then resolves as `cancel`).
   */
  readonly answer: (
    requestId: string,
    answers: QuestionAnswers,
  ) => Effect.Effect<void, AnswerNotDelivered>;
  /**
   * Interrupts the Turn: cancels every open Request, sends `session/cancel`,
   * and waits up to 5 seconds for the Turn to end as `interrupted`. Returns
   * `unresponsive` when `agy` did not answer in time. The Turn then emits no
   * `turn.completed` itself: the session stops the process, the prompt fails,
   * and the Turn ends. A second call while one runs gives the same result.
   */
  readonly interrupt: Effect.Effect<InterruptResult>;
  /**
   * Prepares for the end of the session: cancels every open Request, and makes
   * the Turn end `interrupted` instead of `failed` or `completed`. Sends
   * nothing to `agy`.
   */
  readonly stop: Effect.Effect<void>;
  /**
   * Ends the Turn at once as `interrupted`, for a Turn that did not end by
   * itself: stops its fibers and emits `turn.completed` unless it was already
   * emitted. No event of the Turn follows. Used when the process is gone.
   */
  readonly abandon: Effect.Effect<void>;
  /**
   * Returns true from the moment `turn.completed` was emitted, and not before:
   * until then the Turn still holds the session's one place for an input. The
   * check and the emit happen in one step, so a caller that asks it after
   * `turn.completed` was published always gets true.
   */
  readonly hasEnded: () => boolean;
  /** Waits until the Turn has ended, which is after it emitted `turn.completed`. */
  readonly ended: Effect.Effect<void>;
}

/** An approval Request that is open: `agy` waits for the reply held here. */
interface ApprovalPark {
  readonly kind: "approval";
  /** The id Hercule gave the Request. `request.requestId` is `agy`'s, which it reuses in every process. */
  readonly requestId: string;
  readonly request: ApprovalRequest;
  readonly outcome: Deferred.Deferred<ApprovalOutcome>;
}

/** A question Request that is open: `agy` waits for the reply held here. */
interface QuestionPark {
  readonly kind: "question";
  readonly requestId: string;
  readonly request: ElicitationRequest;
  readonly form: QuestionForm;
  readonly reply: Deferred.Deferred<ElicitationReply>;
}

/** What one `session/prompt` came to: its reply, or why it failed. */
type PromptResult =
  | { readonly kind: "replied"; readonly reply: PromptReply }
  | { readonly kind: "failed"; readonly error: AcpError };

/**
 * Returns the follow-up prompt that tells the model its calls were denied. It
 * names the calls by their tool names only, because the text reaches the model
 * as the user's words: a command, a path or an argument in it could be taken as
 * an instruction. A name that is not plain is written `a tool`.
 */
const buildFollowUpText = (toolNames: ReadonlyArray<string | null | undefined>): string => {
  const names = toolNames.map((name) =>
    name != null && SAFE_TOOL_NAME.test(name) ? name : "a tool",
  );
  return `The user denied your last tool call (${names.join(", ")}). Do not run it again or work around it. Go on without it, or say what you need.`;
};

/**
 * Runs the Turn in a fiber of the current scope. The caller has already written
 * the Turn's first prompt to `agy` (`connection.sendPrompt`) and passes the
 * effect that waits for its reply as `firstReply`, and it has emitted
 * `turn.started` (`openTurn`) and the `user_message`. Follow-up prompts are
 * sent by the Turn itself. The Turn ends by emitting `turn.completed`, and
 * closing the scope interrupts it.
 */
export const startTurn = (
  context: TurnContext,
  input: {
    readonly turnId: string;
    readonly firstReply: Effect.Effect<PromptReply, AcpError>;
  },
): Effect.Effect<Turn, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { sessionId, nativeSessionId, connection, normalizing, emit } = context;
    const scope = yield* Effect.scope;
    const ended = yield* Deferred.make<void>();

    /** The Requests that wait for a reply, by the id Hercule gave them. A Request leaves the map when it settles, so it settles once. */
    const open = new Map<string, ApprovalPark | QuestionPark>();
    let promptInFlight = false;
    /** Whether the Turn must end `interrupted`: the user or the session stopped it. */
    let interrupted = false;
    /** Whether a Request was answered `cancel`. `agy` then replies `end_turn`, so the reply alone does not show it. */
    let answeredCancel = false;
    /** Whether the Turn started to end: no new Request opens and no interrupt is sent from then on. */
    let isEnding = false;
    /** Whether `turn.completed` was emitted. */
    let isClosed = false;
    let interruption: Deferred.Deferred<InterruptResult> | undefined;
    /** The tool names of the Denies the current prompt got, counted once their reply was written. */
    let deniedToolNames: Array<string | null | undefined> = [];
    /** The fibers that resolve the Requests of the current prompt, so the prompt's end waits for them. */
    let pendingResolutions: Array<Fiber.Fiber<unknown>> = [];

    const buildEvent = (toolCallId?: string, acpRequestId?: string) =>
      buildEnvelope(sessionId, {
        nativeSessionId,
        ...(toolCallId === undefined ? {} : { toolCallId }),
        ...(acpRequestId === undefined ? {} : { acpRequestId }),
      });

    const emitResolved = (
      requestId: string,
      outcome: { readonly decision: ApprovalDecision } | { readonly answers: QuestionAnswers },
    ): void => {
      emit([{ _tag: "request.resolved", ...buildEvent(), requestId, ...outcome }]);
    };

    /**
     * Waits until the reply to a Request was written to `agy`. Returns false
     * when the write failed or took longer than the deadline. It then logs why
     * and emits a warning, because the user may have answered something that
     * `agy` never got (spec 06 section 6.5).
     */
    const awaitReplyWritten = (
      replyWritten: Effect.Effect<void, AcpError>,
    ): Effect.Effect<boolean> =>
      replyWritten.pipe(
        Effect.timeoutOption(REPLY_WRITE_DEADLINE),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(true)
            : Effect.logWarning("Antigravity did not take the reply in time.").pipe(
                Effect.as(false),
              ),
        ),
        Effect.catch((error: AcpError) =>
          Effect.logWarning(`The reply to Antigravity was not written: ${error.message}`).pipe(
            Effect.as(false),
          ),
        ),
        Effect.tap((written) =>
          Effect.sync(() => {
            if (!written) {
              emit([
                {
                  _tag: "runtime.warning",
                  ...buildEvent(),
                  turnId: input.turnId,
                  message:
                    "The reply to a Request may not have reached Antigravity, so the Request was closed as cancelled.",
                },
              ]);
            }
          }),
        ),
        Effect.annotateLogs({ sessionId }),
      );

    /**
     * Runs `resolution` in a fiber of the scope and records it, so the end of
     * the Turn waits for it. The fiber outlives a caller that is interrupted.
     */
    const trackResolution = <A>(resolution: Effect.Effect<A>): Effect.Effect<Fiber.Fiber<A>> =>
      Effect.forkIn(resolution, scope).pipe(
        Effect.tap((fiber) =>
          Effect.sync(() => {
            pendingResolutions.push(fiber);
          }),
        ),
      );

    /**
     * Settles an open approval with `decision` and returns an effect that
     * starts what follows. The settling itself (leaving the map, completing the
     * held reply) happens when this runs, in one step, so a decision and an
     * interrupt cannot both settle the Request.
     */
    const settleApproval = (park: ApprovalPark, decision: ApprovalDecision): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { request } = park;
        if (!open.delete(park.requestId)) return;
        // `request.resolved` waits for the write, because the card must stay
        // until the decision reached `agy`. When it did not, the card closes
        // as `cancel`, and a Deny that did not arrive is no Deny.
        const announce = awaitReplyWritten(request.replyWritten).pipe(
          Effect.map((written) => {
            if (written && decision === "deny") deniedToolNames.push(request.toolCall.name);
            emitResolved(park.requestId, { decision: written ? decision : "cancel" });
          }),
        );
        // Tracked before the reply is handed over, so nothing can end the Turn between the two.
        yield* trackResolution(announce);
        // `agy` reports a refused call as failed, so the item must be marked to show as declined.
        if (decision !== "allow") markDeclined(normalizing, request.toolCall.toolCallId);
        if (decision === "cancel") answeredCancel = true;
        Deferred.doneUnsafe(
          park.outcome,
          Effect.succeed(buildApprovalOutcome(request.options, decision)),
        );
      });

    /** Settles an open question as `cancel`, as for an interrupt. */
    const settleQuestionAsCancel = (park: QuestionPark): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!open.delete(park.requestId)) return;
        const announce = awaitReplyWritten(park.request.replyWritten).pipe(
          Effect.map(() => {
            emitResolved(park.requestId, { decision: "cancel" });
          }),
        );
        yield* trackResolution(announce);
        Deferred.doneUnsafe(park.reply, Effect.succeed(CANCELLED_QUESTION));
      });

    const cancelOpenRequests: Effect.Effect<void> = Effect.suspend(() =>
      Effect.forEach(
        [...open.values()],
        (park) =>
          park.kind === "approval" ? settleApproval(park, "cancel") : settleQuestionAsCancel(park),
        { discard: true },
      ),
    );

    const openApproval: Turn["openApproval"] = (request, item) =>
      Effect.gen(function* () {
        if (interrupted || isEnding) {
          markDeclined(normalizing, request.toolCall.toolCallId);
          return CANCELLED_APPROVAL;
        }
        const outcome = yield* Deferred.make<ApprovalOutcome>();
        // `agy` numbers its Requests from the start in every process, so its id cannot name a Request across a resume.
        const requestId = crypto.randomUUID();
        open.set(requestId, { kind: "approval", requestId, request, outcome });
        emit([
          {
            _tag: "request.opened",
            ...buildEvent(request.toolCall.toolCallId, request.requestId),
            request: {
              requestId,
              itemId: item.itemId,
              ...item.description,
              decisions: readApprovalDecisions(request.options),
            },
          },
        ]);
        return yield* Deferred.await(outcome);
      });

    const openQuestion: Turn["openQuestion"] = (request, owner) =>
      Effect.gen(function* () {
        if (interrupted || isEnding) return CANCELLED_QUESTION;
        const form = readQuestionForm(request);
        if (form === undefined) {
          emit([
            {
              _tag: "runtime.warning",
              ...buildEvent(),
              turnId: input.turnId,
              message:
                "Antigravity asked a question in a form Hercule cannot show, so it was cancelled.",
            },
          ]);
          return CANCELLED_QUESTION;
        }
        const reply = yield* Deferred.make<ElicitationReply>();
        const requestId = crypto.randomUUID();
        open.set(requestId, { kind: "question", requestId, request, form, reply });
        emit([
          {
            _tag: "request.opened",
            ...buildEvent(undefined, request.requestId),
            request: {
              requestId,
              itemId: owner.itemId,
              kind: "question",
              detail: { questions: form.questions },
            },
          },
        ]);
        return yield* Deferred.await(reply);
      });

    const decide: Turn["decide"] = (requestId, decision) =>
      Effect.suspend(() => {
        const park = open.get(requestId);
        if (park?.kind !== "approval") return Effect.succeed("decided" as const);
        // `cancel` ends the Turn, so it is an interrupt, which also settles this Request.
        if (decision === "cancel") return interrupt;
        return Effect.as(settleApproval(park, decision), "decided" as const);
      });

    const answer: Turn["answer"] = (requestId, answers) =>
      Effect.gen(function* () {
        const park = open.get(requestId);
        if (park?.kind !== "question") {
          return yield* Effect.fail(
            buildAnswerNotDelivered(
              "This question is not open anymore. Nothing was sent to Antigravity.",
            ),
          );
        }
        const built = buildElicitationReply(park.form, answers);
        if (built.kind === "refused") {
          return yield* Effect.fail(buildAnswerNotDelivered(built.message));
        }
        open.delete(requestId);
        // Tracked before the reply is handed over, so the Turn does not end before `request.resolved` is out.
        const resolution = yield* trackResolution(
          Effect.gen(function* () {
            const written = yield* awaitReplyWritten(park.request.replyWritten);
            emitResolved(requestId, written ? { answers } : { decision: "cancel" });
            return written;
          }),
        );
        Deferred.doneUnsafe(park.reply, Effect.succeed(built.reply));
        const written = yield* Fiber.join(resolution);
        if (written) return;
        return yield* Effect.fail(
          buildAnswerNotDelivered(
            "It is not known whether Antigravity received the answer, so the question was cancelled. Ask again if the agent still needs it.",
          ),
        );
      });

    /** Sends `session/cancel`, and waits for the Turn to end when a prompt is in flight. */
    const sendCancel: Effect.Effect<InterruptResult> = Effect.suspend(() => {
      const waitsForReply = promptInFlight;
      return connection.cancel(nativeSessionId).pipe(
        Effect.catch((error: AcpError) =>
          Effect.logWarning(`session/cancel was not sent: ${error.message}`),
        ),
        Effect.andThen(waitsForReply ? Deferred.await(ended) : Effect.void),
        Effect.timeoutOption(INTERRUPT_DEADLINE),
        Effect.map((result) =>
          Option.isNone(result) && waitsForReply ? "unresponsive" : "stopped",
        ),
      );
    });

    const interrupt: Turn["interrupt"] = Effect.gen(function* () {
      if (interruption === undefined) {
        if (Deferred.isDoneUnsafe(ended) || isEnding) return "stopped";
        // Marked before the first yield, so a Request that opens from now on is cancelled.
        interrupted = true;
        const result = Deferred.makeUnsafe<InterruptResult>();
        interruption = result;
        yield* cancelOpenRequests;
        // A fiber of the scope runs the wait, so a caller that is interrupted cannot leave a second caller waiting for ever.
        yield* Effect.forkIn(
          Effect.flatMap(sendCancel, (value) => Deferred.succeed(result, value)),
          scope,
        );
      }
      return yield* Deferred.await(interruption);
    });

    const stop: Turn["stop"] = Effect.suspend(() => {
      interrupted = true;
      return cancelOpenRequests;
    });

    /** Emits what ends the Turn: an error, when there is one, and `turn.completed`. */
    const finish = (state: TurnState, error?: TurnError): Effect.Effect<void> =>
      Effect.gen(function* () {
        isEnding = true;
        // A Request still open here belongs to a prompt that is over.
        yield* cancelOpenRequests;
        // The controller closes the Requests of a Turn when it completes, so a
        // `request.resolved` that comes after `turn.completed` would be lost.
        yield* Effect.forEach(pendingResolutions, Fiber.await, { discard: true });
        if (error !== undefined) {
          emit([
            {
              _tag: "runtime.error",
              ...buildEvent(),
              turnId: input.turnId,
              class: error.class,
              message: truncateMessage(error.message),
            },
          ]);
        }
        // The session admits the next input once the Turn is closed, so the close and the flag change in one step.
        emit(
          closeTurn(normalizing, {
            state,
            turnId: input.turnId,
            ...(error === undefined ? {} : { error: error.message }),
          }),
        );
        isClosed = true;
      });

    /** Waits for the reply to a prompt, and turns a failure into a result. */
    const awaitReply = (
      waiting: Effect.Effect<PromptReply, AcpError>,
    ): Effect.Effect<PromptResult> =>
      waiting.pipe(
        Effect.map((reply): PromptResult => ({ kind: "replied", reply })),
        Effect.catch((error: AcpError) => Effect.succeed<PromptResult>({ kind: "failed", error })),
      );

    const runTurn = Effect.gen(function* () {
      let waiting = input.firstReply;
      for (;;) {
        deniedToolNames = [];
        pendingResolutions = [];
        promptInFlight = true;
        const result = yield* awaitReply(waiting);
        promptInFlight = false;

        if (result.kind === "failed") {
          // Nothing is known about the tokens of a prompt that did not answer.
          emit(addPromptUsage(normalizing, undefined));
          if (result.error.reason === "closed") {
            return yield* interrupted
              ? finish("interrupted")
              : finish("failed", {
                  class: "unknown",
                  message:
                    "Antigravity's process ended during the turn. Your next message resumes the session.",
                });
          }
          return yield* finish("failed", {
            class: "unknown",
            message: `Antigravity could not finish the turn: ${result.error.message}`,
          });
        }

        emit(addPromptUsage(normalizing, result.reply.usage));
        // A Deny counts only once its reply was written, so wait for the writes of this prompt.
        yield* Effect.forEach(pendingResolutions, Fiber.await, { discard: true });

        const { stopReason } = result.reply;
        if (stopReason === "end_turn") {
          if (interrupted || answeredCancel) return yield* finish("interrupted");
          if (deniedToolNames.length === 0) return yield* finish("completed");
          const followUp: ReadonlyArray<PromptContent> = [
            { type: "text", text: buildFollowUpText(deniedToolNames) },
          ];
          waiting = Effect.flatten(connection.sendPrompt(nativeSessionId, followUp));
          continue;
        }
        if (stopReason === "cancelled") return yield* finish("interrupted");
        const known = STOP_REASON_FAILURES[stopReason];
        return yield* finish(
          "failed",
          known === undefined
            ? {
                class: "unknown",
                message: `Antigravity ended the turn with the stop reason "${stopReason}", which Hercule does not know.`,
              }
            : { class: truncateFact(stopReason), message: known },
        );
      }
    }).pipe(Effect.ensuring(Deferred.succeed(ended, undefined)));

    // The prompt is sent before this returns, so an interrupt right after
    // `startTurn` always finds it in flight.
    promptInFlight = true;
    const runFiber = yield* Effect.forkIn(runTurn, scope, { startImmediately: true });

    const abandon: Turn["abandon"] = Effect.suspend(() => {
      if (isClosed) return Effect.void;
      interrupted = true;
      isEnding = true;
      const fibers: Array<Fiber.Fiber<unknown>> = [...pendingResolutions, runFiber];
      return Fiber.interruptAll(fibers).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!isClosed) {
              emit(closeTurn(normalizing, { state: "interrupted", turnId: input.turnId }));
              isClosed = true;
            }
            Deferred.doneUnsafe(ended, Effect.void);
          }),
        ),
      );
    });

    return {
      id: input.turnId,
      openApproval,
      openQuestion,
      decide,
      answer,
      interrupt,
      stop,
      abandon,
      hasEnded: () => isClosed,
      ended: Deferred.await(ended),
    };
  });
