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
 * Nothing here is reachable that HTTP cannot answer. A mutable topic pushes an
 * invalidation naming the changed records and the client refetches them over
 * HTTP; an append-only topic pushes the records themselves with a cursor. That
 * is why one streaming method carries a union rather than two methods carrying
 * one shape each.
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
import {
  CapExceeded,
  Forbidden,
  Internal,
  InvalidState,
  Unauthenticated,
  Validation,
} from "../errors";
import { Event } from "./event";

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

export const LiveTopic = Schema.Literals(LIVE_TOPICS);

export type LiveTopic = Schema.Schema.Type<typeof LiveTopic>;

export type MutableLiveTopic = (typeof MUTABLE_LIVE_TOPICS)[number];

export type AppendOnlyLiveTopic = (typeof APPEND_ONLY_LIVE_TOPICS)[number];

/** Whether a topic replays from a cursor rather than nudging a refetch. */
export const isAppendOnlyLiveTopic = (topic: LiveTopic): topic is AppendOnlyLiveTopic =>
  (APPEND_ONLY_LIVE_TOPICS as ReadonlyArray<string>).includes(topic);

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
 * An append-only topic's push: the records themselves and the position to
 * resume from. The cursor is opaque to the client, which stores it and echoes
 * it back and never parses it.
 */
export const Delta = Schema.Struct({
  _tag: Schema.Literal("delta"),
  cursor: Schema.String,
  items: Schema.Array(Event),
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
    error: Schema.Union([Unauthenticated, Forbidden, Validation, CapExceeded, Internal]),
    stream: true,
  }),
  Rpc.make("ping", {
    payload: {},
    success: Schema.Struct({}),
    error: Schema.Union([Unauthenticated, Internal]),
  }),
);
