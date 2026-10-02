/**
 * Notification rows.
 *
 * This module reads and writes the contract's `Notification`. The producer,
 * the subject, the actions and the resolution are stored as JSON, because a
 * notification is read and written whole. Nothing here decides policy (who may
 * create or withdraw, what a producer's mute key is); it only reads and writes.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  BoundAction,
  Notification,
  NotificationFilter,
  NotificationProducer,
  NotificationStatus,
  NotificationSubject,
  Resolution,
  SortDirection,
} from "@hercule/contract";
import {
  buildKeyset,
  buildPage,
  decodeCursor,
  encodeCursor,
  mintUuid,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** The page size, cursor and direction of a listing, which is always by `createdAt`. */
export interface NotificationPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

/** A notification as it is written, before it has an id. */
export type NewNotification = Omit<Notification, "id">;

interface NotificationRow {
  readonly id: Uint8Array;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly producer: string;
  readonly mute_key: string | null;
  readonly subject: string;
  readonly event_id: number | null;
  readonly actions: string;
  readonly status: string;
  readonly resolution: string | null;
  readonly created_at: string;
}

const COLUMNS =
  "id, kind, title, body, producer, mute_key, subject, event_id, actions, status, resolution, created_at";

/** Converts a stored row into the contract's notification. */
const parseRow = (row: NotificationRow): Notification => ({
  id: uuidToString(row.id),
  kind: row.kind,
  title: row.title,
  ...(row.body === null ? {} : { body: row.body }),
  producer: JSON.parse(row.producer) as NotificationProducer,
  ...(row.mute_key === null ? {} : { muteKey: row.mute_key }),
  subject: JSON.parse(row.subject) as ReadonlyArray<NotificationSubject>,
  ...(row.event_id === null ? {} : { eventId: row.event_id }),
  actions: JSON.parse(row.actions) as ReadonlyArray<BoundAction>,
  status: row.status as NotificationStatus,
  ...(row.resolution === null ? {} : { resolution: JSON.parse(row.resolution) as Resolution }),
  createdAt: row.created_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Builds the condition that one element of a notification's subject list,
   * `subject.value`, is the given subject. A trigger is named by its workflow
   * and its id in that workflow, a request by its session and its id in that
   * session, and everything else by its id.
   */
  const buildSubjectMatch = (subject: NotificationSubject) => {
    switch (subject.kind) {
      case "trigger":
        return sql`subject.value ->> 'kind' = 'trigger'
                   AND subject.value ->> 'workflowId' = ${subject.workflowId}
                   AND subject.value ->> 'triggerId' = ${subject.triggerId}`;
      case "request":
        return sql`subject.value ->> 'kind' = 'request'
                   AND subject.value ->> 'sessionId' = ${subject.sessionId}
                   AND subject.value ->> 'requestId' = ${subject.requestId}`;
      default:
        return sql`subject.value ->> 'kind' = ${subject.kind}
                   AND subject.value ->> 'id' = ${subject.id}`;
    }
  };

  return {
    /** Writes a new notification and returns it with its id. */
    insert: (notification: NewNotification): Effect.Effect<Notification, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO notifications
            (id, kind, title, body, producer, mute_key, subject, event_id, actions, status,
             resolution, created_at)
          VALUES
            (${id}, ${notification.kind}, ${notification.title}, ${notification.body ?? null},
             ${JSON.stringify(notification.producer)}, ${notification.muteKey ?? null},
             ${JSON.stringify(notification.subject)}, ${notification.eventId ?? null},
             ${JSON.stringify(notification.actions)}, ${notification.status},
             ${notification.resolution === undefined ? null : JSON.stringify(notification.resolution)},
             ${notification.createdAt})
        `;
        return { id: uuidToString(id), ...notification };
      }),

    /** Returns the notification with that id, or none if it does not exist. */
    read: (id: string): Effect.Effect<Option.Option<Notification>, SqlError> =>
      Effect.map(
        sql<NotificationRow>`SELECT ${sql.literal(COLUMNS)} FROM notifications
                             WHERE id = ${uuidFromString(id)}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), parseRow),
      ),

    /**
     * Resolves an open notification. Returns false, and writes nothing, when
     * the notification is not open, so two resolutions racing each other
     * cannot both win.
     */
    resolve: (id: string, resolution: Resolution): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE notifications SET status = 'resolved', resolution = ${JSON.stringify(resolution)}
          WHERE id = ${uuidFromString(id)} AND status = 'open'
          RETURNING id
        `,
        (rows) => rows.length === 1,
      ),

    /**
     * Returns the open notifications whose subject lists any of these
     * subjects, oldest first. Only a decision is ever open.
     */
    listOpenDecisionsAbout: (
      subjects: ReadonlyArray<NotificationSubject>,
    ): Effect.Effect<ReadonlyArray<Notification>, SqlError> =>
      subjects.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<NotificationRow>`
              SELECT ${sql.literal(COLUMNS)} FROM notifications
              WHERE notifications.status = 'open'
                AND EXISTS (SELECT 1 FROM json_each(notifications.subject) AS subject
                            WHERE ${sql.or(subjects.map(buildSubjectMatch))})
              ORDER BY notifications.created_at, notifications.id
            `,
            (rows) => rows.map(parseRow),
          ),

    /**
     * Returns how the most recently resolved decision that lists this subject
     * was resolved: `decided`, `handled` or `withdrawn`. Returns none when no
     * resolved decision lists it. An informational notification is resolved
     * from the start, but it has no answers, so it does not count.
     */
    readLatestResolutionKindAbout: (
      subject: NotificationSubject,
    ): Effect.Effect<Option.Option<Resolution["kind"]>, SqlError> =>
      Effect.map(
        sql<{ readonly kind: Resolution["kind"] }>`
          SELECT notifications.resolution ->> 'kind' AS kind FROM notifications
          WHERE notifications.status = 'resolved'
            AND json_array_length(notifications.actions) > 0
            AND EXISTS (SELECT 1 FROM json_each(notifications.subject) AS subject
                        WHERE ${buildSubjectMatch(subject)})
          ORDER BY notifications.resolution ->> 'at' DESC, notifications.id DESC
          LIMIT 1
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.kind),
      ),

    /**
     * Checks whether a notification of this kind was created after `since`
     * whose subject lists every one of these subjects. It may list more. With
     * no subjects, any notification of the kind created after `since` counts.
     */
    hasNotificationAboutSince: (
      kind: string,
      subjects: ReadonlyArray<NotificationSubject>,
      since: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT notifications.id FROM notifications
          WHERE notifications.kind = ${kind} AND notifications.created_at > ${since}
            AND ${sql.and(
              subjects.map(
                (subject) =>
                  sql`EXISTS (SELECT 1 FROM json_each(notifications.subject) AS subject
                              WHERE ${buildSubjectMatch(subject)})`,
              ),
            )}
          LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /** Returns one page of the notifications that match a filter, ordered by `createdAt`. */
    list: (
      filter: NotificationFilter,
      request: NotificationPageRequest,
    ): Effect.Effect<Page<Notification>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope: CursorScope = {
          op: "notification.query",
          sort: [{ field: "createdAt", direction: request.direction }],
        };
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "created_at", direction: request.direction }],
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const clauses = [keyset];
        if (filter.kind !== undefined) clauses.push(sql`kind = ${filter.kind}`);
        if (filter.status !== undefined) clauses.push(sql`status = ${filter.status}`);
        if (filter.since !== undefined) clauses.push(sql`created_at >= ${filter.since}`);
        const rows = yield* sql<NotificationRow>`
          SELECT ${sql.literal(COLUMNS)} FROM notifications
          WHERE ${sql.and(clauses)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(parseRow)),
          (last) => encodeCursor(scope, [last.createdAt], last.id),
        );
      }),
  };
});

/** Everything the notification service reads and writes. */
export const notificationRepository = make;
