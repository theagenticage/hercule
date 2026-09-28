/**
 * Tests the notification service against a migrated in-memory database: who
 * may create and withdraw a notification, what the service stamps on it, how
 * the list filters and pages, and the two methods the core calls for its
 * own notifications.
 *
 * The mute key comes from the caller: a session's actor names the assistant it
 * speaks for, and a run's actor names the workflow it was started from.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  Grant,
  Notification,
  NotificationCreateInput,
  NotificationSubject,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { withTransaction, type Change } from "../db";
import { buildAnnouncementRecorder, TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotificationService, NotificationServiceLayer, type CoreNotification } from "./index";

type Deps = NotificationService | SqlClient.SqlClient;

const layer = NotificationServiceLayer.pipe(
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

const ASSISTANT_ID = "0199e0e7-0000-7000-8000-00000000a001";
const WORKFLOW_ID = "0199e0e7-0000-7000-8000-00000000f001";
const OTHER_WORKFLOW_ID = "0199e0e7-0000-7000-8000-00000000f002";
const PROFILE_ID = "0199e0e7-0000-7000-8000-00000000d001";

/** A session that speaks for the assistant `ASSISTANT_ID`. */
const ASSISTANT_SESSION_ID = "0199e0e7-0000-7000-8000-00000000a501";
/** A session that is part of no conversation. */
const PLAIN_SESSION_ID = "0199e0e7-0000-7000-8000-00000000b501";
/** A second session in no conversation, which produced nothing. */
const OTHER_SESSION_ID = "0199e0e7-0000-7000-8000-00000000b502";

/** A run started from the stored workflow `WORKFLOW_ID`. */
const WORKFLOW_RUN_ID = "0199e0e7-0000-7000-8000-00000000e001";
/** A run of a workflow sent with the request, so it has no stored workflow. */
const SENT_RUN_ID = "0199e0e7-0000-7000-8000-00000000e002";

const TASK_ID = "0199e0e7-0000-7000-8000-000000007a51";
const OTHER_TASK_ID = "0199e0e7-0000-7000-8000-000000007a52";
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

/** A minute, so two notifications never share a `createdAt` by accident. */
const A_MINUTE = 60_000;

const NOTIFICATION_GRANTS: ReadonlyArray<Grant> = ["notification.read", "notification.write"];

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/**
 * Builds the actor of a session whose profile holds `grants`, speaking for no
 * assistant unless `assistantId` is given.
 */
const buildSessionActor = (
  sessionId: string,
  grants: ReadonlyArray<Grant> = NOTIFICATION_GRANTS,
  assistantId: string | null = null,
): Actor => ({ _tag: "session", sessionId, profileId: PROFILE_ID, grants, assistantId });

const ASSISTANT_SESSION = buildSessionActor(
  ASSISTANT_SESSION_ID,
  NOTIFICATION_GRANTS,
  ASSISTANT_ID,
);
const PLAIN_SESSION = buildSessionActor(PLAIN_SESSION_ID);
const OTHER_SESSION = buildSessionActor(OTHER_SESSION_ID);
const WORKFLOW_RUN: Actor = {
  _tag: "run",
  runId: WORKFLOW_RUN_ID,
  stepId: "notify",
  workflowId: WORKFLOW_ID,
};
const SENT_RUN: Actor = { _tag: "run", runId: SENT_RUN_ID, stepId: "notify", workflowId: null };

/** A decision: two answers, about one task. */
const DECISION: NotificationCreateInput = {
  kind: "triage.proposal",
  title: "Start a bugfix run for #42?",
  body: "The issue has a stack trace and a failing test.",
  subject: [{ kind: "task", id: TASK_ID }],
  actions: [
    {
      id: "start",
      label: "Start Bugfix",
      operation: { op: "run.start", input: { workflowId: WORKFLOW_ID } },
      primary: true,
    },
    { id: "dismiss", label: "Dismiss", operation: null },
  ],
};

