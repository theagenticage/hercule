/**
 * Sessions on the wire: what the controller authors, what the runner reports
 * back, and the one normalized vocabulary every provider's traffic is turned
 * into before it leaves the machine it ran on (spec 06 sections 4 and 6).
 *
 * Normalization happens at the runner, so this file is the whole contract a
 * consumer of a session reads. An `unknown` item kind and a `raw` passthrough
 * carry a vendor message nobody mapped rather than dropping it.
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
 * How much of a session a caller may act on without being asked (spec 06
 * section 2). It rides `SessionSpec`, so the protocol owns it and the plugin
 * host re-exports it rather than declaring a second one.
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
 * short: an error body or a stack trace over 512 bytes would be an undecodable
 * frame, which costs the runner its socket and every session on it.
 */
export const MAX_MESSAGE_LENGTH = 4096;

const Message = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH));

/**
 * A duration on the wire, in milliseconds: the controller turns whole-minute
 * settings into this so the runner never has to know the unit they were
 * authored in, and a test can pick a value a wall clock could not sit through.
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
 * One family, refused by name. A union of five literals answers "expected one
 * of five", and a caller that sent several entries must then guess which entry
 * the refusal was about. This check names the word it did not accept.
 */
export const DisallowedTool = Schema.String.check(
  Schema.makeFilter<string>(
    (value) =>
      isDisallowedTool(value)
        ? undefined
        : `${value} is not a tool family; the families are ${TOOL_FAMILIES.join(", ")}`,
    undefined,
    // Without this, the type guard below would add a second issue about the
    // same entry, and that issue carries no words.
    true,
  ),
).pipe(Schema.refine(isDisallowedTool));

/**
 * What the controller authors for one session: ids, never paths (ADR 0002).
 * The runner resolves it to a `ProviderRunnerContext` on its own machine.
 *
 * The row that stores this keeps it byte for byte, so a field is added here
 * only when something sends it. The rest of spec 06 section 4 - `mcpServers` -
 * arrives with the feature that needs it.
 */
