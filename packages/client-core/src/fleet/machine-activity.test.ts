import { describe, expect, it } from "vitest";
import {
  MACHINE_ACTIVITY_FILTERS,
  describeEmptyMachineActivity,
  describeMachineActivity,
  describeRecentMachineActivity,
  type MachineActivityDay,
  type MachineActivityFilter,
} from "./machine-activity";

type Input = Parameters<typeof describeMachineActivity>[0][number];

const SESSION_ID = "01990000-0000-7000-8000-00000000aaaa";
const RUN_ID = "01990000-0000-7000-8000-00000000bbbb";
const OTHER_RUN_ID = "01990000-0000-7000-8000-00000000cccc";
const TODAY = new Date("2026-11-03T12:00:00.000Z");

let nextId = 1;

/** Builds an audit log entry received at `at` (UTC). Ids rise with every call, so build oldest first and reverse. */
const entry = (
  kind: string,
  payload: Input["payload"],
  at = "2026-11-03T09:12:30.000Z",
  actor: Input["actor"] = "system",
): Input => ({ id: nextId++, kind, payload, actor, receivedAt: at });

/** Describes `events` given newest first, in UTC, with one labelled account. */
const describe_ = (
  events: ReadonlyArray<Input>,
  over: { filter?: MachineActivityFilter; timezone?: string; today?: Date } = {},
): ReadonlyArray<MachineActivityDay> =>
  describeMachineActivity(events, {
    filter: over.filter ?? "all",
    timezone: over.timezone ?? "UTC",
    today: over.today ?? TODAY,
    accounts: [
      { id: "account-1", label: "Claude Max" },
      { id: "account-2", label: null },
    ],
  });

/** Describes one entry and returns its only entry. */
const single = (event: Input) => {
  const [day] = describe_([event]);
  expect(day?.entries).toHaveLength(1);
  return day!.entries[0]!;
};