/** An informational notification: no answers, no body, no subject. */
const INFORMATIONAL: NotificationCreateInput = {
  kind: "triage.fyi",
  title: "Closed three duplicate issues",
};

const CORE: CoreNotification = {
  kind: "core.run-failed",
  title: "The nightly run failed",
  body: "Step `build` exited with 1.",
  subject: [{ kind: "run", id: WORKFLOW_RUN_ID }],
  eventId: 17,
};

/**
 * Runs an effect on a fresh database, on a `TestClock`. The effect
 * runs with no actor; each call inside it picks its caller with `actAs`.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer())));

/** Runs an effect like `run` does, and also returns every change announced after a commit. */
const runRecordingAnnouncements = async <A, E>(
  effect: Effect.Effect<A, E, Deps>,
): Promise<{ readonly value: A; readonly announced: ReadonlyArray<Change> }> => {
  const { listener, announced } = buildAnnouncementRecorder();
  const value = await run(effect.pipe(Effect.provide(listener)));
  return { value, announced };
};

/** Runs one call as `actor`. */
const actAs = <A, E, R>(actor: Actor, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, CurrentActor, actor);

/** Creates a notification as `actor` and returns it as the user reads it. */
const createAndRead = (actor: Actor, input: NotificationCreateInput) =>
  Effect.gen(function* () {
    const notifications = yield* NotificationService;
    const { notificationId } = yield* actAs(actor, notifications.create(input));
    return yield* actAs(USER, notifications.read(notificationId));
  });

/**
 * Casts input that a caller can send over the wire but the types here rule
 * out. Rejecting such input is the service's job, so the test must be able to
 * pass it in.
 */
const castMalformedInput = <T>(input: unknown): T => input as T;

