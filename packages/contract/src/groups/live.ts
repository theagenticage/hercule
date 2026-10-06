/**
 * The live overlay: one WebSocket per client, carrying Live Topic
 * subscriptions and nothing else.
 *
 * Three methods. `hello` authenticates the connection with a ticket fetched
 * over HTTP, because a browser cannot set a header on a WebSocket handshake and
 * the long-lived bearer token must never ride in a URL. `subscribe` is one
 * streaming method per Live Topic; the client ends the stream to unsubscribe.
 * `ping` is an app-level keepalive, because a browser cannot send a WebSocket
 * ping frame.
 *
 * Everything sent here can also be read over HTTP, except the token deltas of
 * `session:<id>:tap`, which are never stored. Each kind of topic pushes
 * something different:
 *
 * - a mutable topic pushes an invalidation with the ids of the changed records,
 *   and the client refetches them over HTTP;
 * - an append-only topic pushes the records themselves, with a cursor to
 *   resume from;
 * - `session:<id>:tap` pushes token deltas, which are never stored and never
 *   replayed, so it has no cursor.
 *
 * That is why one streaming method returns a union, rather than two methods
 * returning one shape each.
 *
 * `hello`'s `v` and `subscribe`'s `topic` are declared wider than the values
 * they accept, and the handler narrows them. A payload the transport cannot
 * decode comes back as an untyped defect rather than one of the contract's
 * errors. Declaring them wide means the handler sees every version and every
 * topic name and can return a proper error. Only a frame with the wrong JSON
 * types - which no client built from this contract can send - fails before
 * the handler.
 */
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { StreamKind, SubagentId } from "@hercule/protocol";
import {
  CapExceeded,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Event } from "./event";
import { TranscriptRow } from "./transcript";

/** The protocol version `hello` agrees on. A connection uses one version throughout. */
export const LIVE_PROTOCOL_VERSION = 1;

/**
 * Topics whose records are mutable: the push holds the changed ids and the
 * client refetches the records over HTTP.
 */
export const MUTABLE_LIVE_TOPICS = [
  "task",
  "run",
  "session",
  "workflow",
  "connection",
  "notification",
  "runner",
  "plugin",
  "provider",
  "assistant",
  "conversation",
  // A subagent is read through its session, so this topic's invalidations
  // carry the ids of the sessions whose subagents changed.
  "subagent",
] as const;

/**
 * Topics that are append-only logs: the push carries the records themselves,
 * and a cursor the client echoes back after a reconnect to replay from.
 */
export const APPEND_ONLY_LIVE_TOPICS = ["event"] as const;

export const LIVE_TOPICS = [...MUTABLE_LIVE_TOPICS, ...APPEND_ONLY_LIVE_TOPICS] as const;

/**
 * The two per-agent append-only topics: `stream` is the durable coalesced
 * transcript, keyed and replayed exactly as `event` is; `tap` carries the
 * ephemeral token deltas, which are never stored and never replayed. They
 * include the session id, so unlike the topics above they are a pattern rather
 * than a fixed list.
 *
 * `session:<id>:stream` and `session:<id>:tap` carry the session's own agent.
 * Each subagent has its own pair, `session:<id>:subagent:<subagentId>:stream`
 * and `:tap`, so a screen showing one agent never receives another's tokens.
 */
export const SESSION_TOPIC_KINDS = ["stream", "tap"] as const;

export type SessionTopicKind = (typeof SESSION_TOPIC_KINDS)[number];

/**
 * A per-agent topic's shape on the wire, e.g. `session:s_1:stream` or
 * `session:s_1:subagent:a_1:tap`.
 */
export type SessionLiveTopic = `session:${string}:${SessionTopicKind}`;

/**
 * The pattern a session topic matches. Both the schema that decodes a session
 * topic and the parser that reads its ids and kind use it, so the two can
 * never disagree about what a session topic is. Neither a session id nor a
 * subagent id can contain `:`, which makes the split unambiguous.
 */
const SESSION_TOPIC_PATTERN = /^session:([^:]+)(?::subagent:([^:]+))?:(stream|tap)$/;

/**
 * A pattern check does not narrow a schema's `Type` past `string`, so this
 * decodes any session topic but is not itself `SessionLiveTopic`; `LiveTopic`
 * below is declared by hand rather than derived from it, to keep the literal
 * precision `isAppendOnlyLiveTopic` narrows on.
 */
const SessionLiveTopicSchema = Schema.String.check(
  Schema.isPattern(SESSION_TOPIC_PATTERN, {
    title: "session live topic",
    description:
      "`session:<id>:stream` or `session:<id>:tap`, or the same with `:subagent:<subagentId>` before the kind",
  }),
);

export const LiveTopic = Schema.Union([Schema.Literals(LIVE_TOPICS), SessionLiveTopicSchema]);

export type MutableLiveTopic = (typeof MUTABLE_LIVE_TOPICS)[number];

export type AppendOnlyLiveTopic = (typeof APPEND_ONLY_LIVE_TOPICS)[number] | SessionLiveTopic;

export type LiveTopic = MutableLiveTopic | AppendOnlyLiveTopic;

/** Checks whether a topic replays from a cursor rather than asking the client to refetch. */
export const isAppendOnlyLiveTopic = (topic: LiveTopic): topic is AppendOnlyLiveTopic =>
  (APPEND_ONLY_LIVE_TOPICS as ReadonlyArray<string>).includes(topic) ||
  SESSION_TOPIC_PATTERN.test(topic);

