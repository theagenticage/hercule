/**
 * What the controller daemon's Scheduler wakes an assistant for (spec 12
 * sections 5.2, 8.2 and 8.3). Each kind of wake gives input to a conversation
 * through `ConversationWakes`, as Queued Input, and never enters the event
 * pipeline:
 *
 * - A heartbeat fires at each time of the assistant's heartbeat schedule, and
 *   gives its prompt to the conversation its target names. A time missed
 *   while the controller was down is skipped, as a cron trigger's is: a
 *   heartbeat is a cadence, not a promise.
 * - A reminder fires once its time has come, even late, because the
 *   controller was down: a reminder is a promise.
 * - A daily rotation rotates every conversation of the assistant whose newest
 *   session was created before the latest `rotation.dailyAt` and has had a
 *   turn.
 *
 * A schedule with no timezone of its own is read in the user's timezone
 * setting.
 */
import * as Context from "effect/Context";
import * as Cron from "effect/Cron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Heartbeat, Reminder, Rotation } from "@hercule/contract";
import { conversationRepository } from "../conversations";
import { withTransaction } from "../db";
import { reminderRepository } from "../reminders";
import { sessionRepository } from "../sessions";
import { Settings } from "../settings";
import { decideFiring } from "../workflows";
import { assistantRepository, type ScheduledAssistant } from "./repository";
import { ConversationWakes, type WakeError } from "./wakes";

/** One wake the Scheduler has to fire. */
export type DueWake =
  | { readonly _tag: "heartbeat"; readonly assistantId: string }
  | { readonly _tag: "reminder"; readonly reminder: Reminder }
  | { readonly _tag: "dailyRotation"; readonly conversationId: string };

/**
 * Returns the latest time at or before `now` that the daily rotation's
 * `dailyAt` names, read in `zone`, or `none` when `zone` is not a known
 * timezone.
 */
const findLatestDailyRotation = (
  rotation: Rotation,
  zone: string,
  now: Date,
): Option.Option<Date> => {
  const [hour, minute] = rotation.dailyAt.split(":");
  const parsed = Cron.parse(`${Number(minute)} ${Number(hour)} * * *`, zone);
  return Result.isFailure(parsed)
    ? Option.none()
    : Option.some(Cron.prev(parsed.success, Cron.next(parsed.success, now)));
};

/**
 * Checks whether the assistant's heartbeat has work at `now`: it fires, or
 * its next time has to be computed because it has none or the one it has was
 * computed in another timezone.
 */
