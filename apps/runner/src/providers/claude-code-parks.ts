/**
 * The parks of a Claude Code session. A park is one `canUseTool` call the
 * harness is waiting on: the harness asked for approval of a tool call, or
 * asked the user a question, and it does not continue that call until the
 * park ends.
 *
 * A session can have several parks open at once, one per `canUseTool` call:
 * the session's own agent and each subagent can ask at the same time. The user
 * answers them in any order, so each park is found by its request id and ends
 * on its own (spec 06 sections 8.1 and 13.3).
 */
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalDecision,
  OpenRequest,
  ProviderEvent,
  QuestionAnswers,
  RequestResolution,
  SubagentId,
} from "@hercule/protocol";
import type { RequestOpened } from "./claude-code-subagents";
import { keyAnswersForVendor } from "./questions";

/**
 * An open request the harness is waiting on for an answer. The promise the
 * harness awaits is hidden in the closures; everything else only needs the
 * request id, who asked, what the request takes, and a way to end the wait.
 *
 * An approval takes one of the decisions it offers; a question takes answers
 * only.
 */
export type Park = {
  readonly requestId: string;
  /** The subagent that asked, or `undefined` when the session's own agent asked. */
  readonly subagentId: SubagentId | undefined;
  /**
   * Whether the request's `request.opened` was published. The caller sets it
   * when it publishes the event. A request that ends before then was never
   * shown to anyone, so its end publishes no `request.resolved` either.
   */
  reported: boolean;
  /**
   * Ends the request without an answer from the user. This happens when:
   *
   * - the turn was interrupted;
   * - the session stopped;
   * - the harness withdrew the request;
   * - the harness's stream ended;
   * - the turn of the subagent that asked ended;
   * - the subagent that asked, or one above it, was stopped;
   * - the frames of the subagent that asked were dropped, so its turn may
   *   never open.
   *
   * The event stream reports the request as cancelled, because the user did
   * not deny it. The harness gets a plain deny, because there is no turn left
   * to interrupt.
   */
  readonly withdraw: () => void;
} & (
  | {
      readonly kind: "approval";
      readonly decisions: ReadonlyArray<ApprovalDecision>;
      /** Sends the decision to the harness in the SDK's terms, and the harness continues. */
      readonly decide: (decision: ApprovalDecision) => void;
    }
  | {
      readonly kind: "question";
      /** Sends the answers to the harness in the SDK's terms, and the harness continues. */
      readonly answer: (answers: QuestionAnswers) => void;
    }
);

/** The open parks of one session, keyed by request id. */
export type Parks = Map<string, Park>;

/** What a park needs to stamp the events it publishes. */
interface EventStamping {
  readonly sessionId: string;
  /** Creates a new event id. */
  readonly mint: () => string;
  /** The runner's own clock, as an ISO-8601 instant. */
  readonly now: () => string;
}

/** One `canUseTool` call, with the request the adapter built for it. */
interface ParkedCall {
  readonly request: OpenRequest;
  /** The subagent that asked, or `undefined` when the session's own agent asked. */
  readonly subagentId: SubagentId | undefined;
  /** The tool's input. An answered question returns it to the harness with the answers added. */
  readonly input: Record<string, unknown>;
  /** The rules an `allow_always` saves, already pointed at the session. */
  readonly persists: ReadonlyArray<PermissionUpdate>;
  /** The harness aborts this signal to withdraw the request. */
  readonly signal: AbortSignal;
}

/** The message the model gets when the user denies a tool call; the SDK requires one. */
const REFUSED = "the user did not allow this";

const CANCELLED = "the user cancelled this turn";

/**
 * Returns what the harness gets when the user cancels a request: a deny with
 * `interrupt: true`, so the turn ends instead of the model trying something
 * else.
 */
const buildCancelResult = (): PermissionResult => ({
  behavior: "deny",
  message: CANCELLED,
  interrupt: true,
  decisionClassification: "user_reject",
});

/**
 * Converts a user's decision into the SDK's permission result.
 *
 * - `decisionClassification` tells the harness who decided.
 * - `allow_always` returns the rules the harness suggested, unchanged apart
 *   from where they are saved.
 * - `cancel` ends the turn; see `buildCancelResult`.
 */