describe("notification.create", () => {
  it("stores a decision from a session as open, stamped with the session, muted by its assistant", async () => {
    const notification = await run(createAndRead(ASSISTANT_SESSION, DECISION));

    expect(notification).toEqual({
      id: notification.id,
      kind: DECISION.kind,
      title: DECISION.title,
      body: DECISION.body,
      producer: { type: "session", sessionId: ASSISTANT_SESSION_ID },
      muteKey: `assistant:${ASSISTANT_ID}`,
      subject: DECISION.subject,
      actions: DECISION.actions,
      status: "open",
      createdAt: notification.createdAt,
    });
    expect(notification.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("stores a notification without answers as resolved, with no resolution", async () => {
    const notification = await run(createAndRead(PLAIN_SESSION, INFORMATIONAL));

    expect(notification.status).toBe("resolved");
    expect(notification.actions).toEqual([]);
    expect(notification.subject).toEqual([]);
    expect("resolution" in notification).toBe(false);
    expect("body" in notification).toBe(false);
  });

  it("gives a session in no conversation no mute key", async () => {
    const notification = await run(createAndRead(PLAIN_SESSION, DECISION));

    expect(notification.producer).toEqual({ type: "session", sessionId: PLAIN_SESSION_ID });
    expect("muteKey" in notification).toBe(false);
  });

  it("stamps a run's step as the producer, muted by the run's stored workflow", async () => {
    const notification = await run(createAndRead(WORKFLOW_RUN, DECISION));

    expect(notification.producer).toEqual({
      type: "run",
      runId: WORKFLOW_RUN_ID,
      stepId: "notify",
    });
    expect(notification.muteKey).toBe(`workflow:${WORKFLOW_ID}`);
  });

  it("gives a run of a sent workflow no mute key", async () => {
    const notification = await run(createAndRead(SENT_RUN, INFORMATIONAL));

    expect(notification.producer).toEqual({ type: "run", runId: SENT_RUN_ID, stepId: "notify" });
    expect("muteKey" in notification).toBe(false);
  });

  it("records one audit entry stamped with the producer, and announces the new notification", async () => {
    const { value, announced } = await runRecordingAnnouncements(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const fromSession = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        const fromRun = yield* actAs(WORKFLOW_RUN, notifications.create(INFORMATIONAL));
        return { fromSession, fromRun, entries: yield* readEventsOfKind("notification.created") };
      }),
    );

    expect(value.entries.map((entry) => [entry.actor, entry.payload])).toEqual([
      [
        `session:${PLAIN_SESSION_ID}`,
        {
          notificationId: value.fromSession.notificationId,
          kind: DECISION.kind,
          producer: { type: "session", sessionId: PLAIN_SESSION_ID },
        },
      ],
      [
        `run:${WORKFLOW_RUN_ID}`,
        {
          notificationId: value.fromRun.notificationId,
          kind: INFORMATIONAL.kind,
          producer: { type: "run", runId: WORKFLOW_RUN_ID, stepId: "notify" },
        },
      ],
    ]);
    expect(announced).toEqual([
      { _tag: "event" },
      {
        _tag: "record",
        topic: "notification",
        id: value.fromSession.notificationId,
        kind: "created",
      },
      { _tag: "event" },
      { _tag: "record", topic: "notification", id: value.fromRun.notificationId, kind: "created" },
    ]);
  });

  it("refuses the user with Forbidden, says why the grant does not help, and writes nothing", async () => {
    const { error, listed } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        return {
          error: yield* Effect.flip(actAs(USER, notifications.create(DECISION))),
          listed: (yield* actAs(USER, notifications.query({}))).items,
        };
      }),
    );

    expect(error).toMatchObject({
      error: {
        code: "forbidden",
        message: expect.stringMatching(/message to you/) as unknown,
        details: { grant: "notification.write" },
      },
    });
    expect(listed).toEqual([]);
  });

  it("refuses a session whose profile lacks notification.write", async () => {
    const error = await run(
      Effect.flatMap(NotificationService, (notifications) =>
        Effect.flip(
          actAs(
            buildSessionActor(PLAIN_SESSION_ID, ["notification.read"]),
            notifications.create(DECISION),
          ),
        ),
      ),
    );

    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "notification.write" } },
    });
  });

  it("refuses a core.* kind from anyone but the core", async () => {
    const errors = await run(
      Effect.flatMap(NotificationService, (notifications) =>
        Effect.all([
          Effect.flip(
            actAs(
              PLAIN_SESSION,
              notifications.create({ ...INFORMATIONAL, kind: "core.run-failed" }),
            ),
          ),
          Effect.flip(
            actAs(
              WORKFLOW_RUN,
              notifications.create({ ...INFORMATIONAL, kind: "core.plugin-error" }),
            ),
          ),
        ]),
      ),
    );

    for (const error of errors) {
      expect(error).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["kind"] }] } },
      });
    }
  });

  it("refuses answers that repeat an id, or that mark more than one primary", async () => {
    const errors = await run(
      Effect.flatMap(NotificationService, (notifications) =>
        Effect.all([
          Effect.flip(
            actAs(
              PLAIN_SESSION,
              notifications.create({
                ...DECISION,
                actions: [
                  { id: "start", label: "Start", operation: null },
                  { id: "start", label: "Start again", operation: null },
                ],
              }),
            ),
          ),
          Effect.flip(
            actAs(
              PLAIN_SESSION,
              notifications.create({
                ...DECISION,
                actions: [
                  { id: "start", label: "Start", operation: null, primary: true },
                  { id: "stop", label: "Stop", operation: null, primary: true },
                ],
              }),
            ),
          ),
        ]),
      ),
    );

    for (const error of errors) expect(error).toMatchObject({ error: { code: "validation" } });
  });

  it("ignores a producer or a mute key in the input, and stamps the caller instead", async () => {
    const notification = await run(
      createAndRead(
        PLAIN_SESSION,
        castMalformedInput({
          ...INFORMATIONAL,
          producer: { type: "core" },
          muteKey: `workflow:${WORKFLOW_ID}`,
        }),
      ),
    );

    expect(notification.producer).toEqual({ type: "session", sessionId: PLAIN_SESSION_ID });
    expect("muteKey" in notification).toBe(false);
  });
});

