/**
 * Tests the notification service against a migrated in-memory database: who
 * may create and withdraw a notification, what the service stamps on it, how
 * the list filters and pages, and the describe lines the user reads. Taking
 * an answer is tested here only for what HTTP cannot reach: two answers at
 * once, an operation that resolves the decision itself, and a caller that is
 * a run. The notifier is tested in `notifier.test.ts`.
 *
 * The mute key comes from the caller: a session's actor names the assistant it
 * speaks for, and a run's actor names the workflow it was started from.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { SqlClient } from "effect/unstable/sql";
import {
  createNotFoundError,
  type BindableOperation,
  type BoundAction,
  type Grant,
  type Notification,
  type NotificationCreateInput,
  type SortDirection,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import type { Change } from "../db";
import { buildAnnouncementRecorder, TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { BindableOperations, type BindableOperationError } from "./bindable-operations";
import { NotificationService, NotificationServiceLayer } from "./index";
import { Notifier, NotifierLayer } from "./notifier";
import { notificationRepository } from "./repository";
import {
  insertOpenDecision,
  NotificationServiceTestLayer,
  readStoredNotification,
} from "./testing";

type Deps = NotificationService | SqlClient.SqlClient;

const layer = NotificationServiceTestLayer.pipe(
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

const ASSISTANT_ID = "0199e0e7-0000-7000-8000-00000000a001";
const WORKFLOW_ID = "0199e0e7-0000-7000-8000-00000000f001";
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
      // The test describer writes the operation id as the describe line.
      actions: [
        { ...DECISION.actions![0]!, describeLine: [{ kind: "text", text: "run.start" }] },
        { ...DECISION.actions![1]!, describeLine: [{ kind: "text", text: "Does nothing" }] },
      ],
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

  it("shows a session and a run every notification, whoever produced it", async () => {
    const { created, readBySession, listedByRun } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const created = [
          (yield* actAs(PLAIN_SESSION, notifications.create(DECISION))).notificationId,
          (yield* actAs(OTHER_SESSION, notifications.create(INFORMATIONAL))).notificationId,
          (yield* actAs(SENT_RUN, notifications.create(INFORMATIONAL))).notificationId,
        ];
        return {
          created,
          readBySession: yield* actAs(PLAIN_SESSION, notifications.read(created[1]!)),
          listedByRun: (yield* actAs(WORKFLOW_RUN, notifications.query({}))).items,
        };
      }),
    );

    expect(readBySession.id).toBe(created[1]);
    expect(listedByRun.map((notification) => notification.id).sort()).toEqual([...created].sort());
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
            notifications.query({ sort: [{ field: "createdAt", direction: "asc" }] }),
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
        const walk = (direction: SortDirection) =>
          Effect.gen(function* () {
            const titles: Array<string> = [];
            let cursor: string | undefined;
            for (let page = 0; page < 10; page++) {
              const result = yield* actAs(
                USER,
                notifications.query({
                  limit: 2,
                  sort: [{ field: "createdAt", direction }],
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
                sort: [{ field: "createdAt", direction: "asc" }],
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

describe("notification.create with bound operations", () => {
  it("refuses an operation an answer may not run, with the path of its op", async () => {
    const error = await run(
      Effect.flatMap(NotificationService, (notifications) =>
        Effect.flip(
          actAs(
            PLAIN_SESSION,
            notifications.create({
              ...DECISION,
              actions: [
                {
                  id: "delete",
                  label: "Delete the task",
                  operation: { op: "task.delete", input: { id: TASK_ID } },
                },
              ],
            }),
          ),
        ),
      ),
    );

    expect(error).toMatchObject({
      error: {
        code: "validation",
        details: { issues: [{ path: ["actions", "0", "operation", "op"] }] },
      },
    });
  });

  it("refuses an input that does not fit the operation, with a path under its input", async () => {
    const error = await run(
      Effect.flatMap(NotificationService, (notifications) =>
        Effect.flip(
          actAs(
            PLAIN_SESSION,
            notifications.create({
              ...DECISION,
              actions: [
                { id: "dismiss", label: "Dismiss", operation: null },
                {
                  id: "start",
                  label: "Start",
                  operation: { op: "run.start", input: { workflowId: 42 } },
                },
              ],
            }),
          ),
        ),
      ),
    );

    expect(error).toMatchObject({
      error: {
        code: "validation",
        details: { issues: [{ path: ["actions", "1", "operation", "input", "workflowId"] }] },
      },
    });
  });

  it('stores the calling session\'s id for the session id "me"', async () => {
    const notification = await run(
      createAndRead(PLAIN_SESSION, {
        ...DECISION,
        actions: [
          {
            id: "continue",
            label: "Continue",
            operation: { op: "session.input", input: { sessionId: "me", text: "continue" } },
          },
        ],
      }),
    );

    expect(notification.actions[0]!.operation).toEqual({
      op: "session.input",
      input: { sessionId: PLAIN_SESSION_ID, text: "continue" },
    });
  });

  it('refuses the session id "me" from a run, because a run is not a session', async () => {
    const error = await run(
      Effect.flatMap(NotificationService, (notifications) =>
        Effect.flip(
          actAs(
            WORKFLOW_RUN,
            notifications.create({
              ...DECISION,
              actions: [
                {
                  id: "continue",
                  label: "Continue",
                  operation: { op: "session.input", input: { sessionId: "me", text: "continue" } },
                },
              ],
            }),
          ),
        ),
      ),
    );

    expect(error).toMatchObject({
      error: {
        code: "validation",
        details: { issues: [{ path: ["actions", "0", "operation", "input", "sessionId"] }] },
      },
    });
  });
});

describe("notification.create with answers only the producer may bind", () => {
  /** Creates a decision as `actor` with one answer running `operation`, and returns the failure. */
  const refuseAnswer = (actor: Actor, operation: { op: string; input: unknown }) =>
    Effect.flatMap(NotificationService, (notifications) =>
      Effect.flip(
        actAs(
          actor,
          notifications.create({
            ...DECISION,
            actions: [{ id: "answer", label: "Answer", operation }],
          }),
        ),
      ),
    );

  it.each([
    ["a session", PLAIN_SESSION],
    ["a run", WORKFLOW_RUN],
  ] as const)(
    "refuses session.respondToApprovalRequest from %s, because only the core binds it",
    async (_, actor) => {
      const error = await run(
        refuseAnswer(actor, {
          op: "session.respondToApprovalRequest",
          input: { sessionId: PLAIN_SESSION_ID, requestId: "req-1", decision: "allow" },
        }),
      );

      expect(error).toMatchObject({
        error: {
          code: "validation",
          details: {
            issues: [
              {
                path: ["actions", "0", "operation", "op"],
                message: expect.stringMatching(
                  /core raises .* bind session.input instead/,
                ) as unknown,
              },
            ],
          },
        },
      });
    },
  );

  it("refuses a session that binds session.input to another session", async () => {
    const error = await run(
      refuseAnswer(PLAIN_SESSION, {
        op: "session.input",
        input: { sessionId: OTHER_SESSION_ID, text: "continue" },
      }),
    );

    expect(error).toMatchObject({
      error: {
        code: "validation",
        details: {
          issues: [
            {
              path: ["actions", "0", "operation", "input"],
              message: expect.stringMatching(/only to itself.*"me"/) as unknown,
            },
          ],
        },
      },
    });
  });

  it("refuses a session in an assistant's conversation that binds session.input to itself", async () => {
    const error = await run(
      refuseAnswer(ASSISTANT_SESSION, {
        op: "session.input",
        input: { sessionId: "me", text: "continue" },
      }),
    );

    expect(error).toMatchObject({
      error: {
        code: "validation",
        details: {
          issues: [
            {
              path: ["actions", "0", "operation", "input"],
              message: expect.stringMatching(
                /conversation\.send.*in the conversation instead/,
              ) as unknown,
            },
          ],
        },
      },
    });
  });

  it("lets a run bind session.input to any session", async () => {
    const notification = await run(
      createAndRead(WORKFLOW_RUN, {
        ...DECISION,
        actions: [
          {
            id: "continue",
            label: "Continue",
            operation: {
              op: "session.input",
              input: { sessionId: PLAIN_SESSION_ID, text: "continue" },
            },
          },
        ],
      }),
    );

    expect(notification.actions[0]!.operation).toEqual({
      op: "session.input",
      input: { sessionId: PLAIN_SESSION_ID, text: "continue" },
    });
  });
});

