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
import { atMost } from "../strings";
import { Attachment, AttachmentId, MAX_ATTACHMENTS_PER_INPUT } from "./attachment";
import { EMPTY_PROMPT_MESSAGE, PromptText, SessionInputOutcome } from "./session";

/**
 * Where an input came from:
 *
 * - `user`: an input someone sent. That is a person, a session, or a workflow
 *   run sending an agent step's prompt; the input's actor names which one.
 * - `subscription`: an input a subscription match created.
 * - `heartbeat` and `reminder`: not written yet. They are already in the
 *   schema, so the scheduled-wake feature needs no migration.
 */
export const INPUT_SOURCES = ["user", "subscription", "heartbeat", "reminder"] as const;

export const InputSource = Schema.Literals(INPUT_SOURCES);

export type InputSource = Schema.Schema.Type<typeof InputSource>;

/**
 * The statuses of an input:
 *
 * - `queued`: the input waits to be sent, or is on its way to the runner. The
 *   queue is the set of rows still `queued`.
 * - `sent`: the input left the controller, and the runner never confirmed it.
 *   Only an agent step's prompt ends here: it is never sent again, because
 *   the runner may have run it, and the runner's answer about the step
 *   settles the step. A confirmation that arrives later still turns it
 *   `delivered`.
 * - `delivered`: the runner took the input. Final.
 * - `cancelled`: the input will never be sent. Final.
 */
export const INPUT_STATUSES = ["queued", "sent", "delivered", "cancelled"] as const;

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
  /** The images sent with the text, in the order the user attached them. */
  attachments: Schema.Array(Attachment),
  status: InputStatus,
  /** What the runner reported this input did, once it was delivered. */
  delivery: Schema.NullOr(Delivery),
  createdAt: Timestamp,
  deliveredAt: Schema.NullOr(Timestamp),
  /**
   * When the input was sent, while the runner has not answered: on a `queued`
   * row on its way to the runner, and on a `sent` row. Null otherwise.
   */
  sentAt: Schema.NullOr(Timestamp),
  /** Why a delivery failed, on a row that is still queued or that the failure ended; null otherwise. */
  reason: Schema.NullOr(Schema.String),
});

export type Input = Schema.Schema.Type<typeof Input>;

/**
 * Declared separately from the payload, so a service can spread these fields
 * next to the two ids. `attachments`, when given, replaces the input's images;
 * when left out, the input keeps them. Whether an empty text leaves the input
 * with no images depends on the stored input, so the service checks that
 * case; the payload refuses only the case it can see (`refuseEmptyInputUpdate`).
 */
export const INPUT_UPDATE_FIELDS = {
  text: PromptText,
  attachments: Schema.optionalKey(atMost(AttachmentId, MAX_ATTACHMENTS_PER_INPUT)),
} as const;

/**
 * Refuses an input update that would leave the input with no text and no
 * images: empty text with an empty `attachments`. Empty text without
 * `attachments` passes, because the input keeps the images it has; the
 * service refuses it when the input has none. The issue is at `text`, with
 * the same message as `refuseEmptyPrompt`.
 */
export const refuseEmptyInputUpdate = Schema.makeFilter(
  (update: { readonly text: string; readonly attachments?: ReadonlyArray<string> }) =>
    update.text.length > 0 || update.attachments === undefined || update.attachments.length > 0
      ? undefined
      : { path: ["text"], issue: EMPTY_PROMPT_MESSAGE },
);

export const InputUpdatePayload = closedStruct(INPUT_UPDATE_FIELDS).check(refuseEmptyInputUpdate);

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