describe("notification.read", () => {
  it("returns NotFound for an id that does not exist", async () => {
    const error = await run(
      Effect.flatMap(NotificationService, (notifications) =>
        Effect.flip(actAs(USER, notifications.read(UNKNOWN_ID))),
      ),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("refuses a session whose profile lacks notification.read, on read and on query", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        const writer = buildSessionActor(PLAIN_SESSION_ID, ["notification.write"]);
        return [
          yield* Effect.flip(actAs(writer, notifications.read(notificationId))),
          yield* Effect.flip(actAs(writer, notifications.query({}))),
        ];
      }),
    );

    for (const error of errors) {
      expect(error).toMatchObject({
        error: { code: "forbidden", details: { grant: "notification.read" } },
      });
    }
  });
});

describe("notification.withdraw", () => {
  it("resolves the producer's open decision as withdrawn, stamped and originated by the session", async () => {
    const { returned, stored, entries } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        yield* TestClock.adjust(A_MINUTE);
        const returned = yield* actAs(
          PLAIN_SESSION,
          notifications.withdraw({ id: notificationId, reason: "answered in the session" }),
        );
        return {
          returned,
          stored: yield* actAs(USER, notifications.read(notificationId)),
          entries: yield* readEventsOfKind("notification.withdrawn"),
        };
      }),
    );

    const stamp = `session:${PLAIN_SESSION_ID}`;
    expect(returned.status).toBe("resolved");
    expect(returned.resolution).toEqual({
      kind: "withdrawn",
      actor: stamp,
      origin: stamp,
      reason: "answered in the session",
      at: returned.resolution!.at,
    });
    // The resolution is dated when the withdrawal happened, not when the
    // notification was created.
    expect(returned.resolution!.at > returned.createdAt).toBe(true);
    // Everything but the status and the resolution is as it was created.
    expect(returned).toEqual(stored);
    expect(entries.map((entry) => [entry.actor, entry.payload])).toEqual([
      [stamp, { notificationId: returned.id, reason: "answered in the session" }],
    ]);
  });

  it("announces the withdrawn notification as updated", async () => {
    const { value: id, announced } = await runRecordingAnnouncements(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        yield* actAs(
          PLAIN_SESSION,
          notifications.withdraw({ id: notificationId, reason: "no longer needed" }),
        );
        return notificationId;
      }),
    );

    expect(announced.slice(2)).toEqual([
      { _tag: "event" },
      { _tag: "record", topic: "notification", id, kind: "updated" },
    ]);
  });

  it("returns NotFound for an id that does not exist", async () => {
    const error = await run(
      Effect.flatMap(NotificationService, (notifications) =>
        Effect.flip(
          actAs(PLAIN_SESSION, notifications.withdraw({ id: UNKNOWN_ID, reason: "gone" })),
        ),
      ),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("refuses a run, even for the run's own decision", async () => {
    const { error, stored } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(WORKFLOW_RUN, notifications.create(DECISION));
        return {
          error: yield* Effect.flip(
            actAs(WORKFLOW_RUN, notifications.withdraw({ id: notificationId, reason: "done" })),
          ),
          stored: yield* actAs(USER, notifications.read(notificationId)),
        };
      }),
    );

    expect(error).toMatchObject({
      error: {
        code: "forbidden",
        message: expect.stringMatching(/run cannot withdraw/) as unknown,
        details: { grant: "notification.write" },
      },
    });
    expect(stored.status).toBe("open");
  });

  it("refuses another session and the user, because only the producer may withdraw", async () => {
    const { errors, stored } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        const withdraw = notifications.withdraw({ id: notificationId, reason: "not mine" });
        return {
          errors: [
            yield* Effect.flip(actAs(OTHER_SESSION, withdraw)),
            yield* Effect.flip(actAs(USER, withdraw)),
          ],
          stored: yield* actAs(USER, notifications.read(notificationId)),
        };
      }),
    );

    for (const error of errors) {
      expect(error).toMatchObject({
        error: {
          code: "forbidden",
          message: expect.stringMatching(/only the producer/) as unknown,
        },
      });
    }
    expect(stored.status).toBe("open");
  });

  it("refuses the producer's session when its profile lacks notification.write", async () => {
    const error = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        return yield* Effect.flip(
          actAs(
            buildSessionActor(PLAIN_SESSION_ID, ["notification.read"]),
            notifications.withdraw({ id: notificationId, reason: "done" }),
          ),
        );
      }),
    );

    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "notification.write" } },
    });
  });

  it("fails with InvalidState for an informational notification, and says it has no question", async () => {
    const error = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(INFORMATIONAL));
        return yield* Effect.flip(
          actAs(PLAIN_SESSION, notifications.withdraw({ id: notificationId, reason: "done" })),
        );
      }),
    );

    expect(error).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringMatching(/informational notification has no question/) as unknown,
      },
    });
  });

  it("fails with InvalidState the second time, says it is already resolved, and keeps the first resolution", async () => {
    const { error, stored } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        yield* actAs(
          PLAIN_SESSION,
          notifications.withdraw({ id: notificationId, reason: "first" }),
        );
        return {
          error: yield* Effect.flip(
            actAs(PLAIN_SESSION, notifications.withdraw({ id: notificationId, reason: "second" })),
          ),
          stored: yield* actAs(USER, notifications.read(notificationId)),
        };
      }),
    );

    expect(error).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringMatching(/already resolved/) as unknown,
      },
    });
    expect(stored.resolution?.reason).toBe("first");
  });

  it("refuses a reason that is empty or longer than one line", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        return [
          yield* Effect.flip(
            actAs(PLAIN_SESSION, notifications.withdraw({ id: notificationId, reason: "" })),
          ),
          yield* Effect.flip(
            actAs(
              PLAIN_SESSION,
              notifications.withdraw({ id: notificationId, reason: "first line\nsecond line" }),
            ),
          ),
        ];
      }),
    );

    for (const error of errors) {
      expect(error).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["reason"] }] } },
      });
    }
  });
});