describe("describeMachineActivity sentences", () => {
  type Case = readonly [
    kind: string,
    payload: Input["payload"],
    sentence: string,
    category: "connection" | "sessions" | "workspaces" | "settings",
    problem?: true,
  ];
  const cases: ReadonlyArray<Case> = [
    ["runner.joined", { reserved: false, becameDefaultRunner: false }, "Joined", "connection"],
    [
      "runner.joined",
      { reserved: true, becameDefaultRunner: false },
      "Joined as a reserved machine",
      "connection",
    ],
    [
      "runner.joined",
      { reserved: false, becameDefaultRunner: true },
      "Joined and became the default machine",
      "connection",
    ],
    ["runner.stateChanged", { state: "online" }, "Back online", "connection"],
    ["runner.stateChanged", { state: "offline" }, "Went offline", "connection", true],
    ["runner.stateChanged", { state: "unreachable" }, "Became unreachable", "connection", true],
    ["runner.stateChanged", { state: "asleep" }, "Changed state to asleep", "connection"],
    [
      "runner.updated",
      { changes: { maxConcurrentSessions: { old: 10, new: 13 } } },
      "Session cap changed from 10 to 13",
      "settings",
    ],
    [
      "runner.updated",
      { changes: { diskWatermarkBytes: { old: 10_737_418_240, new: 200_000_000_000 } } },
      "Disk limit changed from 10.7 GB to 200 GB",
      "settings",
    ],
    [
      "runner.updated",
      { changes: { reserved: { old: false, new: true } } },
      "Marked as reserved",
      "settings",
    ],
    [
      "runner.updated",
      { changes: { reserved: { old: true, new: false } } },
      "No longer reserved",
      "settings",
    ],
    [
      "runner.updated",
      { changes: { name: { old: "atlas", new: "atlas-2" } } },
      "Renamed from atlas to atlas-2",
      "settings",
    ],
    [
      "runner.updated",
      { changes: { labels: { old: ["mac"], new: ["mac", "gpu", "arm"] } } },
      "Added labels gpu, arm",
      "settings",
    ],
    [
      "runner.updated",
      { changes: { labels: { old: ["mac", "gpu"], new: ["mac"] } } },
      "Removed label gpu",
      "settings",
    ],
    [
      "runner.updated",
      { changes: { labels: { old: ["a"], new: ["b"] } } },
      "Added label b and removed label a",
      "settings",
    ],
    [
      "runner.updated",
      {
        changes: {
          maxConcurrentSessions: { old: 4, new: 8 },
          reserved: { old: false, new: true },
        },
      },
      "Session cap changed from 4 to 8; marked as reserved",
      "settings",
    ],
    ["runner.drained", {}, "Set to take no new work", "settings"],
    ["runner.undrained", {}, "Set to take new work again", "settings"],
    [
      "runner.placementsChanged",
      { acceptingPlacements: false },
      "Takes no new sessions: free disk is below its limit",
      "connection",
      true,
    ],
    [
      "runner.placementsChanged",
      { acceptingPlacements: true },
      "Takes new sessions again: free disk is above its limit",
      "connection",
    ],
    [
      "runner.crashLooping",
      { count: 3 },
      "Runner stopped 3 times in a few minutes and is being started again",
      "connection",
    ],
    ["runner.retired", { forced: false }, "Retired", "connection"],
    ["runner.retired", { forced: true }, "Retired without checking for sessions", "connection"],
    ["workspace.created", {}, "Workspace created", "workspaces"],
    [
      "workspace.disposalRequested",
      { operation: "workspaceDispose" },
      "Asked to remove a workspace",
      "workspaces",
    ],
    [
      "workspace.disposalRequested",
      { operation: "workspaceDetach" },
      "Asked to detach a main workspace",
      "workspaces",
    ],
    [
      "workspace.disposalRefused",
      { runnerMessage: "The runner refused safe removal." },
      "Could not remove a workspace: The runner refused safe removal.",
      "workspaces",
      true,
    ],
    [
      "workspace.disposalRefused",
      { message: "Old entries hold their message only here." },
      "Could not remove a workspace",
      "workspaces",
      true,
    ],
    ["workspace.deleted", {}, "Removed a workspace", "workspaces"],
    [
      "workspace.deleted",
      { reason: "none", holder: `run:${RUN_ID}` },
      "Removed a workspace of a finished run",
      "workspaces",
    ],
    [
      "workspace.deleted",
      { reason: "orphan", holder: `session:${SESSION_ID}` },
      "Removed a workspace no thread can resume",
      "workspaces",
    ],
    [
      "workspace.deleted",
      { reason: "idle", holder: `session:${SESSION_ID}` },
      "Removed an idle workspace",
      "workspaces",
    ],
    [
      "workspace.deleted",
      { reason: "inspection", holder: `run:${RUN_ID}` },
      "Removed a workspace kept for inspection",
      "workspaces",
    ],
    [
      "workspace.deleted",
      { reason: "archived", holder: `session:${SESSION_ID}` },
      "Removed an archived thread's workspace",
      "workspaces",
    ],
    ["workspace.detached", {}, "Detached a main workspace, files kept", "workspaces"],
    ["workspace.attachmentRetried", {}, "Retried attaching a main workspace", "workspaces"],
    ["session.spawned", { sessionId: SESSION_ID }, "Session spawned", "sessions"],
    ["session.stopped", { sessionId: SESSION_ID }, "Session stopped", "sessions"],
    ["session.stopped", { sessionId: SESSION_ID, reason: "crash" }, "Session crashed", "sessions"],
    [
      "session.stopped",
      { sessionId: SESSION_ID, reason: "workspace_failed" },
      "Session could not start: its workspace failed",
      "sessions",
    ],
    [
      "session.stopped",
      { sessionId: SESSION_ID, reason: "runner_retired" },
      "Session ended: the machine was retired",
      "sessions",
    ],
    [
      "session.reconciled",
      { sessionId: SESSION_ID, reason: "runner_lost" },
      "Session lost: contact with the machine was lost",
      "sessions",
      true,
    ],
    [
      "session.reconciled",
      { sessionId: SESSION_ID, reason: "runner_restart" },
      "Session ended when the runner restarted",
      "sessions",
    ],
    ["session.archived", { sessionId: SESSION_ID }, "Session archived", "sessions"],
    [
      "providerAccount.signedIn",
      { providerAccountId: "account-1" },
      "Claude Max signed in here",
      "settings",
    ],
    [
      "providerAccount.signedIn",
      { providerAccountId: "account-2" },
      "An account signed in here",
      "settings",
    ],
    [
      "providerAccount.signedIn",
      { providerAccountId: "deleted-account" },
      "An account signed in here",
      "settings",
    ],
  ];

  for (const [kind, payload, sentence, category, problem] of cases) {
    it(`${kind} ${JSON.stringify(payload)} reads "${sentence}"`, () => {
      const result = single(entry(kind, payload));
      expect(result.sentence).toBe(sentence);
      expect(result.category).toBe(category);
      expect(result.problem).toBe(problem === true);
    });
  }

  it("leaves out a kind it does not know", () => {
    expect(describe_([entry("runner.somethingNew", {}), entry("session.continued", {})])).toEqual(
      [],
    );
  });

  it("names the session an entry is about, and no session for other kinds", () => {
    expect(single(entry("session.spawned", { sessionId: SESSION_ID })).subjectSessionId).toBe(
      SESSION_ID,
    );
    expect(single(entry("runner.drained", { sessionId: SESSION_ID })).subjectSessionId).toBe(
      undefined,
    );
  });
});

