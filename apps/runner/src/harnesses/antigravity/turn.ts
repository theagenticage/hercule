/**
 * Runs one Turn of an Antigravity session. ACP has no turn, so a Turn is built
 * here from one `session/prompt` and its reply, plus one more prompt for each
 * round of denied calls (spec 06 section 6.5) and one for each input that
 * steers it (spec 06 section 5). The Turn owns:
 *
 * - the handoff of its first prompt: the Turn writes the prompt itself, stays
 *   unpublished until `agy` is known to have it, and only then emits
 *   `turn.started`, the `user_message` and the output `agy` sent meanwhile;
 * - every prompt written to `agy`: the first, the steers and the follow-ups
 *   for denied calls. The reply of the newest prompt ends the Turn. When `agy`
 *   takes a steer it answers the prompt before it at once and goes on with the
 *   work, so a reply of an older prompt only adds its usage;
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
import * as Queue from "effect/Queue";
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
  ExitReason,
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
import { ANTIGRAVITY_NAME, isQuotaError } from "./agy";
import type { RootConversationFact } from "./agy-files";
import {
  addPromptUsage,
  closeTurn,
  describeRequestItem,
  findRequestOwner,
  markDeclined,
  openTurn,
  releaseTurn,
  takeErrorNotice,
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

/** What happens to a message a Turn refused, said at the end of every refusal. */
const STAYS_QUEUED = "Your message stays queued and is sent when the turn ends.";

/** Starts every message that tells a delivery is not known, so the user reads one wording for it. */
const CANNOT_TELL = "Hercule cannot tell whether Antigravity took the message";

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
  refusal: "Antigravity ended the turn with the stop reason refusal, without giving a reason.",
};

/** An input made ready for `agy`: what the first prompt of a Turn and a steer both take. */
export interface PreparedInput {
  readonly input: AdapterTurnInput;
  readonly prompt: ReadonlyArray<PromptContent>;
  /** The Skill References the prompt got a pointer line for, recorded on the `user_message`. */
  readonly skillReferences: ReadonlyArray<ResolvedSkillReference>;
  /** The names of the skills the prompt got no line for, told to the user right after the `user_message`. */
  readonly skippedSkills: ReadonlyArray<string>;
  /** How long writing the prompt and waiting for `agy` to take it may last. */
  readonly handoffBudget: Duration.Duration;
}

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

/**
 * What an interrupt did.
 *
 * - `cancelled`: `session/cancel` was written to `agy`, and the Turn ended.
 * - `unresponsive`: `session/cancel` was written, but the Turn did not end
 *   within the deadline.
 * - `not-cancelled`: no `session/cancel` reached `agy`. The Turn was already
 *   ending or closed, its first prompt was not proven delivered, or the write
 *   of `session/cancel` failed. The Turn then ends by itself, or not at all.
 */
export type InterruptResult = "cancelled" | "unresponsive" | "not-cancelled";

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

/**
 * How a steer ended.
 *
 * - `accepted`: `agy` took the input into this Turn, which now shows it as a
 *   steered `user_message`.
 * - `refused`: `agy` certainly did not take the input, or the Turn could not
 *   ask it. The controller keeps the input queued.
 * - `unknown`: `agy` may have the input. The session must end the process.
 *
 * `message` says what went wrong, for the user.
 */
