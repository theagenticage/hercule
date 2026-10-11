/**
 * Tests the `issues` feed as a tape: one fake organization that changes
 * between polls the way Sentry's users change it, and the events each poll
 * emits. Also the ways a poll fails, and that a failed poll stores nothing.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import { AuthError, PluginError, type EmittedEvent } from "@hercule/plugin-host";
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
  type FakeIssue,
  type FakeSentry,
  type IngestHarness,
} from "../testing";
import { pollWithConnection } from "./index";

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
    /** Polls once, requires success, and returns the events that poll emitted. */
    poll: async (): Promise<Array<EmittedEvent>> => {
      harness.events.length = 0;
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

describe("the issues feed", () => {
  it("follows an organization over several polls", async () => {
    const tape = buildTape([buildFakeIssue("1001"), buildFakeIssue("1002")]);

    // The first poll only learns what is there.
    expect(await tape.poll()).toEqual([]);
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
      ["sentry.issue.resolved", `1001:resolved:${resolvedIssue.lastSeen}`],
    ]);
    expect(resolved[0]?.payload).toMatchObject({ byYou: true });
    // The departure is stamped with the poll's time, not the issue's.
    expect(Date.parse(resolved[0]?.occurredAt ?? "")).toBeGreaterThan(Date.parse(fresh.lastSeen));
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
      ["sentry.issue.archived", `1003:archived:${archivedIssue.lastSeen}`],
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
    expect(list?.params.get("collapse")).toBe("stats");
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

  it("emits the same dedup keys again when a poll fails after emitting", async () => {
    const tape = buildTape();
    await tape.poll();
    for (const id of ["2001", "2002", "2003"]) tape.world.issues.push(buildFakeIssue(id));
    const before = structuredClone(tape.harness.state.get("watched"));
    let emitted = 0;
    const failing = {
      ...tape.harness.context,
      emit: (event: EmittedEvent) =>
        emitted++ === 1
          ? Effect.fail(new PluginError({ message: "the host could not write the event" }))
          : tape.harness.context.emit(event),
    };

    const failed = await tape.pollResult(failing);

    expect(Result.isFailure(failed)).toBe(true);
    expect(tape.harness.state.get("watched")).toEqual(before);
    const firstAttempt = summarize(tape.harness.events);
    expect(firstAttempt).toHaveLength(1);

    const retried = await tape.poll();
    expect(retried).toHaveLength(3);
    expect(summarize(retried)[0]).toEqual(firstAttempt[0]);
  });
});
