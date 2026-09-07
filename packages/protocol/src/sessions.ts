/**
 * Sessions on the wire: what the controller authors, what the runner reports
 * back, and the one normalized vocabulary every provider's traffic is turned
 * into before it leaves the machine it ran on (spec 06 sections 4 and 6).
 *
 * Normalization happens at the runner, so this file is the whole contract a
 * consumer of a session reads. Enums are open for consumers: an `unknown` item
 * kind and a `raw` passthrough exist so a vendor message nobody mapped is
 * carried rather than dropped.
 */
import { Schema } from "effect";

import { Fact, InstanceId, MAX_FACT_LENGTH, Sequenced, SessionId } from "./primitives";

/**
 * How much of a session a caller may act on without being asked (spec 06
 * section 2). It rides `SessionSpec`, so the protocol owns it and the plugin
 * host re-exports it; a definition on each side would be two vocabularies that
 * drift.
 */
export const AccessMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

export type AccessMode = Schema.Schema.Type<typeof AccessMode>;

/**
 * The longest piece of free text a harness may put in an event. A `Fact` is
 * wrong for these: an error body or a stack trace is a document, and one over
 * 512 bytes would be an undecodable frame, which costs the runner its socket
 * and every session on it.
 */
export const MAX_MESSAGE_LENGTH = 4096;

const Message = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH));

/** The model and the per-model choices a turn runs with (spec 06 section 4). */
export const ModelSelection = Schema.Struct({
  model: Fact,
  options: Schema.Record(Fact, Schema.Union([Schema.String, Schema.Boolean])),
});

export type ModelSelection = Schema.Schema.Type<typeof ModelSelection>;

/**
 * What the controller authors for one session: ids, never paths (ADR 0002).
 * The runner resolves it to a `ProviderRunnerContext` on its own machine.
 *
 * The row that stores this keeps it byte for byte, so a field is added here
 * only when something sends it: `continue`, `outputSchema`, `mcpServers`,
 * `systemPrompt` and `disallowedTools` are spec 06 section 4 fields whose
 * features (resume and fork, structured output, MCP passthrough, agents) are
 * not built yet, and each arrives with the one that needs it.
 */
export const SessionSpec = Schema.Struct({
  instanceId: InstanceId,
  /** `null` is a workspace-less session: the runner gives it a scratch cwd. */
  workspaceId: Schema.NullOr(Fact),
  modelSelection: ModelSelection,
  /** Post-fallback: always a mode the target provider declares native. */
  accessMode: AccessMode,
});

export type SessionSpec = Schema.Schema.Type<typeof SessionSpec>;

/**
 * The explicit join between a Hydra session and the provider-native object
 * behind it. The two ids are separate concepts and nothing else joins them.
 */
export const SessionBinding = Schema.Struct({
  sessionId: SessionId,
  nativeSessionId: Fact,
  instanceId: InstanceId,
});

export type SessionBinding = Schema.Schema.Type<typeof SessionBinding>;

/**
 * The user input for one turn. Text only: attachments are the open item in spec
 * 16 section B, and the pinned `modelSelection` of spec 06 section 4 arrives
 * with the composer that changes a model mid-thread.
 */
export const TurnInput = Schema.Struct({ text: Schema.String });

export type TurnInput = Schema.Schema.Type<typeof TurnInput>;

/**
 * Why a session is gone (spec 06 section 4.1). Pinned, because `resumable` and
 * the session view both read it: `stopped` was asked for, `process_exit` and
 * `crash` were not, `idle_unload` and `runner_restart` may leave native state
 * behind.
 */
