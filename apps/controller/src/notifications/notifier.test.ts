/**
 * Tests the notifier against a migrated in-memory database: the notifications
 * the core raises about itself, and the resolutions and withdrawals of
 * decisions that the controller makes when a question was answered or
 * stopped existing somewhere else. The notification service creates and
 * reads the notifications these tests start from and check.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { NotificationCreateInput, NotificationSubject } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotificationService, Notifier, type CoreNotification } from "./index";
import { NotificationServiceTestLayer } from "./testing";

type Deps = NotificationService | Notifier | SqlClient.SqlClient;

const layer = NotificationServiceTestLayer.pipe(
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

const WORKFLOW_ID = "0199e0e7-0000-7000-8000-00000000f001";
const OTHER_WORKFLOW_ID = "0199e0e7-0000-7000-8000-00000000f002";
const PROFILE_ID = "0199e0e7-0000-7000-8000-00000000d001";

/** A session that is part of no conversation, and produces the decisions. */
const PLAIN_SESSION_ID = "0199e0e7-0000-7000-8000-00000000b501";
/** A second session in no conversation, which produced nothing. */
const OTHER_SESSION_ID = "0199e0e7-0000-7000-8000-00000000b502";

/** A run started from the stored workflow `WORKFLOW_ID`. */
const WORKFLOW_RUN_ID = "0199e0e7-0000-7000-8000-00000000e001";

const TASK_ID = "0199e0e7-0000-7000-8000-000000007a51";
const OTHER_TASK_ID = "0199e0e7-0000-7000-8000-000000007a52";
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** Builds the actor of a session in no conversation that may read and write notifications. */
const buildSessionActor = (sessionId: string): Actor => ({
  _tag: "session",
  sessionId,
  profileId: PROFILE_ID,
  grants: ["notification.read", "notification.write"],
  assistantId: null,
});

const PLAIN_SESSION = buildSessionActor(PLAIN_SESSION_ID);
const OTHER_SESSION = buildSessionActor(OTHER_SESSION_ID);

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
 * Runs an effect on a fresh database, on a `TestClock`. The effect runs with
 * no actor; each call inside it picks its caller with `actAs`.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer())));

/** Runs one call as `actor`. */
const actAs = <A, E, R>(actor: Actor, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, CurrentActor, actor);

