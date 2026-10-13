/**
 * Tests both feeds as a tape: one fake workspace that changes between polls
 * the way Linear's users change it, the events each poll emits, and the
 * signals those events raise and end. Also the ways a poll fails, and that a
 * failed poll stores nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Result } from "effect";
import { AuthError, PluginError, type EmittedEvent } from "@hercule/plugin-host";
import type { LinearConnectionConfig } from "../connection-type";
import { LINEAR_SIGNAL_KINDS } from "../signal-kinds";
import {
  buildFakeIssue,
  buildFakeLinear,
  buildFakeNotification,
  buildFakeWorld,
  buildIngestHarness,
  FAKE_STATES,
  OTHER_USER,
  runAgainstStub,
  stampAt,
  TEST_ORGANIZATION,
  type FakeIssue,
  type FakeLinear,
  type IngestHarness,
} from "../testing";
import { pollWithConnection } from "./index";

/**
 * The clock of every test. Only `Date` is faked, which is what the plugin's
 * `Clock` and the fake Linear read, so a test decides when a poll happens
 * instead of racing the real clock.
 */
const START_OF_TESTS = new Date("2026-10-12T09:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START_OF_TESTS);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Moves the clock forward by `minutes`. */
const advanceClock = (minutes: number): void => {
  vi.setSystemTime(Date.now() + minutes * 60_000);
};

/** Returns an issue's External Ref in the test workspace, which is also its thread. */
const refIssue = (id: string): string => `linear:issue:${TEST_ORGANIZATION.id}/${id}`;

/**
 * Plays the core's part for the signals of `events`, in order: an event ends
 * the open signals on its thread whose kind lists the event's kind among its
 * ends, and raises a signal of every kind that lists it in `from`. The core
 * also evaluates each kind's rule and ends; every Linear kind's rule is
 * "yes", and every end applies to its event kind, so the kinds alone decide.
 */
const applySignalKinds = (harness: IngestHarness, events: ReadonlyArray<EmittedEvent>): void => {
  for (const event of events) {
    const thread = event.refs[0] ?? "";
    for (const kind of LINEAR_SIGNAL_KINDS) {
      const qualified = `linear/${kind.word}`;
      if (kind.ends.some((end) => end.eventKind === event.kind)) {
        const open = harness.openSignals.findIndex(
          (signal) => signal.kind === qualified && signal.threadRef === thread,
        );
        if (open !== -1) harness.openSignals.splice(open, 1);
      }
      if (kind.from.includes(event.kind)) {
        const replaced = harness.openSignals.findIndex(
          (signal) => signal.kind === qualified && signal.threadRef === thread,
        );
        if (replaced !== -1) harness.openSignals.splice(replaced, 1);
        harness.openSignals.push({ kind: qualified, threadRef: thread, raisedAt: stampAt(0) });
      }
    }
  }
};

/** One fake workspace, the harness a Connection would have, and a way to poll both feeds. */
const buildTape = (issues: Array<FakeIssue> = [], config: LinearConnectionConfig = {}) => {
  const fake: FakeLinear = buildFakeLinear(buildFakeWorld(issues));
  const harness = buildIngestHarness();
  const tape = {
    fake,
    harness,
    world: fake.world,
    config,
    /** Polls one feed once and returns the result, whether it succeeded or failed. */
    pollResult: (feed: "issues" | "notifications", context = harness.context) =>
      runAgainstStub(pollWithConnection(feed, tape.config, context), fake),
    /**
     * Lets a minute pass, polls the `issues` feed and then the
     * `notifications` feed, requires both to succeed, raises and ends the
     * signals their events would, and returns the events.
     */
    poll: async (): Promise<Array<EmittedEvent>> => {
      harness.events.length = 0;
      advanceClock(1);
      for (const feed of ["issues", "notifications"] as const) {
        const result = await tape.pollResult(feed);
        if (Result.isFailure(result)) {
          throw new Error(`the ${feed} poll failed: ${result.failure.message}`);
        }
        expect(result.success).toEqual({});
      }
      const events = [...harness.events];
      applySignalKinds(harness, events);
      return events;
    },
    /** Returns the kinds and threads of the open signals, sorted. */
    readOpenSignals: () =>
      harness.openSignals.map((signal) => `${signal.kind} ${signal.threadRef}`).sort(),
  };
  return tape;
};

/** Returns the kinds of events and the thread each is on, which is what a tape asserts. */
const summarize = (events: ReadonlyArray<EmittedEvent>) =>
  events.map((event) => [event.kind, event.refs[0]]);

/** Returns the issue the test changes. Throws when the world has no such issue. */
const findIssue = (tape: ReturnType<typeof buildTape>, id: string): FakeIssue => {
  const issue = tape.world.issues.find((candidate) => candidate.id === id);
  if (issue === undefined) throw new Error(`the world has no issue ${id}`);
  return issue;
};

/** Changes an issue the way Linear does: the change moves `updatedAt`. */
const change = (issue: FakeIssue, fields: Partial<FakeIssue>): void => {
  Object.assign(issue, fields, { updatedAt: stampAt(0) });
};

/** Adds Grace's notification that she assigned Ada `issue`. */
const notifyAssigned = (tape: ReturnType<typeof buildTape>, id: string, issue: FakeIssue) => {
  tape.world.notifications.push(
    buildFakeNotification(id, {
      type: "issueAssignedToYou",
      category: "assignments",
      title: `${OTHER_USER.name} assigned you ${issue.identifier}`,
      issueId: issue.id,
    }),
  );
};

/** Adds Grace's notification that she mentioned Ada in a comment on `issue`. */
const notifyMention = (tape: ReturnType<typeof buildTape>, id: string, issue: FakeIssue) => {
  tape.world.notifications.push(
    buildFakeNotification(id, {
      type: "issueMention",
      category: "mentions",
      title: `${OTHER_USER.name} mentioned you in ${issue.identifier}`,
      issueId: issue.id,
      comment: {
        id: `comment-${id}`,
        body: "@ada can you check the Safari logs?",
        url: `${issue.url}#comment-${id}`,
        createdAt: stampAt(0),
        user: { ...OTHER_USER },
        parent: null,
      },
    }),
  );
};

describe("the tape", () => {
  it("follows an issue that enters, changes and leaves the watched set", async () => {
    const tape = buildTape();
    expect(await tape.poll()).toEqual([]);

    tape.world.issues.push(buildFakeIssue(1));
    const entered = await tape.poll();
    expect(summarize(entered)).toEqual([["linear.issue.entered", refIssue("issue-1")]]);
    expect(entered[0]).toMatchObject({
      title: "ENG-1 Checkout button does nothing on Safari (1)",
      url: "https://linear.app/acme/issue/ENG-1",
      system: "linear",
      author: null,
      payload: {
        workspace: { id: TEST_ORGANIZATION.id, urlKey: "acme" },
        issue: { id: "issue-1", identifier: "ENG-1", state: { type: "unstarted" } },
        toYou: true,
        description: "Pressing the button logs a TypeError and the order is not placed.",
      },
    });
    expect(tape.readOpenSignals()).toEqual([`linear/issue ${refIssue("issue-1")}`]);

    change(findIssue(tape, "issue-1"), { priority: 1, priorityLabel: "Urgent" });
    const changed = await tape.poll();
    expect(summarize(changed)).toEqual([["linear.issue.changed", refIssue("issue-1")]]);
    expect(changed[0]?.payload).toMatchObject({ changes: { priority: { from: 3, to: 1 } } });

    // Nothing changed, so nothing is emitted.
    expect(await tape.poll()).toEqual([]);

    change(findIssue(tape, "issue-1"), { assignee: { ...OTHER_USER } });
    const left = await tape.poll();
    expect(summarize(left)).toEqual([["linear.issue.left", refIssue("issue-1")]]);
    expect(left[0]?.payload).toMatchObject({ reassigned: true, toYou: false });
    expect(tape.readOpenSignals()).toEqual([]);

    expect(await tape.poll()).toEqual([]);
  });

  it("closes an issue that is completed, archived or deleted, with how it closed", async () => {
    const tape = buildTape([buildFakeIssue(1), buildFakeIssue(2), buildFakeIssue(3)]);
    await tape.poll();

    change(findIssue(tape, "issue-1"), { state: { ...FAKE_STATES.completed } });
    change(findIssue(tape, "issue-2"), { archivedAt: stampAt(0) });
    tape.world.issues.splice(tape.world.issues.indexOf(findIssue(tape, "issue-3")), 1);
    const events = await tape.poll();

    expect(events.map((event) => [event.refs[0], event.payload])).toEqual([
      [refIssue("issue-1"), expect.objectContaining({ how: "completed" })],
      [refIssue("issue-2"), expect.objectContaining({ how: "archived" })],
      [refIssue("issue-3"), expect.objectContaining({ how: "deleted" })],
    ]);
    expect(events.every((event) => event.kind === "linear.issue.closed")).toBe(true);
  });

  it("ends a mention when it is marked done in Linear's inbox", async () => {
    // Grace's issue is outside the watched set: only the mention follows it.
    const tape = buildTape([buildFakeIssue(7, { assignee: { ...OTHER_USER } })]);
    expect(await tape.poll()).toEqual([]);

    notifyMention(tape, "notification-1", findIssue(tape, "issue-7"));
    const mentioned = await tape.poll();
    expect(summarize(mentioned)).toEqual([["linear.mentioned", refIssue("issue-7")]]);
    expect(mentioned[0]).toMatchObject({
      dedupKey: "notification-1",
      author: OTHER_USER.name,
      payload: {
        notificationId: "notification-1",
        type: "issueMention",
        actor: OTHER_USER,
        toYou: false,
        comment: {
          id: "comment-notification-1",
          body: "@ada can you check the Safari logs?",
          author: OTHER_USER,
          parent: null,
        },
      },
    });
    expect(tape.readOpenSignals()).toEqual([`linear/mention ${refIssue("issue-7")}`]);

    // The inbox did not change, and the mention is still open in it.
    expect(await tape.poll()).toEqual([]);

    const notification = tape.world.notifications[0];
    if (notification === undefined) throw new Error("the world has no notification");
    notification.archivedAt = stampAt(0);
    const archived = await tape.poll();
    expect(summarize(archived)).toEqual([["linear.notification.archived", refIssue("issue-7")]]);
    expect(archived[0]).toMatchObject({
      dedupKey: "notification-1:archived",
      payload: { notificationId: "notification-1" },
    });
    expect(tape.readOpenSignals()).toEqual([]);

    // Once the signal has ended, the feed stops looking the notification up.
    tape.fake.requests.length = 0;
    expect(await tape.poll()).toEqual([]);
    expect(tape.fake.requests.map((request) => request.operationName)).not.toContain(
      "LinearMentionLookup",
    );
  });

  it("ends an assignment when the issue is assigned to someone else", async () => {
    const tape = buildTape();
    await tape.poll();

    const issue = buildFakeIssue(4);
    tape.world.issues.push(issue);
    notifyAssigned(tape, "notification-2", issue);
    const assigned = await tape.poll();
    expect(summarize(assigned)).toEqual([
      ["linear.issue.entered", refIssue("issue-4")],
      ["linear.assigned", refIssue("issue-4")],
    ]);
    expect(assigned[1]?.payload).toMatchObject({
      actor: OTHER_USER,
      creator: OTHER_USER,
      description: "Pressing the button logs a TypeError and the order is not placed.",
      toYou: true,
    });
    expect(tape.readOpenSignals()).toEqual([
      `linear/assigned ${refIssue("issue-4")}`,
      `linear/issue ${refIssue("issue-4")}`,
    ]);

    // Still assigned to Ada: the assignment stays open.
    expect(await tape.poll()).toEqual([]);

    change(issue, { assignee: { ...OTHER_USER } });
    const unassigned = await tape.poll();
    expect(summarize(unassigned)).toEqual([
      ["linear.issue.left", refIssue("issue-4")],
      ["linear.issue.unassigned", refIssue("issue-4")],
    ]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends an assignment when the issue is completed", async () => {
    const tape = buildTape();
    await tape.poll();

    const issue = buildFakeIssue(5);
    tape.world.issues.push(issue);
    notifyAssigned(tape, "notification-3", issue);
    await tape.poll();
    expect(tape.readOpenSignals()).toHaveLength(2);

    change(issue, { state: { ...FAKE_STATES.completed } });
    const closed = await tape.poll();
    // The issue left the set and is followed: one event serves both.
    expect(summarize(closed)).toEqual([["linear.issue.closed", refIssue("issue-5")]]);
    expect(closed[0]?.payload).toMatchObject({ how: "completed" });
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends a mention on an issue outside the watched set when the issue is completed", async () => {
    const tape = buildTape([buildFakeIssue(8, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-4", findIssue(tape, "issue-8"));
    await tape.poll();
    // The first poll that follows the issue records it as open.
    expect(await tape.poll()).toEqual([]);

    change(findIssue(tape, "issue-8"), { state: { ...FAKE_STATES.completed } });
    const closed = await tape.poll();
    expect(summarize(closed)).toEqual([["linear.issue.closed", refIssue("issue-8")]]);
    expect(tape.readOpenSignals()).toEqual([]);
  });
});

describe("the notifications feed", () => {
  it("emits a plain notification for anything else, and nothing for the user's own", async () => {
    const tape = buildTape([buildFakeIssue(9)]);
    await tape.poll();

    tape.world.notifications.push(
      buildFakeNotification("notification-5", { issueId: "issue-9", comment: null }),
      buildFakeNotification("notification-6", {
        type: "projectUpdateCreated",
        category: "projects",
        title: "Checkout revamp has a new update",
        actor: null,
      }),
      buildFakeNotification("notification-7", {
        issueId: "issue-9",
        actor: { id: "user-ada", name: "Ada Lovelace" },
      }),
    );
    const events = await tape.poll();

    expect(events.map((event) => [event.kind, event.dedupKey, event.author])).toEqual([
      ["linear.notification", "notification-5", OTHER_USER.name],
      ["linear.notification", "notification-6", null],
    ]);
    expect(events[1]).toMatchObject({
      refs: [`linear:notification:${TEST_ORGANIZATION.id}/notification-6`],
      title: "Checkout revamp has a new update",
      payload: {
        subject: { type: "other", id: "notification-6" },
        type: "projectUpdateCreated",
        category: "projects",
        actor: null,
      },
    });
  });

  it("starts from the inbox as it stands, and reads each notification once", async () => {
    const tape = buildTape();
    tape.world.notifications.push(buildFakeNotification("notification-old"));
    expect(await tape.poll()).toEqual([]);

    // Created in the same millisecond as the old one: the cursor keeps the ids it read then.
    tape.world.notifications.push(
      buildFakeNotification("notification-twin", {
        createdAt: tape.world.notifications[0]?.createdAt ?? "",
      }),
    );
    const events = await tape.poll();
    expect(events.map((event) => event.dedupKey)).toEqual(["notification-twin"]);
    expect(await tape.poll()).toEqual([]);
  });
});

describe("the issues feed", () => {
  it("records the issues of a changed filter without an event for each", async () => {
    const tape = buildTape([buildFakeIssue(1)]);
    await tape.poll();
    tape.world.issues.push(buildFakeIssue(2, { assignee: { ...OTHER_USER } }));

    tape.config = { assignees: ["anyone"] };
    expect(await tape.poll()).toEqual([]);

    tape.world.issues.push(buildFakeIssue(3, { assignee: null }));
    expect(summarize(await tape.poll())).toEqual([["linear.issue.entered", refIssue("issue-3")]]);
  });

  it("sends the filters of the config to Linear", async () => {
    const tape = buildTape(
      [
        buildFakeIssue(1, { labels: { nodes: [{ id: "label-bug", name: "Bug" }] } }),
        buildFakeIssue(2),
        buildFakeIssue(3, {
          labels: { nodes: [{ id: "label-bug", name: "Bug" }] },
          state: { ...FAKE_STATES.backlog },
        }),
      ],
      { labels: ["label-bug"], states: ["unstarted"], assignees: ["me", "none"] },
    );
    await tape.poll();
    const stored = tape.harness.state.get("issues") as { issues: Record<string, unknown> };

    expect(Object.keys(stored.issues)).toEqual(["issue-1"]);
  });

  it("fails naming a label the config holds that Linear no longer has", async () => {
    const tape = buildTape([], { labels: ["label-gone"] });

    const result = await tape.pollResult("issues");

    expect(result).toEqual(
      Result.fail(
        new PluginError({
          message:
            "The label label-gone in the Connection's settings no longer exists in Linear, or is archived. Remove it in the Connection's settings.",
        }),
      ),
    );
  });

  it("fails, storing nothing, when the filters match more than 1,000 issues", async () => {
    const tape = buildTape(Array.from({ length: 1001 }, (_, index) => buildFakeIssue(index + 1)));

    const result = await tape.pollResult("issues");

    expect(Result.isFailure(result) && result.failure.message).toContain("more than 1,000");
    expect(tape.harness.state.size).toBe(0);
  });
});

describe("a failed poll", () => {
  it("is an AuthError when Linear refuses the key", async () => {
    const tape = buildTape();
    tape.world.apiKey = "lin_api_another-key";

    for (const feed of ["issues", "notifications"] as const) {
      const result = await tape.pollResult(feed);
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AuthError);
    }
  });

  it("is an AuthError when the credentials hold no key", async () => {
    const tape = buildTape();
    const result = await tape.pollResult("issues", buildIngestHarness({}).context);

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(AuthError);
  });

  it("asks the host to wait as long as Linear's rate limit says, and stores nothing", async () => {
    const tape = buildTape([buildFakeIssue(1)]);
    await tape.poll();
    tape.world.issues.push(buildFakeIssue(2));
    const before = structuredClone(tape.harness.state.get("issues"));
    tape.world.override = () => ({
      status: 400,
      headers: { "retry-after": "90" },
      body: { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] },
    });

    const result = await tape.pollResult("issues");

    expect(result).toEqual(Result.succeed({ nextAfterSeconds: 90 }));
    expect(tape.harness.state.get("issues")).toEqual(before);
    expect(tape.harness.events).toEqual([]);
  });

  it("emits the outbox of a poll that failed after its write", async () => {
    const tape = buildTape();
    await tape.poll();
    tape.world.issues.push(buildFakeIssue(1), buildFakeIssue(2));
    let emits = 0;
    const failSecondEmit = {
      ...tape.harness.context,
      emit: (event: EmittedEvent) =>
        emits++ === 1
          ? Effect.fail(new PluginError({ message: "the host could not write the event" }))
          : tape.harness.context.emit(event),
    };

    const failed = await tape.pollResult("issues", failSecondEmit);
    expect(Result.isFailure(failed)).toBe(true);
    expect(tape.harness.events).toHaveLength(1);

    const events = await tape.poll();
    // The first event is a duplicate the host drops; the second comes now.
    expect(summarize(events)).toEqual([["linear.issue.entered", refIssue("issue-2")]]);
    expect((tape.harness.state.get("issues") as { outbox: Array<unknown> }).outbox).toEqual([]);
  });

  it("fails with a PluginError for a feed the event source does not declare", async () => {
    const tape = buildTape();
    const result = await runAgainstStub(
      pollWithConnection("comments", tape.config, tape.harness.context),
      tape.fake,
    );

    expect(Result.isFailure(result) && result.failure.message).toBe(
      'The Linear event source has no feed "comments".',
    );
  });
});
