/**
 * The inputs a session was given, as the API sees them.
 *
 * Every input a caller sends is stored as one of these before it goes
 * anywhere, so this listing is the session's whole input history and not only
 * what is still waiting. A row still `queued` is the part a caller can act on:
 * it can be rewritten or cancelled until the controller delivers it.
 *
 * An owned sub-resource of the session, so the path is the session's and the id
 * in `:inputId` is the row's.
 */
import { Schema } from "effect";
import { Delivery } from "@hercule/protocol";
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
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { Prompt, SessionInputOutcome } from "./session";

/**
 * Where an input came from. Only `user` is written in this build. The other
 * values are already in the schema, so the subscription and scheduled-wake
 * features need no migration.
 */
export const INPUT_SOURCES = ["user", "subscription", "heartbeat", "reminder"] as const;

export const InputSource = Schema.Literals(INPUT_SOURCES);

export type InputSource = Schema.Schema.Type<typeof InputSource>;

/** `delivered` and `cancelled` are final. The queue is the set of rows still `queued`. */
export const INPUT_STATUSES = ["queued", "delivered", "cancelled"] as const;

export const InputStatus = Schema.Literals(INPUT_STATUSES);

export type InputStatus = Schema.Schema.Type<typeof InputStatus>;

/**
 * One input a session was given, whatever became of it. Queued Input is only
 * the rows still `queued` (CONTEXT.md), which is a state of this row and not a
 * kind of its own.
 */
export const Input = Schema.Struct({
  id: Id,
  sessionId: Id,
  source: InputSource,
  actor: Schema.String,
  text: Schema.String,
  status: InputStatus,
  /** What the runner reported this input did, once it was delivered. */
  delivery: Schema.NullOr(Delivery),
  createdAt: Timestamp,
  deliveredAt: Schema.NullOr(Timestamp),
  /** Set while the row has been sent to the runner and no reply has arrived; null otherwise. */
  sentAt: Schema.NullOr(Timestamp),
  /** Why a delivery failed, on a row that is still queued or that the failure ended; null otherwise. */
  reason: Schema.NullOr(Schema.String),
});

export type Input = Schema.Schema.Type<typeof Input>;

/** Declared separately from the payload, so a service can spread these fields next to the two ids. */
export const INPUT_UPDATE_FIELDS = { text: Prompt } as const;

export const InputUpdatePayload = closedStruct(INPUT_UPDATE_FIELDS);

export type InputUpdatePayload = Schema.Schema.Type<typeof InputUpdatePayload>;

/** The only order of an input list: the order the inputs were sent in. */
export const INPUT_SORT_FIELDS = ["createdAt"] as const;

export const input = HttpApiGroup.make("input")
  .add(
    HttpApiEndpoint.get("query", "/sessions/:id/inputs", {
      params: { id: Id },
      query: pageParams(INPUT_SORT_FIELDS),
      success: page(Input),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.patch("update", "/sessions/:id/inputs/:inputId", {
      params: { id: Id, inputId: Id },
      payload: InputUpdatePayload,
      success: Input,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.delete("cancel", "/sessions/:id/inputs/:inputId", {
      params: { id: Id, inputId: Id },
      success: Input,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("steer", "/sessions/:id/inputs/:inputId/steer", {
      params: { id: Id, inputId: Id },
      success: SessionInputOutcome,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
