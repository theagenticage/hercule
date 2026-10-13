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
        harness.openSignals.push({
          kind: qualified,
          threadRef: thread,
          event: { dedupKey: event.dedupKey, occurredAt: event.occurredAt },
          raisedAt: stampAt(0),
        });
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

/**
 * Closes an issue the way Linear does: the state moves, and so do
 * `updatedAt` and the close time Linear keeps for that state.
 */
const close = (
  issue: FakeIssue,
  state: typeof FAKE_STATES.completed | typeof FAKE_STATES.canceled,
) => {
  change(issue, {
    state: { ...state },
    ...(state.type === "completed" ? { completedAt: stampAt(0) } : { canceledAt: stampAt(0) }),
  });
};

/** Removes an issue from the world, as deleting it in Linear does. */
const deleteIssue = (tape: ReturnType<typeof buildTape>, id: string): void => {
  tape.world.issues.splice(tape.world.issues.indexOf(findIssue(tape, id)), 1);
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

/** Returns the notification of the world with the id `id`. Throws when the world has none. */
const findNotification = (tape: ReturnType<typeof buildTape>, id: string) => {
  const notification = tape.world.notifications.find((candidate) => candidate.id === id);
  if (notification === undefined) throw new Error(`the world has no notification ${id}`);
  return notification;
};

/** Marks a notification Done in Linear's inbox, which archives it. */
const markDone = (tape: ReturnType<typeof buildTape>, id: string): void => {
  findNotification(tape, id).archivedAt = stampAt(0);
};

/** Sets when Linear created a notification, to stand for a Linear clock that differs from ours. */
const setCreatedAt = (tape: ReturnType<typeof buildTape>, id: string, createdAt: string): void => {
  findNotification(tape, id).createdAt = createdAt;
};

/**
 * Lets a minute pass and polls only the `notifications` feed, raising no
 * signal. Returns the events, for a test that plays the core's part itself.
 */
const pollNotificationsOnly = async (
  tape: ReturnType<typeof buildTape>,
): Promise<Array<EmittedEvent>> => {
  tape.harness.events.length = 0;
  advanceClock(1);
  expect(Result.isSuccess(await tape.pollResult("notifications"))).toBe(true);
  return [...tape.harness.events];
};

/**
 * Raises the signal of only the event whose dedup key is `dedupKey`, as the
 * core does when an Ignore Rule catches the other events.
 */
const raiseFromOneNotification = (
  events: ReadonlyArray<EmittedEvent>,
  dedupKey: string,
  tape: ReturnType<typeof buildTape>,
): void => {
  applySignalKinds(
    tape.harness,
    events.filter((event) => event.dedupKey === dedupKey),
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

    close(findIssue(tape, "issue-1"), FAKE_STATES.completed);
    change(findIssue(tape, "issue-2"), { archivedAt: stampAt(0) });
    deleteIssue(tape, "issue-3");
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

    close(issue, FAKE_STATES.completed);
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

    close(findIssue(tape, "issue-8"), FAKE_STATES.completed);
    const closed = await tape.poll();
    expect(summarize(closed)).toEqual([["linear.issue.closed", refIssue("issue-8")]]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends a mention on an issue that is completed before the issues feed first follows it", async () => {
    const tape = buildTape([buildFakeIssue(8, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-4", findIssue(tape, "issue-8"));
    // The issues feed polls before the notifications feed, so it has not followed the issue yet.
    expect(summarize(await tape.poll())).toEqual([["linear.mentioned", refIssue("issue-8")]]);

    advanceClock(1);
    close(findIssue(tape, "issue-8"), FAKE_STATES.completed);
    const [signal] = tape.harness.openSignals;
    const closed = await tape.poll();
    expect(summarize(closed)).toEqual([["linear.issue.closed", refIssue("issue-8")]]);
    expect(closed[0]?.payload).toMatchObject({ how: "completed" });
    expect(tape.readOpenSignals()).toEqual([]);

    // While the core has not ended the signal yet, the end is not emitted again.
    if (signal === undefined) throw new Error("the mention raised no signal");
    tape.harness.openSignals.push(signal);
    expect(await tape.poll()).toEqual([]);
  });

  it("ends a mention on an issue that is deleted before the issues feed first follows it", async () => {
    const tape = buildTape([buildFakeIssue(8, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-4", findIssue(tape, "issue-8"));
    await tape.poll();

    deleteIssue(tape, "issue-8");
    const closed = await tape.poll();
    expect(summarize(closed)).toEqual([["linear.issue.closed", refIssue("issue-8")]]);
    expect(closed[0]).toMatchObject({
      title: "ENG-8 Checkout button does nothing on Safari (8)",
      payload: { how: "deleted", issue: { id: "issue-8" } },
    });
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends an assignment whose issue was reassigned before the issues feed first followed it", async () => {
    const tape = buildTape([buildFakeIssue(6, { assignee: { ...OTHER_USER } })]);
    await tape.poll();

    // Grace assigns Ada, then takes the issue back before any poll.
    const issue = findIssue(tape, "issue-6");
    notifyAssigned(tape, "notification-8", issue);
    expect(summarize(await tape.poll())).toEqual([["linear.assigned", refIssue("issue-6")]]);
    expect(tape.readOpenSignals()).toEqual([`linear/assigned ${refIssue("issue-6")}`]);

    const unassigned = await tape.poll();
    expect(summarize(unassigned)).toEqual([["linear.issue.unassigned", refIssue("issue-6")]]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("keeps a mention on an issue that was already completed open", async () => {
    const tape = buildTape([
      buildFakeIssue(8, {
        assignee: { ...OTHER_USER },
        state: { ...FAKE_STATES.completed },
        completedAt: stampAt(-120),
      }),
    ]);
    await tape.poll();
    notifyMention(tape, "notification-4", findIssue(tape, "issue-8"));
    await tape.poll();

    expect(await tape.poll()).toEqual([]);
    expect(await tape.poll()).toEqual([]);
    expect(tape.readOpenSignals()).toEqual([`linear/mention ${refIssue("issue-8")}`]);
  });
  it("ends an older mention whose issue closed when an Ignore Rule caught a newer mention", async () => {
    const tape = buildTape([buildFakeIssue(3, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-old", findIssue(tape, "issue-3"));
    await tape.poll();

    advanceClock(1);
    close(findIssue(tape, "issue-3"), FAKE_STATES.completed);
    advanceClock(1);
    notifyMention(tape, "notification-new", findIssue(tape, "issue-3"));
    // The notifications feed reads the newer mention before the issues feed
    // sees the close, and an Ignore Rule catches it, so the core raises
    // nothing and the older signal stays open.
    advanceClock(1);
    tape.harness.events.length = 0;
    const caught = await tape.pollResult("notifications");
    expect(Result.isSuccess(caught)).toBe(true);
    expect(tape.harness.events.map((event) => event.dedupKey)).toEqual(["notification-new"]);

    const closed = await tape.poll();
    expect(summarize(closed)).toEqual([["linear.issue.closed", refIssue("issue-3")]]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends an older mention marked done in Linear when an Ignore Rule caught a newer mention", async () => {
    const tape = buildTape([buildFakeIssue(3, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-old", findIssue(tape, "issue-3"));
    await tape.poll();

    advanceClock(1);
    notifyMention(tape, "notification-new", findIssue(tape, "issue-3"));
    // An Ignore Rule catches the newer mention, so the core raises nothing.
    advanceClock(1);
    expect(Result.isSuccess(await tape.pollResult("notifications"))).toBe(true);

    const older = tape.world.notifications.find((candidate) => candidate.id === "notification-old");
    if (older === undefined) throw new Error("the world has no older notification");
    older.archivedAt = stampAt(0);
    const archived = await tape.poll();
    expect(archived.map((event) => event.dedupKey)).toEqual(["notification-old:archived"]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("keeps a newer mention's notification while its signal is on its way and the older one ends", async () => {
    const tape = buildTape([buildFakeIssue(4, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-first", findIssue(tape, "issue-4"));
    await tape.poll();

    // The newer mention's event is stored, but the core has not raised its signal yet.
    advanceClock(1);
    notifyMention(tape, "notification-pending", findIssue(tape, "issue-4"));
    expect(Result.isSuccess(await tape.pollResult("notifications"))).toBe(true);
    await tape.poll();
    // The user resolves the older signal in Hercule.
    tape.harness.openSignals.length = 0;
    await tape.poll();

    // The newer signal is raised, and then the issue is deleted.
    tape.harness.openSignals.push({
      kind: "linear/mention",
      threadRef: refIssue("issue-4"),
      event: {
        dedupKey: "notification-pending",
        occurredAt: findNotification(tape, "notification-pending").createdAt,
      },
      raisedAt: stampAt(0),
    });
    deleteIssue(tape, "issue-4");
    const closed = await tape.poll();
    expect(summarize(closed)).toEqual([["linear.issue.closed", refIssue("issue-4")]]);
    expect(closed[0]?.payload).toMatchObject({ how: "deleted", issue: { id: "issue-4" } });
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends a mention again when its issue reopens, is mentioned again and closes again", async () => {
    const tape = buildTape([buildFakeIssue(5, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-before", findIssue(tape, "issue-5"));
    await tape.poll();
    close(findIssue(tape, "issue-5"), FAKE_STATES.completed);
    expect(summarize(await tape.poll())).toEqual([["linear.issue.closed", refIssue("issue-5")]]);

    change(findIssue(tape, "issue-5"), { state: { ...FAKE_STATES.unstarted }, completedAt: null });
    notifyMention(tape, "notification-after", findIssue(tape, "issue-5"));
    expect(summarize(await tape.poll())).toEqual([["linear.mentioned", refIssue("issue-5")]]);

    close(findIssue(tape, "issue-5"), FAKE_STATES.completed);
    expect(summarize(await tape.poll())).toEqual([["linear.issue.closed", refIssue("issue-5")]]);
    expect(await tape.poll()).toEqual([]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends an older mention whose issue closed when an Ignore Rule caught a newer mention read by the same poll", async () => {
    const tape = buildTape([buildFakeIssue(6, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-old", findIssue(tape, "issue-6"));
    advanceClock(1);
    close(findIssue(tape, "issue-6"), FAKE_STATES.completed);
    advanceClock(1);
    notifyMention(tape, "notification-new", findIssue(tape, "issue-6"));
    // One poll reads both mentions. The core raises the older one's signal
    // and an Ignore Rule catches the newer one, so the signal is written
    // after both notifications.
    raiseFromOneNotification(await pollNotificationsOnly(tape), "notification-old", tape);

    const closed = await tape.poll();
    expect(summarize(closed)).toEqual([["linear.issue.closed", refIssue("issue-6")]]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends an older mention marked done in Linear when an Ignore Rule caught a newer mention read by the same poll", async () => {
    const tape = buildTape([buildFakeIssue(6, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-old", findIssue(tape, "issue-6"));
    advanceClock(1);
    notifyMention(tape, "notification-new", findIssue(tape, "issue-6"));
    raiseFromOneNotification(await pollNotificationsOnly(tape), "notification-old", tape);

    markDone(tape, "notification-old");
    const archived = await tape.poll();
    expect(archived.map((event) => event.dedupKey)).toEqual(["notification-old:archived"]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("checks only the newer of two mentions created at one time, whose signal replaced the older one's", async () => {
    const tape = buildTape([buildFakeIssue(7, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-a", findIssue(tape, "issue-7"));
    notifyMention(tape, "notification-b", findIssue(tape, "issue-7"));
    const mentioned = await tape.poll();
    expect(mentioned.map((event) => event.dedupKey)).toEqual(["notification-a", "notification-b"]);

    // The older notification is Done, but the open signal is the newer one's.
    markDone(tape, "notification-a");
    expect(await tape.poll()).toEqual([]);
    expect(tape.readOpenSignals()).toEqual([`linear/mention ${refIssue("issue-7")}`]);

    markDone(tape, "notification-b");
    const archived = await tape.poll();
    expect(archived.map((event) => event.dedupKey)).toEqual(["notification-b:archived"]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends a mention marked done in Linear when Linear's clock is ahead of the controller's", async () => {
    const tape = buildTape([buildFakeIssue(8, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-ahead", findIssue(tape, "issue-8"));
    setCreatedAt(tape, "notification-ahead", stampAt(3));
    await tape.poll();
    expect(tape.readOpenSignals()).toEqual([`linear/mention ${refIssue("issue-8")}`]);

    markDone(tape, "notification-ahead");
    const archived = await tape.poll();
    expect(archived.map((event) => event.dedupKey)).toEqual(["notification-ahead:archived"]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("keeps the notification of an open mention past a day when Linear's clock is ahead, and ends it when the issue is deleted", async () => {
    const tape = buildTape([buildFakeIssue(8, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-ahead", findIssue(tape, "issue-8"));
    setCreatedAt(tape, "notification-ahead", stampAt(3));
    await tape.poll();

    advanceClock(24 * 60 + 1);
    expect(await tape.poll()).toEqual([]);
    deleteIssue(tape, "issue-8");
    const closed = await tape.poll();
    expect(summarize(closed)).toEqual([["linear.issue.closed", refIssue("issue-8")]]);
    expect(closed[0]?.payload).toMatchObject({ how: "deleted", issue: { id: "issue-8" } });
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends a new mention when the issue reopens and closes again after the controller's clock was set back", async () => {
    const tape = buildTape([buildFakeIssue(9, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-before", findIssue(tape, "issue-9"));
    await tape.poll();
    close(findIssue(tape, "issue-9"), FAKE_STATES.completed);
    expect(summarize(await tape.poll())).toEqual([["linear.issue.closed", refIssue("issue-9")]]);

    // The controller's clock is set back ten minutes; Linear's clock is not.
    const linearNow = Date.now();
    const linearAt = (minutes: number) => new Date(linearNow + minutes * 60_000).toISOString();
    vi.setSystemTime(linearNow - 10 * 60_000);
    Object.assign(findIssue(tape, "issue-9"), {
      state: { ...FAKE_STATES.unstarted },
      completedAt: null,
      updatedAt: linearAt(1),
    });
    notifyMention(tape, "notification-after", findIssue(tape, "issue-9"));
    setCreatedAt(tape, "notification-after", linearAt(2));
    // The issue reopens and closes again between two polls of the issues feed.
    const mentioned = await pollNotificationsOnly(tape);
    expect(summarize(mentioned)).toEqual([["linear.mentioned", refIssue("issue-9")]]);
    applySignalKinds(tape.harness, mentioned);

    Object.assign(findIssue(tape, "issue-9"), {
      state: { ...FAKE_STATES.completed },
      completedAt: linearAt(3),
      updatedAt: linearAt(3),
    });
    expect(summarize(await tape.poll())).toEqual([["linear.issue.closed", refIssue("issue-9")]]);
    expect(tape.readOpenSignals()).toEqual([]);
  });

  it("ends a mention whose issue closed after the notification when the state was reset and the controller's clock is ahead", async () => {
    const tape = buildTape([buildFakeIssue(10, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    notifyMention(tape, "notification-ahead", findIssue(tape, "issue-10"));
    const notifiedAt = findNotification(tape, "notification-ahead").createdAt;
    await pollNotificationsOnly(tape);
    // The controller's clock is five minutes ahead of Linear's when it raises the signal.
    tape.harness.openSignals.push({
      kind: "linear/mention",
      threadRef: refIssue("issue-10"),
      event: { dedupKey: "notification-ahead", occurredAt: notifiedAt },
      raisedAt: stampAt(5),
    });
    tape.harness.state.clear();
    await tape.poll();

    close(findIssue(tape, "issue-10"), FAKE_STATES.completed);
    expect(summarize(await tape.poll())).toEqual([["linear.issue.closed", refIssue("issue-10")]]);
  });

  it("keeps a mention made after its issue closed when the state was reset and the controller's clock is behind", async () => {
    const tape = buildTape([buildFakeIssue(11, { assignee: { ...OTHER_USER } })]);
    await tape.poll();
    // Linear's clock is ahead: the issue closed three minutes, and the mention
    // was made four minutes, after the controller's now.
    Object.assign(findIssue(tape, "issue-11"), {
      state: { ...FAKE_STATES.completed },
      completedAt: stampAt(3),
      updatedAt: stampAt(3),
    });
    notifyMention(tape, "notification-behind", findIssue(tape, "issue-11"));
    setCreatedAt(tape, "notification-behind", stampAt(4));
    await tape.poll();
    expect(tape.readOpenSignals()).toEqual([`linear/mention ${refIssue("issue-11")}`]);

    tape.harness.state.clear();
    expect(await tape.poll()).toEqual([]);
    expect(await tape.poll()).toEqual([]);
    expect(tape.readOpenSignals()).toEqual([`linear/mention ${refIssue("issue-11")}`]);
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

/** Adds `count` notifications from Grace, the first one created at `createdAt`, each `stepMillis` after the one before. */
const addNotifications = (
  tape: ReturnType<typeof buildTape>,
  prefix: string,
  count: number,
  createdAt: string,
  stepMillis: number,
): Array<string> => {
  const ids = Array.from({ length: count }, (_, index) => `${prefix}-${String(index)}`);
  ids.forEach((id, index) => {
    tape.world.notifications.push(
      buildFakeNotification(id, {
        createdAt: new Date(Date.parse(createdAt) + index * stepMillis).toISOString(),
      }),
    );
  });
  return ids;
};

describe("the notifications feed, reading the inbox", () => {
  it("reads more than 250 notifications that share one time, and the newer ones after them", async () => {
    const tape = buildTape();
    await tape.poll();

    const twins = addNotifications(tape, "twin", 251, stampAt(0), 0);
    const first = await tape.poll();
    expect(first).toHaveLength(250);
    const second = await tape.poll();
    expect(second).toHaveLength(1);
    expect(new Set([...first, ...second].map((event) => event.dedupKey))).toEqual(new Set(twins));

    expect(await tape.poll()).toEqual([]);
    tape.world.notifications.push(
      buildFakeNotification("notification-twin", { createdAt: stampAt(0) }),
    );
    advanceClock(1);
    tape.world.notifications.push(
      buildFakeNotification("notification-newer", { createdAt: stampAt(0) }),
    );
    expect((await tape.poll()).map((event) => event.dedupKey)).toEqual([
      "notification-twin",
      "notification-newer",
    ]);
    expect(await tape.poll()).toEqual([]);
  });

  it("reads a backlog of more than 250 notifications over several polls, oldest first, losing none", async () => {
    const tape = buildTape();
    tape.world.notifications.push(
      buildFakeNotification("notification-old", { createdAt: stampAt(-60) }),
    );
    await tape.poll();
    tape.world.pageSize = 100;

    const backlog = addNotifications(tape, "backlog", 600, stampAt(-30), 1000);
    const read: Array<string> = [];
    for (const expected of [250, 250, 100, 0]) {
      const events = await tape.poll();
      expect(events).toHaveLength(expected);
      read.push(...events.map((event) => event.dedupKey));
    }
    expect(read).toEqual(backlog);
  });

  it("reads notifications whose times tie across pages and polls exactly once, oldest first", async () => {
    const tape = buildTape();
    await tape.poll();

    // 700 notifications, 137 to a second, so ties cross both the 250-item
    // pages and the 250 notifications each poll takes.
    const ids = Array.from(
      { length: 700 },
      (_, index) => `mixed-${String(index).padStart(4, "0")}`,
    );
    ids.forEach((id, index) => {
      tape.world.notifications.push(
        buildFakeNotification(id, {
          createdAt: new Date(Date.now() + Math.floor(index / 137) * 1000).toISOString(),
        }),
      );
    });
    const read: Array<string> = [];
    for (const expected of [250, 250, 200, 0]) {
      const events = await tape.poll();
      expect(events).toHaveLength(expected);
      read.push(...events.map((event) => event.dedupKey));
    }
    expect(read).toEqual(ids);
  });

  it("skips a notification created before the newest one it has read", async () => {
    const tape = buildTape();
    await tape.poll();
    const earlier = stampAt(0);

    tape.world.notifications.push(
      buildFakeNotification("notification-newest", { createdAt: stampAt(1) }),
    );
    expect((await tape.poll()).map((event) => event.dedupKey)).toEqual(["notification-newest"]);
    tape.world.notifications.push(
      buildFakeNotification("notification-late", { createdAt: earlier }),
    );
    expect(await tape.poll()).toEqual([]);
  });

  it("starts with every notification that shares the newest time, over more than one page", async () => {
    const tape = buildTape();
    addNotifications(tape, "existing", 251, stampAt(-60), 0);

    expect(await tape.poll()).toEqual([]);
    expect(
      tape.fake.requests.filter((request) => request.operationName === "LinearInboxStart"),
    ).toHaveLength(2);
    expect(await tape.poll()).toEqual([]);
  });

  it("starts by reading only the ids and times of the newest notifications", async () => {
    const tape = buildTape();
    tape.world.notifications.push(buildFakeNotification("notification-old"));
    await tape.poll();

    expect(tape.fake.requests.map((request) => request.operationName)).toContain(
      "LinearInboxStart",
    );
    expect(tape.fake.requests.map((request) => request.operationName)).not.toContain("LinearInbox");
  });
});

describe("the issues feed", () => {
  it("writes no state when nothing changed", async () => {
    const tape = buildTape([buildFakeIssue(1)]);
    await tape.poll();
    await tape.poll();
    const issues = tape.harness.state.get("issues");
    const notifications = tape.harness.state.get("notifications");

    expect(await tape.poll()).toEqual([]);
    expect(tape.harness.state.get("issues")).toBe(issues);
    expect(tape.harness.state.get("notifications")).toBe(notifications);
  });

  it("does not count labels Linear lists in another order as a change", async () => {
    const bug = { id: "label-bug", name: "Bug" };
    const web = { id: "label-web", name: "Web" };
    const tape = buildTape([buildFakeIssue(1, { labels: { nodes: [web, bug] } })]);
    await tape.poll();

    findIssue(tape, "issue-1").labels = { nodes: [bug, web] };
    expect(await tape.poll()).toEqual([]);
  });

  it("fails, storing nothing, when the lookup of the issues that left has more pages than it read", async () => {
    const tape = buildTape([buildFakeIssue(1), buildFakeIssue(2)]);
    await tape.poll();
    close(findIssue(tape, "issue-1"), FAKE_STATES.completed);
    close(findIssue(tape, "issue-2"), FAKE_STATES.completed);
    tape.world.pageSize = 1;
    const before = tape.harness.state.get("issues");

    const result = await tape.pollResult("issues");

    expect(Result.isFailure(result) && result.failure.message).toContain("more pages");
    expect(tape.harness.state.get("issues")).toBe(before);
    expect(tape.harness.events).toEqual([]);
  });

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

  it("fails, storing nothing, when an event would be refused by the host", async () => {
    const issue = buildFakeIssue(2, { url: `https://linear.app/${"x".repeat(300_000)}` });
    const tape = buildTape([issue]);
    await tape.poll();
    const before = tape.harness.state.get("notifications");
    notifyAssigned(tape, "notification-oversized", issue);

    const result = await tape.pollResult("notifications");

    expect(Result.isFailure(result)).toBe(true);
    expect(tape.harness.state.get("notifications")).toBe(before);
    expect(tape.harness.events).toEqual([]);
  });

  it("fails asking for a reset when the stored issues state has an older shape", async () => {
    const tape = buildTape([buildFakeIssue(1)]);
    await tape.poll();
    const stored = tape.harness.state.get("issues") as Record<string, unknown>;
    tape.harness.state.set("issues", {
      ...stored,
      ended: { "issue-1": { closed: "2026-10-13T09:00:00.000Z" } },
    });

    const result = await tape.pollResult("issues");

    expect(Result.isFailure(result) && result.failure).toBeInstanceOf(PluginError);
    expect(Result.isFailure(result) && result.failure.message).toMatch(
      /could not read the stored state of its issues feed: .*Reset the plugin's state in Settings/s,
    );
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