/**
 * Creates three notifications a minute apart: an open decision, an
 * informational one, then a second decision of the same kind. Returns them in
 * the order they were created.
 */
const withThreeNotifications = Effect.gen(function* () {
  const created: Array<Notification> = [];
  for (const input of [
    { ...DECISION, title: "first" },
    { ...INFORMATIONAL, title: "second" },
    { ...DECISION, title: "third" },
  ]) {
    created.push(yield* createAndRead(PLAIN_SESSION, input));
    yield* TestClock.adjust(A_MINUTE);
  }
  return created;
});

/** Returns the titles of the notifications, in the order given. */
const listTitles = (items: ReadonlyArray<Notification>) => items.map((item) => item.title);

describe("notification.query", () => {
  it("lists newest first by default, and oldest first when asked", async () => {
    const { newest, oldest } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        yield* withThreeNotifications;
        return {
          newest: yield* actAs(USER, notifications.query({})),
          oldest: yield* actAs(
            USER,
            notifications.query({ sort: { field: "createdAt", direction: "asc" } }),
          ),
        };
      }),
    );

    expect(listTitles(newest.items)).toEqual(["third", "second", "first"]);
    expect(newest.nextCursor).toBeUndefined();
    expect(listTitles(oldest.items)).toEqual(["first", "second", "third"]);
  });

  it("filters by kind, by status and by since, and requires every filter given to match", async () => {
    const pages = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const [, second] = yield* withThreeNotifications;
        const query = (filter: Parameters<typeof notifications.query>[0]) =>
          Effect.map(actAs(USER, notifications.query(filter)), (page) => listTitles(page.items));
        return {
          byKind: yield* query({ kind: DECISION.kind }),
          open: yield* query({ status: "open" }),
          resolved: yield* query({ status: "resolved" }),
          // `since` keeps the notification created at exactly that instant.
          since: yield* query({ since: second!.createdAt }),
          openSince: yield* query({ status: "open", since: second!.createdAt }),
          none: yield* query({ kind: "triage.never-used" }),
        };
      }),
    );

    expect(pages).toEqual({
      byKind: ["third", "first"],
      open: ["third", "first"],
      resolved: ["second"],
      since: ["third", "second"],
      openSince: ["third"],
      none: [],
    });
  });

  it("pages through every notification once, in both directions", async () => {
    const { desc, asc } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        yield* withThreeNotifications;
        yield* withThreeNotifications;
        const walk = (direction: "asc" | "desc") =>
          Effect.gen(function* () {
            const titles: Array<string> = [];
            let cursor: string | undefined;
            for (let page = 0; page < 10; page++) {
              const result = yield* actAs(
                USER,
                notifications.query({
                  limit: 2,
                  sort: { field: "createdAt", direction },
                  ...(cursor === undefined ? {} : { cursor }),
                }),
              );
              expect(result.items.length).toBeLessThanOrEqual(2);
              titles.push(...listTitles(result.items));
              cursor = result.nextCursor;
              if (cursor === undefined) return titles;
            }
            throw new Error("the listing never ended");
          });
        return { desc: yield* walk("desc"), asc: yield* walk("asc") };
      }),
    );

    expect(asc).toEqual(["first", "second", "third", "first", "second", "third"]);
    expect(desc).toEqual([...asc].reverse());
  });

  it("refuses a malformed cursor, and a cursor from the other direction, as a validation error on cursor", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        yield* withThreeNotifications;
        const first = yield* actAs(USER, notifications.query({ limit: 1 }));
        return [
          yield* Effect.flip(actAs(USER, notifications.query({ cursor: "not-a-cursor" }))),
          yield* Effect.flip(
            actAs(
              USER,
              notifications.query({
                cursor: first.nextCursor!,
                sort: { field: "createdAt", direction: "asc" },
              }),
            ),
          ),
        ];
      }),
    );

    for (const error of errors) {
      expect(error).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["cursor"] }] } },
      });
    }
  });
});

