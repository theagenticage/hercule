/**
 * Subscriptions: a session's standing claim on something that has not happened
 * yet.
 *
 * A session gives a Subscription Target - an External Ref, a run, a session or
 * a Permission Request - and the controller stores the CEL condition that
 * target expands into. When an event satisfies the condition, the event router
 * delivers it to the holder as Queued Input. The caller writes and reads back
 * the target; the event router evaluates the condition. The condition is
 * returned too, so the holder can see what it is really waiting for.
 *
 * The holder is always the session that asked. It is taken from the credential
 * and never from the payload, so a subscription cannot be planted on another
 * session.
 *
 * A target and a holder are both written as one token, `<kind>:<id>`, because
 * that is how an agent types them into a terminal. The codecs below do all of
 * that parsing and formatting, so a command line and a stored row can never
 * disagree about what a token means.
 */
import { Schema, SchemaGetter } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { ExternalRef, Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { markShorthand, markShorthandOnItself } from "../shorthand";
import { bounded } from "../strings";
import { EventId } from "./event";

/**
 * The longest id a target may hold. A target refers to one thing by its id, and
 * an id is a word, not a document.
 */
export const MAX_TARGET_ID_LENGTH = 512;

/**
 * The id of the thing a target waits on. It is not the `Id` schema: run ids
 * and Permission Request ids come from systems this version does not have
 * yet, and rejecting an id format before those systems exist would reject it
 * for the wrong reason.
 */
const TargetId = bounded(1, MAX_TARGET_ID_LENGTH);

/**
 * What a subscription waits on, in its wire form. The shorthand codec that
 * parses it from one typed word is attached to the export below.
 */
const TargetValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ref"), ref: ExternalRef }),
  Schema.Struct({ kind: Schema.Literal("run"), runId: TargetId }),
  Schema.Struct({ kind: Schema.Literal("session"), sessionId: TargetId }),
  Schema.Struct({ kind: Schema.Literal("request"), requestId: TargetId }),
]);

export type SubscriptionTarget = Schema.Schema.Type<typeof TargetValue>;

/** Every form a target may be written in, for the error message. */
const TARGET_FORMS =
  "write run:<run id>, session:<session id>, request:<permission request id>, " +
  "or an External Ref for a ref target: <system>:<kind>:<identity>";

/** Checks whether a typed word is an External Ref, using the schema that owns the grammar. */
const isExternalRef = Schema.is(ExternalRef);

/**
 * Parses one token into a target. Returns `undefined` when the token is not a
 * valid target.
 *
 * A known prefix takes precedence over the ref grammar, so refs of a system
 * called `run` could not be subscribed to. No such system exists, and a prefix
 * that silently became a ref would be worse: the subscription would wait on
 * something the caller never asked for.
 */
const parseTargetShorthand = (text: string): SubscriptionTarget | undefined => {
  const colon = text.indexOf(":");
  if (colon === -1) return undefined;
  const rest = text.slice(colon + 1);
  if (rest === "") return undefined;
  switch (text.slice(0, colon)) {
    case "run":
      return { kind: "run", runId: rest };
    case "session":
      return { kind: "session", sessionId: rest };
    case "request":
      return { kind: "request", requestId: rest };
    default:
      return isExternalRef(text) ? { kind: "ref", ref: text } : undefined;
  }
};

const writeTargetShorthand = (target: SubscriptionTarget): string => {
  switch (target.kind) {
    case "ref":
      return target.ref;
    case "run":
      return `run:${target.runId}`;
    case "session":
      return `session:${target.sessionId}`;
    case "request":
      return `request:${target.requestId}`;
  }
};

/**
 * A target as a person or an agent types it. The error message lists every
 * accepted form, because a token that matches none of them gives no clue which
 * form the writer meant.
 */
export const SubscriptionTargetFromShorthand = Schema.String.check(
  Schema.makeFilter((text: string) =>
    parseTargetShorthand(text) === undefined
      ? `${text} is not a valid Subscription Target: ${TARGET_FORMS}`
      : undefined,
  ),
).pipe(
  Schema.decodeTo(TargetValue, {
    // The check above has already rejected every token this cannot parse, so
    // the cast never sees `undefined`.
    decode: SchemaGetter.transform(
      (text: string) => parseTargetShorthand(text) as SubscriptionTarget,
    ),
    encode: SchemaGetter.transform(writeTargetShorthand),
  }),
);

