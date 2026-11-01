/**
 * Sessions on the wire: what the controller sends, what the runner reports
 * back, and the normalized vocabulary every harness's traffic is converted to
 * before it leaves the machine it ran on (spec 06 sections 4 and 6).
 *
 * The runner normalizes, so this file is the whole contract for anything that
 * reads a session. An `unknown` item kind and a `raw` passthrough keep a vendor
 * message nobody mapped, rather than dropping it.
 */
import { Schema, SchemaGetter } from "effect";

import { AdapterError } from "./adapter-errors";
import { AttachmentReference } from "./attachments";
import { MAX_CATALOG_MODELS, ModelDeclaration } from "./models";
import { OutputSchema } from "./output-schema";
import { MAX_SKILLS, LibrarySkillRevision } from "./skills";
import {
  Fact,
  HarnessAccount,
  ProviderAccountId,
  MAX_FACT_ITEMS,
  MAX_FACT_LENGTH,
  MAX_MESSAGE_LENGTH,
  Message,
  Sequenced,
  SessionId,
  Timestamp,
  UsageReading,
  WorkspaceStepKey,
} from "./primitives";

/**
 * How much a session may do without asking first (spec 06 section 8). It is
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
 * A duration on the wire, in milliseconds. The controller converts
 * whole-minute settings to milliseconds, so the runner never needs to know the
 * unit they were set in, and a test can use a value much shorter than a
 * minute.
 */
const PositiveMillis = Schema.Int.check(Schema.isGreaterThan(0));

/** The harness's original report, retained without interpreting its payload. */
export const HarnessReport = Schema.Struct({ source: Fact, payload: Schema.Json });

export type HarnessReport = Schema.Schema.Type<typeof HarnessReport>;

/**
 * The harness's own id for a subagent, unique within its session: the Claude
 * agent id, the Codex child thread id, or the child id from Hercule's pi
 * extension (spec 06 section 13). It may not contain `:`, because it is the
 * last part of a subagent's live topic, `session:<id>:subagent:<subagentId>:stream`,
 * and a colon in it would let that topic parse two ways.
 */
export const SubagentId = Fact.check(
  Schema.isPattern(/^[^:]+$/, { title: "subagent id", description: "an id with no `:`" }),
);

export type SubagentId = Schema.Schema.Type<typeof SubagentId>;

/**
 * One subagent a resumed session already has a record of, as the controller
 * sends it in `SessionSpec.continue.subagents`:
 *
 * - `itemId` is the item of the call that started the subagent, when the
 *   record has one;
 * - `parentSubagentId` is the subagent that started it, absent when the
 *   session's own agent did. The adapter needs this tree to stop a continued
 *   subagent together with the subagents below it, because a harness such as
 *   Claude Code names no parent agent in its frames;
 * - `lastUsageReport` is the original harness report behind the latest
 *   accepted usage snapshot. The adapter can restore its native counter
 *   baseline without counting that history again.
 */
export const ContinuedSubagent = Schema.Struct({
  subagentId: SubagentId,
  itemId: Schema.optionalKey(Fact),
  parentSubagentId: Schema.optionalKey(SubagentId),
  lastUsageReport: Schema.optionalKey(HarnessReport),
});

export type ContinuedSubagent = Schema.Schema.Type<typeof ContinuedSubagent>;

/** The model and the per-model choices a turn runs with (spec 06 section 4). */
export const ModelSelection = Schema.Struct({
  model: Fact,
  options: Schema.Record(Fact, Schema.Union([Schema.String, Schema.Boolean])),
});

export type ModelSelection = Schema.Schema.Type<typeof ModelSelection>;

/**
 * The families of harness tools a session may have taken away from it. This
 * is Hercule's own vocabulary, and it is coarse on purpose. Each adapter maps
 * a family onto the names its harness gives those tools. A harness that
 * cannot take a family away declares that, and does not pretend to enforce it.
 */
export const TOOL_FAMILIES = ["edit", "write", "shell", "web-search", "web-fetch"] as const;

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
 * What the controller sends for one session: ids, never paths. A workspace's
 * path on disk belongs to the runner, and the controller never stores it. The
 * runner resolves the spec to a `HarnessRunnerContext` on its own machine.
 *
 * The row that stores this keeps it byte for byte, apart from `coordination`,
 * which is never stored. A field is added here only when something sends it.
 * `mcpServers`, the one field of spec 06 section 4 that is not here yet,
 * arrives with the feature that needs it.
 */