export type SteerOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly message: string }
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
   * Hands `prepared` to `agy` as a prompt that steers the running Turn, and
   * returns how that ended once it is known whether `agy` took it, which
   * takes at most `prepared.handoffBudget`. Never fails.
   *
   * Refuses at once, writing nothing, when the Turn is not running (it is in
   * its handoff, between two prompts, or ending), was interrupted, has a
   * Request open (the user answers it first), or is already taking another
   * steer. Otherwise the steer is reserved before the write, so a second one
   * is refused while this one is open.
   *
   * `agy` has taken the steer when the prompt it supersedes replies, or when
   * its own prompt replies, whichever comes first. It refuses with a JSON-RPC
   * error at once, so the steer is refused when that error comes first. The
   * steer is `unknown` when the budget runs out or the connection closes. A
   * refusal that comes after the steer was accepted is not special: it fails
   * the Turn like any prompt that fails. What `agy` does with a steer written
   * after the old prompt ended by itself is not measured. The Turn shows such
   * a steer like any other, as one Turn that the newest prompt's reply ends.
   *
   * The `user_message` of the input is emitted only on acceptance.
   */
  readonly steer: (prepared: PreparedInput) => Effect.Effect<SteerOutcome>;
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
   * `cancelled` when it ended, `unresponsive` when `agy` did not answer in
   * time, and `not-cancelled` when no `session/cancel` was written (see
   * `InterruptResult`). After `unresponsive` the Turn emits no `turn.completed`
   * itself: the session stops the process, the prompt fails, and the Turn
   * ends. A second call while one runs gives the same result.
   */
  readonly interrupt: Effect.Effect<InterruptResult>;
  /**
   * Prepares for the end of the session, which ends for `reason`: cancels
   * every open Request, and makes the Turn end `interrupted` instead of
   * `failed` or `completed`. The one exception is the reason
   * `inactivity_timeout` after the transcript showed a provider error: the
   * Turn then ends `failed` with the provider's words, because a silent
   * session that the model service refused did not stop by the user's will.
   * Sends nothing to `agy`.
   */
  readonly stop: (reason: ExitReason) => Effect.Effect<void>;
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
  /**
   * Takes a fact that the transcript of the session's own conversation tells.
   * An `input` fact marks that `agy` wrote the Turn's prompt, and a
   * `provider-error` fact after it becomes one `runtime.warning` per Turn, in
   * the provider's words. It ends nothing, because `agy` may retry and
   * recover. A fact that arrives before the Turn is published or after it
   * ended does nothing, and so does a provider error before the first input
   * and a second one.
   */
  readonly recordRootConversationFact: (fact: RootConversationFact) => void;
  /** Waits until the Turn has ended, which is after it emitted `turn.completed`, and returns the state it ended in. */
  readonly ended: Effect.Effect<TurnState>;
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

/** One `session/prompt` written to `agy`. Prompts are told apart by identity. */
type Prompt = symbol;

const buildPrompt = (): Prompt => Symbol("prompt");

/**
 * What wakes the loop of a Turn. It reads them one at a time, in the order they
 * happened, and looks at the state they changed.
 */
type TurnEvent =
  | { readonly kind: "prompt-settled"; readonly prompt: Prompt; readonly result: PromptResult }
  | { readonly kind: "steer-decided" };