export const ExitReason = Schema.Literals([
  "stopped",
  "process_exit",
  "idle_unload",
  "runner_restart",
  "crash",
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
 * The three append-only text streams. There is no fourth: where a vendor sends
 * raw and summarized reasoning separately the adapter picks one channel, raw
 * preferred, and the other stays raw-only (spec 06 section 6.4).
 */
export const StreamKind = Schema.Literals(["assistant_text", "reasoning_text", "command_output"]);

export type StreamKind = Schema.Schema.Type<typeof StreamKind>;

const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Money = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * A cumulative token snapshot for the session, not a per-turn delta; cadence
 * differs per harness and the snapshot shape absorbs that. The cache counts are
 * optional because only some harnesses report them, and `costUsd` because only
 * some price the turn (spec 06 section 6.6).
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
 * The fields every normalized event carries. `raw` is the untouched vendor
 * payload under the name of the channel it came off, e.g. `claude.sdk.message`:
 * the escape hatch that keeps a trimmed taxonomy honest.
 *
 * Only the fields every member carries identically are here. `turnId` and
 * `itemId` are declared per member instead: an event about a turn or an item
 * requires its id, the rest have nothing to put in it, and a member that
 * restated a base field would be widening it rather than narrowing it.
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

const event = <const Tag extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
) => Schema.Struct({ _tag: Schema.Literal(tag), ...base, ...fields });

const SessionStarted = event("session.started", {});

const SessionExited = event("session.exited", { reason: ExitReason });

/**
 * A completion the controller cannot bracket against its start is not a turn
 * boundary, so the id is required on both.
 */
const TurnStarted = event("turn.started", { turnId: Fact, model: Schema.optionalKey(Fact) });

const TurnCompleted = event("turn.completed", {
  turnId: Fact,
  state: TurnState,
  usage: Schema.optionalKey(Usage),
  /** This turn's cost, where the harness prices a turn; `usage` is cumulative. */
  costUsd: Schema.optionalKey(Money),
  error: Schema.optionalKey(Message),
});

/**
 * `detail` is kind-specific and stays Json here: its shape is the adapter's to
 * decide per kind, a consumer that does not know a kind renders it generically,
 * and pinning twelve shapes in the protocol would freeze what each harness may
 * yet report.
 */
const itemFields = {
  /** Every item belongs to a turn; unsolicited output gets a synthetic one. */
  turnId: Fact,
  itemId: Fact,
  kind: ItemKind,
  detail: Schema.optionalKey(Schema.Json),
};

const ItemStarted = event("item.started", itemFields);

const ItemUpdated = event("item.updated", itemFields);

const ItemCompleted = event("item.completed", { ...itemFields, status: ItemStatus });

/**
 * Append-only text for one (item, streamKind). Unbounded, unlike the facts a
 * peer states about itself: this is the payload, and cutting it would lose
 * output rather than refuse a claim.
 */
const ContentDelta = event("content.delta", {
  turnId: Fact,
  itemId: Fact,
  streamKind: StreamKind,
  delta: Schema.String,
});

const SessionUsageUpdated = event("session.usage.updated", { usage: Usage });

/** Either may fire inside a turn or between turns, so the turn id is optional. */
const RuntimeWarning = event("runtime.warning", {
  turnId: Schema.optionalKey(Fact),
  message: Message,
});

/**
 * `class` is the one open vocabulary here. Codex's `codexErrorInfo` enum is the
 * reference set every adapter maps into as far as it can, with `unknown` for
 * the rest; it stays a string rather than a literal union because a harness
 * naming a class this build has not heard of should still reach the user.
 */
const RuntimeError = event("runtime.error", {
  turnId: Schema.optionalKey(Fact),
  class: Fact,
  message: Schema.optionalKey(Message),
});

export const ProviderEvent = Schema.Union([
  SessionStarted,
  SessionExited,
  TurnStarted,
  TurnCompleted,
  ItemStarted,
  ItemUpdated,
  ItemCompleted,
  ContentDelta,
  SessionUsageUpdated,
  RuntimeWarning,
  RuntimeError,
]);

export type ProviderEvent = Schema.Schema.Type<typeof ProviderEvent>;

/**
 * Start one session. It carries the instance's decoded config the way a probe
 * does, because the runner holds no Hydra state and cannot look it up.
 */
export const SessionStart = Schema.Struct({
  _tag: Schema.Literal("sessionStart"),
  sessionId: SessionId,
  providerId: Fact,
  config: Schema.Json,
  spec: SessionSpec,
});

export type SessionStart = Schema.Schema.Type<typeof SessionStart>;

export const SessionStop = Schema.Struct({
  _tag: Schema.Literal("sessionStop"),
  sessionId: SessionId,
});

export type SessionStop = Schema.Schema.Type<typeof SessionStop>;

export const SessionInput = Schema.Struct({
  _tag: Schema.Literal("sessionInput"),
  sessionId: SessionId,
  input: TurnInput,
});

export type SessionInput = Schema.Schema.Type<typeof SessionInput>;

/**
 * The first replayable runner event: one normalized event, under the sequence
 * number that lets the controller insert it exactly once.
 */
export const SessionEvent = Schema.Struct({
  _tag: Schema.Literal("sessionEvent"),
  ...Sequenced.fields,
  event: ProviderEvent,
});

export type SessionEvent = Schema.Schema.Type<typeof SessionEvent>;

/**
 * The most sessions one runner will ever report. Bounded like every other array
 * on this wire; the per-runner session cap (spec 03 section 5.3) is well under
 * it, so the limit refuses a nonsense report rather than a real one.
 */
export const MAX_SESSIONS_PER_RUNNER = 256;

/** What the runner's adapters actually hold, as `listSessions` found them. */
export const SessionsReport = Schema.Struct({
  _tag: Schema.Literal("sessionsReport"),
  sessions: Schema.Array(SessionBinding).check(Schema.isMaxLength(MAX_SESSIONS_PER_RUNNER)),
});

export type SessionsReport = Schema.Schema.Type<typeof SessionsReport>;