describe("createCoreNotification", () => {
  it("stores an informational notification from the core, with no mute key, stamped as the system", async () => {
    const { notification, entries } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        // No actor: only the controller calls this, and it checks no grant.
        yield* notifications.createCoreNotification(CORE);
        const [notification] = (yield* actAs(USER, notifications.query({}))).items;
        return {
          notification: notification!,
          entries: yield* readEventsOfKind("notification.created"),
        };
      }),
    );

    expect(notification).toEqual({
      id: notification.id,
      kind: CORE.kind,
      title: CORE.title,
      body: CORE.body,
      producer: { type: "core" },
      subject: CORE.subject,
      eventId: CORE.eventId,
      actions: [],
      status: "resolved",
      createdAt: notification.createdAt,
    });
    expect(entries.map((entry) => [entry.actor, entry.payload])).toEqual([
      ["system", { notificationId: notification.id, kind: CORE.kind, producer: { type: "core" } }],
    ]);
  });

  it("rolls back with the caller's transaction, so it never reports a change that did not happen", async () => {
    const { failure, listed, entries } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const notifications = yield* NotificationService;
        const failure = yield* Effect.flip(
          withTransaction(
            sql,
            Effect.andThen(
              notifications.createCoreNotification(CORE),
              Effect.fail("the change the notification reports failed"),
            ),
          ),
        );
        return {
          failure,
          listed: (yield* actAs(USER, notifications.query({}))).items,
          entries: yield* readEventsOfKind("notification.created"),
        };
      }),
    );

    expect(failure).toBe("the change the notification reports failed");
    expect(listed).toEqual([]);
    expect(entries).toEqual([]);
  });
});

