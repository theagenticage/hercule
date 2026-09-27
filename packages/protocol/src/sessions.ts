/**
 * Sessions on the wire: what the controller sends, what the runner reports
 * back, and the normalized vocabulary every provider's traffic is converted to
 * before it leaves the machine it ran on (spec 06 sections 4 and 6).
 *
 * The runner normalizes, so this file is the whole contract for anything that
 * reads a session. An `unknown` item kind and a `raw` passthrough keep a vendor
 * message nobody mapped, rather than dropping it.
 */
import { Schema } from "effect";

import { OutputSchema } from "./output-schema";
import {
  Fact,
  InstanceId,
  InstanceSecrets,
  MAX_FACT_LENGTH,
  Sequenced,
  SessionId,
} from "./primitives";

/**
 * How much a session may do without asking first (spec 06 section 2). It is
 * part of `SessionSpec`, so the protocol owns it and the plugin host
 * re-exports it rather than declaring a second one.
 */
export const AccessMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

export type AccessMode = Schema.Schema.Type<typeof AccessMode>;

/**
 * The longest piece of free text a harness may put in an event. A `Fact` is too
 * short: an error body or a stack trace over 512 bytes would make the frame
 * undecodable, which would cost the runner its socket and every session on it.
 */
export const MAX_MESSAGE_LENGTH = 4096;

const Message = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH));

/**
 * A duration on the wire, in milliseconds. The controller converts
 * whole-minute settings to milliseconds, so the runner never needs to know the
 * unit they were set in, and a test can use a value much shorter than a
 * minute.
 */
const PositiveMillis = Schema.Int.check(Schema.isGreaterThan(0));

/** The model and the per-model choices a turn runs with (spec 06 section 4). */
export const ModelSelection = Schema.Struct({
  model: Fact,
  options: Schema.Record(Fact, Schema.Union([Schema.String, Schema.Boolean])),
});

export type ModelSelection = Schema.Schema.Type<typeof ModelSelection>;

/**
 * A family of harness tools a session may have taken away from it. This is
 * Hercule's own vocabulary, and it is coarse on purpose. Each adapter maps a
 * family onto the names its harness gives those tools. A harness that cannot
 * take a family away declares that, and does not pretend to enforce it.
 */
const TOOL_FAMILIES = ["edit", "write", "shell", "web-search", "web-fetch"] as const;

export type DisallowedTool = (typeof TOOL_FAMILIES)[number];

const isDisallowedTool = (value: string): value is DisallowedTool =>
  (TOOL_FAMILIES as ReadonlyArray<string>).includes(value);

/**
 * One tool family. A union of five literals fails with "expected one of five",
 * and a caller that sent several entries must then guess which entry was
 * wrong. This check includes the rejected word in its error message.
 */
export const DisallowedTool = Schema.String.check(
  Schema.makeFilter<string>(
    (value) =>
      isDisallowedTool(value)
        ? undefined
        : `${value} is not a tool family; the families are ${TOOL_FAMILIES.join(", ")}`,
    undefined,
    // Without this, the type guard below would add a second issue about the
    // same entry, with no message.
    true,
  ),
).pipe(Schema.refine(isDisallowedTool));

/**
 * What the controller sends for one session: ids, never paths (ADR 0002). The
 * runner resolves it to a `ProviderRunnerContext` on its own machine.
 *
 * The row that stores this keeps it byte for byte, so a field is added here
 * only when something sends it. The rest of spec 06 section 4 - `mcpServers` -
 * arrives with the feature that needs it.
 */
