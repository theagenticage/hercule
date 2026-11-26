/**
 * Runs one Turn of an Antigravity session. ACP has no turn, so a Turn is built
 * here from one `session/prompt` and its reply, plus one more prompt for each
 * round of denied calls (spec 06 section 6.5). The Turn owns:
 *
 * - the handoff of its first prompt: the Turn writes the prompt itself, stays
 *   unpublished until `agy` is known to have it, and only then emits
 *   `turn.started`, the `user_message` and the output `agy` sent meanwhile;
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
import * as Result from "effect/Result";
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
import { buildUserMessage } from "../events";
import type { AdapterTurnInput } from "../index";
import { buildEnvelope } from "../normalize";
import { truncateFact, truncateMessage } from "../text";
import type { ResolvedSkillReference } from "../../skills";
import { ANTIGRAVITY_NAME } from "./agy";
import {
  addPromptUsage,
  closeTurn,
  describeRequestItem,
  findRequestOwner,
  markDeclined,
  openTurn,
  releaseTurn,
  type NormalizerState,
} from "./normalize";
import {
  buildApprovalDecisions,
  buildApprovalOutcome,
  buildElicitationReply,
  buildOrphanMessage,
  buildQuestionNotOpen,
  CANCELLED_APPROVAL,
  CANCELLED_QUESTION,
  parseQuestionForm,
  type QuestionForm,
} from "./requests";

/** How long `agy` has to answer `session/cancel` with the reply to the prompt (spec 06 section 10.5). */
const INTERRUPT_DEADLINE = Duration.seconds(5);

/** How long a reply may take to be written to `agy` before it counts as not written. */
const REPLY_WRITE_DEADLINE = Duration.seconds(5);

/** A tool name that may appear in the follow-up prompt. Anything else could carry text meant for the model. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_]{1,64}$/;

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
  readonly normalizing: NormalizerState;
  /** Publishes events on the session's stream, in order. */
  readonly emit: (events: ReadonlyArray<HarnessEvent>) => void;
  /**
   * Called when it is not known whether `agy` got the first prompt. The prompt
   * may be running, so the session must end the process before it writes
   * another one.
   */
  readonly onDeliveryUnknown: () => void;
}

/** How an interrupt ended: `agy` answered `session/cancel` in time, or it did not. */
export type InterruptResult = "stopped" | "unresponsive";

/**
 * How the handoff of a Turn's first prompt ended.
 *
 * - `proven`: `agy` has the prompt, and the Turn is published.
 * - `not-sent`: `agy` certainly did not get the prompt, and no Turn is published.
 * - `unknown`: it is not known whether `agy` got the prompt, and no Turn is
 *   published. The prompt may be running, so the session must end the process.
 *
 * `message` says what went wrong, for the user.
 */
export type Handoff =
  | { readonly kind: "proven" }
  | { readonly kind: "not-sent"; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string };