describe("describe lines", () => {
  it("are added to the answers of an open decision only, on read and on query", async () => {
    const { open, listed, withdrawn } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        const open = yield* actAs(USER, notifications.read(notificationId));
        const listed = (yield* actAs(USER, notifications.query({}))).items[0]!;
        yield* actAs(PLAIN_SESSION, notifications.withdraw({ id: notificationId, reason: "done" }));
        return { open, listed, withdrawn: yield* actAs(USER, notifications.read(notificationId)) };
      }),
    );

    expect(open.actions.map((action) => action.describeLine)).toEqual([
      [{ kind: "text", text: "run.start" }],
      [{ kind: "text", text: "Does nothing" }],
    ]);
    expect(listed.actions).toEqual(open.actions);
    // A resolved decision's answers can no longer be taken, so they are not described.
    expect(withdrawn.actions).toEqual(DECISION.actions);
  });

  it("are added only for the user, the only caller who can take an answer", async () => {
    const { read, listed } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
        return {
          read: yield* actAs(PLAIN_SESSION, notifications.read(notificationId)),
          listed: (yield* actAs(PLAIN_SESSION, notifications.query({}))).items[0]!,
        };
      }),
    );

    expect(read.actions).toEqual(DECISION.actions);
    expect(listed.actions).toEqual(DECISION.actions);
  });

  it("say why a stored answer whose operation no longer passes the check cannot be taken", async () => {
    const notification = await run(
      Effect.gen(function* () {
        // An operation that was bindable when the notification was created,
        // and no longer is. Only a direct insert into the table can store one.
        const stored = yield* (yield* notificationRepository).insert({
          kind: "triage.proposal",
          title: "Delete the duplicate?",
          producer: { type: "session", sessionId: PLAIN_SESSION_ID },
          subject: [],
          actions: [
            {
              id: "delete",
              label: "Delete",
              operation: { op: "task.delete", input: { id: TASK_ID } },
            },
          ],
          status: "open",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        return yield* actAs(
          USER,
          Effect.flatMap(NotificationService, (notifications) => notifications.read(stored.id)),
        );
      }),
    );

    expect(notification.actions[0]!.describeLine).toEqual([
      {
        kind: "text",
        text: "Cannot be taken: An answer cannot run task.delete. An answer can run one of: task.update, run.start, session.input, session.respondToApprovalRequest.",
      },
    ]);
  });
});

