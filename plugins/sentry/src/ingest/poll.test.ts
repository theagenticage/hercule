/**
 * Tests the `issues` feed as a tape: one fake organization that changes
 * between polls the way Sentry's users change it, and the events each poll
 * emits. Also the ways a poll fails, and that a failed poll stores nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Result } from "effect";
import {
  AuthError,
  MAX_EMITTED_FIELD_BYTES,
  MAX_EVENT_TITLE_LENGTH,
  PluginError,
  type EmittedEvent,
} from "@hercule/plugin-host";
import type { SentryConnectionConfig } from "../connection-type";
import {
  buildFakeIssue,
  buildFakeSentry,
  buildFakeWorld,
  buildIngestHarness,
  runAgainstStub,
  stampAt,
  TEST_ACCOUNT_ID,
  TEST_TOKEN,
  type FakeActivity,
  type FakeIssue,
  type FakeSentry,
  type IngestHarness,
} from "../testing";
import { pollWithConnection } from "./index";

/**
 * The clock of every test. Only `Date` is faked, which is what the plugin's
 * `Clock` and the fake Sentry read, so a test decides when a poll happens
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

/** Watches every unresolved issue, whoever it is assigned to. */
const ANYONE: SentryConnectionConfig = { assignees: ["anyone"] };

/** One fake organization, the harness a Connection would have, and a way to poll. */
const buildTape = (issues: Array<FakeIssue> = [], config: SentryConnectionConfig = ANYONE) => {
  const fake: FakeSentry = buildFakeSentry(buildFakeWorld(issues));
  const harness: IngestHarness = buildIngestHarness();
  const tape = {
    fake,
    harness,
    world: fake.world,
    config,
    /** Polls once and returns the result, whether it succeeded or failed. */
    pollResult: (context = harness.context) =>
      runAgainstStub(
        pollWithConnection(tape.config, { accountId: TEST_ACCOUNT_ID }, context),
        fake,
      ),
    /** The time of the latest poll, as the plugin writes it into keys. */
    lastPollTime: "",
    /**
     * Lets a minute pass, polls once, requires success, and returns the events
     * the host would have stored from that poll.
     */
    poll: async (): Promise<Array<EmittedEvent>> => {
      harness.events.length = 0;
      advanceClock(1);
      tape.lastPollTime = new Date().toISOString();
      const result = await tape.pollResult();
      if (Result.isFailure(result)) {
        throw new Error(`the poll failed: ${result.failure.message}`);
      }
      expect(result.success).toEqual({});
      return [...harness.events];
    },
  };
  return tape;
};

/** Returns the kinds and the dedup keys of events, which is what a tape asserts. */
const summarize = (events: ReadonlyArray<EmittedEvent>) =>
  events.map((event) => [event.kind, event.dedupKey]);

/** Returns the issue the test changes. Throws when the world has no such issue. */
const findIssue = (tape: ReturnType<typeof buildTape>, id: string): FakeIssue => {
  const issue = tape.world.issues.find((candidate) => candidate.id === id);
  if (issue === undefined) throw new Error(`the world has no issue ${id}`);
  return issue;
};

/**
 * Builds a regression activity created `minutesFromNow` minutes from now, so a
 * negative number is in the past. A regression the feed has not seen yet must
 * be created after the poll that stored the issue, and every poll first lets a
 * minute pass: half a minute from now is after the last poll and before the next.
 */
const buildRegression = (id: string, minutesFromNow: number, version?: string): FakeActivity => ({
  id,
  type: "set_regression",
  dateCreated: stampAt(minutesFromNow),
  data: version === undefined ? {} : { version },
});

/** Resolves an issue the way Sentry shows it afterwards. */
const resolve = (issue: FakeIssue): void => {
  issue.status = "resolved";
  issue.substatus = null;
};

/** Reopens an issue by hand: no new event, so no new `lastSeen`. */
const reopen = (issue: FakeIssue): void => {
  issue.status = "unresolved";
  issue.substatus = "ongoing";
};

/** Returns the ids of the issues the events are about, each once, in the order they first appear. */
const listIssueIds = (events: ReadonlyArray<EmittedEvent>): Array<string> => [
  ...new Set(events.map((event) => event.dedupKey.split(":")[0] ?? "")),
];

/** Reads the `lastSeen` the feed stored for an issue. */
const readStoredLastSeen = (tape: ReturnType<typeof buildTape>, id: string): unknown => {
  const watched = tape.harness.state.get("watched") as {
    issues: Record<string, { issue: { lastSeen: string } }>;
  };
  return watched.issues[id]?.issue.lastSeen;
};