const hasHeartbeatWork = (assistant: ScheduledAssistant, zone: string, now: Date): boolean =>
  assistant.heartbeat.enabled &&
  (assistant.heartbeatNextAt === null ||
    assistant.heartbeatNextZone !== zone ||
    Date.parse(assistant.heartbeatNextAt) <= now.getTime());

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings;
  const wakes = yield* ConversationWakes;
  const assistants = yield* assistantRepository;
  const conversations = yield* conversationRepository;
  const reminders = yield* reminderRepository;
  const sessions = yield* sessionRepository;

  /**
   * Returns the conversation a heartbeat wakes the assistant in: the web
   * conversation, or for `most-recent` the one the owner wrote in last.
   * Returns `none` when the assistant has no web conversation to fall back on.
   */
  const readHeartbeatConversation = (
    assistantId: string,
    target: Heartbeat["target"],
  ): Effect.Effect<Option.Option<string>, SqlError> =>
    Effect.gen(function* () {
      if (target === "most-recent") {
        const latest = yield* conversations.readLatestOwnerConversationId(assistantId);
        if (Option.isSome(latest)) return latest;
      }
      const main = yield* conversations.readMainConversationIds([assistantId]);
      return Option.fromNullishOr(main.get(assistantId));
    });

  /**
   * Fires the assistant's heartbeat if one of its times has come, and moves
   * its next time on. The assistant is read again, because it may have been
   * edited or deleted since it was listed. The wake and the next time are
   * written in one transaction, so a heartbeat never fires twice for one time.
   */
  const fireHeartbeat = (assistantId: string, now: Date): Effect.Effect<void, WakeError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const found = yield* assistants.readScheduled(assistantId);
        if (Option.isNone(found)) return;
        const assistant = found.value;
        const { heartbeat } = assistant;
        const zone = heartbeat.timezone ?? (yield* settings.readOwnerTimezone());
        if (!hasHeartbeatWork(assistant, zone, now)) return;
        const parsed = Cron.parse(heartbeat.schedule, zone);
        if (Result.isFailure(parsed)) {
          // A save checks both the schedule and the timezone, so this is a
          // timezone a newer timezone database dropped.
          return yield* Effect.logWarning("A heartbeat's schedule cannot be read", {
            assistantId,
            zone,
            error: parsed.failure.message,
          });
        }
        const cron = parsed.success;
        const scheduledFor = assistant.heartbeatNextAt;
        if (scheduledFor !== null && assistant.heartbeatNextZone === zone) {
          const { firedAt } = decideFiring(cron, scheduledFor, now);
          const conversationId =
            firedAt === undefined
              ? Option.none()
              : yield* readHeartbeatConversation(assistantId, heartbeat.target);
          if (Option.isSome(conversationId)) {
            yield* wakes.wake({
              conversationId: conversationId.value,
              assistantId,
              source: "heartbeat",
              text: heartbeat.prompt,
            });
          }
        }
        yield* assistants.setHeartbeatNext(assistantId, Cron.next(cron, now).toISOString(), zone);
      }),
    );

  /**
   * Fires a reminder: marks it fired and gives its text to its conversation,
   * in one transaction. A reminder cancelled since it was listed is left
   * alone.
   */
  const fireReminder = (reminder: Reminder, now: Date): Effect.Effect<void, WakeError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        if (!(yield* reminders.markFired(reminder.id, now.toISOString()))) return;
        const conversation = yield* conversations.read(reminder.conversationId);
        if (Option.isNone(conversation)) return;
        yield* wakes.wake({
          conversationId: reminder.conversationId,
          assistantId: conversation.value.assistantId,
          source: "reminder",
          text: reminder.text,
        });
      }),
    );

  return {
    /**
     * Returns the wakes that are due at `now`: the heartbeats with work, the
     * pending reminders whose time has come, and the conversations due for
     * their daily rotation.
     */
    listDue: (now: Date): Effect.Effect<ReadonlyArray<DueWake>, SqlError> =>
      Effect.gen(function* () {
        const ownerZone = yield* settings.readOwnerTimezone();
        const due: Array<DueWake> = [];
        for (const assistant of yield* assistants.listScheduled()) {
          const assistantId = assistant.agentId;
          if (hasHeartbeatWork(assistant, assistant.heartbeat.timezone ?? ownerZone, now)) {
            due.push({ _tag: "heartbeat", assistantId });
          }
          const rotation = assistant.rotation;
          const dailyRotation = findLatestDailyRotation(
            rotation,
            rotation.timezone ?? ownerZone,
            now,
          );
          if (Option.isSome(dailyRotation)) {
            for (const conversationId of yield* sessions.listConversationsDueForDailyRotation(
              assistantId,
              dailyRotation.value.toISOString(),
            )) {
              due.push({ _tag: "dailyRotation", conversationId });
            }
          }
        }
        for (const reminder of yield* reminders.listDue(now.toISOString())) {
          due.push({ _tag: "reminder", reminder });
        }
        return due;
      }),

    /** Fires one wake `listDue` returned, as the module comment describes. */
    fire: (wake: DueWake, now: Date): Effect.Effect<void, WakeError> => {
      switch (wake._tag) {
        case "heartbeat":
          return fireHeartbeat(wake.assistantId, now);
        case "reminder":
          return fireReminder(wake.reminder, now);
        case "dailyRotation":
          return Effect.asVoid(wakes.rotate(wake.conversationId));
      }
    },
  };
});

export class ScheduledWakes extends Context.Service<ScheduledWakes, Effect.Success<typeof make>>()(
  "hercule/controller/assistants/ScheduledWakes",
) {}

export const ScheduledWakesLayer: Layer.Layer<
  ScheduledWakes,
  never,
  SqlClient.SqlClient | Settings | ConversationWakes
> = Layer.effect(ScheduledWakes)(make);