describe("notification.act", () => {
  const RENAME: BoundAction = {
    id: "rename",
    label: "Rename",
    operation: { op: "task.update", input: { taskId: TASK_ID, title: "Renamed" } },
  };

  /** Runs one operation for a test. It is handed the notifier, so it can resolve decisions. */
  type RunOperation = (
    operation: BindableOperation,
    notifier: Notifier["Service"],
  ) => Effect.Effect<void, BindableOperationError>;

  /**
   * Builds the notification service over a real database and a fake port
   * whose `run` calls `run`.
   */
  const buildLayer = (run: RunOperation) =>
    NotificationServiceLayer.pipe(
      Layer.provide(
        Layer.effect(BindableOperations)(
          Effect.gen(function* () {
            const notifier = yield* Notifier;
            return BindableOperations.of({
              run: (operation) => run(operation, notifier),
              describe: () => Effect.succeed([]),
            });
          }),
        ),
      ),
      Layer.provideMerge(NotifierLayer),
      Layer.provideMerge(AuditLogLayer),
      Layer.provideMerge(TestDatabase),
    );

  /** Inserts an open decision about the task, whose one answer renames it. */
  const insertRenameDecision = insertOpenDecision({ kind: "task", id: TASK_ID }, [RENAME]);

  /**
   * Returns a `run` whose first call signals `entered`, waits for `release`,
   * then ends with `firstOutcome`. Later calls succeed at once. `calls`
   * counts every call.
   */
  const buildHeldRun = (firstOutcome: Effect.Effect<void, BindableOperationError>) => {
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    const counter = { calls: 0 };
    const run: RunOperation = () => {
      counter.calls += 1;
      return counter.calls === 1
        ? Effect.andThen(
            Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)),
            firstOutcome,
          )
        : Effect.void;
    };
    return { entered, release, counter, run };
  };

  /**
   * Takes the rename answer twice: the second answer is taken while the first
   * holds the transaction. Returns both results, and the number of calls to
   * `run` seen while the first still held it.
   */
  const actTwiceAtOnce = (held: ReturnType<typeof buildHeldRun>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const id = yield* insertRenameDecision;
        const first = yield* Effect.forkChild(
          Effect.result(notifications.act({ id, actionId: "rename" })),
        );
        yield* Deferred.await(held.entered);
        const second = yield* Effect.forkChild(
          Effect.result(notifications.act({ id, actionId: "rename" })),
        );
        // Gives the second answer time to run if nothing held it back.
        yield* Effect.sleep("50 millis");
        const callsWhileHeld = held.counter.calls;
        yield* Deferred.succeed(held.release, undefined);
        return {
          first: yield* Fiber.join(first),
          second: yield* Fiber.join(second),
          callsWhileHeld,
        };
      }).pipe(Effect.provide(buildLayer(held.run)), Effect.provideService(CurrentActor, USER)),
    );

  it("lets a second answer wait for the first, and run once the first has failed", async () => {
    const held = buildHeldRun(Effect.fail(createNotFoundError("no such task")));

    const { first, second, callsWhileHeld } = await actTwiceAtOnce(held);

    expect(callsWhileHeld).toBe(1);
    expect(first).toMatchObject({ _tag: "Failure", failure: { error: { code: "not_found" } } });
    expect(second).toMatchObject({
      _tag: "Success",
      success: { resolution: { kind: "decided", actionId: "rename" } },
    });
    expect(held.counter.calls).toBe(2);
  });

  it("lets a second answer wait for the first, and refuses it once the first has resolved the decision", async () => {
    const held = buildHeldRun(Effect.void);

    const { first, second, callsWhileHeld } = await actTwiceAtOnce(held);

    expect(callsWhileHeld).toBe(1);
    expect(first).toMatchObject({
      _tag: "Success",
      success: { resolution: { kind: "decided", actionId: "rename" } },
    });
    expect(second).toMatchObject({
      _tag: "Failure",
      failure: {
        error: {
          code: "invalid_state",
          message: expect.stringMatching(/already resolved/) as unknown,
        },
      },
    });
    expect(held.counter.calls).toBe(1);
  });

  it("accepts an operation that resolves the decision itself with the same answer", async () => {
    // `session.respondToApprovalRequest` does this: it resolves the approval decision about
    // the request it answers, with the answer the user took.
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const id = yield* insertRenameDecision;
        yield* notifications.act({ id, actionId: "rename" });
        return yield* readStoredNotification(id);
      }).pipe(
        Effect.provide(
          buildLayer((_, notifier) =>
            Effect.asVoid(notifier.answerDecisionsAbout({ kind: "task", id: TASK_ID }, "rename")),
          ),
        ),
        Effect.provideService(CurrentActor, USER),
      ),
    );

    expect(stored.resolution).toMatchObject({ kind: "decided", actionId: "rename" });
  });

  it("refuses a run, which passes every grant check, and leaves the decision open", async () => {
    let calls = 0;
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const id = yield* insertRenameDecision;
        const refused = yield* Effect.flip(
          actAs(SENT_RUN, notifications.act({ id, actionId: "rename" })),
        );
        return { refused, stored: yield* readStoredNotification(id) };
      }).pipe(
        Effect.provide(
          buildLayer(() =>
            Effect.sync(() => {
              calls += 1;
            }),
          ),
        ),
      ),
    );

    expect(outcome.refused).toMatchObject({
      error: {
        code: "forbidden",
        message: expect.stringMatching(/^only the user may take an answer/) as unknown,
      },
    });
    expect(outcome.stored.status).toBe("open");
    expect(calls).toBe(0);
  });
});