export const SessionSpec = Schema.Struct({
  instanceId: InstanceId,
  /** `null` for a session without a workspace: the runner gives it a scratch working directory. */
  workspaceId: Schema.NullOr(Fact),
  modelSelection: ModelSelection,
  /** The mode after the access-mode fallback: always one the target provider declares native. */
  accessMode: AccessMode,
  /**
   * Appended to the harness's own system prompt, never in place of it. A
   * session with no Agent behind it carries no prompt here.
   */
  systemPrompt: Schema.optionalKey(Schema.String),
  /**
   * The tool families to take away. A provider that declares it enforces none
   * of them still receives the list, and the record the caller reads reports
   * that the provider ignores the field.
   */
  disallowedTools: Schema.optionalKey(Schema.Array(DisallowedTool)),
  /**
   * What the session's turns must return, as a JSON Schema within the subset
   * `lintOutputSchema` accepts. Without a schema, turns return prose.
   */
  outputSchema: Schema.optionalKey(OutputSchema),
  /**
   * The provider-native session this one continues from, on the same runner
   * and the same instance (spec 06 section 4.1). A resume continues that
   * native session; a fork branches off it, leaving the original untouched.
   */
  continue: Schema.optionalKey(
    Schema.Struct({ nativeSessionId: Fact, mode: Schema.Literals(["resume", "fork"]) }),
  ),
  /**
   * The time limits the runner supervisor enforces on this session (spec 03
   * section 6.2). The two limits are required: a spec without them is a
   * controller bug, and the runner has no default of its own to fall back on.
   *
   * `idleMs` is optional. With it, the supervisor stops a session that has
   * sat between turns that long, with the exit reason `idle_unload`, which
   * leaves the native session behind so a later start can resume it. Without
   * it, a session is never unloaded for being idle.
   */
  timeouts: Schema.Struct({
    inactivityMs: PositiveMillis,
    absoluteMs: PositiveMillis,
    idleMs: Schema.optionalKey(PositiveMillis),
  }),
});

export type SessionSpec = Schema.Schema.Type<typeof SessionSpec>;

/**
 * The explicit join between a Hercule session and the provider-native object
 * behind it. The two ids are separate concepts and nothing else joins them.
 */
export const SessionBinding = Schema.Struct({
  sessionId: SessionId,
  nativeSessionId: Fact,
  instanceId: InstanceId,
});

export type SessionBinding = Schema.Schema.Type<typeof SessionBinding>;

/**
 * One turn's input. Attachments are an open item in spec 16 section B.
 * `modelSelection` is the session's current model, sent on every frame. A
 * harness accepts a model change only on the input that starts a turn, so an
 * adapter applies it there and ignores it the rest of the time.
 */
export const TurnInput = Schema.Struct({
  text: Schema.String,
  modelSelection: Schema.optionalKey(ModelSelection),
});

export type TurnInput = Schema.Schema.Type<typeof TurnInput>;

/** Whether an input opened a turn of its own or steered one already running. */
export const Delivery = Schema.Literals(["opened", "steered"]);

export type Delivery = Schema.Schema.Type<typeof Delivery>;

/**
 * What the adapter reports an input did. This is the only reliable source:
 * inferring it from the order events arrive in is ruled out by ADR 0007.
 */
export const SendResult = Schema.Struct({ turnId: Fact, delivery: Delivery });

export type SendResult = Schema.Schema.Type<typeof SendResult>;

/**
 * Why a session ended (spec 06 section 4.1). The session view reads it: only
 * `idle_unload` and `runner_restart` leave native state behind.
 */
export const ExitReason = Schema.Literals([
  "stopped",
  "process_exit",
  "idle_unload",
  "runner_restart",
  "crash",
  "inactivity_timeout",
  "absolute_timeout",
  /** The workspace the session was waiting for could not be made. */
  "workspace_failed",
]);

export type ExitReason = Schema.Schema.Type<typeof ExitReason>;

/** How a turn ended. A turn ends by stopping, never by a single reply. */
export const TurnState = Schema.Literals(["completed", "failed", "interrupted"]);

export type TurnState = Schema.Schema.Type<typeof TurnState>;

/** What an item is, in the one vocabulary every harness is mapped into. */
export const ItemKind = Schema.Literals([
  "user_message",
  "assistant_message",
  "reasoning",
  "command_execution",
  "file_change",
  "tool_call",
  "web_search",
  "subagent",
  "plan",
  "context_compaction",
  "error",
  /** The forward-compatible catch-all: an unmapped vendor item, with its raw. */
  "unknown",
]);

export type ItemKind = Schema.Schema.Type<typeof ItemKind>;

export const ItemStatus = Schema.Literals(["completed", "failed", "declined"]);

export type ItemStatus = Schema.Schema.Type<typeof ItemStatus>;

/**
 * The four answers a parked session can be given. `allow_always` keeps a rule
 * for the rest of the session; `cancel` denies the request and ends the turn.
 */
export const ApprovalDecision = Schema.Literals(["allow", "allow_always", "deny", "cancel"]);

export type ApprovalDecision = Schema.Schema.Type<typeof ApprovalDecision>;

/**
 * The answers this request accepts. When a request cannot keep a rule, or an
 * allow would have nothing to apply to, this list leaves those answers out.
 * Otherwise a surface could offer an answer the harness would silently
 * replace with another.
 */
const Decisions = Schema.NonEmptyArray(ApprovalDecision);