describe("createCoreNotification", () => {
  it("stores an informational notification from the core, with no mute key, stamped as the system", async () => {
    const { notification, entries } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const notifier = yield* Notifier;
        // No actor: only the controller calls this, and it checks no grant.
        yield* notifier.createCoreNotification(CORE);
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
        const notifier = yield* Notifier;
        const failure = yield* Effect.flip(
          withTransaction(
            sql,
            Effect.andThen(
              notifier.createCoreNotification(CORE),
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

describe("createCoreNotification with unlessRaised", () => {
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
  const checkCreated = (
    candidate: CoreNotification,
    offsetMs: number,
    about?: ReadonlyArray<NotificationSubject>,
  ): Promise<boolean> =>
    run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const notifier = yield* Notifier;
        yield* notifier.createCoreNotification(RAISED);
        const [raised] = (yield* actAs(USER, notifications.query({}))).items;
        yield* notifier.createCoreNotification(candidate, {
          unlessRaised: {
            since: shiftIso(raised!.createdAt, offsetMs),
            ...(about === undefined ? {} : { about }),
          },
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
      // A subject of its own is left out of the search when `about` names
      // only the shared one.
      ownSubjectLeftOutOfTheSearch: await checkCreated(
        { ...RAISED, subject: [RUNNER, { kind: "runner", id: UNKNOWN_ID }] },
        -1,
        [RUNNER],
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
      ownSubjectLeftOutOfTheSearch: false,
    });
  });

  it("creates nothing when one was raised within the quiet period before now, and creates it once the period is over", async () => {
    /** Raises `RAISED`, then asks to create it again unless raised `within` before now. */
    const checkCreatedWithin = (within: Duration.Duration): Promise<boolean> =>
      run(
        Effect.gen(function* () {
          const notifications = yield* NotificationService;
          const notifier = yield* Notifier;
          yield* notifier.createCoreNotification(RAISED);
          yield* notifier.createCoreNotification(RAISED, { unlessRaised: { within } });
          return (yield* actAs(USER, notifications.query({}))).items.length === 2;
        }),
      );

    expect({
      withinAnHour: await checkCreatedWithin(Duration.hours(1)),
      withinNoTime: await checkCreatedWithin(Duration.zero),
    }).toEqual({ withinAnHour: false, withinNoTime: true });
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
        const notifier = yield* Notifier;
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
        yield* notifier.withdrawDecisionsAbout(
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
        const notifier = yield* Notifier;
        const { notificationId } = yield* createDecisionAbout("about the task", [
          { kind: "task", id: TASK_ID },
        ]);
        yield* notifier.withdrawDecisionsAbout([], "nothing was removed");
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

describe("decide", () => {
  const API_KEY_USER: Actor = {
    ...USER,
    credential: { kind: "apiKey", id: "0199e0e7-0002-7000-8000-000000000000", tokenHash: "y" },
  };

  it("resolves an open decision as decided with the answer, stamped with the actor and where it was taken", async () => {
    const results = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const notifier = yield* Notifier;
        const decideAs = (actor: Actor) =>
          Effect.gen(function* () {
            const { notificationId } = yield* actAs(PLAIN_SESSION, notifications.create(DECISION));
            const open = yield* actAs(USER, notifications.read(notificationId));
            const [start, dismiss] = open.actions;
            const decided = yield* actAs(actor, notifier.decide(open, start!));
            const again = yield* actAs(actor, notifier.decide(open, dismiss!));
            return {
              decided,
              again,
              stored: yield* actAs(USER, notifications.read(notificationId)),
            };
          });
        return {
          login: yield* decideAs(USER),
          apiKey: yield* decideAs(API_KEY_USER),
          session: yield* decideAs(OTHER_SESSION),
          entries: yield* readEventsOfKind("notification.decided"),
        };
      }),
    );

    const expectations = [
      [results.login, "user", "web"],
      [results.apiKey, "user", "api"],
      [results.session, `session:${OTHER_SESSION_ID}`, `session:${OTHER_SESSION_ID}`],
    ] as const;
    for (const [result, actor, origin] of expectations) {
      expect(result.decided, origin).toBe(true);
      // The second answer finds the decision resolved, and changes nothing.
      expect(result.again, origin).toBe(false);
      expect(result.stored.status, origin).toBe("resolved");
      expect(result.stored.resolution, origin).toEqual({
        kind: "decided",
        actionId: "start",
        actor,
        origin,
        at: result.stored.resolution!.at,
      });
    }
    expect(results.entries.map((entry) => [entry.actor, entry.payload])).toEqual(
      expectations.map(([result, actor]) => [
        actor,
        {
          notificationId: result.stored.id,
          actionId: "start",
          op: "run.start",
          producer: { type: "session", sessionId: PLAIN_SESSION_ID },
        },
      ]),
    );
  });
});

describe("answerDecisionsAbout", () => {
  const REQUEST: NotificationSubject = {
    kind: "request",
    sessionId: PLAIN_SESSION_ID,
    requestId: "req-1",
  };

  /** Builds the `session.respond` answer to the request `REQUEST` with one decision. */
  const buildRespond = (decision: "allow" | "deny") => ({
    op: "session.respond" as const,
    input: { sessionId: PLAIN_SESSION_ID, requestId: "req-1", decision },
  });

  /**
   * Raises a core decision about `subject`, titled `title`, whose answers
   * respond to `REQUEST`, the way the core raises one for each approval
   * request.
   */
  const raiseApproval = (title: string, subject: ReadonlyArray<NotificationSubject>) =>
    Effect.flatMap(Notifier, (notifier) =>
      notifier.createCoreNotification({
        kind: "core.approval",
        title,
        subject,
        actions: [
          { id: "allow", label: "Allow", operation: buildRespond("allow") },
          { id: "deny", label: "Deny", operation: buildRespond("deny") },
        ],
      }),
    );

  it("resolves the open decisions about the subject that offer the answer, as decided with that answer", async () => {
    const { outcome, byTitle, entries } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const notifier = yield* Notifier;
        yield* raiseApproval("about the request", [REQUEST]);
        yield* raiseApproval("about another request", [{ ...REQUEST, requestId: "req-2" }]);
        yield* actAs(
          PLAIN_SESSION,
          notifications.create({ ...DECISION, title: "offers no such answer", subject: [REQUEST] }),
        );

        const outcome = yield* actAs(USER, notifier.answerDecisionsAbout(REQUEST, "deny"));

        const all = (yield* actAs(USER, notifications.query({}))).items;
        return {
          outcome,
          byTitle: new Map(all.map((notification) => [notification.title, notification])),
          entries: yield* readEventsOfKind("notification.decided"),
        };
      }),
    );

    expect(outcome).toBe("decided");
    const decided = byTitle.get("about the request")!;
    expect(decided.resolution).toEqual({
      kind: "decided",
      actionId: "deny",
      actor: "user",
      origin: "web",
      at: decided.resolution!.at,
    });
    expect(byTitle.get("about another request")!.status).toBe("open");
    expect(byTitle.get("offers no such answer")!.status).toBe("open");
    expect(entries.map((entry) => entry.payload)).toEqual([
      {
        notificationId: decided.id,
        actionId: "deny",
        op: "session.respond",
        producer: { type: "core" },
      },
    ]);
  });

  it("reports a question already decided when the only decision about the subject was decided", async () => {
    const { first, second } = await run(
      Effect.gen(function* () {
        const notifier = yield* Notifier;
        yield* raiseApproval("about the request", [REQUEST]);
        const answer = notifier.answerDecisionsAbout(REQUEST, "allow");
        return { first: yield* actAs(USER, answer), second: yield* actAs(USER, answer) };
      }),
    );

    expect(first).toBe("decided");
    expect(second).toBe("already-decided");
  });

  it("reports a question withdrawn when the only decision about the subject was withdrawn", async () => {
    const { outcome, stored } = await run(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const notifier = yield* Notifier;
        yield* raiseApproval("about the request", [REQUEST]);
        yield* notifier.withdrawDecisionsAbout([REQUEST], "the turn was interrupted");
        return {
          outcome: yield* actAs(USER, notifier.answerDecisionsAbout(REQUEST, "allow")),
          stored: (yield* actAs(USER, notifications.query({}))).items[0]!,
        };
      }),
    );

    expect(outcome).toBe("already-withdrawn");
    // The withdrawal stands: the answer given too late changes nothing.
    expect(stored.resolution).toMatchObject({ kind: "withdrawn" });
  });

  it("reports none when no decision lists the subject", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const notifier = yield* Notifier;
        // An informational notification is resolved from the start, but it
        // asks nothing, so it does not settle the question.
        yield* notifier.createCoreNotification({ ...CORE, subject: [REQUEST] });
        return yield* actAs(USER, notifier.answerDecisionsAbout(REQUEST, "allow"));
      }),
    );

    expect(outcome).toBe("none");
  });
});