export const SessionSpec = Schema.Struct({
  providerAccountId: ProviderAccountId,
  /** `null` for a session without a workspace: the runner gives it a scratch working directory. */
  workspaceId: Schema.NullOr(Fact),
  modelSelection: ModelSelection,
  /** The mode after the access-mode fallback: always one the target harness declares native. */
  accessMode: AccessMode,
  /**
   * Appended to the harness's own system prompt, never in place of it. A
   * session with no Agent behind it carries no prompt here.
   */
  systemPrompt: Schema.optionalKey(Schema.String),
  /**
   * An assistant's memory as the session starts with it: the `## Memory
   * (core)` section and the `## Memory topics` index, already rendered. The
   * adapter appends it after everything else in the system prompt, the
   * Hercule skill included, because it is the part that changes most often
   * (spec 12 section 6.3). Only an assistant's conversation session has one.
   */
  memory: Schema.optionalKey(Schema.String),
  /**
   * The paragraph that tells the agent how to work beside other agent
   * sessions on the same repositories: Discussions, the Wiki, and the
   * repositories checked out in its workspace (spec 19 section 7.1). The
   * controller builds it again at every start, a resume or a fork included,
   * so it is never stored and is absent from the session's stored spec. The
   * adapter puts it right before `memory`. Absent when the session has no
   * repository checked out, or holds no grant the paragraph is about. A
   * runner that does not know this field ignores it.
   */
  coordination: Schema.optionalKey(Schema.String),
  /**
   * `false` turns off the harness's own automatic compaction. An assistant's
   * session sets it, because the controller rotates that session to a fresh
   * one instead, so the context is never summarized behind the assistant's
   * back (spec 06 section 9.2). Absent leaves the harness's default.
   */
  autoCompaction: Schema.optionalKey(Schema.Literal(false)),
  /**
   * The tool families to take away. A harness that declares it enforces none
   * of them still receives the list, and the record the caller reads reports
   * that the harness ignores the field.
   */
  disallowedTools: Schema.optionalKey(Schema.Array(DisallowedTool)),
  /**
   * What the session's turns must return, as a JSON Schema within the subset
   * `lintOutputSchema` accepts. Without a schema, turns return prose.
   */
  outputSchema: Schema.optionalKey(OutputSchema),
  /**
   * The harness-native session this one continues from, on the same runner
   * and the same Provider Account (spec 06 section 4.1). A resume continues that
   * native session; a fork branches off it, leaving the original untouched.
   *
   * `subagents` lists the subagents the controller already has records of,
   * sent on a resume only. The adapter seeds its own map from it, so a
   * subagent the harness continues in the new process lands on the record it
   * already has (spec 06 section 13.2). `lastUsageReport` is the original
   * report behind its latest accepted usage snapshot. An adapter can restore
   * its native counter baseline without counting that history again. The
   * controller keeps the report unchanged. A fork sends none: a forked
   * session starts with no subagents.
   */
  continue: Schema.optionalKey(
    Schema.Struct({
      nativeSessionId: Fact,
      mode: Schema.Literals(["resume", "fork"]),
      subagents: Schema.optionalKey(Schema.Array(ContinuedSubagent)),
    }),
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
 * The explicit join between a Hercule session and the harness-native object
 * behind it. The two ids are separate concepts and nothing else joins them.
 */
export const SessionBinding = Schema.Struct({
  sessionId: SessionId,
  nativeSessionId: Fact,
  providerAccountId: ProviderAccountId,
});

export type SessionBinding = Schema.Schema.Type<typeof SessionBinding>;

/**
 * One turn's input: its text, the images attached to it, and the session that
 * sent it when another agent did.
 * `modelSelection` is the session's current model, sent on every frame. A
 * harness accepts a model change only on the input that starts a turn, so an
 * adapter applies it there and ignores it the rest of the time.
 */
export const TurnInput = Schema.Struct({
  /** Empty when the input is images alone. */
  text: Schema.String,
  modelSelection: Schema.optionalKey(ModelSelection),
  /**
   * The input's images, in the order the user attached them. These are
   * references, never bytes: the runner fetches each image over HTTP before
   * it hands the turn to the harness, so a large image never holds up the
   * socket. Sent only to a runner whose hello lists `ATTACHMENTS_CAPABILITY`.
   */
  attachments: Schema.optionalKey(
    Schema.Array(AttachmentReference).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
  ),
  /**
   * The agent step this input runs, set only on the input that starts an
   * agent step's turn. The runner reports how that turn ends as the step's
   * result, under this key, instead of only as session events.
   */
  step: Schema.optionalKey(WorkspaceStepKey),
  /**
   * The session whose agent sent this input, set only when another session's
   * agent sent it as a message (`source` user, actor `session:<id>`, and not
   * the receiving session itself). The controller reads it from the stored
   * actor, never from the caller. The runner tells the harness who sent the
   * message and copies the id to the `user_message` it reports. An older
   * runner drops the key when it decodes the frame, so its transcript shows
   * no sender.
   */
  senderSessionId: Schema.optionalKey(SessionId),
});

export type TurnInput = Schema.Schema.Type<typeof TurnInput>;

/** Whether an input opened a turn of its own or steered one already running. */
export const Delivery = Schema.Literals(["opened", "steered"]);

export type Delivery = Schema.Schema.Type<typeof Delivery>;

/**
 * What the adapter reports an input did. This is the only reliable source.
 * An input can race the end of a turn, so the order events arrive in cannot
 * tell whether the input steered the turn or opened a new one. Only the
 * adapter knows (ADR 0007).
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
  /** A tool read one file. `detail.path` holds the path (spec 06 section 6.3). */
  "file_read",
  /**
   * A tool searched or listed files. `detail.pattern` and `detail.path` hold
   * what it searched for and where, and either may be absent.
   */
  "file_search",
  "tool_call",
  "web_search",
  "subagent",
  "plan",
  /**
   * A live list of steps the agent keeps while it works: Claude's `TodoWrite`
   * and Task tools, and later Codex's plan updates. An agent has one per turn.
   * It is updated in place with `item.updated` and completed when the turn
   * ends. `detail` is a `TodoListDetail`. It is not a `plan`: a plan is text
   * the agent proposes, and a todo list is live progress.
   */
  "todo_list",
  /**
   * The agent paused for a set time, such as Codex's `clock.sleep` tool.
   * `detail` is a `WaitDetail`.
   */
  "wait",
  /**
   * The agent generated an image. `detail` is an `ImageGenerationDetail`.
   */
  "image_generation",
  "context_compaction",
  "error",
  /** The forward-compatible catch-all: an unmapped vendor item, with its raw. */
  "unknown",
]);

export type ItemKind = Schema.Schema.Type<typeof ItemKind>;

export const ItemStatus = Schema.Literals(["completed", "failed", "declined"]);

export type ItemStatus = Schema.Schema.Type<typeof ItemStatus>;

/**
 * The four answers an approval can be given. `allow_always` keeps a rule for
 * the rest of the session; `cancel` denies the request and ends the turn of
 * the agent that asked it.
 */
export const ApprovalDecision = Schema.Literals(["allow", "allow_always", "deny", "cancel"]);

export type ApprovalDecision = Schema.Schema.Type<typeof ApprovalDecision>;

/**
 * The decisions an approval accepts. When a request cannot keep a rule, or an
 * allow would have nothing to apply to, this list leaves those decisions out.
 * Otherwise a surface could offer a decision the harness would silently
 * replace with another.
 */
const Decisions = Schema.NonEmptyArray(ApprovalDecision);

/**
 * The fields of every request a harness can park a session on.
 *
 * `detail` is a closed struct per `kind` rather than free Json: the surfaces
 * render the card from it, and a vendor-shaped payload there would make what
 * the user sees depend on which harness asked (ADR 0007).
 */
const defineOpenRequestFields = <const K extends string, F extends Schema.Struct.Fields>(
  kind: K,
  detail: F,
) => ({
  requestId: Fact,
  /** The item the request is about, so a surface can overlay it in place. */
  itemId: Fact,
  kind: Schema.Literal(kind),
  detail: Schema.Struct(detail),
});

/** An approval one agent of a session is parked on, and the decisions it accepts. */
const defineApprovalRequest = <const K extends string, F extends Schema.Struct.Fields>(
  kind: K,
  detail: F,
) => Schema.Struct({ ...defineOpenRequestFields(kind, detail), decisions: Decisions });

/** A rename has two paths and a multi-file edit more, so this is a list. */
const Paths = Schema.Array(Fact);

const CommandApproval = defineApprovalRequest("command_approval", { command: Message });

const FileChangeApproval = defineApprovalRequest("file_change_approval", { paths: Paths });

const FileReadApproval = defineApprovalRequest("file_read_approval", { paths: Paths });

const ToolApproval = defineApprovalRequest("tool_approval", { toolName: Fact });

/**
 * One question in a `question` request: the chip it is labelled with, the
 * prose the agent wrote, and the options it offers. An option's description
 * is absent when the agent wrote none, and nothing is made up in its place.
 * An approval and a question are different things sharing one request slot,
 * so the question keeps its own structure rather than being flattened to
 * text: a surface that reads only the text cannot show what the answers were.
 *
 * The struct is closed, like every detail here: a vendor's extra field (the
 * Claude SDK's `preview`) would make what the user sees depend on which
 * harness asked (ADR 0007). Every harness maps its own shape into this one.
 */
const Question = Schema.Struct({
  question: Message,
  header: Fact,
  options: Schema.Array(Schema.Struct({ label: Fact, description: Schema.optionalKey(Message) })),
  /** Whether more than one option may be chosen. */
  multiSelect: Schema.Boolean,
  /**
   * Present, and true, when the harness asked to keep the answer secret, as a
   * Codex `isSecret` question does. Nothing can keep it secret: the answer is
   * shown, stored and sent like any other. So a surface warns the user
   * instead. It is left out on every other question.
   */
  secret: Schema.optionalKey(Schema.Literal(true)),
});

/**
 * Questions one agent of a session asks the user: it is parked on them, unless
 * the request is async (below). A harness asks one to four questions at a
 * time, so the request holds a list. It accepts answers only, never a
 * decision. To turn the questions down, the user stops the asking agent, and
 * the request resolves as `cancel`.
 *
 * `async` is present, and true, on an async question: one the asking agent
 * does not wait on. The agent keeps working, and the request stays open after
 * the agent's turn ends, until the question is answered, the asking agent is
 * stopped, or the session exits. It is left out when the agent waits (parks)
 * for the answer.
 */
const QuestionRequest = Schema.Struct({
  ...defineOpenRequestFields("question", { questions: Schema.NonEmptyArray(Question) }),
  async: Schema.optionalKey(Schema.Literal(true)),
});

/**
 * One answer to a question: an option's label or text the user typed. Text
 * that is empty or only spaces would answer nothing, so it is refused.
 */
const AnswerText = Message.check(
  Schema.isPattern(/\S/, { title: "answer", description: "text that is not only spaces" }),
);

/**
 * The most characters all the answers to one request may hold together,
 * headers included. The answers travel to the runner and come back in
 * `request.resolved`, and a frame over `MAX_FRAME_BYTES` (2 MiB) closes the
 * runner's connection, ending the stream of every session on it. JSON can
 * write one character as six bytes, so the limit stays far below
 * `MAX_FRAME_BYTES` divided by six. Four full messages is still more than
 * anyone types in answer to a question.
 */
export const MAX_ANSWERS_LENGTH = 4 * MAX_MESSAGE_LENGTH;

/** Counts the characters in a set of answers: every header, value and list item. */
const countAnswerCharacters = (answers: {
  readonly [header: string]: string | ReadonlyArray<string>;
}): number =>
  Object.entries(answers)
    .flat(2)
    .reduce((total, text) => total + text.length, 0);

/**
 * The answers to a `question` request, keyed by each question's header. A
 * question is answered with one text, or with a list when it allows several
 * options; a list of one is also accepted for a question that takes one
 * answer. Which headers are required, and whether more than one answer is
 * allowed, depends on the request, so the controller checks that against the
 * open request.
 *
 * A header is any string, not a `Fact`: a record drops a key that fails its
 * key schema instead of failing, so an empty or overlong header would vanish
 * without a word. Kept, it reaches the controller, which refuses it as a
 * header the request does not have. The limit on all characters together
 * still bounds its length.
 */
export const QuestionAnswers = Schema.Record(
  Schema.String,
  Schema.Union([
    AnswerText,
    Schema.NonEmptyArray(AnswerText).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
  ]),
).check(
  Schema.isBetweenProperties(1, MAX_FACT_ITEMS),
  Schema.makeFilter((answers) =>
    countAnswerCharacters(answers) <= MAX_ANSWERS_LENGTH
      ? true
      : `the answers and their headers together hold more than ${String(MAX_ANSWERS_LENGTH)} characters`,
  ),
);

export type QuestionAnswers = Schema.Schema.Type<typeof QuestionAnswers>;

/**
 * A Request one agent of a session is parked on, as the database row and the
 * API hold it. `request.opened` carries the same five shapes. A session can
 * have several open at once, one or more per agent (spec 06 section 13.3).
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
 * Checks whether a request is an async question: one the asking agent does not
 * wait on. Such a request stays open after its agent's turn ends, and it does
 * not stop the session's inactivity watch.
 */
export const isAsyncQuestion = (request: OpenRequest): boolean =>
  request.kind === "question" && request.async === true;

/** An open request that is an approval: any kind but `question`. It takes a decision. */
export type ApprovalRequest = Exclude<OpenRequest, { readonly kind: "question" }>;

/** One question of a `question` request. */
export type Question = Schema.Schema.Type<typeof Question>;

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
 * A token snapshot counting everything the agent used since this process
 * started, not a per-turn delta: harnesses report at different intervals, and
 * a snapshot works for all of them. The controller adds each process's count
 * to the session's running total, so a resumed session is not counted twice.
 * The four token counts never overlap: `inputTokens` is the input not read
 * from cache. The optional fields are the ones only some harnesses report
 * (spec 06 section 6.6).
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
 * Reports known token counts and whether every model call could be counted.
 * An incomplete report is a subtotal. Recovering a native baseline permits
 * counting later calls, but cannot reconstruct the missing interval.
 */
export const UsageReport = Schema.Struct({
  status: Schema.Literals(["complete", "incomplete"]),
  counts: Usage,
});

export type UsageReport = Schema.Schema.Type<typeof UsageReport>;

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
  harnessRefs: Schema.optionalKey(
    Schema.Record(Fact, Schema.String.check(Schema.isMaxLength(MAX_FACT_LENGTH))),
  ),
  raw: Schema.optionalKey(HarnessReport),
};