/**
 * One question a harness parked a session on, and the answers it accepts.
 *
 * `detail` is a closed struct per `kind` rather than free Json: the surfaces
 * render the card from it, and a vendor-shaped payload there would make what
 * the user sees depend on which harness asked (ADR 0007).
 */
const defineOpenRequest = <const K extends string, F extends Schema.Struct.Fields>(
  kind: K,
  detail: F,
) =>
  Schema.Struct({
    requestId: Fact,
    /** The item the request is about, so a surface can overlay it in place. */
    itemId: Fact,
    kind: Schema.Literal(kind),
    decisions: Decisions,
    detail: Schema.Struct(detail),
  });

/** A rename has two paths and a multi-file edit more, so this is a list. */
const Paths = Schema.Array(Fact);

const CommandApproval = defineOpenRequest("command_approval", { command: Message });

const FileChangeApproval = defineOpenRequest("file_change_approval", { paths: Paths });

const FileReadApproval = defineOpenRequest("file_read_approval", { paths: Paths });

const ToolApproval = defineOpenRequest("tool_approval", { toolName: Fact });

/**
 * One question in a `question` request: the chip it is labelled with, the
 * prose the agent wrote, and the options it offers. A permission request and a
 * question are different things sharing one request slot, so the question
 * keeps its own structure rather than being flattened to text: a surface that
 * reads only the text cannot show what the answers were.
 *
 * The struct is closed, like every detail here: a vendor's extra field (the
 * Claude SDK's `preview`) would make what the user sees depend on which
 * harness asked (ADR 0007). Every provider maps its own shape into this one.
 */
const Question = Schema.Struct({
  question: Message,
  header: Fact,
  options: Schema.Array(Schema.Struct({ label: Fact, description: Message })),
  /** Whether more than one option may be chosen, once answering is built. */
  multiSelect: Schema.Boolean,
});

/** A harness asks one to four questions at a time, so the request holds a list. */
const QuestionRequest = defineOpenRequest("question", {
  questions: Schema.NonEmptyArray(Question),
});

/**
 * The request a session is parked on, as the database row and the API hold it.
 * `request.opened` carries the same five shapes.
 */
export const OpenRequest = Schema.Union([
  CommandApproval,
  FileChangeApproval,
  FileReadApproval,
  ToolApproval,
  QuestionRequest,
]);

export type OpenRequest = Schema.Schema.Type<typeof OpenRequest>;

/**
 * The three append-only text streams. When a vendor sends raw and summarized
 * reasoning separately, the adapter picks one, preferring raw, and keeps the
 * other only in `raw` (spec 06 section 6.4).
 */
export const StreamKind = Schema.Literals(["assistant_text", "reasoning_text", "command_output"]);

export type StreamKind = Schema.Schema.Type<typeof StreamKind>;

const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Money = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * A cumulative token snapshot for the session, not a per-turn delta: harnesses
 * report at different intervals, and a snapshot works for all of them. The
 * optional fields are the ones only some harnesses report (spec 06 section
 * 6.6).
 */
export const Usage = Schema.Struct({
  inputTokens: Tokens,
  outputTokens: Tokens,
  cacheReadTokens: Schema.optionalKey(Tokens),
  cacheWriteTokens: Schema.optionalKey(Tokens),
  costUsd: Schema.optionalKey(Money),
});

export type Usage = Schema.Schema.Type<typeof Usage>;

/**
 * The fields every normalized event has. `turnId` and `itemId` are declared
 * per event instead, so an event about a turn or an item requires its id and
 * the other events have no field for one.
 */
const base = {
  eventId: Fact,
  sessionId: Fact,
  /** An ISO-8601 timestamp, from the runner's own clock. */
  at: Fact,
  /** Native ids: thread id, vendor item id, tool_use id. */
  providerRefs: Schema.optionalKey(
    Schema.Record(Fact, Schema.String.check(Schema.isMaxLength(MAX_FACT_LENGTH))),
  ),
  raw: Schema.optionalKey(Schema.Struct({ source: Fact, payload: Schema.Json })),
};

const defineEvent = <const Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) => Schema.Struct({ _tag: Schema.Literal(tag), ...base, ...fields });

const SessionStarted = defineEvent("session.started", {});

/**
 * `message` explains the exit when the reason alone does not: for a workspace
 * that could not be made, it holds the machine's own error message.
 */
const SessionExited = defineEvent("session.exited", {
  reason: ExitReason,
  message: Schema.optionalKey(Message),
});

