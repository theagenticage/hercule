/**
 * Sessions: one provider-backed agent conversation, as the API sees it. A
 * caller spawns a session, reads it and sends it input; the only thing a
 * caller can change is its model selection.
 *
 * `requestedAccessMode` and `accessMode` are both on the record because the
 * access-mode fallback of [06-providers section 8.4] must never be silent.
 */
import { Duration, Schema, SchemaGetter, Tuple } from "effect";
import {
  ATTACHMENT_DOWNLOAD_TIMEOUT,
  AccessMode,
  ApprovalDecision,
  type ApprovalRequest,
  Fact,
  ModelSelection,
  OpenRequest,
  OutputSchema,
  QuestionAnswers,
  SESSION_INPUT_DEADLINE,
  SubagentId,
  Usage,
  UsageReport,
  StartingRevision,
} from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import {
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, Timestamp } from "../ids";
import { UnenforcedSpecField } from "./agent";
import { AttachmentId, MAX_ATTACHMENTS_PER_INPUT } from "./attachment";
import { Branch } from "./workspace";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";

/**
 * The request, subagent and usage vocabulary comes from the runner protocol;
 * the API returns it unchanged.
 */
export { ApprovalDecision, OpenRequest, QuestionAnswers, SubagentId, Usage, UsageReport };
export type { ApprovalRequest };

/**
 * A Request one agent of a session is parked on: the request exactly as the
 * harness opened it, and the subagent that asked.
 *
 * - `subagentId` is absent when the session's own agent asked (spec 06
 *   section 13.3).
 * - `subagentName` is the asking subagent's name: its `description`, else its
 *   `agentType`, read from its Subagent record every time the session is
 *   read, so it is never older than the record. It is absent when the
 *   session's own agent asked, and when the record holds neither field.
 */
export const SessionRequest = OpenRequest.mapMembers(
  Tuple.map(
    Schema.fieldsAssign({
      subagentId: Schema.optionalKey(SubagentId),
      subagentName: Schema.optionalKey(Schema.String),
    }),
  ),
);

export type SessionRequest = Schema.Schema.Type<typeof SessionRequest>;

/**
 * The longest prompt or turn input text the API accepts: the text is sent to
 * the runner in one frame. Images are not part of it: a frame carries only a
 * reference to each one.
 */
export const MAX_PROMPT_LENGTH = 64 * 1024;

/** A prompt that must have text, for the payloads that cannot carry images. */
export const Prompt = bounded(1, MAX_PROMPT_LENGTH);

/**
 * The text of a session's prompt or input. It may be empty when the payload
 * carries images; `refuseEmptyPrompt` refuses a payload with neither.
 */
export const PromptText = bounded(0, MAX_PROMPT_LENGTH);

/** The images sent with a prompt or input, in the order the user attached them. */
const PromptAttachments = Schema.optionalKey(atMost(AttachmentId, MAX_ATTACHMENTS_PER_INPUT));

/** The message of the issue for a prompt or input with no text and no images. */
export const EMPTY_PROMPT_MESSAGE = "A prompt needs text or at least one image.";

/**
 * Refuses a session prompt or input with no text and no images. It checks
 * `text` or `prompt`, whichever field the payload names its text with, so one
 * filter serves every payload that carries `attachments`. The issue points at
 * that field, so a client can show it where the user types the text.
 */
export const refuseEmptyPrompt = Schema.makeFilter(
  (payload: {
    readonly text?: string;
    readonly prompt?: string;
    readonly attachments?: ReadonlyArray<string>;
  }) => {
    const field = payload.prompt === undefined ? "text" : "prompt";
    if ((payload[field] ?? "").length > 0 || (payload.attachments?.length ?? 0) > 0)
      return undefined;
    return { path: [field], issue: EMPTY_PROMPT_MESSAGE };
  },
);

/**
 * The status of a session:
 *
 * - `queued`: placement accepted it, but the runner is full or unreachable;
 * - `starting`: the start was sent and no `session.started` has come back yet;
 * - `idle`: running, with no turn in progress;
 * - `busy`: a turn is running;
 * - `exited`: the process is gone. An exited session with `resumable` true is
 *   resumed in place by its next input.
 */
export const SESSION_STATUSES = ["queued", "starting", "idle", "busy", "exited"] as const;

export const SessionStatus = Schema.Literals(SESSION_STATUSES);