describe("the issues feed", () => {
  it("follows an organization over several polls", async () => {
    const tape = buildTape([buildFakeIssue("1001"), buildFakeIssue("1002")]);

    // The first poll only learns what is there.
    expect(await tape.poll()).toEqual([]);
    const baselineTime = tape.lastPollTime;
    expect(tape.harness.state.has("watched")).toBe(true);
    expect(await tape.poll()).toEqual([]);

    // A new issue enters.
    const fresh = buildFakeIssue("1003", {
      firstSeen: stampAt(-2),
      lastSeen: stampAt(-1),
      latestEvent: {
        eventID: "e1",
        dateCreated: stampAt(-1),
        release: "webshop@2.4.0",
        environment: "production",
        frames: [{ filename: "app/checkout.ts", function: "submitOrder", lineNo: 42, inApp: true }],
        type: "TypeError",
        value: "cannot read properties of undefined",
      },
    });
    tape.world.issues.push(fresh);
    const entered = await tape.poll();
    const enteredTime = tape.lastPollTime;
    expect(summarize(entered)).toEqual([
      ["sentry.issue.entered", `1003:entered:${fresh.lastSeen}`],
    ]);
    const [enteredEvent] = entered as [EmittedEvent];
    expect(enteredEvent.occurredAt).toBe(fresh.lastSeen);
    expect(enteredEvent.refs).toEqual(["sentry:issue:4501/1003", "sentry:project:4501/11"]);
    expect(enteredEvent.url).toBe("https://acme.sentry.io/issues/1003/");
    expect(enteredEvent.system).toBe("sentry");
    expect(enteredEvent.author).toBeNull();
    expect(enteredEvent.title).toBe(`WEBSHOP-1003 ${fresh.title}`);
    expect(enteredEvent.payload).toMatchObject({
      org: { id: "4501", slug: "acme" },
      issue: { id: "1003", shortId: "WEBSHOP-1003", project: { id: "11", slug: "webshop" } },
      toYou: false,
      latestEvent: { release: "webshop@2.4.0", environment: "production" },
    });

    // The user resolves issue 1001 in Sentry.
    const resolvedIssue = findIssue(tape, "1001");
    resolvedIssue.status = "resolved";
    resolvedIssue.substatus = null;
    resolvedIssue.actorId = "88";
    const resolved = await tape.poll();
    expect(summarize(resolved)).toEqual([
      ["sentry.issue.resolved", `1001:resolved:${baselineTime}`],
    ]);
    expect(resolved[0]?.payload).toMatchObject({ byYou: true });
    // The departure is stamped with the poll's time, not the issue's.
    expect(resolved[0]?.occurredAt).toBe(tape.lastPollTime);
    expect(await tape.poll()).toEqual([]);

    // Issue 1002 is resolved and regresses between two polls: the poll never saw it resolved.
    const regressedIssue = findIssue(tape, "1002");
    regressedIssue.substatus = "regressed";
    regressedIssue.lastSeen = stampAt(-1);
    regressedIssue.activity = [
      {
        id: "9001",
        type: "set_regression",
        dateCreated: stampAt(-1),
        data: { version: "webshop@2.5.0" },
      },
    ];
    const regressed = await tape.poll();
    expect(summarize(regressed)).toEqual([["sentry.issue.regressed", "1002:regressed:9001"]]);
    expect(regressed[0]?.occurredAt).toBe(regressedIssue.activity[0]?.dateCreated);
    expect(regressed[0]?.payload).toMatchObject({ after: "resolved", release: "webshop@2.5.0" });
    // Nothing new happened, so nothing is emitted again.
    expect(await tape.poll()).toEqual([]);

    // Issue 1003 is archived by a teammate.
    const archivedIssue = findIssue(tape, "1003");
    archivedIssue.status = "ignored";
    archivedIssue.substatus = "archived_until_escalating";
    archivedIssue.actorId = "89";
    const archived = await tape.poll();
    expect(summarize(archived)).toEqual([
      ["sentry.issue.archived", `1003:archived:${enteredTime}`],
    ]);
    expect(archived[0]?.payload).toMatchObject({
      substatus: "archived_until_escalating",
      byYou: false,
    });

    // It comes back escalating, which Sentry records without a regression activity.
    archivedIssue.status = "unresolved";
    archivedIssue.substatus = "escalating";
    archivedIssue.actorId = null;
    archivedIssue.lastSeen = stampAt(0);
    const returned = await tape.poll();
    expect(summarize(returned)).toEqual([
      ["sentry.issue.regressed", `1003:regressed:${archivedIssue.lastSeen}`],
    ]);
    expect(returned[0]?.occurredAt).toBe(archivedIssue.lastSeen);
    expect(returned[0]?.payload).toMatchObject({ after: "archived" });

    // Issue 1002 is open, regressed, and now Sentry marks it escalating.
    regressedIssue.substatus = "escalating";
    regressedIssue.lastSeen = stampAt(0.5);
    const escalating = await tape.poll();
    expect(summarize(escalating)).toEqual([
      ["sentry.issue.escalating", `1002:escalating:${regressedIssue.lastSeen}`],
    ]);
    expect(escalating[0]?.occurredAt).toBe(regressedIssue.lastSeen);
    expect(await tape.poll()).toEqual([]);
  });

  it("re-baselines silently when the filters change, and still emits the issues that left", async () => {
    const tape = buildTape([
      buildFakeIssue("1001"),
      buildFakeIssue("1002", { assignedTo: { type: "user", id: "89", name: "grace" } }),
    ]);
    await tape.poll();

    // Only unassigned issues from now on: 1002 leaves, and a new unassigned issue appears.
    tape.config = { assignees: ["none"] };
    tape.world.issues.push(buildFakeIssue("1003"));
    const events = await tape.poll();

    expect(events.map((event) => event.kind)).toEqual(["sentry.issue.left"]);
    expect(events[0]?.payload).toMatchObject({
      reason: "unmatched",
      reassigned: false,
      lastSeenDays: 14,
      issue: { id: "1002" },
    });
    // The issue the new filter brought in is part of the baseline, so a later poll does not announce it.
    expect(await tape.poll()).toEqual([]);
    const watched = tape.harness.state.get("watched") as { issues: Record<string, unknown> };
    expect(Object.keys(watched.issues).sort()).toEqual(["1001", "1003"]);
  });

  it("says why an issue left", async () => {
    const mine = { type: "user" as const, id: "88", name: "ada" };
    const tape = buildTape(
      [
        buildFakeIssue("1001", { assignedTo: mine }),
        buildFakeIssue("1002", { assignedTo: mine }),
        buildFakeIssue("1003", { assignedTo: mine }),
      ],
      {},
    );
    await tape.poll();

    findIssue(tape, "1001").assignedTo = { type: "user", id: "89", name: "grace" };
    findIssue(tape, "1002").lastSeen = stampAt(-20 * 24 * 60);
    tape.world.issues = tape.world.issues.filter((issue) => issue.id !== "1003");
    const events = await tape.poll();

    expect(events.map((event) => [event.kind, event.payload])).toEqual([
      ["sentry.issue.left", expect.objectContaining({ reason: "unmatched", reassigned: true })],
      ["sentry.issue.left", expect.objectContaining({ reason: "aged-out", lastSeenDays: 14 })],
      ["sentry.issue.left", expect.objectContaining({ reason: "deleted" })],
    ]);
    expect(events[0]?.payload).toMatchObject({ issue: { id: "1001" } });
    // The deleted issue is described as the last poll stored it.
    expect(events[2]?.payload).toMatchObject({ issue: { id: "1003", shortId: "WEBSHOP-1003" } });
  });

  it("emits a resolved or archived issue as resolved by someone else", async () => {
    const tape = buildTape([buildFakeIssue("1001")]);
    await tape.poll();
    const issue = findIssue(tape, "1001");
    issue.status = "resolved";
    issue.actorId = "89";

    const events = await tape.poll();

    expect(events[0]?.payload).toMatchObject({ byYou: false });
  });

  it("fails without writing state when the filters match more than 1,000 issues", async () => {
    const issues = Array.from({ length: 1001 }, (_, index) => buildFakeIssue(String(5000 + index)));
    const tape = buildTape(issues);

    const result = await tape.pollResult();

    expect(Result.isFailure(result) && result.failure instanceof PluginError).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.message).toContain("more than 1000");
    expect(tape.harness.state.size).toBe(0);
  });

  it("watches exactly 1,000 issues", async () => {
    const issues = Array.from({ length: 1000 }, (_, index) => buildFakeIssue(String(5000 + index)));
    const tape = buildTape(issues);

    expect(await tape.poll()).toEqual([]);
    expect(tape.harness.state.size).toBe(1);
  });

  it("fails without writing state when a configured value is gone from Sentry", async () => {
    const tape = buildTape([buildFakeIssue("1001")]);
    await tape.poll();
    const before = structuredClone(tape.harness.state.get("watched"));
    tape.world.issues.push(buildFakeIssue("1002"));

    for (const config of [
      { ...ANYONE, environments: ["qa"] },
      { ...ANYONE, projects: ["project:99"] },
      { assignees: ["team:99"] },
      { assignees: ["user:99"] },
    ]) {
      tape.config = config;
      const result = await tape.pollResult();
      expect(Result.isFailure(result) && result.failure instanceof PluginError).toBe(true);
    }

    expect(tape.harness.events).toEqual([]);
    expect(tape.harness.state.get("watched")).toEqual(before);
  });

  it("asks for the issues the way the research recorded", async () => {
    const tape = buildTape([buildFakeIssue("1001")], {
      ...ANYONE,
      projects: ["team:31"],
      environments: ["staging", "production"],
    });

    await tape.poll();

    const list = tape.fake.requests.find((request) => request.path.endsWith("/issues/"));
    expect(list?.origin).toBe("https://us.sentry.io");
    expect(list?.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(list?.params.get("query")).toBe("is:unresolved lastSeen:-14d");
    expect(list?.params.get("sort")).toBe("new");
    expect(list?.params.get("limit")).toBe("100");
    expect(list?.params.get("groupStatsPeriod")).toBe("");
    expect(list?.params.has("collapse")).toBe(false);
    expect(list?.params.getAll("project")).toEqual(["11"]);
    expect(list?.params.getAll("environment")).toEqual(["production", "staging"]);
  });

  it("defaults to the issues assigned to the user or their teams", async () => {
    const tape = buildTape(
      [
        buildFakeIssue("1001"),
        buildFakeIssue("1002", { assignedTo: { type: "user", id: "88", name: "ada" } }),
      ],
      {},
    );
    await tape.poll();

    const list = tape.fake.requests.find((request) => request.path.endsWith("/issues/"));
    expect(list?.params.get("query")).toBe("is:unresolved lastSeen:-14d assigned:[me, my_teams]");
    const watched = tape.harness.state.get("watched") as { issues: Record<string, unknown> };
    expect(Object.keys(watched.issues)).toEqual(["1002"]);
  });

  it("returns the wait when Sentry rate limits the poll, and stores nothing", async () => {
    const tape = buildTape([buildFakeIssue("1001")]);
    await tape.poll();
    const before = structuredClone(tape.harness.state.get("watched"));
    tape.world.issues.push(buildFakeIssue("1002"));
    tape.world.override = (request) =>
      request.path.endsWith("/issues/")
        ? {
            status: 429,
            headers: { "x-sentry-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 17) },
          }
        : undefined;

    const result = await tape.pollResult();

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.nextAfterSeconds).toBeGreaterThanOrEqual(15);
      expect(result.success.nextAfterSeconds).toBeLessThanOrEqual(17);
    }
    expect(tape.harness.events).toEqual([]);
    expect(tape.harness.state.get("watched")).toEqual(before);
  });

  it("waits at least one second when the rate limit window already ended", async () => {
    const tape = buildTape([buildFakeIssue("1001")]);
    tape.world.override = () => ({
      status: 429,
      headers: { "x-sentry-rate-limit-reset": String(Math.floor(Date.now() / 1000) - 5) },
    });

    const result = await tape.pollResult();

    expect(Result.isSuccess(result) && result.success).toEqual({ nextAfterSeconds: 1 });
  });

  it("fails with an AuthError when Sentry refuses the token", async () => {
    const tape = buildTape([buildFakeIssue("1001")]);
    tape.world.token = "another-token";

    const result = await tape.pollResult();

    expect(Result.isFailure(result) && result.failure instanceof AuthError).toBe(true);
  });

  it("fails with an AuthError when the Connection holds no token", async () => {
    const tape = buildTape([buildFakeIssue("1001")]);
    const harness = buildIngestHarness({});

    const result = await tape.pollResult(harness.context);

    expect(Result.isFailure(result) && result.failure instanceof AuthError).toBe(true);
  });

  it("fails with a plain PluginError when the list is forbidden", async () => {
    const tape = buildTape([buildFakeIssue("1001")]);
    tape.world.override = (request) =>
      request.path.endsWith("/issues/")
        ? { status: 403, body: { detail: "You do not have permission to perform this action." } }
        : undefined;

    const result = await tape.pollResult();

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure).toBeInstanceOf(PluginError);
    expect(result.failure).not.toBeInstanceOf(AuthError);
  });

  it("reads at most 20 latest events per poll and defers the rest without losing any", async () => {
    const tape = buildTape();
    await tape.poll();
    for (let index = 1; index <= 25; index += 1) {
      tape.world.issues.push(buildFakeIssue(String(3000 + index)));
    }

    const first = await tape.poll();

    expect(first.map((event) => event.dedupKey.split(":")[0])).toEqual(
      Array.from({ length: 20 }, (_, index) => String(3001 + index)),
    );
    expect(
      tape.fake.requests.filter((request) => request.path.endsWith("/events/latest/")),
    ).toHaveLength(20);

    const second = await tape.poll();
    expect(second.map((event) => event.dedupKey.split(":")[0])).toEqual(
      Array.from({ length: 5 }, (_, index) => String(3021 + index)),
    );
    expect(await tape.poll()).toEqual([]);
  });

  it("fails a pasted-token poll after the organization is renamed, saying to reconnect with the new slug", async () => {
    const tape = buildTape();
    await tape.poll();
    const renamed = buildIngestHarness({ token: TEST_TOKEN, organization: "acme-old" });

    const result = await tape.pollResult(renamed.context);

    const message = Result.isFailure(result) ? result.failure.message : "";
    expect(message).toContain('Sentry has no organization "acme-old"');
    expect(message).toContain("reconnect the Connection with its new slug");
  });

  describe("the outbox", () => {
    const readOutbox = (tape: ReturnType<typeof buildTape>): ReadonlyArray<{ dedupKey: string }> =>
      (tape.harness.state.get("watched") as { outbox: Array<{ dedupKey: string }> }).outbox;

    /** Builds a context whose second emit fails once, as a host that could not write an event. */
    const failSecondEmit = (tape: ReturnType<typeof buildTape>) => {
      let emits = 0;
      return {
        ...tape.harness.context,
        emit: (event: EmittedEvent) =>
          emits++ === 1
            ? Effect.fail(new PluginError({ message: "the host could not write the event" }))
            : tape.harness.context.emit(event),
      };
    };

    it("emits what a failed poll left, and still ends the signal of an issue it announced", async () => {
      const tape = buildTape();
      await tape.poll();
      for (const id of ["2001", "2002", "2003"]) tape.world.issues.push(buildFakeIssue(id));

      const failed = await tape.pollResult(failSecondEmit(tape));

      expect(Result.isFailure(failed)).toBe(true);
      expect(tape.harness.events).toHaveLength(1);
      // All three issues are in the stored set, and the three events wait in the outbox.
      const watched = tape.harness.state.get("watched") as { issues: Record<string, unknown> };
      expect(Object.keys(watched.issues).sort()).toEqual(["2001", "2002", "2003"]);
      expect(readOutbox(tape).map((event) => event.dedupKey.split(":")[0])).toEqual([
        "2001",
        "2002",
        "2003",
      ]);

      // The announced issue 2002 is resolved before the next poll.
      resolve(findIssue(tape, "2002"));
      const events = await tape.poll();

      expect(events.map((event) => event.dedupKey.split(":").slice(0, 2).join(":"))).toEqual([
        // The outbox again: 2001 is a duplicate the host drops.
        "2002:entered",
        "2003:entered",
        "2002:resolved",
      ]);
      expect(readOutbox(tape)).toEqual([]);
    });

    it("leaves the outbox empty after a poll with nothing pending", async () => {
      const tape = buildTape();
      await tape.poll();
      expect(readOutbox(tape)).toEqual([]);

      tape.world.issues.push(buildFakeIssue("2001"));
      expect(await tape.poll()).toHaveLength(1);
      expect(readOutbox(tape)).toEqual([]);

      expect(await tape.poll()).toEqual([]);
      expect(readOutbox(tape)).toEqual([]);
    });

    it("leaves the state as it was, and emits nothing, when a poll fails before the write", async () => {
      const tape = buildTape();
      await tape.poll();
      tape.world.issues.push(buildFakeIssue("2001"));
      const before = structuredClone(tape.harness.state.get("watched"));
      tape.fake.world.override = (request) =>
        request.path.endsWith("/events/latest/") ? { status: 500 } : undefined;

      const failed = await tape.pollResult();

      expect(Result.isFailure(failed)).toBe(true);
      expect(tape.harness.state.get("watched")).toEqual(before);
      expect(tape.harness.events).toEqual([]);
    });
  });

  describe("the filter", () => {
    it("does not re-baseline when a team or a user is renamed", async () => {
      const tape = buildTape([buildFakeIssue("1001")], { assignees: ["team:31", "user:89"] });
      await tape.poll();
      const readFilter = () => (tape.harness.state.get("watched") as { filter: string }).filter;
      const before = readFilter();

      // Sentry renames the team and the user, and an issue joins in the same interval.
      const teams = tape.world.teams[0]!;
      teams.slug = "platform-eng";
      tape.world.members[1]!.username = "grace.h";
      const joined = buildFakeIssue("1002", {
        assignedTo: { type: "team", id: "31", name: "platform-eng" },
      });
      tape.world.issues.push(joined);
      const events = await tape.poll();

      expect(summarize(events)).toEqual([
        ["sentry.issue.entered", `1002:entered:${joined.lastSeen}`],
      ]);
      expect(readFilter()).toBe(before);
      const list = tape.fake.requests.filter((request) => request.path.endsWith("/issues/")).at(-1);
      expect(list?.params.get("query")).toContain("assigned:[#platform-eng, grace.h]");
    });

    it("re-baselines when the settings change, and emits nothing for the issues that entered or came back", async () => {
      const tape = buildTape([
        buildFakeIssue("1001"),
        buildFakeIssue("1002", { substatus: "ongoing" }),
      ]);
      await tape.poll();
      const resolved = findIssue(tape, "1001");
      resolve(resolved);
      await tape.poll();
      reopen(resolved);
      resolved.lastSeen = stampAt(-1);
      resolved.activity = [buildRegression("9001", 0.5)];
      const escalating = findIssue(tape, "1002");
      escalating.substatus = "escalating";
      tape.world.issues.push(buildFakeIssue("1003", { substatus: "regressed" }));

      // A wider window: 1001 would be a regression and 1003 an entry; 1002 stayed.
      tape.config = { ...ANYONE, lastSeenDays: 30 };
      const events = await tape.poll();

      expect(summarize(events)).toEqual([
        ["sentry.issue.escalating", `1002:escalating:${escalating.lastSeen}`],
      ]);
      const watched = tape.harness.state.get("watched") as {
        issues: Record<string, unknown>;
        left: Record<string, unknown>;
      };
      expect(Object.keys(watched.issues).sort()).toEqual(["1001", "1002", "1003"]);
      expect(watched.left).toEqual({});
      expect(await tape.poll()).toEqual([]);
    });

    it("fails, saying the list is too long, instead of calling a value gone", async () => {
      const tape = buildTape([buildFakeIssue("1001")], { ...ANYONE, projects: ["project:11"] });
      await tape.poll();
      const before = structuredClone(tape.harness.state.get("watched"));
      // The configured project is on the 12th page, which the feed does not read.
      const webshop = tape.world.projects[0]!;
      tape.world.projects = [
        ...Array.from({ length: 1100 }, (_, index) => ({
          id: String(5000 + index),
          slug: `project-${String(index)}`,
          name: `Project ${String(index)}`,
          teamIds: [],
        })),
        webshop,
      ];

      const result = await tape.pollResult();

      expect(Result.isFailure(result) && result.failure.message).toBe(
        "The organization's projects list is too long to read: it has more than 10 pages.",
      );
      expect(tape.harness.state.get("watched")).toEqual(before);
    });

    it("says a team owns no projects, rather than that it is gone", async () => {
      const tape = buildTape([buildFakeIssue("1001")], { ...ANYONE, projects: ["team:32"] });
      tape.world.projects[1]!.teamIds = [];

      const result = await tape.pollResult();

      expect(Result.isFailure(result) && result.failure.message).toContain(
        "The team team:32 owns no projects;",
      );
    });
  });

  describe("the keys of the events", () => {
    it("keys the end of each stay in the set apart", async () => {
      const tape = buildTape([buildFakeIssue("1001")]);
      await tape.poll();
      const firstStay = tape.lastPollTime;
      const issue = findIssue(tape, "1001");

      resolve(issue);
      expect(summarize(await tape.poll())).toEqual([
        ["sentry.issue.resolved", `1001:resolved:${firstStay}`],
      ]);
      const firstLeft = tape.lastPollTime;

      // Somebody reopens it by hand. There is no new event, so Sentry reports no new regression.
      reopen(issue);
      expect(summarize(await tape.poll())).toEqual([
        ["sentry.issue.regressed", `1001:regressed:${firstLeft}`],
      ]);
      const secondStay = tape.lastPollTime;

      resolve(issue);
      expect(summarize(await tape.poll())).toEqual([
        ["sentry.issue.resolved", `1001:resolved:${secondStay}`],
      ]);
      const secondLeft = tape.lastPollTime;

      // The second return has no new activity either, and still raises an event of its own.
      reopen(issue);
      expect(summarize(await tape.poll())).toEqual([
        ["sentry.issue.regressed", `1001:regressed:${secondLeft}`],
      ]);
    });

    it("keys a regression of a resolved issue that comes back by the activity id", async () => {
      const tape = buildTape([buildFakeIssue("1001")]);
      await tape.poll();
      const issue = findIssue(tape, "1001");
      resolve(issue);
      await tape.poll();

      reopen(issue);
      issue.substatus = "regressed";
      issue.lastSeen = stampAt(-1);
      issue.activity = [buildRegression("9001", 0.5, "webshop@2.5.0")];
      const events = await tape.poll();

      expect(summarize(events)).toEqual([["sentry.issue.regressed", "1001:regressed:9001"]]);
      expect(events[0]?.occurredAt).toBe(issue.activity[0]?.dateCreated);
      expect(events[0]?.payload).toMatchObject({ after: "resolved", release: "webshop@2.5.0" });
    });

    it("does not take a regression from before the issue left for a new one", async () => {
      const tape = buildTape([
        buildFakeIssue("1001", { activity: [buildRegression("8000", -1000)] }),
      ]);
      await tape.poll();
      const issue = findIssue(tape, "1001");
      resolve(issue);
      await tape.poll();
      const left = tape.lastPollTime;

      reopen(issue);
      const events = await tape.poll();

      expect(summarize(events)).toEqual([["sentry.issue.regressed", `1001:regressed:${left}`]]);
    });

    it("emits a second regression between two polls once an activity id is stored", async () => {
      const tape = buildTape([buildFakeIssue("1001")]);
      await tape.poll();
      const issue = findIssue(tape, "1001");

      issue.substatus = "regressed";
      issue.lastSeen = stampAt(-1);
      issue.activity = [buildRegression("9001", 0.5, "webshop@2.5.0")];
      expect(summarize(await tape.poll())).toEqual([
        ["sentry.issue.regressed", "1001:regressed:9001"],
      ]);
      expect(await tape.poll()).toEqual([]);

      // Resolved and regressed again between two polls: the substatus is regressed throughout.
      issue.lastSeen = stampAt(0);
      issue.activity.push(buildRegression("9002", 0, "webshop@2.6.0"));
      const second = await tape.poll();
      expect(summarize(second)).toEqual([["sentry.issue.regressed", "1001:regressed:9002"]]);
      expect(second[0]?.payload).toMatchObject({ after: "resolved", release: "webshop@2.6.0" });

      // Two regressions in one interval give two events, oldest first.
      issue.lastSeen = stampAt(2);
      issue.activity.push(buildRegression("9003", 0.5), buildRegression("9004", 0.75));
      expect(summarize(await tape.poll())).toEqual([
        ["sentry.issue.regressed", "1001:regressed:9003"],
        ["sentry.issue.regressed", "1001:regressed:9004"],
      ]);
    });

    it("emits both the regression and the escalation of an issue that did both between two polls", async () => {
      const tape = buildTape([buildFakeIssue("1001")]);
      await tape.poll();
      const issue = findIssue(tape, "1001");

      issue.substatus = "escalating";
      issue.lastSeen = stampAt(-1);
      issue.activity = [buildRegression("9001", 0.5)];
      const events = await tape.poll();

      expect(summarize(events)).toEqual([
        ["sentry.issue.regressed", "1001:regressed:9001"],
        ["sentry.issue.escalating", `1001:escalating:${issue.lastSeen}`],
      ]);
      expect(events[0]?.payload).toMatchObject({ after: "resolved" });
    });

    it("follows one issue from new, to resolved, to back, to archived, to back escalating", async () => {
      const tape = buildTape();
      await tape.poll();
      const issue = buildFakeIssue("1001", { firstSeen: stampAt(-2), lastSeen: stampAt(-1) });
      tape.world.issues.push(issue);

      const entered = await tape.poll();
      const firstStay = tape.lastPollTime;
      expect(summarize(entered)).toEqual([
        ["sentry.issue.entered", `1001:entered:${issue.lastSeen}`],
      ]);

      resolve(issue);
      issue.actorId = "88";
      const resolved = await tape.poll();
      expect(summarize(resolved)).toEqual([
        ["sentry.issue.resolved", `1001:resolved:${firstStay}`],
      ]);
      expect(resolved[0]?.payload).toMatchObject({ byYou: true });

      // It regresses before the next poll.
      reopen(issue);
      issue.actorId = null;
      issue.substatus = "regressed";
      issue.lastSeen = stampAt(-1);
      issue.activity = [buildRegression("9001", 0.5, "webshop@2.5.0")];
      const regressed = await tape.poll();
      const secondStay = tape.lastPollTime;
      expect(summarize(regressed)).toEqual([["sentry.issue.regressed", "1001:regressed:9001"]]);
      expect(regressed[0]?.payload).toMatchObject({ after: "resolved", release: "webshop@2.5.0" });

      issue.status = "ignored";
      issue.substatus = "archived_until_escalating";
      const archived = await tape.poll();
      expect(summarize(archived)).toEqual([
        ["sentry.issue.archived", `1001:archived:${secondStay}`],
      ]);
      const archivedStay = tape.lastPollTime;

      // It escalates: back in the set with no regression activity, so the time it left keys the event.
      issue.status = "unresolved";
      issue.substatus = "escalating";
      issue.lastSeen = stampAt(3);
      const back = await tape.poll();
      expect(summarize(back)).toEqual([
        ["sentry.issue.regressed", `1001:regressed:${archivedStay}`],
      ]);
      expect(back[0]?.payload).toMatchObject({ after: "archived" });
      expect(await tape.poll()).toEqual([]);
    });
  });

  describe("the regression watermark", () => {
    it("emits a regression that happened after an issue joined the set already regressed", async () => {
      const tape = buildTape([buildFakeIssue("1001", { substatus: "regressed" })]);
      const issue = findIssue(tape, "1001");
      issue.activity = [buildRegression("9001", -5)];
      await tape.poll();

      // Resolved and regressed again before the next poll: the substatus is regressed throughout.
      issue.lastSeen = stampAt(0.5);
      issue.activity.push(buildRegression("9002", 0.5, "webshop@2.6.0"));
      const events = await tape.poll();

      expect(summarize(events)).toEqual([["sentry.issue.regressed", "1001:regressed:9002"]]);
      expect(events[0]?.payload).toMatchObject({ after: "resolved", release: "webshop@2.6.0" });
    });

    it("remembers the regressions of an issue that was regressed when it was stored, and emits none", async () => {
      const tape = buildTape([buildFakeIssue("1001", { substatus: "regressed" })]);
      const issue = findIssue(tape, "1001");
      // Sentry records the regression a few seconds after the issue's last event.
      issue.activity = [
        {
          ...buildRegression("9001", 0),
          dateCreated: new Date(Date.parse(issue.lastSeen) + 5000).toISOString(),
        },
      ];
      await tape.poll();

      // An ordinary event moves lastSeen. The detail is read, and the old regression is not news.
      issue.lastSeen = stampAt(-1);
      expect(await tape.poll()).toEqual([]);
      const watched = tape.harness.state.get("watched") as {
        issues: Record<string, { regressionActivityId?: string }>;
      };
      expect(watched.issues["1001"]?.regressionActivityId).toBe("9001");

      // A regression after that is news.
      issue.lastSeen = stampAt(0);
      issue.activity.push(buildRegression("9002", 0));
      expect(summarize(await tape.poll())).toEqual([
        ["sentry.issue.regressed", "1001:regressed:9002"],
      ]);
    });

    it("emits a regression of an issue that was ongoing when it was stored, and skips an older one", async () => {
      const tape = buildTape([buildFakeIssue("1001")]);
      const issue = findIssue(tape, "1001");
      issue.activity = [buildRegression("8000", -100)];
      await tape.poll();

      issue.substatus = "regressed";
      issue.lastSeen = stampAt(-1);
      issue.activity.push(buildRegression("9001", 0.5));
      const events = await tape.poll();

      expect(summarize(events)).toEqual([["sentry.issue.regressed", "1001:regressed:9001"]]);
    });
  });

  describe("the bounds of a payload", () => {
    const HUGE = 300 * 1024;

    it("emits an issue whose texts are far over the limits, cut to fixed lengths", async () => {
      const tape = buildTape();
      await tape.poll();
      const issue = buildFakeIssue("1001", {
        title: "t".repeat(HUGE),
        culprit: "c".repeat(HUGE),
        errorType: "e".repeat(HUGE),
        assignedTo: { type: "user", id: "88", name: "n".repeat(HUGE) },
        latestEvent: {
          eventID: "abc123",
          dateCreated: stampAt(-1),
          release: "r".repeat(HUGE),
          environment: "p".repeat(HUGE),
          frames: Array.from({ length: 30 }, (_, index) => ({
            filename: "f".repeat(HUGE),
            function: "g".repeat(HUGE),
            lineNo: index,
            inApp: true,
          })),
          type: "T".repeat(HUGE),
          value: "é".repeat(HUGE),
        },
      });
      tape.world.issues.push(issue);

      const events = await tape.poll();

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(new TextEncoder().encode(JSON.stringify(event.payload)).length).toBeLessThan(
        MAX_EMITTED_FIELD_BYTES,
      );
      expect(event.title.length).toBeLessThanOrEqual(MAX_EVENT_TITLE_LENGTH);
      const payload = event.payload as {
        issue: { title: string; culprit: string };
        latestEvent: {
          exception: { value: string; frames: Array<{ filename: string; function: string }> };
        };
      };
      expect(payload.issue.title).toHaveLength(512);
      expect(payload.issue.culprit).toHaveLength(512);
      expect(payload.latestEvent.exception.value).toHaveLength(4096);
      expect(payload.latestEvent.exception.frames[0]?.filename).toHaveLength(256);
      expect(payload.latestEvent.exception.frames[0]?.function).toHaveLength(256);
    });

    it("names an issue with an empty title by its short id", async () => {
      const tape = buildTape();
      await tape.poll();
      tape.world.issues.push(buildFakeIssue("1001", { title: "" }));

      const events = await tape.poll();

      expect(events[0]?.title).toBe("WEBSHOP-1001 WEBSHOP-1001");
    });
  });

  describe("the checks of what Sentry sends", () => {
    /** An event of an issue, with only the id changed from what a test needs. */
    const buildEventOf = (eventID: string) => ({
      eventID,
      dateCreated: stampAt(-1),
      release: null,
      environment: null,
      frames: [],
      type: "TypeError",
      value: "boom",
    });

    it.each([
      ["an issue id of 300,000 digits", () => buildFakeIssue("9".repeat(300_000))],
      ["an issue id that is not a number", () => buildFakeIssue("12ab")],
      ["a short id with a slash", () => buildFakeIssue("1003", { shortId: "WEBSHOP/1003" })],
      ["a time that is not a date", () => buildFakeIssue("1003", { lastSeen: "yesterday" })],
      [
        "an event id that is not hexadecimal",
        () => buildFakeIssue("1003", { latestEvent: buildEventOf("not-hex") }),
      ],
    ])("fails the poll before it writes anything when Sentry sends %s", async (_name, build) => {
      const tape = buildTape([buildFakeIssue("1001")]);
      await tape.poll();
      // An earlier poll's event is still in the outbox, because its emit failed.
      tape.world.issues.push(buildFakeIssue("1002"));
      const downContext = {
        ...tape.harness.context,
        emit: () => Effect.fail(new PluginError({ message: "the host is down" })),
      };
      advanceClock(1);
      expect(Result.isFailure(await tape.pollResult(downContext))).toBe(true);
      const stateBefore = JSON.stringify(tape.harness.state.get("watched"));
      expect(stateBefore).toContain('"outbox":[{');
      tape.harness.events.length = 0;

      tape.world.issues.push(build());
      advanceClock(1);
      const result = await tape.pollResult();

      expect(Result.isFailure(result) && result.failure instanceof PluginError).toBe(true);
      // The message quotes at most a part of the response.
      if (Result.isFailure(result)) expect(result.failure.message.length).toBeLessThan(2000);
      expect(JSON.stringify(tape.harness.state.get("watched"))).toBe(stateBefore);
    });
  });

  describe("the memory of what left", () => {
    it("takes an issue that returns after more than 90 days without a poll for a new one", async () => {
      const tape = buildTape([buildFakeIssue("1001")]);
      await tape.poll();
      const issue = findIssue(tape, "1001");
      resolve(issue);
      await tape.poll();

      advanceClock(91 * 24 * 60);
      reopen(issue);
      issue.lastSeen = stampAt(-1);
      const events = await tape.poll();

      expect(summarize(events)).toEqual([
        ["sentry.issue.entered", `1001:entered:${issue.lastSeen}`],
      ]);
    });
  });

  describe("the read budget", () => {
    /**
     * Builds `count` regressed issues from id 2001 on, each with the regression it joined with. A
     * higher id was seen longer ago.
     */
    const buildRegressedIssues = (count: number): Array<FakeIssue> =>
      Array.from({ length: count }, (_, index) =>
        buildFakeIssue(String(2001 + index), {
          substatus: "regressed",
          lastSeen: stampAt(-500 - index),
          // A short id is a lower id than the ones `regressAgain` writes.
          activity: [buildRegression(String(index + 1), -500 - index)],
        }),
      );

    /** Gives every issue a new event and a new regression, as if each came back once more. */
    const regressAgain = (tape: ReturnType<typeof buildTape>, activityId: string): void => {
      for (const issue of tape.world.issues) {
        issue.lastSeen = stampAt(0.5);
        issue.activity.push(buildRegression(`${activityId}${issue.id}`, 0.5));
      }
    };

    it("reads the stayed issue that was seen longest ago first, and defers the rest without losing any", async () => {
      const tape = buildTape(buildRegressedIssues(22));
      await tape.poll();
      const oldestOfDeferred = findIssue(tape, "2002").lastSeen;

      regressAgain(tape, "1");
      const first = await tape.poll();
      // Id order would have read 2001 to 2020; the longest unseen come first instead.
      expect(listIssueIds(first)).toEqual(
        Array.from({ length: 20 }, (_, index) => String(2022 - index)),
      );
      expect(readStoredLastSeen(tape, "2002")).toBe(oldestOfDeferred);
      expect(readStoredLastSeen(tape, "2001")).not.toBe(findIssue(tape, "2001").lastSeen);

      // Everything moves again. The two deferred issues kept their old entry, so they go first.
      regressAgain(tape, "2");
      const second = await tape.poll();
      expect(listIssueIds(second)).toEqual([
        "2002",
        "2001",
        ...Array.from({ length: 18 }, (_, index) => String(2003 + index)),
      ]);
      // The deferred issues report both regressions they missed, oldest first.
      expect(
        second.filter((event) => event.dedupKey.startsWith("2002:")).map((event) => event.dedupKey),
      ).toEqual(["2002:regressed:12002", "2002:regressed:22002"]);
    });

    it("still checks a deferred issue for a regression after Sentry moves it to ongoing", async () => {
      const tape = buildTape(buildRegressedIssues(21));
      await tape.poll();
      regressAgain(tape, "1");
      const first = await tape.poll();
      expect(first).toHaveLength(20);
      const readEntry = (id: string) =>
        (tape.harness.state.get("watched") as { issues: Record<string, { recheck?: boolean }> })
          .issues[id];
      // 2001 was seen most recently, so its check waited and is marked for later.
      expect(readEntry("2001")?.recheck).toBe(true);
      expect(readEntry("2002")?.recheck).toBeUndefined();

      // The issue is ongoing now, and has had no event since: the substatus alone no longer asks for a read.
      findIssue(tape, "2001").substatus = "ongoing";
      const second = await tape.poll();

      expect(summarize(second)).toEqual([["sentry.issue.regressed", "2001:regressed:12001"]]);
      expect(second[0]?.payload).toMatchObject({ after: "resolved" });
      expect(readEntry("2001")?.recheck).toBeUndefined();
      expect(await tape.poll()).toEqual([]);
    });

    it("reads the issues that entered before the issues that stayed", async () => {
      const tape = buildTape(buildRegressedIssues(20));
      await tape.poll();

      regressAgain(tape, "1");
      tape.world.issues.push(buildFakeIssue("3000"));
      const events = await tape.poll();

      // The new issue takes one of the 20 latest events, so the issue seen most recently waits.
      expect(listIssueIds(events)).toEqual([
        "3000",
        ...Array.from({ length: 19 }, (_, index) => String(2020 - index)),
      ]);
      expect(summarize(events.slice(0, 1))).toEqual([
        ["sentry.issue.entered", `3000:entered:${findIssue(tape, "3000").lastSeen}`],
      ]);
    });

    it("defers an issue that came back when the budget is spent, and emits it on the next poll", async () => {
      const tape = buildTape(
        Array.from({ length: 21 }, (_, index) => buildFakeIssue(String(4001 + index))),
      );
      await tape.poll();
      for (const issue of tape.world.issues) resolve(issue);
      expect(await tape.poll()).toHaveLength(21);

      for (const issue of tape.world.issues) {
        reopen(issue);
        issue.substatus = "regressed";
        issue.lastSeen = stampAt(-1);
        issue.activity = [buildRegression(`9${issue.id}`, 0.5)];
      }
      const first = await tape.poll();
      expect(listIssueIds(first)).toEqual(
        Array.from({ length: 20 }, (_, index) => String(4001 + index)),
      );

      const second = await tape.poll();
      expect(summarize(second)).toEqual([["sentry.issue.regressed", "4021:regressed:94021"]]);
      expect(second[0]?.payload).toMatchObject({ after: "resolved" });
      expect(await tape.poll()).toEqual([]);
    });
  });
});