const buildPermissionResult = (
  decision: ApprovalDecision,
  persists: ReadonlyArray<PermissionUpdate>,
): PermissionResult => {
  switch (decision) {
    case "allow":
      return { behavior: "allow", decisionClassification: "user_temporary" };
    case "allow_always":
      return {
        behavior: "allow",
        updatedPermissions: [...persists],
        decisionClassification: "user_permanent",
      };
    case "deny":
      return buildDenyResult();
    case "cancel":
      return buildCancelResult();
  }
};

/**
 * Returns a plain deny. The harness gets one when the user denies a call, when
 * a request is withdrawn, and when nobody is left to answer.
 */
export const buildDenyResult = (): PermissionResult => ({
  behavior: "deny",
  message: REFUSED,
  decisionClassification: "user_reject",
});

/**
 * Converts the user's answers to an `AskUserQuestion` call into the SDK's
 * permission result: an allow whose input is the tool's own input with the
 * answers added, keyed by each question's full text. The SDK takes one string
 * per question, so several picks are joined with ", ", the separator the SDK
 * itself uses for a multi-select answer.
 */
const buildAnsweredResult = (
  input: Record<string, unknown>,
  answers: QuestionAnswers,
): PermissionResult => ({
  behavior: "allow",
  updatedInput: {
    ...input,
    answers: Object.fromEntries(
      [...keyAnswersForVendor(answers, input["questions"], "question")].map(([key, picks]) => [
        key,
        picks.join(", "),
      ]),
    ),
  },
  decisionClassification: "user_temporary",
});

/**
 * Opens a park for one `canUseTool` call and adds it to `parks`.
 *
 * Returns the promise the harness awaits, and the `request.opened` event for
 * the caller to publish. The caller publishes it rather than this function,
 * because when a request may be shown depends on the asker's turn. The caller
 * sets the park's `reported` when it does.
 *
 * The promise never rejects. It resolves when the user answers, when the
 * harness aborts `call.signal`, or when the park is withdrawn. Each of those
 * publishes `request.resolved` through `emit`, if the park's `reported` is
 * set by then. Only the first one counts: a later answer finds the park gone
 * and does nothing.
 */
export const openPark = (
  parks: Parks,
  stamping: EventStamping,
  emit: (event: ProviderEvent) => void,
  call: ParkedCall,
): { readonly result: Promise<PermissionResult>; readonly opened: RequestOpened } => {
  const { request, subagentId } = call;
  const { requestId } = request;
  const attribution = subagentId === undefined ? {} : { subagentId };
  const result = new Promise<PermissionResult>((settle) => {
    const endPark = (resolution: RequestResolution, harnessResult: PermissionResult): void => {
      const park = parks.get(requestId);
      // A park already gone was ended by an earlier answer, so this one does nothing.
      if (park === undefined) return;
      parks.delete(requestId);
      call.signal.removeEventListener("abort", withdraw);
      if (park.reported) {
        emit({
          _tag: "request.resolved",
          eventId: stamping.mint(),
          sessionId: stamping.sessionId,
          at: stamping.now(),
          ...attribution,
          requestId,
          ...resolution,
        });
      }
      settle(harnessResult);
    };
    const withdraw = (): void => endPark({ decision: "cancel" }, buildDenyResult());
    call.signal.addEventListener("abort", withdraw, { once: true });
    parks.set(
      requestId,
      request.kind === "question"
        ? {
            requestId,
            subagentId,
            reported: false,
            withdraw,
            kind: "question",
            answer: (answers) => endPark({ answers }, buildAnsweredResult(call.input, answers)),
          }
        : {
            requestId,
            subagentId,
            reported: false,
            withdraw,
            kind: "approval",
            decisions: request.decisions,
            decide: (decision) =>
              endPark({ decision }, buildPermissionResult(decision, call.persists)),
          },
    );
  });
  return {
    result,
    opened: {
      _tag: "request.opened",
      eventId: stamping.mint(),
      sessionId: stamping.sessionId,
      at: stamping.now(),
      ...attribution,
      request,
    },
  };
};

/** Withdraws every open park. */
export const withdrawAllParks = (parks: Parks): void => {
  for (const park of [...parks.values()]) park.withdraw();
};

/** Withdraws the parks the given subagents asked. The session's own agent's parks stay open. */
export const withdrawParksAskedBy = (parks: Parks, subagentIds: ReadonlySet<SubagentId>): void => {
  for (const park of [...parks.values()]) {
    if (park.subagentId !== undefined && subagentIds.has(park.subagentId)) park.withdraw();
  }
};