export type SessionStatus = Schema.Schema.Type<typeof SessionStatus>;

export const Session = Schema.Struct({
  id: Id,
  /**
   * The session's title, capped at 80 characters, set once and never
   * rewritten. For an agent step's session it is the run's workflow name and
   * the step's id, as `<workflow name> · <step id>`. For any other session it
   * is the opening prompt's first non-empty line.
   */
  title: Schema.String,
  status: SessionStatus,
  /**
   * Computed when the session is read, never stored. True when all of these hold:
   *
   * - the session is `exited` and has a `nativeSessionId`;
   * - its runner is not retired, and its workspace is still ready;
   * - it answered no assistant's conversation, or that conversation still exists.
   *
   * True means the next input resumes it in place.
   */
  resumable: Schema.Boolean,
  /**
   * Computed when the session is read: true when the session exited before
   * its last resume started any turn, inputs wait for it, no input has been
   * stored since that resume, and it could otherwise be resumed (`resumable`).
   * Such a session is not resumed automatically, because it would most likely
   * die the same way again: its input waits, and the next input anyone sends
   * resumes it with all of it (the crash-loop guard, spec 12 section 5.1). An
   * assistant's owner is told with a "can't be reached" notice when the hold
   * starts.
   */
  resumeHeld: Schema.Boolean,
  permissionProfileId: Id,
  /** The Agent this session was spawned from; `null` for a Thread. Kept only as a record of origin. */
  agentId: Schema.NullOr(Id),
  /**
   * The assistant's conversation this session answers; `null` for any other
   * session. Kept after the conversation is deleted, as a record of origin.
   */
  conversationId: Schema.NullOr(Id),
  /**
   * The run whose agent step started this session; `null` for any other
   * session. Kept after the run ends, as a record of origin.
   */
  runId: Schema.NullOr(Id),
  /** The id, in that run's plan, of the agent step this session runs; `null` when `runId` is. */
  stepId: Schema.NullOr(Schema.String),
  instanceId: Id,
  /** The runner the session started on. A session never moves to another runner. */
  runnerId: Id,
  workspaceId: Schema.NullOr(Id),
  /** The project the thread belongs to. It only groups the thread; nothing is derived from it. */
  projectId: Schema.NullOr(Id),
  requestedAccessMode: AccessMode,
  /** The mode the session actually runs in, after the access-mode fallback. */
  accessMode: AccessMode,
  /** The provider-native id, once the runner has reported its binding. */
  nativeSessionId: Schema.NullOr(Schema.String),
  /**
   * The model the session runs under now. It starts as the spec's and is
   * updated by `session.update` and by an input that carries a model or
   * options, so a resume or a fork uses the model the conversation ended on
   * rather than the one it started with.
   */
  modelSelection: ModelSelection,
  /** Set where this session was forked off another one; null otherwise. */
  parentSessionId: Schema.NullOr(Id),
  /**
   * The Requests the session's agents are parked on, oldest first; empty when
   * nothing waits on the user. Several can be open at once, from the
   * session's own agent and from its subagents, and each is answered on its
   * own, in any order. A Request closes when it is answered, when the turn of
   * the agent that asked ends, when that agent is stopped, or when the
   * session exits.
   */
  openRequests: Schema.Array(SessionRequest),
  /**
   * The session's Token Usage: every token its own agent and all its
   * subagents have used over the session's whole life, summed across its
   * processes. Absent until the harness reports exact usage. Incomplete counts appear only in `usageReport`.
   */
  usage: Schema.optionalKey(Usage),
  /** The known counts and their completeness; absent until usage is reported. */
  usageReport: Schema.optionalKey(UsageReport),
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  /** The time of the last exit. Kept while the session is resumed, and overwritten when it exits again. */
  exitedAt: Schema.NullOr(Timestamp),
  /**
   * The last time the session did something: it started, its status changed,
   * or its harness reported an event. Ending the session is not activity, so
   * an exited session keeps the time of what it did last; `exitedAt` holds the
   * exit.
   */
  lastActivityAt: Timestamp,
  /**
   * The fields this session was spawned with that its provider ignores.
   * Computed from the instance's declared capabilities every time the session
   * is read.
   */
  unenforced: Schema.Array(UnenforcedSpecField),
});

export type Session = Schema.Schema.Type<typeof Session>;