/**
 * What a turn returned under the session's output schema (spec 06 section 7).
 * It has one shape for every harness. The runner validates whatever its
 * harness produced against the declared schema, so `ok` means the same thing
 * on every provider, and a failure gives its reason in the same words.
 */
export const StructuredResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("ok"), value: Schema.Json }),
  Schema.Struct({ outcome: Schema.Literal("schema-failure"), reason: Message }),
]);

export type StructuredResult = Schema.Schema.Type<typeof StructuredResult>;

/**
 * The controller must be able to match a turn's completion with its start, so
 * the turn id is required on both.
 */
const TurnStarted = defineEvent("turn.started", { turnId: Fact, model: Schema.optionalKey(Fact) });

const TurnCompleted = defineEvent("turn.completed", {
  turnId: Fact,
  state: TurnState,
  usage: Schema.optionalKey(Usage),
  /** This turn's cost, where the harness prices a turn; `usage` is cumulative. */
  costUsd: Schema.optionalKey(Money),
  error: Schema.optionalKey(Message),
  /**
   * How the turn's result matched the session's output schema. It is absent
   * on a session that was given no schema, and on a turn that ended for
   * another reason. An ordinary failure is reported by `state`, not as a
   * schema result.
   */
  structuredResult: Schema.optionalKey(StructuredResult),
});

/**
 * `detail` stays Json: each adapter decides its shape per kind, and fixing
 * twelve shapes here would limit what each harness can report in future.
 */
const itemFields = {
  /** Every item belongs to a turn; unsolicited output gets a synthetic one. */
  turnId: Fact,
  itemId: Fact,
  kind: ItemKind,
  detail: Schema.optionalKey(Schema.Json),
};

const ItemStarted = defineEvent("item.started", itemFields);

const ItemCompleted = defineEvent("item.completed", { ...itemFields, status: ItemStatus });

/** Append-only text for one (item, streamKind). Unbounded: cutting it loses output. */
const ContentDelta = defineEvent("content.delta", {
  turnId: Fact,
  itemId: Fact,
  streamKind: StreamKind,
  delta: Schema.String,
});

const SessionUsageUpdated = defineEvent("session.usage.updated", { usage: Usage });

/** Either may fire inside a turn or between turns, so the turn id is optional. */
const RuntimeWarning = defineEvent("runtime.warning", {
  turnId: Schema.optionalKey(Fact),
  message: Message,
});

/**
 * `class` is the only open vocabulary here. Adapters map into Codex's
 * `codexErrorInfo` enum as the reference set, with `unknown` for the rest. It
 * stays a string, so a class this build does not know still reaches the user.
 */
const RuntimeError = defineEvent("runtime.error", {
  turnId: Schema.optionalKey(Fact),
  class: Fact,
  message: Schema.optionalKey(Message),
});

/**
 * The session is parked: nothing more happens on this turn until a decision
 * arrives. The request is nested rather than spread across the event, so the
 * row and the API hold exactly what arrived, whatever fields the event
 * envelope gains later.
 */
const RequestOpened = defineEvent("request.opened", { request: OpenRequest });

/**
 * The session is no longer parked, whatever ended it: the user's answer, an
 * interrupted turn, or the harness withdrawing the question.
 */
const RequestResolved = defineEvent("request.resolved", {
  requestId: Fact,
  decision: ApprovalDecision,
});

export const ProviderEvent = Schema.Union([
  SessionStarted,
  SessionExited,
  TurnStarted,
  TurnCompleted,
  ItemStarted,
  ItemCompleted,
  ContentDelta,
  SessionUsageUpdated,
  RuntimeWarning,
  RuntimeError,
  RequestOpened,
  RequestResolved,
]);

export type ProviderEvent = Schema.Schema.Type<typeof ProviderEvent>;

/**
 * The longest a session token may be. Hercule creates 32 random bytes encoded
 * as base64url, which is 43 characters. The limit leaves room, so a change of
 * encoding does not need a protocol change, and it is far below a fact's
 * limit, because a credential is not free text.
 */
const MAX_TOKEN_LENGTH = 128;

/**
 * Who a commit is made as: the account of the Connection the work acts
 * through. A session start and a workspace step start both carry it, so the
 * machine sets the same identity whichever of them commits.
 */
export const GitIdentity = Schema.Struct({ name: Fact, email: Fact });

export type GitIdentity = Schema.Schema.Type<typeof GitIdentity>;