describe("createCoreNotification with unlessRaisedSince", () => {
  const RUNNER_ID = "0199e0e7-0000-7000-8000-00000000ba01";
  const RUNNER: NotificationSubject = { kind: "runner", id: RUNNER_ID };
  const RUN: NotificationSubject = { kind: "run", id: WORKFLOW_RUN_ID };

  /** The notification raised first in every case: about a run and a runner. */
  const RAISED: CoreNotification = {
    ...CORE,
    kind: "core.runner-unreachable",
    subject: [RUN, RUNNER],
  };

  /** Returns `iso` moved by `ms` milliseconds, as an ISO timestamp. */
  const shiftIso = (iso: string, ms: number): string =>
    new Date(new Date(iso).getTime() + ms).toISOString();

  /**
   * Raises `RAISED` on a fresh database, then asks to create `candidate`
   * unless a matching notification was raised since `offsetMs` milliseconds
   * from the moment `RAISED` was created. Returns whether `candidate` was
   * created.
   */
  const checkCreated = (candidate: CoreNotification, offsetMs: number): Promise<boolean> =>
    run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        yield* notifications.createCoreNotification(RAISED);
        const [raised] = (yield* actAs(USER, notifications.query({}))).items;
        yield* notifications.createCoreNotification(candidate, {
          unlessRaisedSince: shiftIso(raised!.createdAt, offsetMs),
        });
        return (yield* actAs(USER, notifications.query({}))).items.length === 2;
      }),
    );

  it("creates nothing when one of that kind about every subject was raised after the instant, and creates it otherwise", async () => {
    const aboutRunner: CoreNotification = { ...RAISED, subject: [RUNNER] };

    const created = {
      // The runner is listed second in `RAISED`, so this also checks that
      // every subject of the stored notification is searched.
      sameKindAndSubject: await checkCreated(aboutRunner, -1),
      everySubjectInAnotherOrder: await checkCreated({ ...RAISED, subject: [RUNNER, RUN] }, -1),
      raisedAtTheInstant: await checkCreated(aboutRunner, 0),
      otherKind: await checkCreated({ ...aboutRunner, kind: "core.run-failed" }, -1),
      otherSubject: await checkCreated(
        { ...RAISED, subject: [{ kind: "runner", id: UNKNOWN_ID }] },
        -1,
      ),
      sameIdOtherKindOfSubject: await checkCreated(
        { ...RAISED, subject: [{ kind: "session", id: RUNNER_ID }] },
        -1,
      ),
      oneSubjectNotRaisedAbout: await checkCreated(
        { ...RAISED, subject: [RUNNER, { kind: "runner", id: UNKNOWN_ID }] },
        -1,
      ),
    };

    expect(created).toEqual({
      sameKindAndSubject: false,
      everySubjectInAnotherOrder: false,
      // The instant itself is excluded: only a notification raised after it counts.
      raisedAtTheInstant: true,
      otherKind: true,
      otherSubject: true,
      sameIdOtherKindOfSubject: true,
      oneSubjectNotRaisedAbout: true,
    });
  });
});