export const SessionSpec = Schema.Struct({
  instanceId: InstanceId,
  /** `null` is a workspace-less session: the runner gives it a scratch cwd. */
  workspaceId: Schema.NullOr(Fact),
  modelSelection: ModelSelection,
  /** Post-fallback: always a mode the target provider declares native. */
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
   * What the session's turns must answer with, as a JSON Schema inside the
   * subset `lintOutputSchema` accepts. An absent schema means prose.
   */
  outputSchema: Schema.optionalKey(OutputSchema),
  /**
   * Picks the provider-native session this one carries on from, on the same
   * runner and the same instance (spec 06 section 4.1). A resume continues that
   * native session; a fork branches off it, leaving the original untouched.
   */
  continue: Schema.optionalKey(
    Schema.Struct({ nativeSessionId: Fact, mode: Schema.Literals(["resume", "fork"]) }),
  ),
  /**
   * The two clocks the runner supervisor holds this session to (spec 03
   * section 6.2). Required: a spec without it is a controller bug, not a
   * runner choice, and the runner holds no default of its own to fall back on.
   */
  timeouts: Schema.Struct({
    inactivityMs: PositiveMillis,
    absoluteMs: PositiveMillis,
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
 * One turn's input. Attachments are the open item in spec 16 section B.
 * `modelSelection` is the session's current model, on every frame; a harness
 * takes a model change only on the input that opens a turn, so an adapter
 * applies it there and leaves it alone the rest of the time.
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
 * What the adapter says an input did. The only authority on it: reading it off
 * the order events arrive in is the inference ADR 0007 rules out.
 */
export const SendResult = Schema.Struct({ turnId: Fact, delivery: Delivery });

export type SendResult = Schema.Schema.Type<typeof SendResult>;

/**
 * Why a session is gone (spec 06 section 4.1). Pinned because the session view
 * reads it: only `idle_unload` and `runner_restart` leave native state behind.
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
 * The four answers a parked session can be given. `allow_always` persists a
 * rule for the rest of the session, `cancel` denies and ends the turn with it.
 */
export const ApprovalDecision = Schema.Literals(["allow", "allow_always", "deny", "cancel"]);

export type ApprovalDecision = Schema.Schema.Type<typeof ApprovalDecision>;

/**
 * Which answers this request takes. A request that may persist no rule, or that
 * has nothing for an allow to carry, says so here rather than leaving a surface
 * to offer an answer the harness would have to substitute for silently.
 */
const Decisions = Schema.NonEmptyArray(ApprovalDecision);

/**
 * One question a harness parked a session on, and the answers it accepts.
 *
 * `detail` is a closed struct per `kind` rather than free Json: the surfaces
 * render the card from it, and a vendor-shaped payload there would make what
 * the user reads a function of which harness answered (ADR 0007).
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

/** A rename carries two paths, a multi-file edit more, so it is a list. */
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
 * The struct is closed, as every detail here is - a vendor's extra field (the
 * Claude SDK's `preview`) would make what the user reads a function of which
 * harness asked (ADR 0007). Every provider maps its own shape into this one.
 */
const Question = Schema.Struct({
  question: Message,
  header: Fact,
  options: Schema.Array(Schema.Struct({ label: Fact, description: Message })),
  /** Whether more than one option may be chosen, once answering is built. */
  multiSelect: Schema.Boolean,
});

/** A harness asks one to four at a time, so the request carries a list. */
const QuestionRequest = defineOpenRequest("question", {
  questions: Schema.NonEmptyArray(Question),
});

/**
 * The request a session is parked on, as the row that holds it and the API
 * that hands it out read it. The same five shapes ride `request.opened`.
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
 * The three append-only text streams. Where a vendor sends raw and summarized
 * reasoning separately the adapter picks one, raw preferred, and the other
 * stays raw-only (spec 06 section 6.4).
 */
export const StreamKind = Schema.Literals(["assistant_text", "reasoning_text", "command_output"]);

export type StreamKind = Schema.Schema.Type<typeof StreamKind>;

const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Money = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * A cumulative token snapshot for the session, not a per-turn delta: cadence
 * differs per harness and the snapshot shape absorbs that. The optional fields
 * are the ones only some harnesses report (spec 06 section 6.6).
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
 * The fields every normalized event carries identically. `turnId` and `itemId`
 * are declared per member instead, so an event about a turn or an item requires
 * its id and the rest have no place to put one.
 */
const base = {
  eventId: Fact,
  sessionId: Fact,
  /** An ISO-8601 instant, as the runner read its own clock. */
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
 * `message` carries what the exit was, where the reason alone does not say it:
 * a workspace that could not be made says why in the machine's own words.
 */
const SessionExited = defineEvent("session.exited", {
  reason: ExitReason,
  message: Schema.optionalKey(Message),
});

/**
 * What a turn answered under the session's output schema (spec 06 section 7).
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
 * A completion the controller cannot bracket against its start is not a turn
 * boundary, so the id is required on both.
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
   * How the turn answered the session's output schema. It is absent on a
   * session that was given no schema, and on a turn that ended for a reason of
   * its own. An ordinary failure is reported by `state`, and not as a verdict
   * about a schema.
   */
  structuredResult: Schema.optionalKey(StructuredResult),
});

/**
 * `detail` stays Json: its shape is the adapter's to decide per kind, and
 * pinning twelve shapes here would freeze what each harness may yet report.
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
 * `class` is the one open vocabulary here. Codex's `codexErrorInfo` enum is the
 * reference set adapters map into, with `unknown` for the rest; it stays a
 * string so a class this build has not heard of still reaches the user.
 */
const RuntimeError = defineEvent("runtime.error", {
  turnId: Schema.optionalKey(Fact),
  class: Fact,
  message: Schema.optionalKey(Message),
});

/**
 * The session is parked: nothing more happens on this turn until a decision
 * arrives. The request is nested rather than spread across the event, so what
 * the row and the API hold is exactly what arrived, whatever the envelope
 * around it grows to carry.
 */
const RequestOpened = defineEvent("request.opened", { request: OpenRequest });

/**
 * The park is over, whoever ended it: the user's answer, the turn being
 * interrupted, or the harness withdrawing the question.
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
 * The longest a session token may be. Hercule mints 32 random bytes rendered
 * base64url, which is 43 characters; the bound is a multiple of that so a
 * change of encoding does not need a protocol change, and it is far below a
 * fact's, because a credential is not free text.
 */
const MAX_TOKEN_LENGTH = 128;

/**
 * Start one session. It carries the instance's decoded config the way a probe
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
   * The session's own credential on the public API, minted for this start. The
   * runner injects it into the agent's environment and keeps it nowhere else:
   * this frame is the only place its plaintext ever travels, and the controller
   * holds nothing but its hash. An empty one would authenticate nobody, so the
   * wire refuses it rather than leaving the agent to find out. It is also what
   * the session proves itself with when it asks this machine for a git
   * credential.
   */
  token: Schema.String.check(Schema.isLengthBetween(1, MAX_TOKEN_LENGTH)),
  /** `GH_TOKEN` for this session, where a GitHub Connection backs it. */
  ghToken: Schema.optionalKey(Fact),
  /**
   * Who the session commits as: the account its Connection belongs to. Absent
   * where no Connection backs it, and the machine then leaves git's own
   * identity alone rather than inventing one.
   */
  gitIdentity: Schema.optionalKey(Schema.Struct({ name: Fact, email: Fact })),
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
  /** The Queued Input row this is, which is what the answer is correlated by. */
  requestId: Fact,
  sessionId: SessionId,
  input: TurnInput,
});

export type SessionInput = Schema.Schema.Type<typeof SessionInput>;

/**
 * Ends the running turn as `interrupted`. Fire-and-forget: the outcome arrives
 * in the session's own stream as `turn.completed`, so a second answer channel
 * would carry nothing.
 */
export const SessionInterrupt = Schema.Struct({
  _tag: Schema.Literal("sessionInterrupt"),
  sessionId: SessionId,
});

export type SessionInterrupt = Schema.Schema.Type<typeof SessionInterrupt>;

/**
 * Answers the request the session is parked on. `requestId` is the adapter's
 * own, echoed back: the controller mints none of its own for a park it did not
 * open. Fire-and-forget in the shape above - what the answer did arrives in the
 * session's own stream as `request.resolved`.
 */
export const SessionRespond = Schema.Struct({
  _tag: Schema.Literal("sessionRespond"),
  sessionId: SessionId,
  requestId: Fact,
  decision: ApprovalDecision,
});

export type SessionRespond = Schema.Schema.Type<typeof SessionRespond>;

/**
 * What one input did, under the row id it was sent with. It carries no turn id:
 * the turn reaches the controller on `turn.started`, and a field with no
 * consumer is a field that will be wrong.
 */
export const SessionInputResult = Schema.Struct({
  _tag: Schema.Literal("sessionInputResult"),
  requestId: Fact,
  ok: Schema.Boolean,
  delivery: Schema.optionalKey(Delivery),
  /** Why it was not delivered, so the caller reads a reason rather than a flag. */
  message: Schema.optionalKey(Message),
});

export type SessionInputResult = Schema.Schema.Type<typeof SessionInputResult>;

/** One normalized event, under the sequence number the controller inserts it on, once. */
export const SessionEvent = Schema.Struct({
  _tag: Schema.Literal("sessionEvent"),
  ...Sequenced.fields,
  event: ProviderEvent,
});

export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>;

/**
 * The most sessions one runner will ever report. The per-runner cap of spec 03
 * section 5.3 is well under it, so this refuses nonsense, not a real report.
 */
export const MAX_SESSIONS_PER_RUNNER = 256;

/** What the runner's adapters actually hold, as `listSessions` found them. */
export const SessionsReport = Schema.Struct({
  _tag: Schema.Literal("sessionsReport"),
  sessions: Schema.Array(SessionBinding).check(Schema.isMaxLength(MAX_SESSIONS_PER_RUNNER)),
});

export type SessionsReport = Schema.Schema.Type<typeof SessionsReport>;