describe("describeMachineActivity actors", () => {
  const actorOf = (actor: Input["actor"]) =>
    single(entry("session.archived", { sessionId: SESSION_ID }, undefined, actor)).actor;

  it("tells the user, a session and the controller apart", () => {
    expect(actorOf("user")).toEqual({ kind: "user" });
    expect(actorOf(`session:${SESSION_ID}`)).toEqual({ kind: "session", sessionId: SESSION_ID });
    expect(actorOf("system")).toEqual({ kind: "system" });
  });

  it("reads an entry without an actor as the controller's own act", () => {
    expect(actorOf(null)).toEqual({ kind: "system" });
  });

  it("keeps a run or a plugin as itself, never as the controller", () => {
    expect(actorOf(`run:${RUN_ID}`)).toEqual({ kind: "other", label: "run 0000bbbb" });
    expect(actorOf("plugin:github")).toEqual({ kind: "other", label: "plugin:github" });
  });
});

describe("describeMachineActivity folding", () => {
  const spawn = (at: string, over: { actor?: Input["actor"]; runId?: string } = {}) =>
    entry(
      "session.spawned",
      { sessionId: SESSION_ID, ...(over.runId === undefined ? {} : { runId: over.runId }) },
      at,
      over.actor ?? "user",
    );

  it("folds entries of one kind, wording and actor in one minute, newest first", () => {
    const events = [
      spawn("2026-11-03T09:12:01.000Z"),
      spawn("2026-11-03T09:12:20.000Z"),
      spawn("2026-11-03T09:12:59.000Z"),
    ].reverse();
    const [day] = describe_(events);
    expect(day?.entries).toHaveLength(1);
    const folded = day!.entries[0]!;
    expect(folded.sentence).toBe("3 sessions spawned");
    expect(folded.key).toBe(String(events[0]!.id));
    expect(folded.details.map((detail) => detail.eventId)).toEqual(events.map((e) => e.id));
    // Every line is the same, so no detail repeats it.
    expect(folded.details.every((detail) => detail.line === undefined)).toBe(true);
  });

  it("does not fold across minutes, actors, wordings or runs", () => {
    const events = [
      spawn("2026-11-03T09:12:59.000Z"),
      spawn("2026-11-03T09:13:00.000Z"),
      spawn("2026-11-03T09:13:10.000Z", { actor: "system" }),
      spawn("2026-11-03T09:13:20.000Z", { runId: RUN_ID }),
      spawn("2026-11-03T09:13:30.000Z", { runId: OTHER_RUN_ID }),
      entry("session.archived", { sessionId: SESSION_ID }, "2026-11-03T09:13:40.000Z", "user"),
    ].reverse();
    const [day] = describe_(events);
    expect(day?.entries.map((each) => each.count)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("does not fold two runs whose ids end the same, though both read as the same label", () => {
    const sameTailRun = "01990000-0000-7000-8000-11110000bbbb";
    const [day] = describe_(
      [
        spawn("2026-11-03T09:12:05.000Z", { actor: `run:${RUN_ID}` }),
        spawn("2026-11-03T09:12:30.000Z", { actor: `run:${sameTailRun}` }),
      ].reverse(),
    );
    expect(day?.entries.map((each) => each.count)).toEqual([1, 1]);
    expect(day?.entries.map((each) => each.actor)).toEqual([
      { kind: "other", label: "run 0000bbbb" },
      { kind: "other", label: "run 0000bbbb" },
    ]);
  });

  it("folds an entry without an actor with one stamped system, as both read as the controller", () => {
    const [day] = describe_(
      [
        entry("session.archived", { sessionId: SESSION_ID }, "2026-11-03T09:12:05.000Z", null),
        entry("session.archived", { sessionId: SESSION_ID }, "2026-11-03T09:12:30.000Z", "system"),
      ].reverse(),
    );
    expect(day?.entries).toHaveLength(1);
    expect(day?.entries[0]?.count).toBe(2);
    expect(day?.entries[0]?.actor).toEqual({ kind: "system" });
  });

  it("counts the log entries an entry stands for", () => {
    const [day] = describe_(
      [1, 2, 3].map((second) => spawn(`2026-11-03T09:12:0${second}.000Z`)).reverse(),
    );
    expect(day?.entries[0]?.count).toBe(3);
    expect(single(spawn("2026-11-03T09:12:01.000Z")).count).toBe(1);
  });

  it("lists details only when they tell more than the sentence", () => {
    const deleted = (second: number) =>
      entry("workspace.deleted", { reason: "none" }, `2026-11-03T09:12:0${second}.000Z`);
    const refused = (second: number, runnerMessage: string) =>
      entry("workspace.disposalRefused", { runnerMessage }, `2026-11-03T09:12:0${second}.000Z`);

    // Identical lines and no session: nothing to unfold, folded or not.
    const [identical] = describe_([deleted(1), deleted(2), deleted(3)].reverse());
    expect(identical?.entries[0]).toMatchObject({ count: 3, details: [] });
    expect(single(deleted(1)).details).toEqual([]);

    // Lines that differ: the details say what the sentence does not.
    const [differing] = describe_([refused(1, "In use."), refused(2, "Dirty.")].reverse());
    expect(differing?.entries[0]?.details.map((detail) => detail.line)).toEqual([
      "Could not remove a workspace: Dirty.",
      "Could not remove a workspace: In use.",
    ]);

    // A session: a single entry is about it, and the screen names it after the
    // sentence. A single entry has nothing to unfold.
    const lone = single(spawn("2026-11-03T09:12:01.000Z"));
    expect(lone.subjectSessionId).toBe(SESSION_ID);
    expect(lone.details).toEqual([]);
    // A fold has no subject. The lines are all the same, so each detail is its session alone.
    const [sessions] = describe_(
      [spawn("2026-11-03T09:12:01.000Z"), spawn("2026-11-03T09:12:02.000Z")].reverse(),
    );
    expect(sessions?.entries[0]?.subjectSessionId).toBe(undefined);
    expect(sessions?.entries[0]?.details.map((detail) => detail.sessionId)).toEqual([
      SESSION_ID,
      SESSION_ID,
    ]);
    expect(sessions?.entries[0]?.details.every((detail) => "line" in detail)).toBe(false);
  });

  it("does not fold a state with another state, nor a stop reason with another", () => {
    const [day] = describe_([
      entry("runner.stateChanged", { state: "offline" }),
      entry("runner.stateChanged", { state: "unreachable" }),
      entry("session.stopped", { reason: "crash" }),
      entry("session.stopped", {}),
    ]);
    expect(day?.entries).toHaveLength(4);
  });

  it("folds entries that are not next to each other, at the place of the newest", () => {
    const events = [
      spawn("2026-11-03T09:12:05.000Z"),
      entry("runner.drained", {}, "2026-11-03T09:12:30.000Z"),
      spawn("2026-11-03T09:12:50.000Z"),
    ].reverse();
    const [day] = describe_(events);
    expect(day?.entries.map((each) => each.sentence)).toEqual([
      "2 sessions spawned",
      "Set to take no new work",
    ]);
  });

  it("sets the run only when its sessions were spawned for one run", () => {
    const [day] = describe_(
      [
        spawn("2026-11-03T09:12:05.000Z", { runId: RUN_ID }),
        spawn("2026-11-03T09:12:06.000Z", { runId: RUN_ID }),
        spawn("2026-11-03T09:14:06.000Z"),
      ].reverse(),
    );
    expect(day?.entries[0]).toMatchObject({ sentence: "Session spawned" });
    expect(day?.entries[0]).not.toHaveProperty("runId");
    expect(day?.entries[1]).toMatchObject({ sentence: "2 sessions spawned", runId: RUN_ID });
  });

  it("counts removed workspaces, and words other repeats as times", () => {
    const [day] = describe_(
      [
        ...[1, 2, 3, 4, 5, 6].map((second) =>
          entry("workspace.deleted", { reason: "none" }, `2026-11-03T03:10:0${second}.000Z`),
        ),
        entry("runner.stateChanged", { state: "offline" }, "2026-11-03T04:00:01.000Z"),
        entry("runner.stateChanged", { state: "online" }, "2026-11-03T04:00:10.000Z"),
        entry("runner.stateChanged", { state: "offline" }, "2026-11-03T04:00:20.000Z"),
      ].reverse(),
    );
    expect(day?.entries.map((each) => each.sentence)).toEqual([
      "Went offline (2 times)",
      "Back online",
      "6 workspaces of finished runs removed",
    ]);
  });

  it("words a folded refusal by its count and keeps each message in its detail", () => {
    const [day] = describe_(
      [
        entry("workspace.disposalRefused", { runnerMessage: "It has uncommitted changes." }),
        entry("workspace.disposalRefused", { runnerMessage: "It is in use." }),
      ].reverse(),
    );
    expect(day?.entries).toHaveLength(1);
    expect(day?.entries[0]?.sentence).toBe("Could not remove 2 workspaces");
    expect(day?.entries[0]?.details.map((detail) => detail.line)).toEqual([
      "Could not remove a workspace: It is in use.",
      "Could not remove a workspace: It has uncommitted changes.",
    ]);
  });

  it("keeps the two 02:30 minutes of the night daylight saving time ends apart", () => {
    // In Europe/Amsterdam the clock goes from 03:00 back to 02:00 on 2026-10-25,
    // so 02:30 happens at 00:30 UTC and again at 01:30 UTC.
    const events = [
      spawn("2026-10-25T00:30:10.000Z"),
      spawn("2026-10-25T00:30:40.000Z"),
      spawn("2026-10-25T01:30:20.000Z"),
    ].reverse();
    const [day] = describe_(events, { timezone: "Europe/Amsterdam" });
    expect(day?.entries.map((each) => [each.time, each.sentence])).toEqual([
      ["02:30", "Session spawned"],
      ["02:30", "2 sessions spawned"],
    ]);
  });
});

describe("describeMachineActivity filters", () => {
  /** One of every kind that can be a problem, each beside a healthy entry of the same kind, in different minutes. */
  const events = [
    entry("runner.stateChanged", { state: "online" }, "2026-11-03T08:01:00.000Z"),
    entry("runner.stateChanged", { state: "offline" }, "2026-11-03T08:02:00.000Z"),
    entry("runner.stateChanged", { state: "unreachable" }, "2026-11-03T08:03:00.000Z"),
    entry("workspace.deleted", {}, "2026-11-03T08:04:00.000Z"),
    entry("workspace.disposalRefused", { runnerMessage: "In use." }, "2026-11-03T08:05:00.000Z"),
    entry("session.reconciled", { reason: "runner_restart" }, "2026-11-03T08:06:00.000Z"),
    entry("session.reconciled", { reason: "runner_lost" }, "2026-11-03T08:07:00.000Z"),
    entry("runner.placementsChanged", { acceptingPlacements: true }, "2026-11-03T08:08:00.000Z"),
    entry("runner.placementsChanged", { acceptingPlacements: false }, "2026-11-03T08:09:00.000Z"),
    entry("runner.crashLooping", { count: 3 }, "2026-11-03T08:10:00.000Z"),
    entry("session.stopped", { reason: "crash" }, "2026-11-03T08:11:00.000Z"),
    entry("runner.drained", {}, "2026-11-03T08:12:00.000Z"),
    entry(
      "providerAccount.signedIn",
      { providerAccountId: "account-1" },
      "2026-11-03T08:13:00.000Z",
    ),
  ].reverse();

  const sentences = (filter: MachineActivityFilter) =>
    describe_(events, { filter })
      .flatMap((day) => day.entries)
      .map((each) => each.sentence);

  it("keeps exactly the four problems under Problems", () => {
    expect(sentences("problems")).toEqual([
      "Takes no new sessions: free disk is below its limit",
      "Session lost: contact with the machine was lost",
      "Could not remove a workspace: In use.",
      "Became unreachable",
      "Went offline",
    ]);
  });

  it("keeps a category's entries under its filter", () => {
    expect(sentences("workspaces")).toEqual([
      "Could not remove a workspace: In use.",
      "Removed a workspace",
    ]);
    expect(sentences("sessions")).toEqual([
      "Session crashed",
      "Session lost: contact with the machine was lost",
      "Session ended when the runner restarted",
    ]);
    expect(sentences("settings")).toEqual(["Claude Max signed in here", "Set to take no new work"]);
    expect(sentences("connection")).toHaveLength(6);
    expect(sentences("all")).toHaveLength(13);
  });

  it("filters before folding, so Problems never folds in a healthy entry", () => {
    const [day] = describe_(
      [
        entry("runner.stateChanged", { state: "offline" }, "2026-11-03T08:00:05.000Z"),
        entry("runner.stateChanged", { state: "online" }, "2026-11-03T08:00:20.000Z"),
        entry("runner.stateChanged", { state: "offline" }, "2026-11-03T08:00:40.000Z"),
      ].reverse(),
      { filter: "problems" },
    );
    expect(day?.entries).toHaveLength(1);
    expect(day?.entries[0]?.count).toBe(2);
    expect(day?.entries[0]?.sentence).toBe("Went offline (2 times)");
  });

  it("lists the filters in the order the control shows them", () => {
    expect(MACHINE_ACTIVITY_FILTERS.map((each) => each.label)).toEqual([
      "All",
      "Problems",
      "Connection",
      "Sessions",
      "Workspaces",
      "Settings",
    ]);
  });
});

describe("describeMachineActivity days", () => {
  const at = (iso: string) => entry("runner.drained", {}, iso);

  it("heads the days Today, Yesterday, then by weekday and date, newest first", () => {
    const days = describe_(
      [
        at("2025-12-29T10:00:00.000Z"),
        at("2026-11-01T10:00:00.000Z"),
        at("2026-11-02T10:00:00.000Z"),
        at("2026-11-03T09:12:00.000Z"),
      ].reverse(),
    );
    expect(days.map((day) => [day.key, day.heading])).toEqual([
      ["2026-11-03", "Today"],
      ["2026-11-02", "Yesterday"],
      ["2026-11-01", "Sun 1 Nov"],
      ["2025-12-29", "Mon 29 Dec 2025"],
    ]);
    expect(days[0]?.entries[0]?.time).toBe("09:12");
  });

  it("puts an entry on its day in the display timezone, not in UTC", () => {
    // 03:30 UTC on 3 November is 19:30 on 2 November in Los Angeles.
    const events = [at("2026-11-03T03:30:00.000Z")];
    const utc = describe_(events);
    const losAngeles = describe_(events, { timezone: "America/Los_Angeles" });
    expect(utc.map((day) => [day.heading, day.entries[0]?.time])).toEqual([["Today", "03:30"]]);
    expect(losAngeles.map((day) => [day.key, day.heading, day.entries[0]?.time])).toEqual([
      ["2026-11-02", "Yesterday", "19:30"],
    ]);
  });
});

describe("describeRecentMachineActivity", () => {
  const at = (iso: string) => entry("runner.drained", {}, iso);
  const describeRecent = (
    events: ReadonlyArray<Input>,
    over: { timezone?: string; today?: Date } = {},
  ) =>
    describeRecentMachineActivity(events, {
      timezone: over.timezone ?? "UTC",
      today: over.today ?? TODAY,
      accounts: [],
    });

  it("returns the newest five entries, unfiltered", () => {
    const events = [1, 2, 3, 4, 5, 6, 7].map((minute) => at(`2026-11-03T08:0${minute}:00.000Z`));
    const recent = describeRecent([...events].reverse());
    expect(recent.map((each) => each.key)).toEqual(
      [...events]
        .reverse()
        .slice(0, 5)
        .map((each) => String(each.id)),
    );
    expect(describeRecent([entry("runner.stateChanged", { state: "online" })])).toHaveLength(1);
  });

  it("gives the day of an entry that is not from today, and none for one that is", () => {
    const recent = describeRecent(
      [
        at("2026-10-30T10:00:00.000Z"),
        at("2026-11-02T10:00:00.000Z"),
        at("2026-11-03T09:12:00.000Z"),
      ].reverse(),
    );
    expect(recent.map((each) => each.day)).toEqual([undefined, "Yesterday", "Fri 30 Oct"]);
  });

  it("decides today by date in the timezone, not by the heading", () => {
    // 03:30 UTC on 3 November is 19:30 on 2 November in Los Angeles, where today is 2 November.
    const events = [at("2026-11-03T03:30:00.000Z")];
    expect(describeRecent(events)[0]?.day).toBeUndefined();
    expect(
      describeRecent(events, {
        timezone: "America/Los_Angeles",
        today: new Date("2026-11-03T06:00:00Z"),
      })[0]?.day,
    ).toBeUndefined();
    expect(
      describeRecent(events, {
        timezone: "America/Los_Angeles",
        today: new Date("2026-11-03T12:00:00Z"),
      })[0]?.day,
    ).toBe("Yesterday");
  });

  it("returns nothing for a zone this runtime cannot format", () => {
    expect(describeRecent([at("2026-11-03T09:12:00.000Z")], { timezone: "Not/A_Zone" })).toEqual(
      [],
    );
  });
});

describe("describeEmptyMachineActivity", () => {
  it("words the empty list for each filter", () => {
    const words = MACHINE_ACTIVITY_FILTERS.map((each) =>
      describeEmptyMachineActivity(each.filter, "atlas"),
    );
    expect(words).toEqual([
      "Nothing has happened on atlas yet.",
      "No problems on atlas.",
      "No connection changes on atlas.",
      "No session activity on atlas.",
      "No workspace activity on atlas.",
      "No settings changes on atlas.",
    ]);
  });
});