/**
 * How a subagent stands, computed from its turns:
 *
 * - `running`: one of its turns is open;
 * - `completed`, `failed`: how its last turn ended;
 * - `stopped`: its last turn was interrupted, or it was still running when
 *   its session's process exited.
 *
 * A subagent its parent gives more work goes back to `running`.
 */
export const SUBAGENT_STATUSES = ["running", "completed", "failed", "stopped"] as const;

export const SubagentStatus = Schema.Literals(SUBAGENT_STATUSES);

export type SubagentStatus = Schema.Schema.Type<typeof SubagentStatus>;

/**
 * An agent a session's harness delegated work to while the session runs (spec
 * 02, Subagent). It is part of its session, never a session of its own, so it
 * is read through its session. Every field is written as the session's events
 * arrive, so a list row needs no second read.
 */
export const Subagent = Schema.Struct({
  /** The harness's own id for the subagent, unique within its session. */
  id: SubagentId,
  sessionId: Id,
  /** The subagent that started this one; absent when the session's own agent did. */
  parentSubagentId: Schema.optionalKey(SubagentId),
  /** The `subagent` item that started it, in its parent's transcript. */
  itemId: Schema.optionalKey(Schema.String),
  /** The short task name its parent gave it, else the first line of the brief its parent gave it. */
  description: Schema.optionalKey(Schema.String),
  /** The harness's name for the kind of agent: Claude's `subagent_type`, Codex's role. */
  agentType: Schema.optionalKey(Schema.String),
  /** The model its latest turn ran on, as the harness reports it. */
  model: Schema.optionalKey(Schema.String),
  status: SubagentStatus,
  /** How many of its items were tool calls of any kind, calls on subagents included. */
  toolCalls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** One line saying what it is doing now, while it runs; absent once it has ended. */
  activity: Schema.optionalKey(Schema.String),
  /** The first line of its last message, once it has ended. */
  result: Schema.optionalKey(Schema.String),
  /**
   * Its own Token Usage, not its subagents'. Absent where the harness reports
   * no exact count for it, which a screen shows as not reported, never as 0.
   */
  usage: Schema.optionalKey(Usage),
  /** The known counts and their completeness; absent until usage is reported. */
  usageReport: Schema.optionalKey(UsageReport),
  /**
   * The `at` of its `subagent.started`, or of its first event when that came
   * first. Like every event's `at`, it was read off the runner's clock.
   */
  startedAt: Schema.String,
  /** The `at` of the event that ended its last turn; absent while it runs. */
  endedAt: Schema.optionalKey(Schema.String),
});

export type Subagent = Schema.Schema.Type<typeof Subagent>;

/** What a session's subagent listing may be sorted by; oldest first by default. */
export const SUBAGENT_SORT_FIELDS = ["startedAt"] as const;

/**
 * The payload of `session.interrupt`. Without `subagentId` it stops all work
 * in the session: its own agent's turn and every running subagent. With
 * `subagentId` it stops that subagent and every subagent below it, and leaves
 * the rest of the session running.
 */
export const SessionInterruptInput = closedStruct({
  subagentId: Schema.optionalKey(SubagentId),
});

export type SessionInterruptInput = Schema.Schema.Type<typeof SessionInterruptInput>;

/**
 * Decodes a `session.interrupt` request with no body to `{}`, which interrupts
 * all work in the session. A bare `POST /sessions/:id/interrupt` is how agents,
 * scripts and older clients ask for an interrupt, and an empty body reaches
 * the payload decoder as `null`. Clients never send this form: `{}` encodes
 * with `SessionInterruptInput` first.
 */
const SessionInterruptWithoutBody = Schema.Null.pipe(
  Schema.decodeTo(SessionInterruptInput, {
    decode: SchemaGetter.transform(() => ({})),
    encode: SchemaGetter.transform(() => null),
  }),
);

/** The most repos one thread's workspace may hold. */
export const MAX_SPAWN_CHECKOUTS = 32;

/** Refuses ambiguous revision choices and names Git cannot use as branches. */
export const refuseInvalidCheckoutRevision = Schema.makeFilter(
  (checkout: { readonly baseBranch?: string; readonly startingRevision?: StartingRevision }) => {
    if (checkout.baseBranch !== undefined && checkout.startingRevision !== undefined)
      return "Choose startingRevision or the deprecated baseBranch, never both.";
    const revision = checkout.startingRevision;
    if (revision !== undefined && revision.kind !== "current" && revision.branch !== undefined)
      return Schema.is(Branch)(revision.branch)
        ? undefined
        : "startingRevision.branch must be a valid Git branch name.";
    return undefined;
  },
);