/**
 * Parses a session topic into its session id, its subagent id and its kind.
 * `subagentId` is absent for a topic of the session's own agent. Returns
 * `undefined` when the topic is not a session topic.
 */
export const parseSessionTopic = (
  topic: string,
):
  | {
      readonly sessionId: string;
      readonly subagentId?: SubagentId;
      readonly kind: SessionTopicKind;
    }
  | undefined => {
  const match = SESSION_TOPIC_PATTERN.exec(topic);
  if (match === null) return undefined;
  const [, sessionId, subagentId, kind] = match;
  return {
    sessionId: sessionId!,
    ...(subagentId === undefined ? {} : { subagentId }),
    kind: kind as SessionTopicKind,
  };
};

/** Builds the topic name of a session's durable transcript. */
export const buildSessionStreamTopic = (sessionId: string): SessionLiveTopic =>
  `session:${sessionId}:stream`;

/** Builds the topic name of a session's ephemeral token deltas. */
export const buildSessionTapTopic = (sessionId: string): SessionLiveTopic =>
  `session:${sessionId}:tap`;

/** Builds the topic name of one subagent's durable transcript. */
export const buildSubagentStreamTopic = (
  sessionId: string,
  subagentId: SubagentId,
): SessionLiveTopic => `session:${sessionId}:subagent:${subagentId}:stream`;

/** Builds the topic name of one subagent's ephemeral token deltas. */
export const buildSubagentTapTopic = (
  sessionId: string,
  subagentId: SubagentId,
): SessionLiveTopic => `session:${sessionId}:subagent:${subagentId}:tap`;

/**
 * Builds the topic name of one agent's durable transcript: the session's own
 * agent when `subagentId` is undefined, else that subagent.
 */
export const buildAgentStreamTopic = (
  sessionId: string,
  subagentId: SubagentId | undefined,
): SessionLiveTopic =>
  subagentId === undefined
    ? buildSessionStreamTopic(sessionId)
    : buildSubagentStreamTopic(sessionId, subagentId);

/**
 * Builds the topic name of one agent's ephemeral token deltas: the session's
 * own agent when `subagentId` is undefined, else that subagent.
 */
export const buildAgentTapTopic = (
  sessionId: string,
  subagentId: SubagentId | undefined,
): SessionLiveTopic =>
  subagentId === undefined
    ? buildSessionTapTopic(sessionId)
    : buildSubagentTapTopic(sessionId, subagentId);

/** How a record changed, spelled as in the audit kinds. */
export const InvalidateKind = Schema.Literals(["created", "updated", "deleted"]);

export type InvalidateKind = Schema.Schema.Type<typeof InvalidateKind>;

/** A mutable topic's push: which records changed, and how. */
export const Invalidate = Schema.Struct({
  _tag: Schema.Literal("invalidate"),
  ids: Schema.Array(Schema.String),
  kind: InvalidateKind,
});

export type Invalidate = Schema.Schema.Type<typeof Invalidate>;

/**
 * One token delta, as a `tap` topic pushes it: the same fields as
 * `content.delta`, without the envelope. A tap is not stored, so it needs no
 * session id, timestamp or provenance of its own. `subagentId` names the
 * subagent that produced it; it is absent for the session's own agent.
 */
export const TapItem = Schema.Struct({
  turnId: Schema.String,
  itemId: Schema.String,
  streamKind: StreamKind,
  delta: Schema.String,
  subagentId: Schema.optionalKey(SubagentId),
});

export type TapItem = Schema.Schema.Type<typeof TapItem>;

/**
 * An append-only topic's push: the records themselves and, for a topic that
 * replays, the position to resume from. The cursor is opaque to the client,
 * which stores it, sends it back and never parses it. `session:<id>:tap` has
 * no cursor: its deltas are never stored and never replayed, so there is no
 * position to resume from.
 */
export const Delta = Schema.Struct({
  _tag: Schema.Literal("delta"),
  cursor: Schema.optionalKey(Schema.String),
  items: Schema.Array(Schema.Union([Event, TranscriptRow, TapItem])),
});

export type Delta = Schema.Schema.Type<typeof Delta>;

/** A message on a subscription's stream, for either kind of topic. */
export const LiveMessage = Schema.Union([Delta, Invalidate]);

export type LiveMessage = Schema.Schema.Type<typeof LiveMessage>;

export const HelloResult = Schema.Struct({
  v: Schema.Literal(LIVE_PROTOCOL_VERSION),
  /** The version `controller.read` returns, so a client can detect a version mismatch. */
  serverVersion: Schema.NonEmptyString,
});

export type HelloResult = Schema.Schema.Type<typeof HelloResult>;

export const live = RpcGroup.make(
  Rpc.make("hello", {
    payload: { v: Schema.Number, ticket: Schema.String },
    success: HelloResult,
    error: Schema.Union([Unauthenticated, Validation, InvalidState, Internal]),
  }),
  Rpc.make("subscribe", {
    payload: { topic: Schema.String, cursor: Schema.optionalKey(Schema.String) },
    success: LiveMessage,
    error: Schema.Union([Unauthenticated, Forbidden, Validation, NotFound, CapExceeded, Internal]),
    stream: true,
  }),
  Rpc.make("ping", {
    payload: {},
    success: Schema.Struct({}),
    error: Schema.Union([Unauthenticated, Internal]),
  }),
);