export interface Turn {
  readonly id: string;
  /**
   * Completes once, with how the handoff of the first prompt ended. Until then
   * the Turn is reserved: it counts as running, so no other input is admitted,
   * and the output `agy` sends is held. An interrupt or a stop that comes
   * meanwhile is applied when the handoff is proven.
   */
  readonly handoff: Deferred.Deferred<Handoff>;
  /**
   * Opens an approval Request and waits for its decision. Returns the ACP
   * outcome to send to `agy`: the user's decision, or `cancelled` when the
   * Turn is interrupted before or while it waits, or when the call the Request
   * is about is not a running item of this Turn (the Turn then warns). A
   * Request that comes during the handoff waits for it, because the item it is
   * about may be in the output that is held.
   */
  readonly openApproval: (request: ApprovalRequest) => Effect.Effect<ApprovalOutcome>;
  /**
   * Opens a question Request and waits for its answers. Returns the ACP reply
   * to send: the answers, or `cancel` when the form cannot be read, the Turn
   * is interrupted, or the question's call is not a running item of this Turn
   * (the Turn then warns).
   */
  readonly openQuestion: (request: ElicitationRequest) => Effect.Effect<ElicitationReply>;
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
 * Warns that a Request of `agy` belongs to no running item of a Turn. `turnId`
 * is left out when the Request has no published Turn to belong to.
 */
const warnOrphan = (
  normalizing: NormalizerState,
  emit: TurnContext["emit"],
  what: string,
  toolCallId: string | null | undefined,
  turnId: string | undefined,
): void => {
  emit([
    {
      _tag: "runtime.warning",
      ...buildEnvelope(normalizing.sessionId, {
        nativeSessionId: normalizing.nativeSessionId,
        ...(toolCallId == null ? {} : { toolCallId }),
      }),
      ...(turnId === undefined ? {} : { turnId }),
      message: buildOrphanMessage(what),
    },
  ]);
};

/**
 * Cancels an approval Request that belongs to no running item of a Turn, shows
 * the call as declined, and warns. Returns the outcome to send to `agy`.
 * `turnId` is the Turn the warning is about, or undefined when there is none.
 */
export const cancelOrphanApproval = (
  normalizing: NormalizerState,
  emit: TurnContext["emit"],
  request: ApprovalRequest,
  turnId?: string,
): ApprovalOutcome => {
  // A call that is shown as cancelled, not as failed, because nobody ran it.
  markDeclined(normalizing, request.toolCall.toolCallId);
  warnOrphan(normalizing, emit, "for approval of a call", request.toolCall.toolCallId, turnId);
  return CANCELLED_APPROVAL;
};

/** Cancels a question Request that belongs to no running item of a Turn, and warns. Returns the reply to send to `agy`. */
export const cancelOrphanQuestion = (
  normalizing: NormalizerState,
  emit: TurnContext["emit"],
  request: ElicitationRequest,
  turnId?: string,
): ElicitationReply => {
  warnOrphan(normalizing, emit, "a question", request.toolCallId, turnId);
  return CANCELLED_QUESTION;
};

/**
 * Starts a Turn for `input` and returns it reserved: its handoff is pending.
 * The session has held the output of `agy` since it admitted the input
 * (`holdTurn`), and the Turn releases or replays it. A fiber of the current scope
 * writes the first prompt (`prompt`) to `agy`, which must take at most
 * `handoffBudget`, and then runs the Turn. Follow-up prompts are sent by the
 * Turn itself. The Turn ends by emitting `turn.completed`, and closing the
 * scope interrupts it.
 *
 * The Turn is published only when the handoff is proven: it emits
 * `turn.started`, the input's `user_message` (with the skipped-skills warning when
 * a skill was skipped), the held output and then lets the
 * Requests that waited go on. When the prompt is not delivered, or it is not
 * known whether it was, the Turn emits nothing of its own and releases the held
 * output as output with no input (see `Handoff`).
 */
export const startTurn = (
  context: TurnContext,
  input: {
    readonly input: AdapterTurnInput;
    readonly prompt: ReadonlyArray<PromptContent>;
    /** The Skill References the prompt got a pointer line for, recorded on the `user_message`. */
    readonly skillReferences: ReadonlyArray<ResolvedSkillReference>;
    /** The names of the skills the prompt got no line for, told to the user right after the `user_message`. */
    readonly skippedSkills: ReadonlyArray<string>;
    readonly handoffBudget: Duration.Duration;
  },
): Effect.Effect<Turn, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { sessionId, nativeSessionId, connection, normalizing, emit, onDeliveryUnknown } =
      context;
    const scope = yield* Effect.scope;
    const turnId = crypto.randomUUID();
    const ended = yield* Deferred.make<void>();
    const handoff = yield* Deferred.make<Handoff>();