const defineEvent = <const Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) => Schema.Struct({ _tag: Schema.Literal(tag), ...base, ...fields });

/**
 * The field that names the agent an event belongs to: the subagent its id
 * names, or the session's own agent when it is absent (spec 06 section 13).
 * It is spread into each event an agent can cause, rather than put in `base`,
 * because `session.started` and `session.exited` belong to the session's
 * process and never to one agent.
 */
const attribution = { subagentId: Schema.optionalKey(SubagentId) };

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
 * on every harness, and a failure gives its reason in the same words.
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
const TurnStarted = defineEvent("turn.started", {
  ...attribution,
  turnId: Fact,
  model: Schema.optionalKey(Fact),
});

const TurnCompleted = defineEvent("turn.completed", {
  ...attribution,
  turnId: Fact,
  state: TurnState,
  usage: Schema.optionalKey(Usage),
  /**
   * This turn's cost, where the harness prices a turn. `usage` counts since
   * this process started.
   */
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
 * The `detail` of an `unknown` item: the label names a message that no decision
 * covers, or a known message that could not be read. It is written as
 * `<harness>: <message type>`, such as `claude: system/foo_bar`. A client shows
 * it so the gap is visible and not a bare "Step". The label is absent on rows
 * written before it existed.
 */
export const UnknownItemDetail = Schema.Struct({ label: Schema.optionalKey(Fact) });

export type UnknownItemDetail = Schema.Schema.Type<typeof UnknownItemDetail>;

/**
 * The `detail` of a `context_compaction` item: how the harness shrank the
 * conversation to fit its context window. Every field is optional, because a
 * harness reports only what it knows, and the item is already shown while the
 * compaction runs.
 *
 * - `trigger` is `auto` when the harness compacted on its own, `manual` when
 *   the user asked for it.
 * - `tokensBefore` and `tokensAfter` count the conversation's tokens before
 *   and after.
 * - `summary` is the text that replaces the conversation, cut to the length of
 *   a message.
 */
export const ContextCompactionDetail = Schema.Struct({
  trigger: Schema.optionalKey(Schema.Literals(["auto", "manual"])),
  tokensBefore: Schema.optionalKey(Tokens),
  tokensAfter: Schema.optionalKey(Tokens),
  summary: Schema.optionalKey(Message),
});

export type ContextCompactionDetail = Schema.Schema.Type<typeof ContextCompactionDetail>;

/**
 * The most steps a todo list holds. The runner does not cut a longer list,
 * because that would change the count a client shows ("2 of 5"). It shows the
 * agent's tool call as failed instead.
 */
export const MAX_TODO_STEPS = 128;

/** Where one step of a todo list stands. */
export const TodoStepStatus = Schema.Literals(["pending", "in_progress", "completed"]);

export type TodoStepStatus = Schema.Schema.Type<typeof TodoStepStatus>;

/**
 * One step of a todo list. Its text is a `Fact` and not a `Message`, because
 * a step is one line, such as "Run the tests", and a client shows it on a
 * single row. A step with no text is not a step.
 */
export const TodoStep = Schema.Struct({ text: Fact, status: TodoStepStatus });

export type TodoStep = Schema.Schema.Type<typeof TodoStep>;

/**
 * The `detail` of a `todo_list` item: the agent's steps, in the order it
 * listed them, at most `MAX_TODO_STEPS`. Every `item.updated` carries the whole
 * list again.
 */
export const TodoListDetail = Schema.Struct({
  steps: Schema.Array(TodoStep).check(Schema.isMaxLength(MAX_TODO_STEPS)),
});

export type TodoListDetail = Schema.Schema.Type<typeof TodoListDetail>;

/**
 * The `detail` of a `wait` item: how long the agent asked to wait, in
 * milliseconds. The agent may be woken before that time has passed, so this is
 * the time it asked for and not the time it waited.
 */
export const WaitDetail = Schema.Struct({
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type WaitDetail = Schema.Schema.Type<typeof WaitDetail>;

/**
 * The `detail` of an `image_generation` item: `path` is the file the harness
 * saved the image to. It is absent when the harness saved none.
 */
export const ImageGenerationDetail = Schema.Struct({ path: Schema.optionalKey(Fact) });

export type ImageGenerationDetail = Schema.Schema.Type<typeof ImageGenerationDetail>;

/**
 * `detail` stays Json: each adapter decides its shape per kind, and fixing
 * twelve shapes here would limit what each harness can report in future.
 *
 * One field is shared by every adapter: a `user_message` whose input had
 * images carries them in `detail.attachments`, in the order the user attached
 * them, each as `{ id, name, mimeType, sizeBytes }`. These are references
 * only; a client reads the bytes through `attachment.readContent`. The field
 * is absent when the input had no images.
 *
 * Another shared field: a `user_message` whose text had Skill References that
 * the runner translated for the harness carries their names in
 * `detail.skills`, such as `["review", "webshop:release"]`, each name once, in
 * order of first appearance. The text itself is stored as typed. A reference
 * that named no skill of the session is not listed. The field is absent when
 * the runner translated none.
 *
 * A further field is shared the same way: a `user_message` whose input another
 * session's agent sent carries that session's id in `detail.senderSessionId`,
 * copied from the input's `senderSessionId`. The field is absent on any other
 * message, the owner's included.
 *
 * Five more shapes are shared by every adapter and exported as schemas:
 * `UnknownItemDetail` for an `unknown` item, `ContextCompactionDetail` for a
 * `context_compaction` item, `TodoListDetail` for a `todo_list` item,
 * `WaitDetail` for a `wait` item and `ImageGenerationDetail` for an
 * `image_generation` item. All are written by the adapter and decoded by clients; the event itself still
 * carries Json.
 */
const itemFields = {
  ...attribution,
  /** Every item belongs to a turn; unsolicited output gets a synthetic one. */
  turnId: Fact,
  itemId: Fact,
  kind: ItemKind,
  detail: Schema.optionalKey(Schema.Json),
};

const ItemStarted = defineEvent("item.started", itemFields);

/**
 * Replaces the `detail` of an item that has already started, as a whole and
 * not as a patch. It never changes the item's `kind`, and it does not end the
 * item: `item.completed` still follows.
 */
const ItemUpdated = defineEvent("item.updated", itemFields);

/** The most files one `item.completed` reports as edited (spec 19 section 4.1). */
export const MAX_EDITED_FILES = 256;

/** The longest path an edited file may have, inside its checkout. */
const MAX_EDITED_FILE_PATH_LENGTH = 1024;

/** One path segment: not empty, not `.` and not `..`, and holding no `/`. */
const EDITED_PATH_SEGMENT = String.raw`(?!\.\.?(?:/|$))[^/]+`;

/**
 * A file a session edited: the Resource of the checkout it lies in, and its
 * path inside that checkout. The path is relative (no leading `/`), has `/`
 * separators, and has no empty, `.` or `..` segment. It holds no backslash and
 * no character that could disguise it when shown: control characters, line
 * and paragraph separators, and Unicode format characters such as the
 * bidirectional overrides. The runner converts the whole paths an adapter
 * writes into this shape, so the controller never sees a path on the runner's
 * disk.
 */
export const EditedFile = Schema.Struct({
  resourceId: Fact,
  path: Schema.String.check(
    Schema.isBetweenLength(1, MAX_EDITED_FILE_PATH_LENGTH),
    Schema.isPattern(new RegExp(`^${EDITED_PATH_SEGMENT}(?:/${EDITED_PATH_SEGMENT})*$`), {
      title: "path",
      description: "a relative path with `/` separators and no empty, `.` or `..` segment",
    }),
    Schema.isPattern(/^[^\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, {
      title: "path characters",
      description: "a path with no backslash, control or format character",
    }),
  ),
});

export type EditedFile = Schema.Schema.Type<typeof EditedFile>;

/**
 * `editedFiles` is set only on a completed `file_change` item whose files lie
 * in the session's checkouts. The runner never drops it to fit a frame. Files
 * a command changed arrive on `FilesEdited` instead.
 */
const ItemCompleted = defineEvent("item.completed", {
  ...itemFields,
  status: ItemStatus,
  editedFiles: Schema.optionalKey(
    Schema.Array(EditedFile).check(Schema.isBetweenLength(1, MAX_EDITED_FILES)),
  ),
});

/** Append-only text for one (item, streamKind). Unbounded: cutting it loses output. */
const ContentDelta = defineEvent("content.delta", {
  ...attribution,
  turnId: Fact,
  itemId: Fact,
  streamKind: StreamKind,
  delta: Schema.String,
});

/**
 * Without `subagentId` the snapshot covers the session's own agent and every
 * subagent; with one, it covers that subagent alone (spec 06 section 6.6).
 */
const SessionUsageUpdated = Schema.Union([
  defineEvent("session.usage.updated", {
    ...attribution,
    usage: Usage,
    usageReport: Schema.optionalKey(Schema.Never),
  }),
  defineEvent("session.usage.updated", {
    ...attribution,
    usage: Schema.optionalKey(Schema.Never),
    usageReport: Schema.Struct({ status: Schema.Literal("incomplete"), counts: Usage }),
  }),
]);

/**
 * Something went wrong, but the session goes on, such as a retry or an event
 * the runner had to shrink. It may fire inside a turn or between turns, so the
 * turn id is optional.
 */
const RuntimeWarning = defineEvent("runtime.warning", {
  ...attribution,
  turnId: Schema.optionalKey(Fact),
  message: Message,
});

/**
 * Neutral information about the session, such as "Conversation was cleared".
 * Unlike a warning, nothing went wrong: a client draws it as a plain note, not
 * as a problem. Like a warning, it may fire inside a turn or between turns, so
 * the turn id is optional, and it never opens a turn of its own.
 */
const RuntimeNotice = defineEvent("runtime.notice", {
  ...attribution,
  turnId: Schema.optionalKey(Fact),
  message: Message,
});

/**
 * `class` is the only open vocabulary here. Adapters map into Codex's
 * `codexErrorInfo` enum as the reference set, with `unknown` for the rest. A
 * refused input or a failed start is reported with `class` set to the
 * `AdapterError` tag (PascalCase, such as `HarnessNotInstalled`), next to the
 * vendor classes, which are snake_case. It stays a string, so a class this
 * build does not know still reaches the user.
 */
const RuntimeError = defineEvent("runtime.error", {
  ...attribution,
  turnId: Schema.optionalKey(Fact),
  class: Fact,
  message: Schema.optionalKey(Message),
});

/**
 * An agent of the session is parked: nothing more happens on that agent's
 * turn until a decision arrives. The request is nested rather than spread across the event, so the
 * row and the API hold exactly what arrived, whatever fields the event
 * envelope gains later.
 */
const RequestOpened = defineEvent("request.opened", { ...attribution, request: OpenRequest });

/**
 * The agent is no longer parked on this Request, whatever ended it: the
 * user's decision, an interrupted turn, or the harness withdrawing the
 * question.
 */
const RequestResolved = defineEvent("request.resolved", {
  ...attribution,
  requestId: Fact,
  decision: ApprovalDecision,
});

/**
 * The agent is no longer parked on this Request, because the user answered
 * its question. It
 * carries the answers rather than a decision, so the stream holds what the
 * user said.
 */
const RequestResolvedWithAnswers = defineEvent("request.resolved", {
  ...attribution,
  requestId: Fact,
  answers: QuestionAnswers,
});

/**
 * A subagent's introduction, sent once per process before any event of that
 * subagent (spec 06 section 13.2). The event belongs to the agent that started
 * the subagent, so it has no `subagentId` of its own: it is stored in the
 * transcript `parentSubagentId` names, or the session's own when that is
 * absent.
 *
 * - `itemId` is the `subagent` item that started it, in its parent's transcript.
 * - `description` is the short task name the parent gave it.
 * - `agentType` is the harness's name for the kind of agent: Claude's
 *   `subagent_type`, Codex's role.
 */
const SubagentStarted = defineEvent("subagent.started", {
  subagentId: SubagentId,
  parentSubagentId: Schema.optionalKey(SubagentId),
  itemId: Schema.optionalKey(Fact),
  description: Schema.optionalKey(Message),
  agentType: Schema.optionalKey(Fact),
});

/**
 * How a request ended, as `request.resolved` carries it beside the request's
 * id: with a decision, or with the answers to its questions.
 */
export type RequestResolution =
  | { readonly decision: ApprovalDecision }
  | { readonly answers: QuestionAnswers };

/** Every event this build of the protocol knows, which `HarnessEvent` decodes strictly. */
const KNOWN_EVENTS = [
  SessionStarted,
  SessionExited,
  SubagentStarted,
  TurnStarted,
  TurnCompleted,
  ItemStarted,
  ItemUpdated,
  ItemCompleted,
  ContentDelta,
  SessionUsageUpdated,
  RuntimeWarning,
  RuntimeNotice,
  RuntimeError,
  RequestOpened,
  RequestResolved,
  RequestResolvedWithAnswers,
] as const;

/**
 * An event whose `_tag` this build does not know, kept whole. A newer runner
 * can send a tag the controller has no arm for, and a newer controller can
 * serve one to an older client. Decoding such an event into this arm, instead
 * of failing, keeps the connection and the transcript alive.
 *
 * - `originalType` is the `_tag` the event arrived with.
 * - `payload` is the whole event as it arrived, including its own `_tag`.
 *
 * The envelope (`eventId`, `sessionId`, `at` and `subagentId`) is lifted out of
 * the payload, so the event is stored, ordered and attributed to a subagent's
 * transcript like any other.
 *
 * `originalType` is a `Fact`, because the UI draws it. So an unknown tag must
 * still be a fact (1 to 512 characters): an empty or longer tag fails the event
 * like any other malformed one, even though the tag is otherwise unknown.
 */
const UnknownEvent = defineEvent("unknown", {
  ...attribution,
  originalType: Fact,
  payload: Schema.Unknown,
});

/** Lists the tags a member of `KNOWN_EVENTS` decodes: one, or one per branch of a union. */
const readEventTags = (member: (typeof KNOWN_EVENTS)[number]): ReadonlyArray<string> =>
  "fields" in member
    ? [member.fields._tag.literal]
    : member.members.map((branch) => branch.fields._tag.literal);

/**
 * The tags `HarnessEvent` has an arm for, `unknown` included. Derived from
 * the arms, so a new event is known the moment it is added to `KNOWN_EVENTS`.
 */
const ARM_TAGS: ReadonlySet<string> = new Set([
  ...KNOWN_EVENTS.flatMap(readEventTags),
  UnknownEvent.fields._tag.literal,
]);

/** An event as received or stored, before its tag is checked against the arms. */
type ReceivedEvent = { readonly _tag: string } & Readonly<Record<string, unknown>>;

/**
 * Builds the `unknown` event for an event whose tag no arm has: the tag becomes
 * `originalType`, the whole received object becomes `payload`, and the fields
 * every event has are copied up. Does not validate anything: a caller that
 * needs a valid event decodes the result with `UnknownEvent`.
 */
const wrapUnknownEvent = (received: ReceivedEvent): typeof UnknownEvent.Encoded =>
  ({
    _tag: "unknown",
    originalType: received._tag,
    payload: received,
    eventId: received.eventId,
    sessionId: received.sessionId,
    at: received.at,
    ...("subagentId" in received ? { subagentId: received.subagentId } : {}),
  }) as typeof UnknownEvent.Encoded;

/**
 * An event with a `_tag` no arm has, as it arrives. The tag check is what
 * keeps a malformed event of a known kind a failure: without it, a broken
 * `session.exited` would decode as an unknown event and its session would
 * never be seen to end.
 *
 * The decoded event must be a valid `UnknownEvent`, so the tag must be a
 * `Fact` (1 to 512 characters); any other tag fails like a malformed event.
 */
const UnrecognisedEvent = Schema.StructWithRest(
  Schema.Struct({
    _tag: Schema.String.check(
      Schema.makeFilter((tag: string) => (ARM_TAGS.has(tag) ? "a tag with an event arm" : true), {
        title: "a tag no event arm has",
      }),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
).pipe(
  Schema.decodeTo(UnknownEvent, {
    // The envelope fields are `unknown` here. `UnknownEvent` validates them next,
    // and a missing or malformed one fails the whole event.
    decode: SchemaGetter.transform(wrapUnknownEvent),
    encode: SchemaGetter.passthrough({ strict: false }),
  }),
);

/**
 * A normalized event. An event whose `_tag` is not one of the known ones
 * decodes as the `unknown` arm; a malformed event of a known tag fails.
 * Encoding writes the `unknown` arm as it is.
 *
 * `UnrecognisedEvent` has no literal `_tag`, and a union with such a member
 * cannot look an event up by its tag. So the arms that have one are a union of
 * their own, which keeps the lookup: decoding a known event stays about as
 * fast as before the `unknown` arm existed.
 */
export const HarnessEvent = Schema.Union([
  Schema.Union([...KNOWN_EVENTS, UnknownEvent]),
  UnrecognisedEvent,
]);

export type HarnessEvent = Schema.Schema.Type<typeof HarnessEvent>;

/**
 * Parses the JSON text of a stored event into a `HarnessEvent`. The text is
 * trusted: the controller wrote it itself, so it is well-formed JSON of an
 * object with a string `_tag`, and the function does not check that. Fails
 * only when the text is not valid JSON.
 *
 * - An event whose `_tag` this build has an arm for is returned as parsed,
 *   without decoding it. Decoding every stored row would cost time on a hot
 *   path, and could reject a row written in an older shape.
 * - An event of any other tag becomes the `unknown` event, without validation.
 *
 * Needed because a newer build may store an event type this build does not
 * know, and the operator may roll back to this build on the same database. That
 * is all it supports: a row of an unfamiliar type that has the envelope every
 * event has, which protocol 11 guarantees. A row whose envelope this build
 * cannot encode is not supported.
 */
export const parseStoredEvent = (text: string): HarnessEvent => {
  const stored = JSON.parse(text) as ReceivedEvent;
  return ARM_TAGS.has(stored._tag) ? (stored as HarnessEvent) : wrapUnknownEvent(stored);
};

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
 * Starts one session, or resumes it, and hands its harness the session's
 * first input. It carries the Provider Account's `HarnessAccount`, as a probe
 * does, because the runner holds no Hercule state and cannot look it up.
 *
 * The runner answers the input with a `SessionInputResult` under
 * `requestId`, exactly as it answers a `SessionInput`. It answers on every
 * path: a start that fails before the harness took the input answers it as
 * refused. Carrying the input here, rather than in a second frame after
 * `session.started`, means a session never sits idle waiting for its first
 * turn (spec 06 section 4.2).
 */
export const SessionStart = Schema.Struct({
  _tag: Schema.Literal("sessionStart"),
  /** The id of the Queued Input row `input` came from, which the reply is matched by. */
  requestId: Fact,
  sessionId: SessionId,
  /** The input the session starts with: its oldest waiting Queued Input row. */
  input: TurnInput,
  harnessId: Fact,
  harnessAccount: HarnessAccount,
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
  token: Schema.String.check(Schema.isBetweenLength(1, MAX_TOKEN_LENGTH)),
  /**
   * `GH_TOKEN` for this session. Present only when a GitHub Connection backs
   * the session and the controller read a usable token from it: an expired
   * token, a disabled Connection, or one that needs reconnecting leaves it
   * off. The runner keeps it in memory as the first copy of that Connection's
   * token. A token close to its expiry is sent as it is; the runner replaces it by
   * sending `GithubTokenRequest` when it prepares the session.
   */
  ghToken: Schema.optionalKey(Fact),
  /**
   * The GitHub Connection that backs the session. Present whenever there is
   * one, even without a `ghToken`: when the start token is missing or stale,
   * the runner asks the controller for that Connection's token. The runner
   * keys its in-memory copy of the token by it, so sessions that share a
   * Connection share one copy.
   */
  githubConnectionId: Schema.optionalKey(Fact),
  /**
   * When `ghToken` stops working. Absent when the token has no expiry, such as
   * a personal access token. Present only when `ghToken` is.
   */
  ghTokenExpiresAt: Schema.optionalKey(Timestamp),
  /**
   * Who the session commits as: the account its Connection belongs to. Present
   * whenever a Connection backs the session, even without a `ghToken`, because
   * the runner may fetch a token later. Absent when no Connection backs it; the
   * machine then leaves git's own identity unchanged rather than inventing one.
   */
  gitIdentity: Schema.optionalKey(GitIdentity),
  /** The branch the session's checkout is switched to before the harness starts. */
  checkoutBranch: Schema.optionalKey(Fact),
  /**
   * Present when the session sees the user's own material: instructions,
   * agents, commands and rules from the default locations of the user's own
   * harness installation on the runner's machine (spec 06 section 9.1).
   * Skills are not among them: every Thread gets its skills from `skills`,
   * whatever its harness. The controller sets it only for a Thread placed on
   * its local runner. It carries no path,
   * because only the runner knows where those locations are. A runner that
   * does not know this field ignores it, and the session runs isolated.
   */
  userMaterial: Schema.optionalKey(Schema.Literal(true)),
  /**
   * The skills this session gets from the Skill Library, decided for this
   * session at every start, fork and resume (spec 06 section 9.4). It is the
   * session's own list, never "the library", and never holds the built-in
   * `hercule` skill, which the runner adds itself. Absent or empty means no
   * library skills. The controller sends it only to a runner that listed
   * `SKILLS_CAPABILITY`.
   */
  skills: Schema.optionalKey(
    Schema.Array(LibrarySkillRevision).check(Schema.isMaxLength(MAX_SKILLS)),
  ),
  /**
   * The whole Model Catalog of the session's Provider Account, narrowed to
   * what a harness needs to run a model (`ModelDeclaration`), in the catalog's
   * order. The pi adapter declares to pi the models of this list that pi does
   * not ship, so the session can run any model of the catalog. Absent means
   * this start does not manage the declarations (the harness lists all its
   * models itself). Present and empty means the catalog holds no model, so the
   * adapter clears the declarations of an earlier start. Every other adapter
   * ignores the field.
   */
  catalogModels: Schema.optionalKey(
    Schema.Array(ModelDeclaration).check(Schema.isMaxLength(MAX_CATALOG_MODELS)),
  ),
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
 * A frame that carries one Queued Input to the runner: a `SessionInput`, or a
 * `SessionStart` with the input the session starts with. The runner answers
 * either one with a `SessionInputResult` under its `requestId`.
 */
export type FrameCarryingInput = SessionInput | SessionStart;

/**
 * Stops work in a session; each turn it ends completes as `interrupted`.
 *
 * - Without `subagentId`, it stops all work in the session: the turn of the
 *   session's own agent and every running subagent.
 * - With `subagentId`, it stops that subagent and every subagent below it,
 *   and leaves the rest of the session running (spec 06 section 13.4).
 *
 * There is no reply frame: the outcome arrives in the session's own stream as
 * `turn.completed`, so a reply would add nothing.
 */
export const SessionInterrupt = Schema.Struct({
  _tag: Schema.Literal("sessionInterrupt"),
  sessionId: SessionId,
  subagentId: Schema.optionalKey(SubagentId),
});

export type SessionInterrupt = Schema.Schema.Type<typeof SessionInterrupt>;

/**
 * Decides one approval an agent of the session is parked on. `requestId` is
 * the adapter's own id, sent back: the controller does not create ids for
 * requests it did not open. Like `SessionInterrupt`, there is no reply frame: the result
 * arrives in the session's own stream as `request.resolved`.
 */
export const SessionRespondToApprovalRequest = Schema.Struct({
  _tag: Schema.Literal("sessionRespondToApprovalRequest"),
  sessionId: SessionId,
  requestId: Fact,
  decision: ApprovalDecision,
});

export type SessionRespondToApprovalRequest = Schema.Schema.Type<
  typeof SessionRespondToApprovalRequest
>;

/**
 * Answers the questions of one open question request. The runner replies with
 * a `SessionRespondToQuestionResult` under `answerId`, which tells the
 * controller whether the answer reached the agent. When it did, the request
 * resolves in the session's own stream as `request.resolved`, with the
 * answers.
 *
 * `answerId` is new for every attempt to answer, so the result of one attempt
 * is never taken for the result of another, such as a retry of the same
 * request.
 */
export const SessionRespondToQuestion = Schema.Struct({
  _tag: Schema.Literal("sessionRespondToQuestion"),
  sessionId: SessionId,
  requestId: Fact,
  answerId: Fact,
  answers: QuestionAnswers,
  /**
   * The session's current model, sent on every input frame too. A harness
   * takes a model change only on the input that starts a turn, and an answer
   * can start one, so the adapter applies this there and ignores it the rest
   * of the time.
   */
  modelSelection: ModelSelection,
});

export type SessionRespondToQuestion = Schema.Schema.Type<typeof SessionRespondToQuestion>;

/**
 * What happened to one attempt to answer a question, with the `answerId` it
 * was sent with. Sent by the runner for every `SessionRespondToQuestion`.
 */
export const SessionRespondToQuestionResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("sessionRespondToQuestionResult"),
    answerId: Fact,
    ok: Schema.Literal(true),
  }),
  Schema.Struct({
    _tag: Schema.Literal("sessionRespondToQuestionResult"),
    answerId: Fact,
    ok: Schema.Literal(false),
    /**
     * Written for the user: gives the reason the answer did not reach the agent,
     * or states that it is not known whether it did.
     */
    message: Message,
  }),
]);

export type SessionRespondToQuestionResult = Schema.Schema.Type<
  typeof SessionRespondToQuestionResult
>;

/**
 * What happened to one input, with the row id it was sent with. It has no turn
 * id: the controller learns the turn from `turn.started`, and a field nothing
 * reads would sooner or later be wrong.
 */
export const SessionInputResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("sessionInputResult"),
    requestId: Fact,
    ok: Schema.Literal(true),
    delivery: Delivery,
  }),
  Schema.Struct({
    _tag: Schema.Literal("sessionInputResult"),
    requestId: Fact,
    ok: Schema.Literal(false),
    /** Why it was not delivered. The controller reads its `_tag` to decide what happens to the input. */
    error: AdapterError,
  }),
]);

export type SessionInputResult = Schema.Schema.Type<typeof SessionInputResult>;

/** One normalized event, with the sequence number the controller uses to store it exactly once. */
export const SessionEvent = Schema.Struct({
  _tag: Schema.Literal("sessionEvent"),
  ...Sequenced.fields,
  event: HarnessEvent,
});

export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>;

/**
 * The capability for `FilesEdited`. The controller lists it at hello when it
 * reads the frame. A controller on an older build closes the socket on a
 * frame it cannot read, so the runner sends `FilesEdited` only when the
 * controller's hello lists this.
 */
export const FILES_EDITED_CAPABILITY = "filesEdited";

/**
 * Sent by the runner, unasked, with files a session changed that no
 * `file_change` item named: the runner found them by asking git after one of
 * the session's commands finished (spec 19 section 4.1). It travels outside
 * the session's numbered events, because finding the files takes a git
 * process, and the events of every session must not wait for it. The
 * controller needs only to learn of the edit soon, not in order with the
 * session's events.
 */
export const FilesEdited = Schema.Struct({
  _tag: Schema.Literal("filesEdited"),
  sessionId: Fact,
  editedFiles: Schema.Array(EditedFile).check(Schema.isBetweenLength(1, MAX_EDITED_FILES)),
});

export type FilesEdited = Schema.Schema.Type<typeof FilesEdited>;

/**
 * Sent by the runner, unasked, when a running session's harness reports the
 * usage of the session's Provider Account (Claude Code's `rate_limit_event`,
 * Codex's `account/rateLimits/updated`). It travels outside the session's
 * numbered events and is best effort, like `FilesEdited`: the controller needs
 * the latest reading, not every one, so a reading lost with a dropped socket
 * is replaced by the next.
 */
export const AccountUsageReported = Schema.Struct({
  _tag: Schema.Literal("accountUsageReported"),
  sessionId: Fact,
  readings: Schema.Array(UsageReading).check(Schema.isBetweenLength(1, MAX_FACT_ITEMS)),
});

export type AccountUsageReported = Schema.Schema.Type<typeof AccountUsageReported>;

/**
 * The capability for `GithubTokenRequest` and `GithubTokenAnswer`. The runner
 * lists it at hello when it sends the request; the controller lists it when it
 * answers it. Both frames are new, so a controller on an older build cannot
 * decode the request and closes the socket, again after every reconnect. The
 * runner therefore sends `GithubTokenRequest` only when the controller's hello
 * lists this. `PROTOCOL_VERSION` does not change, because a peer without the
 * capability still works for everything else: the runner then keeps using the
 * copy of the token it got in `SessionStart`.
 */
export const GITHUB_TOKEN_CAPABILITY = "github-token";

/**
 * Sent by the runner when a session's `gh` command needs a GitHub token and
 * the runner's in-memory copy of its Connection's token has gone stale: too
 * old, or close to its expiry. The `gh` shim in the session asks the runner,
 * and the runner asks the controller here, because only the controller can
 * refresh a Connection's token.
 *
 * `sessionToken` is the session's own credential from `SessionStart.token`.
 * The controller finds the session by it and answers from that session's own
 * GitHub Connection only. The request names no Connection, so a session cannot
 * ask for another one's token. The controller answers with exactly one
 * `GithubTokenAnswer` carrying the same `requestId`.
 */
export const GithubTokenRequest = Schema.Struct({
  _tag: Schema.Literal("githubTokenRequest"),
  requestId: Fact,
  sessionToken: Fact,
});

export type GithubTokenRequest = Schema.Schema.Type<typeof GithubTokenRequest>;

/**
 * The reply to one `GithubTokenRequest`: either a token to use, or the reason
 * there is none. Two union members, and each forbids the other's keys, so a
 * frame that has both or neither does not decode and a reader cannot forget to
 * check which it is. `expiresAt` is absent when the token has no expiry.
 * `reason` is one human-readable line that the runner passes on to the person
 * running `gh`, for example that the Connection needs reconnecting.
 */
const GithubTokenGranted = Schema.Struct({
  _tag: Schema.Literal("githubTokenAnswer"),
  requestId: Fact,
  token: Fact,
  expiresAt: Schema.optionalKey(Timestamp),
  reason: Schema.optionalKey(Schema.Never),
});

const GithubTokenRefused = Schema.Struct({
  _tag: Schema.Literal("githubTokenAnswer"),
  requestId: Fact,
  reason: Fact,
  token: Schema.optionalKey(Schema.Never),
  expiresAt: Schema.optionalKey(Schema.Never),
});

export const GithubTokenAnswer = Schema.Union([GithubTokenGranted, GithubTokenRefused]);

export type GithubTokenAnswer = Schema.Schema.Type<typeof GithubTokenAnswer>;

/**
 * The most sessions one runner will ever report. A runner's own session cap,
 * `maxConcurrentSessions`, is about one session per 2 GiB of RAM by default
 * (spec 03 section 5.3). That is well under this limit, so the limit only
 * rejects a nonsense report.
 */
export const MAX_SESSIONS_PER_RUNNER = 256;

/** The sessions the runner's adapters actually hold, as `listSessions` found them. */
export const SessionsReport = Schema.Struct({
  _tag: Schema.Literal("sessionsReport"),
  sessions: Schema.Array(SessionBinding).check(Schema.isMaxLength(MAX_SESSIONS_PER_RUNNER)),
});

export type SessionsReport = Schema.Schema.Type<typeof SessionsReport>;