/**
 * Starts one session. It carries the instance's decoded config, as a probe
 * does, because the runner holds no Hercule state and cannot look it up.
 */
export const SessionStart = Schema.Struct({
  _tag: Schema.Literal("sessionStart"),
  sessionId: SessionId,
  providerId: Fact,
  config: Schema.Json,
  /** The instance's credentials, which its config never holds; `{}` when none. */
  secrets: InstanceSecrets,
  spec: SessionSpec,
  /**
   * The session's own credential for the public API, created for this start.
   * The runner puts it in the agent's environment and keeps it nowhere else:
   * this frame is the only place the plaintext is ever sent, and the
   * controller stores only its hash. An empty token would authenticate nobody,
   * so the schema rejects it rather than leaving the agent to find out. The
   * session also uses it to prove its identity when it asks this machine for a
   * git credential.
   */
  token: Schema.String.check(Schema.isLengthBetween(1, MAX_TOKEN_LENGTH)),
  /** `GH_TOKEN` for this session, when a GitHub Connection backs it. */
  ghToken: Schema.optionalKey(Fact),
  /**
   * Who the session commits as: the account its Connection belongs to. Absent
   * when no Connection backs it; the machine then leaves git's own identity
   * unchanged rather than inventing one.
   */
  gitIdentity: Schema.optionalKey(GitIdentity),
  /** The branch the session's checkout is switched to before the harness starts. */
  checkoutBranch: Schema.optionalKey(Fact),
});

export type SessionStart = Schema.Schema.Type<typeof SessionStart>;

export const SessionStop = Schema.Struct({
  _tag: Schema.Literal("sessionStop"),
  sessionId: SessionId,
});

export type SessionStop = Schema.Schema.Type<typeof SessionStop>;

export const SessionInput = Schema.Struct({
  _tag: Schema.Literal("sessionInput"),
  /** The id of the Queued Input row, which the reply is matched by. */
  requestId: Fact,
  sessionId: SessionId,
  input: TurnInput,
});

export type SessionInput = Schema.Schema.Type<typeof SessionInput>;

/**
 * Ends the running turn as `interrupted`. There is no reply frame: the outcome
 * arrives in the session's own stream as `turn.completed`, so a reply would
 * add nothing.
 */
export const SessionInterrupt = Schema.Struct({
  _tag: Schema.Literal("sessionInterrupt"),
  sessionId: SessionId,
});

export type SessionInterrupt = Schema.Schema.Type<typeof SessionInterrupt>;

/**
 * Answers the request the session is parked on. `requestId` is the adapter's
 * own id, sent back: the controller does not create ids for requests it did
 * not open. Like `SessionInterrupt`, there is no reply frame: the result
 * arrives in the session's own stream as `request.resolved`.
 */
export const SessionRespond = Schema.Struct({
  _tag: Schema.Literal("sessionRespond"),
  sessionId: SessionId,
  requestId: Fact,
  decision: ApprovalDecision,
});

export type SessionRespond = Schema.Schema.Type<typeof SessionRespond>;

/**
 * What happened to one input, with the row id it was sent with. It has no turn
 * id: the controller learns the turn from `turn.started`, and a field nothing
 * reads would sooner or later be wrong.
 */
export const SessionInputResult = Schema.Struct({
  _tag: Schema.Literal("sessionInputResult"),
  requestId: Fact,
  ok: Schema.Boolean,
  delivery: Schema.optionalKey(Delivery),
  /** Why it was not delivered, so the caller gets a reason rather than only a flag. */
  message: Schema.optionalKey(Message),
});

export type SessionInputResult = Schema.Schema.Type<typeof SessionInputResult>;

/** One normalized event, with the sequence number the controller uses to store it exactly once. */
export const SessionEvent = Schema.Struct({
  _tag: Schema.Literal("sessionEvent"),
  ...Sequenced.fields,
  event: ProviderEvent,
});

export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>;

/**
 * The most sessions one runner will ever report. The per-runner cap of spec 03
 * section 5.3 is well under it, so this only rejects a nonsense report.
 */
export const MAX_SESSIONS_PER_RUNNER = 256;

/** The sessions the runner's adapters actually hold, as `listSessions` found them. */
export const SessionsReport = Schema.Struct({
  _tag: Schema.Literal("sessionsReport"),
  sessions: Schema.Array(SessionBinding).check(Schema.isMaxLength(MAX_SESSIONS_PER_RUNNER)),
});

export type SessionsReport = Schema.Schema.Type<typeof SessionsReport>;