/** One repo a fresh workspace gets a worktree of, and where that worktree starts. */
export const SpawnCheckout = Schema.Struct({
  resourceId: Id,
  /** Deprecated remote-branch choice; use startingRevision for explicit local or remote state. */
  baseBranch: Schema.optionalKey(Branch),
  startingRevision: Schema.optionalKey(StartingRevision),
}).check(refuseInvalidCheckoutRevision);

export type SpawnCheckout = Schema.Schema.Type<typeof SpawnCheckout>;

/** A repo's main workspace. */
export const PrimarySpawnWorkspace = Schema.Struct({
  kind: Schema.Literal("primary"),
  resourceId: Id,
  /** An Agent or workflow branch policy. Threads omit this field to preserve the shared checkout. */
  branch: Schema.optionalKey(Branch),
});

/** A new workspace with a worktree for each repo in `checkouts`. */
export const EphemeralSpawnWorkspace = Schema.Struct({
  kind: Schema.Literal("ephemeral"),
  /** An empty list makes a scratch workspace: a directory with no checkout at all. */
  checkouts: atMost(SpawnCheckout, MAX_SPAWN_CHECKOUTS),
});

/**
 * The workspace a thread opens in: the repo's main workspace, a fresh worktree
 * of its own, or one that already exists. A workspace is a kind and a list of
 * checkouts; every git detail is on a checkout. Without a workspace, the
 * thread has no checkout at all.
 */
export const SpawnWorkspace = Schema.Union([
  PrimarySpawnWorkspace,
  EphemeralSpawnWorkspace,
  Schema.Struct({ kind: Schema.Literal("existing"), workspaceId: Id }),
]);

export type SpawnWorkspace = Schema.Schema.Type<typeof SpawnWorkspace>;

/**
 * The payload of `session.spawn`. A spawn with an `agentId` takes its settings
 * from that Agent. A spawn with no `agentId` is a Thread, and takes the user's
 * `thread.*` settings instead. Either way, a value given here overrides the
 * Agent or the setting, for this session only.
 */
export const SessionSpawnInput = closedStruct({
  prompt: PromptText,
  /** Ids from `attachment.create`; the prompt's images. */
  attachments: PromptAttachments,
  /**
   * The Agent to spawn from. Its fields take the place of the `thread.*`
   * settings, with the same precedence. `instanceId` and `permissionProfileId`
   * are rejected with it, because the Agent sets both.
   */
  agentId: Schema.optionalKey(Id),
  /** What every turn of this session must return. A schema outside the subset all harnesses support is rejected. */
  outputSchema: Schema.optionalKey(OutputSchema),
  instanceId: Schema.optionalKey(Id),
  model: Schema.optionalKey(Schema.NonEmptyString),
  /** The per-model choices this session opens with; a choice the model does not offer is rejected. */
  options: Schema.optionalKey(ModelSelection.fields.options),
  accessMode: Schema.optionalKey(AccessMode),
  /** Chooses a runner directly, a reserved one included; placement is skipped. */
  runnerId: Schema.optionalKey(Id),
  /** The Permission Profile the session's token carries, in place of the thread default. */
  permissionProfileId: Schema.optionalKey(Id),
  /** The project the thread belongs to; every resource in `workspace` must be in it. */
  projectId: Schema.optionalKey(Id),
  /** Where the session works; when absent, the thread has no checkout. */
  workspace: Schema.optionalKey(SpawnWorkspace),
}).check(refuseEmptyPrompt);

export type SessionSpawnInput = Schema.Schema.Type<typeof SessionSpawnInput>;

/**
 * What a session runs under from now on: the model and options a caller chose
 * since its last call.
 *
 * - `options` is merged into the options the session already runs with,
 *   because a submission carries only what the user changed;
 * - a call whose `model` differs from the stored one starts from `{}`, because
 *   the choices belong to the model that offered them;
 * - a call with neither field changes nothing.
 */
export const SESSION_SELECTION_FIELDS = {
  model: Schema.optionalKey(Schema.NonEmptyString),
  options: Schema.optionalKey(ModelSelection.fields.options),
} as const;

