/**
 * Subscriptions: a session's standing claim on something that has not happened
 * yet.
 *
 * A session names a Subscription Target - an External Ref, a run, a session or
 * a Permission Request - and the controller stores the CEL condition that
 * target expands into. When an event satisfies the condition, the matcher
 * delivers it to the holder as Queued Input. The target is what a caller
 * writes and reads back; the condition is what the matcher evaluates, and it
 * is answered so the holder can see what it is really waiting for.
 *
 * The holder is always the session that asked. It is taken from the credential
 * and never from the payload, so a subscription cannot be planted on another
 * session.
 *
 * A target and a holder are both written as one token, `<kind>:<id>`, because
 * that is how an agent types them into a terminal. The codecs below are the
 * whole of that parsing, in both directions, so a command line and a stored
 * row can never disagree about what a token means.
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
import { EXTERNAL_REF_PATTERN, ExternalRef, Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { markShorthand } from "../shorthand";
import { bounded } from "../strings";

/**
 * The longest id a target may name. A target names one thing by its id, and an
 * id is a word, not a document.
 */
export const MAX_SUBSCRIPTION_SUBJECT_LENGTH = 512;

/**
 * The id of the thing a target waits on. It is not the `Id` schema: a run id
 * and a Permission Request id are written by systems this version does not
 * have yet, and refusing a shape before the thing exists would refuse it for
 * the wrong reason.
 */
const Subject = bounded(1, MAX_SUBSCRIPTION_SUBJECT_LENGTH);

/**
 * What a subscription waits on, as it travels on the wire. The shorthand that
 * reads it from one written word is marked on the export below.
 */
const TargetValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ref"), ref: ExternalRef }),
  Schema.Struct({ kind: Schema.Literal("run"), runId: Subject }),
  Schema.Struct({ kind: Schema.Literal("session"), sessionId: Subject }),
  Schema.Struct({ kind: Schema.Literal("request"), requestId: Subject }),
]);

export type SubscriptionTarget = Schema.Schema.Type<typeof TargetValue>;

/** Every form a target may be written in, as a refusal has to name them. */
const TARGET_FORMS =
  "write run:<run id>, session:<session id>, request:<permission request id>, " +
  "or an External Ref for a ref target: <system>:<kind>:<identity>";

/**
 * The target one token stands for, or `undefined` when it stands for none.
 *
 * A prefix wins over the ref grammar, so a system that called itself `run`
 * could not be subscribed to by its refs. No system does, and a prefix that
 * silently became a ref would be worse: the subscription would wait on
 * something the caller never named.
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
      return EXTERNAL_REF_PATTERN.test(text) ? { kind: "ref", ref: text } : undefined;
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
 * A target as a person and an agent type it. The refusal names every accepted
 * form, because a token that parses as none of them gives the writer no clue
 * which one they were close to.
 */
export const SubscriptionTargetFromShorthand = Schema.String.check(
  Schema.makeFilter((text: string) =>
    parseTargetShorthand(text) === undefined
      ? `${text} names no Subscription Target: ${TARGET_FORMS}`
      : undefined,
  ),
).pipe(
  Schema.decodeTo(TargetValue, {
    // The check above has already refused every token this cannot read, so the
    // cast is over a case that cannot arrive.
    decode: SchemaGetter.transform(
      (text: string) => parseTargetShorthand(text) as SubscriptionTarget,
    ),
    encode: SchemaGetter.transform(writeTargetShorthand),
  }),
);

/**
 * What a subscription waits on, as every payload and every record carries it.
 * The wire carries the whole target; the shorthand is marked on it, so a
 * terminal can take the one word instead and decode it here.
 */
export const SubscriptionTarget = markShorthand(TargetValue, SubscriptionTargetFromShorthand);

/** Who holds a subscription. Only a session may, and v1 has no second kind. */
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
 * target uses, so a holder is one spelling everywhere. The id itself is
 * checked by the struct, so a malformed id is reported as an id and not as an
 * unreadable token.
 *
 * The wire carries the written word here, so this codec is a field's own
 * schema and is marked with itself.
 */
const HolderFromShorthand = Schema.String.check(
  Schema.makeFilter((text: string) =>
    parseHolderShorthand(text) === undefined
      ? `${text} names no subscription holder: ${HOLDER_FORM}`
      : undefined,
  ),
).pipe(
  Schema.decodeTo(SubscriptionHolder, {
    decode: SchemaGetter.transform(
      (text: string) => parseHolderShorthand(text) as SubscriptionHolder,
    ),
    encode: SchemaGetter.transform((holder) => `${holder.kind}:${holder.id}`),
  }),
);

export const SubscriptionHolderFromShorthand = markShorthand(
  HolderFromShorthand,
  HolderFromShorthand,
);

/**
 * Whether the matcher can still evaluate this subscription's condition.
 *
 * An evaluation that fails is a no-match and never an end: the condition is
 * evaluated again on the next event, and the failure is reported here so the
 * holder can see why nothing arrives.
 */
export const SubscriptionHealth = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ok") }),
  Schema.Struct({
    state: Schema.Literal("error"),
    message: Schema.String,
    /** When the current run of failures began. */
    at: Timestamp,
  }),
]);

export type SubscriptionHealth = Schema.Schema.Type<typeof SubscriptionHealth>;

export const Subscription = Schema.Struct({
  id: Id,
  target: SubscriptionTarget,
  /** The CEL source the target expanded into, which is what the matcher reads. */
  condition: Schema.String,
  holder: SubscriptionHolder,
  health: SubscriptionHealth,
  createdAt: Timestamp,
  /**
   * When the subscription stopped waiting. A listing answers live
   * subscriptions only, so it is absent there; it is the field an ended
   * subscription is read back through.
   */
  endedAt: Schema.optionalKey(Timestamp),
});

export type Subscription = Schema.Schema.Type<typeof Subscription>;

/** A listing is a history of what a session is waiting for, and is walked by age. */
export const SUBSCRIPTION_SORT_FIELDS = ["createdAt"] as const;

/** What creating a subscription takes. The holder comes from the credential. */
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
      error: [Unauthenticated, Forbidden, Validation, InvalidState, Internal],
    }),
    HttpApiEndpoint.delete("cancel", "/subscriptions/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
