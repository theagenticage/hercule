/**
 * Reminders: one-shot Scheduled Wakes. A reminder belongs to a conversation,
 * and at its time its text arrives in that conversation as input, so the
 * assistant speaks. The assistant sets one on itself, or the user sets one.
 *
 * A reminder belongs to the conversation, not to a session, so it outlives a
 * rotation unchanged. A reminder whose time passed while the controller was
 * down fires late, as soon as the controller is back.
 */
import { Schema } from "effect";
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
import { Actor, Id, Timestamp, TimestampWithOffset } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { Prompt } from "./session";

/**
 * Where a reminder is in its life:
 *
 * - `pending`: its time has not come yet.
 * - `fired`: its text was given to the conversation.
 * - `cancelled`: it was cancelled before its time.
 */
export const ReminderStatus = Schema.Literals(["pending", "fired", "cancelled"]);

export type ReminderStatus = Schema.Schema.Type<typeof ReminderStatus>;

export const Reminder = Schema.Struct({
  id: Id,
  /** The conversation the reminder's text arrives in. */
  conversationId: Id,
  /** When the reminder fires. */
  at: Timestamp,
  /** The text the assistant is given when the reminder fires. */
  text: Prompt,
  status: ReminderStatus,
  /** Who set the reminder: `user` or `session:<id>`. */
  actor: Actor,
  createdAt: Timestamp,
  /** When the reminder fired; null while it is pending or once it is cancelled. */
  firedAt: Schema.NullOr(Timestamp),
});

export type Reminder = Schema.Schema.Type<typeof Reminder>;

/** The list is sorted by the time each reminder fires. */
export const REMINDER_SORT_FIELDS = ["at"] as const;

/** The filters of `reminder.query`. */
export const ReminderFilter = Schema.Struct({
  /**
   * Only this conversation's reminders. A session token may leave it out and
   * gets its own conversation's; a user credential lists every conversation's.
   */
  conversationId: Schema.optionalKey(Id),
  status: Schema.optionalKey(ReminderStatus),
});

/**
 * The payload of `reminder.create`. A session token sets a reminder on its own
 * conversation and leaves `conversationId` out; a user credential names it.
 */
export const ReminderCreateInput = Schema.Struct({
  conversationId: Schema.optionalKey(Id),
  at: TimestampWithOffset,
  text: Prompt,
});

export type ReminderCreateInput = Schema.Schema.Type<typeof ReminderCreateInput>;

/** Which reminder was created, so it can be cancelled later. */
export const ReminderCreated = Schema.Struct({ reminderId: Id });

export type ReminderCreated = Schema.Schema.Type<typeof ReminderCreated>;

export const reminder = HttpApiGroup.make("reminder")
  .add(
    HttpApiEndpoint.get("query", "/reminders", {
      query: Schema.Struct({
        ...ReminderFilter.fields,
        ...pageParams(REMINDER_SORT_FIELDS).fields,
      }),
      success: page(Reminder),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/reminders", {
      payload: ReminderCreateInput,
      success: ReminderCreated,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("cancel", "/reminders/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