export const SessionSelection = Schema.Struct(SESSION_SELECTION_FIELDS);

export type SessionSelection = Schema.Schema.Type<typeof SessionSelection>;

/**
 * One turn's input: the text, the images, and the model and options sent with
 * it. Declared separately from the payload, so a service can spread these
 * fields next to the session id and apply the same bounds to an in-process
 * caller. A struct built from these fields needs `refuseEmptyPrompt` too.
 */
export const SESSION_INPUT_FIELDS = {
  text: PromptText,
  /** Ids from `attachment.create`; the input's images. */
  attachments: PromptAttachments,
  ...SESSION_SELECTION_FIELDS,
} as const;

export const SESSION_UPDATE_FIELDS = SESSION_SELECTION_FIELDS;

export const SessionUpdateInput = closedStruct(SESSION_UPDATE_FIELDS);

export type SessionUpdateInput = Schema.Schema.Type<typeof SessionUpdateInput>;

/**
 * The body of `session.input`: one turn's input, and whether to steer it.
 *
 * `steer` is only on this payload, not in `SESSION_INPUT_FIELDS`, because two
 * other callers only ever queue: a notification's answer that runs
 * `session.input` when the user picks it, and an in-process caller.
 *
 * With `steer: true`, a busy session gets the input in its running turn, as
 * `input.steer` would do for a queued input. A session in any other status
 * takes the input as if the flag were absent, because the sender cannot know
 * the status at the moment its call lands. Queueing stays the default.
 */
export const SessionInputPayload = closedStruct({
  ...SESSION_INPUT_FIELDS,
  steer: Schema.optionalKey(Schema.Boolean),
}).check(refuseEmptyPrompt);

export type SessionInputPayload = Schema.Schema.Type<typeof SessionInputPayload>;

/**
 * One call of `session.input` as a single object: the session's id, which an
 * HTTP request sends in its path, and the text. A bound answer sends this
 * shape, so taking the answer queues the text as the session's next input.
 */
export const SessionInputCall = closedStruct({ sessionId: Id, ...SESSION_INPUT_FIELDS }).check(
  refuseEmptyPrompt,
);

export type SessionInputCall = Schema.Schema.Type<typeof SessionInputCall>;

/**
 * What happened to one input. `inputId` is the id of the row it was stored as,
 * which a caller can edit or cancel while it is still `queued`.
 *
 * Adding input to a turn that is already running is steering, which is why it
 * needs the `session.steer` grant. `opened` and `steered` are the runner's own
 * words for what it did with the input. `queued` is the controller's word for
 * an input the session cannot take yet, including the input that resumes an
 * exited session, and a steer on a provider that does not steer natively: the
 * running turn is interrupted, and the input is sent as the next turn.
 */
export const SessionInputOutcome = Schema.Struct({
  inputId: Id,
  result: Schema.Literals(["opened", "steered", "queued"]),
});

export type SessionInputOutcome = Schema.Schema.Type<typeof SessionInputOutcome>;

/**
 * The longest the controller takes to answer `session.input` or `input.steer`:
 * its wait for the runner's report, plus the time the runner may spend
 * downloading the input's images first. A client sets its own request time
 * limit above this, so it never gives up on a request the controller is still
 * working on.
 */
export const MAX_INPUT_ANSWER_WAIT: Duration.Duration = Duration.sum(
  SESSION_INPUT_DEADLINE,
  ATTACHMENT_DOWNLOAD_TIMEOUT,
);

/**
 * The decision on an approval one of a session's agents is parked on.
 * `requestId` is that Request's own id, so a decision that arrives after the
 * harness moved on is rejected rather than applied to another open Request.
 */
export const SESSION_RESPOND_TO_APPROVAL_REQUEST_FIELDS = {
  requestId: Fact,
  decision: ApprovalDecision,
} as const;

export const SessionRespondToApprovalRequestInput = closedStruct(
  SESSION_RESPOND_TO_APPROVAL_REQUEST_FIELDS,
);

export type SessionRespondToApprovalRequestInput = Schema.Schema.Type<
  typeof SessionRespondToApprovalRequestInput
>;

/**
 * One call of `session.respondToApprovalRequest` as a single object: the
 * session's id, which an HTTP request sends in its path, and the decision.
 * The core binds it to the answers of the `core.approval` decision it raises
 * for each approval.
 */