    /** The Requests that wait for a reply, by the id Hercule gave them. A Request leaves the map when it settles, so it settles once. */
    const open = new Map<string, ApprovalPark | QuestionPark>();
    let promptInFlight = false;
    /** Whether the Turn must end `interrupted`: the user or the session stopped it. */
    let interrupted = false;
    /**
     * Where the Turn is in its life. `handoff` lasts until the first prompt is
     * proven delivered or refused. From `ending` on, no new Request opens and no
     * interrupt is sent. `closed` is from the moment `turn.completed` was
     * emitted, or from the refusal of the first prompt.
     */
    let phase: "handoff" | "running" | "ending" | "closed" = "handoff";
    /** Whether the session is ending, so a reply that cannot be written is no news to the user. */
    let isStopped = false;
    /** The interrupt that was sent and waits for its result, shared with a second caller. */
    let pendingInterrupt: Deferred.Deferred<InterruptResult> | undefined;
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
            if (!written && !isStopped) {
              emit([
                {
                  _tag: "runtime.warning",
                  ...buildEvent(),
                  turnId,
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

    /** Whether `turn.started` was emitted. The Turn of a refused prompt never is. */
    let isPublished = false;
    const orphanTurnId = (): string | undefined => (isPublished ? turnId : undefined);

    const openApproval: Turn["openApproval"] = (request) =>
      Effect.gen(function* () {
        // The item the Request is about may be in the output held during the handoff.
        yield* Deferred.await(handoff);
        const item = describeRequestItem(
          normalizing,
          request.toolCall.toolCallId,
          request.toolCall,
        );
        if (item === undefined || item.turnId !== turnId) {
          return cancelOrphanApproval(normalizing, emit, request, orphanTurnId());
        }
        if (interrupted || phase !== "running") {
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
              decisions: buildApprovalDecisions(request.options),
            },
          },
        ]);
        return yield* Deferred.await(outcome);
      });

    const openQuestion: Turn["openQuestion"] = (request) =>
      Effect.gen(function* () {
        yield* Deferred.await(handoff);
        const owner =
          request.toolCallId == null
            ? undefined
            : findRequestOwner(normalizing, request.toolCallId);
        if (owner === undefined || owner.turnId !== turnId) {
          return cancelOrphanQuestion(normalizing, emit, request, orphanTurnId());
        }
        if (interrupted || phase !== "running") return CANCELLED_QUESTION;
        const form = parseQuestionForm(request);
        if (form === undefined) {
          emit([
            {
              _tag: "runtime.warning",
              ...buildEvent(),
              turnId,
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
          return yield* Effect.fail(buildQuestionNotOpen());
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
            "It is not known whether Antigravity received the answer, so the question was cancelled. The agent can ask again if it still needs the answer.",
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
      if (pendingInterrupt === undefined) {
        if (phase === "ending" || phase === "closed") return "stopped";
        // Marked before the first yield, so a Request that opens from now on is cancelled.
        interrupted = true;
        const result = Deferred.makeUnsafe<InterruptResult>();
        pendingInterrupt = result;
        yield* cancelOpenRequests;
        // A fiber of the scope runs the wait, so a caller that is interrupted cannot leave a second caller waiting for ever.
        // `session/cancel` follows the proven handoff, because `agy` has no prompt to cancel before it.
        yield* Effect.forkIn(
          Deferred.await(handoff).pipe(
            Effect.flatMap((outcome) =>
              outcome.kind === "proven" ? sendCancel : Effect.succeed("stopped" as const),
            ),
            Effect.flatMap((value) =>
              Effect.suspend(() => {
                // A finished interrupt is forgotten, so the next one sends `session/cancel` again.
                if (pendingInterrupt === result) pendingInterrupt = undefined;
                return Deferred.succeed(result, value);
              }),
            ),
          ),
          scope,
        );
      }
      return yield* Deferred.await(pendingInterrupt);
    });

    const stop: Turn["stop"] = Effect.suspend(() => {
      interrupted = true;
      isStopped = true;
      return cancelOpenRequests;
    });

    /** Emits what ends the Turn: an error, when there is one, and `turn.completed`. */
    const finish = (state: TurnState, error?: TurnError): Effect.Effect<void> =>
      Effect.gen(function* () {
        phase = "ending";
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
              turnId,
              class: error.class,
              message: truncateMessage(error.message),
            },
          ]);
        }
        // The session admits the next input once the Turn is closed, so the close and the flag change in one step.
        emit(
          closeTurn(normalizing, {
            state,
            turnId,
            ...(error === undefined ? {} : { error: error.message }),
          }),
        );
        phase = "closed";
      });

    /** Waits for the reply to a prompt, and turns a failure into a result. */
    const awaitReply = (
      waiting: Effect.Effect<PromptReply, AcpError>,
    ): Effect.Effect<PromptResult> =>
      waiting.pipe(
        Effect.map((reply): PromptResult => ({ kind: "replied", reply })),
        Effect.catch((error: AcpError) => Effect.succeed<PromptResult>({ kind: "failed", error })),
      );

    /**
     * Ends the handoff without a published Turn: releases the held output as
     * output with no input, and closes the Turn. Does nothing once the handoff
     * has ended, so the first outcome stays.
     */
    const refuseHandoff = (outcome: Exclude<Handoff, { readonly kind: "proven" }>): void => {
      if (phase !== "handoff") return;
      phase = "closed";
      emit(releaseTurn(normalizing));
      Deferred.doneUnsafe(handoff, Effect.succeed(outcome));
      if (outcome.kind === "unknown") onDeliveryUnknown();
    };

    /** Writes the first prompt and returns the effect that waits for its reply, or refuses the handoff and returns undefined. */
    const writeFirstPrompt = Effect.gen(function* () {
      const written = yield* Effect.result(
        connection.sendPrompt(nativeSessionId, input.prompt),
      ).pipe(Effect.timeoutOption(input.handoffBudget));
      if (Option.isNone(written)) {
        refuseHandoff({
          kind: "unknown",
          message: "Antigravity did not take the input in time, so it may or may not have arrived.",
        });
        return undefined;
      }
      if (Result.isFailure(written.value)) {
        const { reason, message } = written.value.failure;
        refuseHandoff(
          reason === "not-sent"
            ? { kind: "not-sent", message }
            : {
                kind: "unknown",
                message: `Antigravity lost its connection while the input was handed over, so it may or may not have arrived: ${message}`,
              },
        );
        return undefined;
      }
      // Proven: the Turn is published before anything that waited on the handoff goes on.
      phase = "running";
      isPublished = true;
      emit(
        openTurn(
          normalizing,
          turnId,
          buildUserMessage({
            sessionId,
            turnId,
            text: input.input.text,
            attachments: input.input.attachments,
            skillReferences: input.skillReferences,
            skippedSkills: { harnessName: ANTIGRAVITY_NAME, names: input.skippedSkills },
            senderSessionId: input.input.senderSessionId,
            steered: false,
            harnessRefs: { nativeSessionId },
          }),
        ),
      );
      Deferred.doneUnsafe(handoff, Effect.succeed({ kind: "proven" }));
      return written.value.success;
    });

    const runTurn = Effect.gen(function* () {
      let waiting = yield* writeFirstPrompt;
      if (waiting === undefined) return;
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
          if (interrupted) return yield* finish("interrupted");
          if (deniedToolNames.length === 0) return yield* finish("completed");
          const followUp: ReadonlyArray<PromptContent> = [
            { type: "text", text: buildFollowUpText(deniedToolNames) },
          ];
          // A Request still open belongs to the prompt that is over, so it must not stay answerable.
          yield* cancelOpenRequests;
          yield* Effect.forEach(pendingResolutions, Fiber.await, { discard: true });
          // An interrupt that came while the Requests were cancelled ends the Turn, with no follow-up sent.
          if (interrupted) return yield* finish("interrupted");
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
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          // A Turn that is interrupted while its prompt is written has no outcome yet.
          refuseHandoff({
            kind: "unknown",
            message:
              "Antigravity was stopped while the input was handed over, so it may or may not have arrived.",
          });
          Deferred.doneUnsafe(ended, Effect.void);
        }),
      ),
    );

    const runFiber = yield* Effect.forkIn(runTurn, scope, { startImmediately: true });

    const abandon: Turn["abandon"] = Effect.suspend(() => {
      if (phase === "closed") return Effect.void;
      interrupted = true;
      // Interrupting the fiber of a Turn that is still in its handoff refuses the handoff.
      if (phase !== "handoff") phase = "ending";
      const fibers: Array<Fiber.Fiber<unknown>> = [...pendingResolutions, runFiber];
      return Fiber.interruptAll(fibers).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (phase !== "closed") {
              emit(closeTurn(normalizing, { state: "interrupted", turnId }));
              phase = "closed";
            }
            Deferred.doneUnsafe(ended, Effect.void);
          }),
        ),
      );
    });

    return {
      id: turnId,
      handoff,
      openApproval,
      openQuestion,
      decide,
      answer,
      interrupt,
      stop,
      abandon,
      hasEnded: () => phase === "closed",
      ended: Deferred.await(ended),
    };
  });