describe("withdrawDecisionsAbout", () => {
  const TRIGGER: NotificationSubject = {
    kind: "trigger",
    workflowId: WORKFLOW_ID,
    triggerId: "on-push",
  };

  /** Creates a decision as the plain session about these subjects, titled `title`. */
  const createDecisionAbout = (title: string, subject: ReadonlyArray<NotificationSubject>) =>
    Effect.flatMap(NotificationService, (notifications) =>
      actAs(PLAIN_SESSION, notifications.create({ ...DECISION, title, subject })),
    );

  it("withdraws every open decision that lists a removed subject, and leaves the rest", async () => {
    const { byTitle, entries } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        yield* createDecisionAbout("about the task", [{ kind: "task", id: TASK_ID }]);
        yield* createDecisionAbout("about two tasks", [
          { kind: "task", id: OTHER_TASK_ID },
          { kind: "task", id: TASK_ID },
        ]);
        yield* createDecisionAbout("about the trigger", [TRIGGER]);
        yield* createDecisionAbout("about the same trigger id in another workflow", [
          { ...TRIGGER, workflowId: OTHER_WORKFLOW_ID },
        ]);
        yield* createDecisionAbout("about another trigger of the workflow", [
          { ...TRIGGER, triggerId: "nightly" },
        ]);
        yield* createDecisionAbout("about a run with the task's id", [
          { kind: "run", id: TASK_ID },
        ]);
        yield* createDecisionAbout("about another task", [{ kind: "task", id: OTHER_TASK_ID }]);
        yield* actAs(
          PLAIN_SESSION,
          notifications.create({
            ...INFORMATIONAL,
            title: "informational about the task",
            subject: [{ kind: "task", id: TASK_ID }],
          }),
        );
        const { notificationId: answered } = yield* createDecisionAbout(
          "already withdrawn about the task",
          [{ kind: "task", id: TASK_ID }],
        );
        yield* actAs(
          PLAIN_SESSION,
          notifications.withdraw({ id: answered, reason: "answered in the session" }),
        );

        // No actor: only the controller calls this, and it checks no grant.
        yield* notifications.withdrawDecisionsAbout(
          [{ kind: "task", id: TASK_ID }, TRIGGER],
          "the task was deleted",
        );

        const all = (yield* actAs(USER, notifications.query({}))).items;
        return {
          byTitle: new Map(all.map((one) => [one.title, one])),
          entries: yield* readEventsOfKind("notification.withdrawn"),
        };
      }),
    );

    const withdrawnByTheCore = ["about the task", "about two tasks", "about the trigger"] as const;
    for (const title of withdrawnByTheCore) {
      const one = byTitle.get(title)!;
      expect(one.status, title).toBe("resolved");
      expect(one.resolution, title).toEqual({
        kind: "withdrawn",
        actor: "system",
        origin: "core",
        reason: "the task was deleted",
        at: one.resolution!.at,
      });
    }
    for (const title of [
      "about the same trigger id in another workflow",
      "about another trigger of the workflow",
      "about a run with the task's id",
      "about another task",
    ]) {
      expect(byTitle.get(title)!.status, title).toBe("open");
    }
    expect(byTitle.get("informational about the task")!.status).toBe("resolved");
    expect("resolution" in byTitle.get("informational about the task")!).toBe(false);
    expect(byTitle.get("already withdrawn about the task")!.resolution).toMatchObject({
      actor: `session:${PLAIN_SESSION_ID}`,
      reason: "answered in the session",
    });

    // One entry for the session's own withdrawal, then one per decision the
    // core withdrew, stamped as the system.
    expect(entries.map((entry) => entry.actor)).toEqual([
      `session:${PLAIN_SESSION_ID}`,
      "system",
      "system",
      "system",
    ]);
    expect(new Set(entries.slice(1).map((entry) => entry.payload.notificationId))).toEqual(
      new Set(withdrawnByTheCore.map((title) => byTitle.get(title)!.id)),
    );
    for (const entry of entries.slice(1)) {
      expect(entry.payload.reason).toBe("the task was deleted");
    }
  });

  it("withdraws nothing for an empty list of subjects", async () => {
    const { stored, entries } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* createDecisionAbout("about the task", [
          { kind: "task", id: TASK_ID },
        ]);
        yield* notifications.withdrawDecisionsAbout([], "nothing was removed");
        return {
          stored: yield* actAs(USER, notifications.read(notificationId)),
          entries: yield* readEventsOfKind("notification.withdrawn"),
        };
      }),
    );

    expect(stored.status).toBe("open");
    expect(entries).toEqual([]);
  });
});