export const SessionRespondToApprovalRequestCall = closedStruct({
  sessionId: Id,
  ...SESSION_RESPOND_TO_APPROVAL_REQUEST_FIELDS,
});

export type SessionRespondToApprovalRequestCall = Schema.Schema.Type<
  typeof SessionRespondToApprovalRequestCall
>;

/**
 * The answers to the questions one of a session's agents is parked on, keyed
 * by each question's header. `requestId` is that Request's own id, for the
 * same reason as a decision's.
 */
export const SESSION_RESPOND_TO_QUESTION_FIELDS = {
  requestId: Fact,
  answers: QuestionAnswers,
} as const;

export const SessionRespondToQuestionInput = closedStruct(SESSION_RESPOND_TO_QUESTION_FIELDS);

export type SessionRespondToQuestionInput = Schema.Schema.Type<
  typeof SessionRespondToQuestionInput
>;

/**
 * Branching a session: `fork` opens a second provider-native session from the
 * one the parent left behind, and leaves the parent's own history untouched.
 * It runs on the parent's runner and provider instance, because that is where
 * the native state is. Continuing the parent itself is not done here: an
 * exited session that still has its transcript is resumed in place by its next
 * input.
 */
export const SESSION_CONTINUE_FIELDS = {
  mode: Schema.Literal("fork"),
  prompt: PromptText,
  /** Ids from `attachment.create`; the prompt's images. */
  attachments: PromptAttachments,
} as const;

export const SessionContinueInput = closedStruct(SESSION_CONTINUE_FIELDS).check(refuseEmptyPrompt);

export type SessionContinueInput = Schema.Schema.Type<typeof SessionContinueInput>;

/**
 * One status, or several. The runner page's "how full is this machine" view
 * needs `starting | idle | busy` in one read; every other caller asks for one.
 * The query string carries several as repeated `status` keys.
 */
export const SessionStatusFilter = Schema.Union([
  SessionStatus,
  Schema.NonEmptyArray(SessionStatus),
]);

export const SessionFilter = Schema.Struct({
  status: Schema.optionalKey(SessionStatusFilter),
  runnerId: Schema.optionalKey(Id),
  /** Only the sessions spawned from this Agent. */
  agentId: Schema.optionalKey(Id),
  /** Only the sessions carrying this Permission Profile, whichever Agent spawned them. */
  permissionProfileId: Schema.optionalKey(Id),
  /** Only the sessions of this conversation. */
  conversationId: Schema.optionalKey(Id),
  /** Only the sessions this run's agent steps started. */
  runId: Schema.optionalKey(Id),
  /** `true` lists the sessions with no Agent behind them; `false` lists the rest. */
  thread: Schema.optionalKey(Schema.Boolean),
});

export const SESSION_SORT_FIELDS = ["createdAt"] as const;

export const session = HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.get("query", "/sessions", {
      query: Schema.Struct({
        ...SessionFilter.fields,
        ...pageParams(SESSION_SORT_FIELDS).fields,
      }),
      success: page(Session),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/sessions/:id", {
      params: { id: Id },
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.get("querySubagents", "/sessions/:id/subagents", {
      params: { id: Id },
      query: pageParams(SUBAGENT_SORT_FIELDS),
      success: page(Subagent),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("spawn", "/sessions", {
      payload: SessionSpawnInput,
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.patch("update", "/sessions/:id", {
      params: { id: Id },
      payload: SessionUpdateInput,
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("input", "/sessions/:id/input", {
      params: { id: Id },
      payload: SessionInputPayload,
      success: SessionInputOutcome,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("interrupt", "/sessions/:id/interrupt", {
      params: { id: Id },
      payload: [SessionInterruptInput, SessionInterruptWithoutBody],
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("respondToApprovalRequest", "/sessions/:id/respond-to-approval-request", {
      params: { id: Id },
      payload: SessionRespondToApprovalRequestInput,
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("respondToQuestion", "/sessions/:id/respond-to-question", {
      params: { id: Id },
      payload: SessionRespondToQuestionInput,
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("stop", "/sessions/:id/stop", {
      params: { id: Id },
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("continue", "/sessions/:id/continue", {
      params: { id: Id },
      payload: SessionContinueInput,
      success: Session,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