/**
 * What a subscription waits on, as every payload and every record carries it.
 * The wire carries the whole target object; the shorthand codec is attached to
 * it, so a terminal can accept the one-word form instead and decode it here.
 */
export const SubscriptionTarget = markShorthand(TargetValue, SubscriptionTargetFromShorthand);

/** Who holds a subscription. Only a session can; v1 has no other kind of holder. */
export const SubscriptionHolder = Schema.Struct({
  kind: Schema.Literal("session"),
  id: Id,
});

export type SubscriptionHolder = Schema.Schema.Type<typeof SubscriptionHolder>;

const HOLDER_FORM = "write session:<session id>";

const parseHolderShorthand = (text: string): SubscriptionHolder | undefined =>
  text.startsWith("session:") ? { kind: "session", id: text.slice("session:".length) } : undefined;

/**
 * A holder as a query string carries it, in the same `<kind>:<id>` shorthand a
 * target uses, so a holder is written the same way everywhere. The struct
 * validates the id itself, so a malformed id is reported as an invalid id and
 * not as an unreadable token.
 *
 * The query string carries the typed word, so this codec is the field's own
 * schema and is annotated with itself.
 */
export const SubscriptionHolderFromShorthand = markShorthandOnItself(
  Schema.String.check(
    Schema.makeFilter((text: string) =>
      parseHolderShorthand(text) === undefined
        ? `${text} is not a valid subscription holder: ${HOLDER_FORM}`
        : undefined,
    ),
  ).pipe(
    Schema.decodeTo(SubscriptionHolder, {
      decode: SchemaGetter.transform(
        (text: string) => parseHolderShorthand(text) as SubscriptionHolder,
      ),
      encode: SchemaGetter.transform((holder) => `${holder.kind}:${holder.id}`),
    }),
  ),
);

/**
 * Whether the event router can evaluate this subscription's condition.
 *
 * An evaluation that fails counts as no match and never ends the
 * subscription: the condition is evaluated again on the next event, and the
 * failure is reported here so the holder can see why nothing arrives. The
 * health is set on the first failure, refreshed while failures continue, and
 * cleared by the next clean evaluation.
 */
export const SubscriptionHealth = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ok") }),
  Schema.Struct({
    state: Schema.Literal("error"),
    /** The evaluator's error message about the condition. */
    message: Schema.String,
    /** When this error began. */
    at: Timestamp,
  }),
]);

export type SubscriptionHealth = Schema.Schema.Type<typeof SubscriptionHealth>;

export const Subscription = Schema.Struct({
  id: Id,
  target: SubscriptionTarget,
  /** The CEL source the target expanded into, which is what the event router reads. */
  condition: Schema.String,
  holder: SubscriptionHolder,
  health: SubscriptionHealth,
  /**
   * The last wake-up a restart cancelled after it was sent and before it was
   * acknowledged. That event will not be delivered again. It is cleared when a
   * later wake-up for this subscription is written.
   */
  lostWakeUp: Schema.NullOr(Schema.Struct({ eventId: EventId, at: Timestamp })),
  createdAt: Timestamp,
});

export type Subscription = Schema.Schema.Type<typeof Subscription>;

/** The list is sorted by age only. */
export const SUBSCRIPTION_SORT_FIELDS = ["createdAt"] as const;

/** The payload of `subscription.create`. The holder comes from the credential. */
export const SubscriptionCreateInput = Schema.Struct({ target: SubscriptionTarget });

export type SubscriptionCreateInput = Schema.Schema.Type<typeof SubscriptionCreateInput>;

/** Which subscription was created, so the holder can cancel it later. */
export const SubscriptionCreated = Schema.Struct({ subscriptionId: Id });

export type SubscriptionCreated = Schema.Schema.Type<typeof SubscriptionCreated>;

export const subscription = HttpApiGroup.make("subscription")
  .add(
    HttpApiEndpoint.get("query", "/subscriptions", {
      query: Schema.Struct({
        holder: Schema.optionalKey(SubscriptionHolderFromShorthand),
        ...pageParams(SUBSCRIPTION_SORT_FIELDS).fields,
      }),
      success: page(Subscription),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.post("create", "/subscriptions", {
      payload: SubscriptionCreateInput,
      success: SubscriptionCreated,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.delete("cancel", "/subscriptions/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
