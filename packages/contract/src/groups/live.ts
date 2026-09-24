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
 * Nothing here is reachable that HTTP cannot answer, except one thing that is
 * never stored anywhere: a mutable topic pushes an invalidation naming the
 * changed records and the client refetches them over HTTP; an append-only
 * topic pushes the records themselves, with a cursor to resume from except for
 * `session:<id>:tap`, whose token deltas are never persisted and never replay.
 * That is why one streaming method carries a union rather than two methods
 * carrying one shape each.
 *
 * `hello`'s `v` and `subscribe`'s `topic` are declared wider than the values
 * they accept, and the handler narrows them. A payload the transport cannot
 * decode comes back as an untyped defect rather than one of the contract's
 * errors, so every version and every topic name is a value the handler gets to
 * see and answer for, and only a frame whose JSON types are wrong - which no
 * client built from this contract can send - fails before it.
 */
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { StreamKind } from "@hercule/protocol";
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

/** The protocol version `hello` agrees on. One conversation, one version. */
export const LIVE_PROTOCOL_VERSION = 1;

/**
 * Topics whose records are mutable: the push names the changed ids and the
 * client refetches them over HTTP.
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
] as const;

/**
 * Topics that are append-only logs: the push carries the records themselves,
 * and a cursor the client echoes back after a reconnect to replay from.
 */
export const APPEND_ONLY_LIVE_TOPICS = ["event"] as const;

export const LIVE_TOPICS = [...MUTABLE_LIVE_TOPICS, ...APPEND_ONLY_LIVE_TOPICS] as const;

/**
 * The two per-session append-only topics: `stream` is the durable coalesced
 * transcript, keyed and replayed exactly as `event` is; `tap` is the ephemeral
 * token deltas, which never persists and never replays. Parameterized by the
 * session id, so - unlike the flat topics above - they are a shape rather than
 * an enumerable list.
 */
export const SESSION_TOPIC_KINDS = ["stream", "tap"] as const;

export type SessionTopicKind = (typeof SESSION_TOPIC_KINDS)[number];

/** A per-session topic's shape on the wire, e.g. `session:s_1:stream`. */
export type SessionLiveTopic = `session:${string}:${SessionTopicKind}`;

/**
 * The one pattern a session topic matches - on the wire and when one is pulled
 * apart - so the schema that decodes it and the parser that reads its id and
 * kind can never disagree about what counts as one. The id excludes `:`, which
 * is what makes the split unambiguous.
 */
const SESSION_TOPIC_PATTERN = /^session:([^:]+):(stream|tap)$/;

/**
 * A pattern check does not narrow a schema's `Type` past `string`, so this
 * decodes any session topic but is not itself `SessionLiveTopic`; `LiveTopic`
 * below is declared by hand rather than derived from it, to keep the literal
 * precision `isAppendOnlyLiveTopic` narrows on.
 */
const SessionLiveTopicSchema = Schema.String.check(
  Schema.isPattern(SESSION_TOPIC_PATTERN, {
    title: "session live topic",
    description: "`session:<id>:stream` or `session:<id>:tap`",
  }),
);

export const LiveTopic = Schema.Union([Schema.Literals(LIVE_TOPICS), SessionLiveTopicSchema]);

export type MutableLiveTopic = (typeof MUTABLE_LIVE_TOPICS)[number];

export type AppendOnlyLiveTopic = (typeof APPEND_ONLY_LIVE_TOPICS)[number] | SessionLiveTopic;

export type LiveTopic = MutableLiveTopic | AppendOnlyLiveTopic;

/** Whether a topic replays from a cursor rather than nudging a refetch. */
export const isAppendOnlyLiveTopic = (topic: LiveTopic): topic is AppendOnlyLiveTopic =>
  (APPEND_ONLY_LIVE_TOPICS as ReadonlyArray<string>).includes(topic) ||
  SESSION_TOPIC_PATTERN.test(topic);

/** A session topic's id and kind, or nothing when the topic is not one. */
export const parseSessionTopic = (
  topic: string,
): { readonly sessionId: string; readonly kind: SessionTopicKind } | undefined => {
  const match = SESSION_TOPIC_PATTERN.exec(topic);
  if (match === null) return undefined;
  return { sessionId: match[1]!, kind: match[2] as SessionTopicKind };
};

/** The one session's durable transcript, as a topic name. */
export const buildSessionStreamTopic = (sessionId: string): SessionLiveTopic =>
  `session:${sessionId}:stream`;

/** The one session's ephemeral token taps, as a topic name. */
export const buildSessionTapTopic = (sessionId: string): SessionLiveTopic =>
  `session:${sessionId}:tap`;

/** Which way a record changed, as the audit kinds spell it. */
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
 * One token delta, as `session:<id>:tap` pushes it: the same fields
 * `content.delta` carries, minus the envelope a tap never needs (it is not
 * stored, so it has no session id, instant or provenance of its own).
 */
export const TapItem = Schema.Struct({
  turnId: Schema.String,
  itemId: Schema.String,
  streamKind: StreamKind,
  delta: Schema.String,
});

export type TapItem = Schema.Schema.Type<typeof TapItem>;

/**
 * An append-only topic's push: the records themselves and, for a topic that
 * replays, the position to resume from. The cursor is opaque to the client,
 * which stores it and echoes it back and never parses it. `session:<id>:tap`
 * carries none: it is never persisted per token and never replays, so there is
 * no position for it to resume from.
 */
export const Delta = Schema.Struct({
  _tag: Schema.Literal("delta"),
  cursor: Schema.optionalKey(Schema.String),
  items: Schema.Array(Schema.Union([Event, TranscriptRow, TapItem])),
});

export type Delta = Schema.Schema.Type<typeof Delta>;

/** What a subscription's stream carries, whichever family its topic is in. */
export const LiveMessage = Schema.Union([Delta, Invalidate]);

export type LiveMessage = Schema.Schema.Type<typeof LiveMessage>;

export const HelloResult = Schema.Struct({
  v: Schema.Literal(LIVE_PROTOCOL_VERSION),
  /** What the controller answers `controller.read` with, so a client can see skew. */
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