/** The steer a Turn is taking: reserved before the write, until it is decided. */
interface OpenSteer {
  /** The prompt written for the steer. */
  readonly steerPrompt: Prompt;
  /** The newest prompt when the steer was reserved: the one `agy` answers when it takes the steer. */
  readonly supersededPrompt: Prompt;
  readonly prepared: PreparedInput;
  readonly decision: Deferred.Deferred<SteerOutcome>;
  /** Whether the write of the steer's prompt has started: `agy` may then have the message, so an interrupt does not refuse the steer. */
  isWriteStarted: boolean;
}

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
 * `handoffBudget`, and then runs the Turn. Follow-up prompts and steers are
 * written by the Turn itself. The Turn ends by emitting `turn.completed`, and closing the
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
  input: PreparedInput,
): Effect.Effect<Turn, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { sessionId, nativeSessionId, connection, normalizing, emit, onDeliveryUnknown } =
      context;
    const scope = yield* Effect.scope;
    const turnId = crypto.randomUUID();
    const ended = yield* Deferred.make<TurnState>();
    /** How the Turn ended. `interrupted` until `finish` says otherwise, which is also what a Turn that is abandoned or whose handoff failed reports. */
    let endState: TurnState = "interrupted";
    const handoff = yield* Deferred.make<Handoff>();

    /** The Requests that wait for a reply, by the id Hercule gave them. A Request leaves the map when it settles, so it settles once. */
    const open = new Map<string, ApprovalPark | QuestionPark>();
    /** Whether a prompt is in flight, which is from the proven handoff until the newest prompt's reply is read. */
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
    /** Whether the session is ending because it had no activity for too long. */
    let isInactivityTimeout = false;
    /** The interrupt that was sent and waits for its result, shared with a second caller. */
    let pendingInterrupt: Deferred.Deferred<InterruptResult> | undefined;
    /**
     * The tool names of the Denies not yet told to the model, counted once their
     * reply was written. They carry over a steer: the follow-up goes out only
     * when the newest prompt replies.
     */
    let deniedToolNames: Array<string | null | undefined> = [];
    /** The fibers that resolve the Requests since the last follow-up, so the end of a prompt waits for them. */
    let pendingResolutions: Array<Fiber.Fiber<unknown>> = [];
    const events = yield* Queue.unbounded<TurnEvent>();
    /** The prompt whose reply ends the Turn. It starts as the first prompt, which is written before anything reads it. */
    let newestPrompt = buildPrompt();
    let openSteer: OpenSteer | undefined;
    /** The fiber that waits for the reply of each prompt written, by prompt. */
    const waitingReplies = new Map<Prompt, Fiber.Fiber<PromptResult>>();
    /** The result of every prompt whose reply was read. The Turn ends by the one of the newest prompt, once no steer is open. */
    const results = new Map<Prompt, PromptResult>();

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

    /**
     * Sends `session/cancel`, and waits for the Turn to end when a prompt is in
     * flight. Returns `not-cancelled` at once when the write failed.
     */
    const sendCancel: Effect.Effect<InterruptResult> = Effect.suspend(() => {
      const waitsForReply = promptInFlight;
      return connection.cancel(nativeSessionId).pipe(
        Effect.as(true),
        Effect.catch((error: AcpError) =>
          Effect.logWarning(`session/cancel was not sent: ${error.message}`).pipe(Effect.as(false)),
        ),
        Effect.flatMap((isWritten) =>
          isWritten
            ? (waitsForReply ? Deferred.await(ended) : Effect.void).pipe(
                Effect.timeoutOption(INTERRUPT_DEADLINE),
                Effect.map((result): InterruptResult =>
                  Option.isNone(result) && waitsForReply ? "unresponsive" : "cancelled",
                ),
              )
            : Effect.succeed<InterruptResult>("not-cancelled"),
        ),
      );
    });

    const interrupt: Turn["interrupt"] = Effect.gen(function* () {
      if (pendingInterrupt === undefined) {
        if (phase === "ending" || phase === "closed") return "not-cancelled";
        // Marked before the first yield, so a Request that opens from now on is cancelled.
        interrupted = true;
        refuseOpenSteer();
        const result = Deferred.makeUnsafe<InterruptResult>();
        pendingInterrupt = result;
        yield* cancelOpenRequests;
        // A fiber of the scope runs the wait, so a caller that is interrupted cannot leave a second caller waiting for ever.
        // `session/cancel` follows the proven handoff, because `agy` has no prompt to cancel before it.
        yield* Effect.forkIn(
          Deferred.await(handoff).pipe(
            Effect.flatMap((outcome) =>
              outcome.kind === "proven"
                ? sendCancel
                : Effect.succeed<InterruptResult>("not-cancelled"),
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

    const stop: Turn["stop"] = (reason) =>
      Effect.suspend(() => {
        interrupted = true;
        refuseOpenSteer();
        isStopped = true;
        isInactivityTimeout = reason === "inactivity_timeout";
        return cancelOpenRequests;
      });

    /**
     * Ends the Turn the user or the session stopped: `interrupted`, except when
     * the inactivity timeout stopped a Turn that saw a provider error. That
     * Turn failed because of the error, so it ends `failed` with the provider's
     * words.
     */
    const finishStopped = (): Effect.Effect<void> =>
      isInactivityTimeout && newestProviderError !== undefined
        ? finish("failed", {
            class: isQuotaError(newestProviderError) ? "usage_limit" : "provider_error",
            message: newestProviderError,
          })
        : finish("interrupted");

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
        endState = state;
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
          message: `${CANNOT_TELL}, because it did not answer in time.`,
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
                message: `${CANNOT_TELL}, because its connection ended while the message was handed over: ${message}`,
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

    const postTurnEvent = (event: TurnEvent): void => {
      Queue.offerUnsafe(events, event);
    };

    /**
     * Forks a fiber of the scope that waits for the reply of `prompt`, adds its
     * usage, and posts what it came to. Returns the fiber, which ends with that
     * result.
     */
    const watchReply = (
      prompt: Prompt,
      waiting: Effect.Effect<PromptReply, AcpError>,
    ): Effect.Effect<Fiber.Fiber<PromptResult>> =>
      Effect.forkIn(
        Effect.map(awaitReply(waiting), (result) => {
          // Every reply adds its usage when it arrives, whatever the Turn is doing, so a reply that comes after the Turn ended is counted too.
          if (result.kind === "replied")
            emit(addPromptUsage(normalizing, result.reply.usage, turnId));
          postTurnEvent({ kind: "prompt-settled", prompt, result });
          return result;
        }),
        scope,
      ).pipe(
        Effect.tap((fiber) =>
          Effect.sync(() => {
            waitingReplies.set(prompt, fiber);
          }),
        ),
      );

    /**
     * Decides the open steer `steerPrompt` as `outcome`, once: a second decision
     * of the same steer does nothing. An accepted steer makes its prompt the
     * newest and shows its input as a steered `user_message`. Wakes the loop,
     * which may hold a reply that now ends the Turn.
     */
    const decideSteer = (steerPrompt: Prompt, outcome: SteerOutcome): void => {
      const current = openSteer;
      if (current === undefined || current.steerPrompt !== steerPrompt) return;
      openSteer = undefined;
      if (outcome.kind === "accepted") {
        newestPrompt = steerPrompt;
        const { input, skillReferences, skippedSkills } = current.prepared;
        emit(
          buildUserMessage({
            sessionId,
            turnId,
            text: input.text,
            attachments: input.attachments,
            skillReferences,
            skippedSkills: { harnessName: ANTIGRAVITY_NAME, names: skippedSkills },
            senderSessionId: input.senderSessionId,
            steered: true,
            harnessRefs: { nativeSessionId },
          }),
        );
      }
      Deferred.doneUnsafe(current.decision, Effect.succeed(outcome));
      postTurnEvent({ kind: "steer-decided" });
    };

    /**
     * Refuses the open steer when the write of its prompt has not started,
     * because an interrupt or a stop ends the Turn and `agy` never got the
     * message. A steer whose write started is left to its outcome, because
     * `agy` may have the message, and refusing it would let the controller
     * send it twice.
     */
    const refuseOpenSteer = (): void => {
      if (openSteer === undefined || openSteer.isWriteStarted) return;
      decideSteer(openSteer.steerPrompt, {
        kind: "refused",
        message: `The turn was stopped before Antigravity took the message. ${STAYS_QUEUED}`,
      });
    };

    /** Returns why the Turn cannot take a steer now, or undefined when it can. */
    const findSteerRefusal = (): string | undefined => {
      if (phase !== "running" || !promptInFlight) {
        return `Antigravity cannot take a message while the turn is starting or ending. ${STAYS_QUEUED}`;
      }
      if (interrupted) {
        return `The turn is being stopped, so the message was not sent to Antigravity. ${STAYS_QUEUED}`;
      }
      if (open.size > 0) {
        return `Antigravity is waiting for your answer to a request, and takes no message before it. Answer the request first. ${STAYS_QUEUED}`;
      }
      if (openSteer !== undefined) {
        return `Antigravity is still taking your previous message. ${STAYS_QUEUED}`;
      }
      return undefined;
    };

    /** Returns what a failed write of the steer's prompt means for the steer. */
    const decideFailedWrite = (error: AcpError): SteerOutcome =>
      error.reason === "not-sent"
        ? {
            kind: "refused",
            message: `Antigravity did not get your message: ${error.message} ${STAYS_QUEUED}`,
          }
        : {
            kind: "unknown",
            message: `${CANNOT_TELL}, because its connection ended while the message was handed over: ${error.message}`,
          };

    /** Returns what the reply or the failure of the steer's own prompt means for the steer. */
    const decideSteerPromptResult = (result: PromptResult): SteerOutcome => {
      if (result.kind === "replied") return { kind: "accepted" };
      const { error } = result;
      return error.reason === "refused"
        ? {
            kind: "refused",
            message: `Antigravity did not take your message: ${truncateFact(error.harnessMessage ?? error.message)} ${STAYS_QUEUED}`,
          }
        : { kind: "unknown", message: `${CANNOT_TELL}: ${error.message}` };
    };

    /**
     * Returns what the reply or the failure of the prompt the steer supersedes
     * means for the steer, or undefined when it decides nothing and the steer's
     * own reply decides. `agy` answers that prompt at once when it takes the
     * steer.
     *
     * - A reply accepts the steer, except the `cancelled` reply that answers an
     *   interrupt: that cancel ends the old prompt whatever the steer comes to.
     * - A refusal of the old prompt says nothing about the steer, which `agy`
     *   still answers itself. If the steer is then refused, the old prompt's
     *   failure ends the Turn as any failed prompt does.
     * - The connection ending leaves the steer unknown.
     */
    const decideSupersededResult = (result: PromptResult): SteerOutcome | undefined => {
      if (result.kind === "replied") {
        return interrupted && result.reply.stopReason === "cancelled"
          ? undefined
          : { kind: "accepted" };
      }
      return result.error.reason === "refused"
        ? undefined
        : { kind: "unknown", message: `${CANNOT_TELL}, because its connection ended.` };
    };

    const steer: Turn["steer"] = (prepared) =>
      Effect.suspend(() => {
        const refusal = findSteerRefusal();
        if (refusal !== undefined)
          return Effect.succeed<SteerOutcome>({ kind: "refused", message: refusal });
        // Reserved before the write, so a second steer is refused and a reply of the old prompt cannot end the Turn meanwhile.
        const steerPrompt = buildPrompt();
        const supersededPrompt = newestPrompt;
        const decision = Deferred.makeUnsafe<SteerOutcome>();
        const current: OpenSteer = {
          steerPrompt,
          supersededPrompt,
          prepared,
          decision,
          isWriteStarted: false,
        };
        openSteer = current;
        const notTakenInTime: SteerOutcome = {
          kind: "unknown",
          message: `${CANNOT_TELL}, because it did not answer in time.`,
        };
        const decideAlone = Effect.gen(function* () {
          // Marked before the write starts: from the moment the line is handed to the pipe, `agy` may have the message.
          current.isWriteStarted = true;
          const written = yield* Effect.result(
            connection.sendPrompt(nativeSessionId, prepared.prompt),
          );
          if (Result.isFailure(written)) {
            decideSteer(steerPrompt, decideFailedWrite(written.failure));
            return;
          }
          const steerReply = yield* watchReply(steerPrompt, written.success);
          const supersededReply = waitingReplies.get(supersededPrompt);
          const outcome = yield* Effect.raceFirst(
            Effect.map(Fiber.join(steerReply), decideSteerPromptResult),
            supersededReply === undefined
              ? Effect.never
              : Effect.flatMap(Fiber.join(supersededReply), (result) => {
                  const decided = decideSupersededResult(result);
                  return decided === undefined ? Effect.never : Effect.succeed(decided);
                }),
          );
          decideSteer(steerPrompt, outcome);
        });
        const decideWithinBudget = decideAlone.pipe(
          Effect.timeoutOption(prepared.handoffBudget),
          Effect.flatMap((finished) =>
            Option.isNone(finished)
              ? Effect.sync(() => {
                  decideSteer(steerPrompt, notTakenInTime);
                })
              : Effect.void,
          ),
        );
        // The steer can also be decided from outside (an interrupt refuses it before its write finished), and then the caller does not wait for the write.
        return Effect.raceFirst(decideWithinBudget, Deferred.await(decision)).pipe(
          // A caller that is gone while `agy` may be reading the prompt leaves the same doubt as a timeout.
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (Deferred.isDoneUnsafe(decision)) return;
              decideSteer(steerPrompt, notTakenInTime);
              onDeliveryUnknown();
            }),
          ),
          Effect.andThen(Deferred.await(decision)),
        );
      });

    /** Whether this Turn already showed an `ERROR_MESSAGE` step of the transcript. */
    let hasShownRootError = false;
    /**
     * Whether a `USER_INPUT` step came since the Turn was published. `agy`
     * writes the first prompt's one within seconds, so an error that comes
     * earlier belongs to the Turn before.
     */
    let hasSeenRootUserInput = false;
    /** The words of the newest provider error the transcript showed since the first input, for a Turn that the inactivity timeout ends. */
    let newestProviderError: string | undefined;

    const recordRootConversationFact: Turn["recordRootConversationFact"] = (fact) => {
      if (!isPublished || phase === "closed") return;
      if (fact.kind === "input") {
        hasSeenRootUserInput = true;
        return;
      }
      if (!hasSeenRootUserInput) return;
      newestProviderError = fact.words;
      if (hasShownRootError) return;
      hasShownRootError = true;
      emit([
        {
          _tag: "runtime.warning",
          ...buildEvent(),
          turnId,
          message: truncateMessage(
            `Google's model service answered with an error, and Antigravity may try again: ${fact.words}`,
          ),
        },
      ]);
    };

    const runTurn = Effect.gen(function* () {
      const waiting = yield* writeFirstPrompt;
      if (waiting === undefined) return;
      promptInFlight = true;
      yield* watchReply(newestPrompt, waiting);
      for (;;) {
        const event = yield* Queue.take(events);
        if (event.kind === "prompt-settled") results.set(event.prompt, event.result);
        // While a steer is open, the reply of the prompt it supersedes is held: it ends the Turn only if the steer is refused. A reply of an older prompt ends nothing.
        if (openSteer !== undefined) continue;
        const result = results.get(newestPrompt);
        if (result === undefined) continue;
        promptInFlight = false;

        if (result.kind === "failed") {
          // Nothing is known about the tokens of a prompt that did not answer.
          emit(addPromptUsage(normalizing, undefined, turnId));
          if (result.error.reason === "closed") {
            return yield* interrupted
              ? finishStopped()
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

        // A Deny counts only once its reply was written, so wait for the writes so far.
        yield* Effect.forEach(pendingResolutions, Fiber.await, { discard: true });

        const { stopReason } = result.reply;
        if (stopReason === "end_turn") {
          if (interrupted) return yield* finishStopped();
          const notice = takeErrorNotice(normalizing);
          if (notice !== undefined) {
            return yield* finish("failed", {
              class: isQuotaError(notice) ? "usage_limit" : "provider_error",
              message: notice,
            });
          }
          if (deniedToolNames.length === 0) return yield* finish("completed");
          const followUp: ReadonlyArray<PromptContent> = [
            { type: "text", text: buildFollowUpText(deniedToolNames) },
          ];
          // A Request still open belongs to the prompt that is over, so it must not stay answerable.
          yield* cancelOpenRequests;
          yield* Effect.forEach(pendingResolutions, Fiber.await, { discard: true });
          // An interrupt that came while the Requests were cancelled ends the Turn, with no follow-up sent.
          if (interrupted) return yield* finish("interrupted");
          deniedToolNames = [];
          pendingResolutions = [];
          newestPrompt = buildPrompt();
          promptInFlight = true;
          yield* watchReply(
            newestPrompt,
            Effect.flatten(connection.sendPrompt(nativeSessionId, followUp)),
          );
          continue;
        }
        if (stopReason === "cancelled") return yield* finishStopped();
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
            message: `${CANNOT_TELL}, because the session was stopped while the message was handed over.`,
          });
          // A steer still open when the Turn is over is not decided: `agy` may have it.
          if (openSteer !== undefined) {
            decideSteer(openSteer.steerPrompt, {
              kind: "unknown",
              message: `${CANNOT_TELL}, because the turn ended first.`,
            });
          }
          Deferred.doneUnsafe(ended, Effect.succeed(endState));
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
            Deferred.doneUnsafe(ended, Effect.succeed(endState));
          }),
        ),
      );
    });

    return {
      id: turnId,
      handoff,
      steer,
      openApproval,
      openQuestion,
      decide,
      answer,
      interrupt,
      stop,
      abandon,
      hasEnded: () => phase === "closed",
      recordRootConversationFact,
      ended: Deferred.await(ended),
    };
  });
