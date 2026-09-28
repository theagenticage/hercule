/**
 * Test helpers for other domains whose writes withdraw open decisions or
 * raise notifications.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { BoundAction, Notification, NotificationSubject } from "@hercule/contract";
import { AuditLog } from "../events";
import { BindableOperations } from "./bindable-operations";
import { Notifier, NotifierLayer } from "./notifier";
import { notificationRepository } from "./repository";
import { NotificationService, NotificationServiceLayer } from "./service";

/**
 * A fake of the `BindableOperations` port. `run` succeeds without doing
 * anything. `describe` writes each operation's id as its describe line, such
 * as "run.start".
 *
 * The real port lives in the controller daemon, which a domain's test cannot
 * import. A test that checks the real lines, or what an operation really
 * does, runs the controller over HTTP.
 */
const FakeBindableOperationsLayer: Layer.Layer<BindableOperations> = Layer.succeed(
  BindableOperations,
  BindableOperations.of({
    run: () => Effect.void,
    describe: (operations) =>
      Effect.succeed(operations.map((operation) => [{ kind: "text", text: operation.op }])),
  }),
);

/**
 * The notification service and the notifier over the fake port above, for a
 * test that reads notifications through the service. A test that only needs
 * the notifier uses `NotifierLayer` instead. Both still need the database and
 * the audit log.
 */
export const NotificationServiceTestLayer: Layer.Layer<
  NotificationService | Notifier,
  never,
  SqlClient.SqlClient | AuditLog
> = NotificationServiceLayer.pipe(
  Layer.provide(FakeBindableOperationsLayer),
  Layer.provideMerge(NotifierLayer),
);

/** The session every decision these helpers insert comes from. */
const PRODUCER_SESSION_ID = "0199e0e7-5555-7000-8000-000000000000";

/**
 * Inserts an open decision about one subject, straight into the table, and
 * returns its id. The answers are stored as given, without any check, so a
 * test can store one that `notification.create` would reject. A test of a
 * delete uses it to check that the delete withdraws the decisions about what
 * it deleted.
 */
export const insertOpenDecision = (
  subject: NotificationSubject,
  actions: ReadonlyArray<BoundAction> = [{ id: "dismiss", label: "Dismiss", operation: null }],
): Effect.Effect<string, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const notifications = yield* notificationRepository;
    const stored = yield* notifications.insert({
      kind: "triage.proposal",
      title: "Start a bugfix?",
      producer: { type: "session", sessionId: PRODUCER_SESSION_ID },
      subject: [subject],
      actions,
      status: "open",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    return stored.id;
  });

/** Reads a notification straight from the table. Dies if it does not exist. */
export const readStoredNotification = (
  id: string,
): Effect.Effect<Notification, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const notifications = yield* notificationRepository;
    return Option.getOrThrow(yield* notifications.read(id));
  });

/**
 * Returns the bodies of the notifications of one kind about one subject,
 * oldest first. An integration test uses it to check what the core reported,
 * because `notification.query` cannot filter by subject.
 */
export const readNotificationBodiesAbout = (
  kind: string,
  subject: Exclude<NotificationSubject, { readonly kind: "trigger" | "request" }>,
): Effect.Effect<ReadonlyArray<string | null>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly body: string | null }>`
      SELECT notifications.body FROM notifications
      WHERE notifications.kind = ${kind}
        AND EXISTS (SELECT 1 FROM json_each(notifications.subject) AS subject
                    WHERE subject.value ->> 'kind' = ${subject.kind}
                      AND subject.value ->> 'id' = ${subject.id})
      ORDER BY notifications.created_at, notifications.id`;
    return rows.map((row) => row.body);
  });
