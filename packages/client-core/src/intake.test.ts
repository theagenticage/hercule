import {
  EVENT_HANDLINGS,
  type EventFacts,
  type EventWithFacts,
  type Signal,
  type SignalAction,
} from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTAKE_LIST_WIDTH,
  EVENT_HANDLING_OPTIONS,
  MIN_INTAKE_LIST_WIDTH,
  MIN_INTAKE_PANE_WIDTH,
  buildHandlingLabels,
  buildInitials,
  buildIntakeTabs,
  buildSignalAnswers,
  countToDo,
  cutHandlingLabels,
  decidePluginMark,
  describeAnswerKey,
  describeBuildFailure,
  computeEventHorizonStart,
  describeEventHorizon,
  describeEventListEnd,
  describeHandlingCaption,
  describeEventSystem,
  describeEventTitle,
  moveEventSelection,
  describeNotScreened,
  describeOrchestrationSegment,
  describeResolvedElsewhere,
  describeSignalAsker,
  describeSignalOutcome,
  describeSignalOutcomeMoment,
  describeSignalProvenance,
  describeSignalRow,
  findReplyAnswer,
  findSuggestedAnswer,
  fitIntakeListWidth,
  fitsIntakePane,
  groupEventsByDay,
  groupSignalsByDay,
  groupSignalsIntoSections,
  isBackFromSnooze,
  listUrgentSignals,
  moveSignalSelection,
  nameSignalSource,
  parseIntakeListWidth,
  trimAnswerEllipsis,
  type EventHandlingLabel,
} from "./intake";

const PLUGINS = [
  { id: "github", displayName: "GitHub" },
  { id: "slack", displayName: "Slack" },
];

const TRIAGE_ID = "01a06d02-7f00-7000-8000-000000000001";
const ADA_ID = "01a06d02-7e00-7000-8000-000000000001";
const RAISERS = {
  workflows: [{ id: TRIAGE_ID, name: "Triage" }],
  assistants: [{ id: ADA_ID, name: "Ada" }],
};

const EVENT_ORIGIN = {
  type: "event",
  eventId: 1,
  connectionId: "01a06d02-7200-7000-8000-000000000001",
  threadRef: "acme/webshop#1296",
} as const;

/** Builds an open signal of `kind`, created at `createdAt`, with the given fields changed. */
const buildSignal = (id: string, overrides: Partial<Signal> = {}): Signal => ({
  id,
  kind: "github/mentioned",
  origin: EVENT_ORIGIN,
  title: `Signal ${id}`,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: "2026-10-10T09:00:00.000Z",
  ...overrides,
});

const fromUser = (reason = "asked by hand") =>
  ({ type: "api", actor: "user", eventIds: [], reason }) as const;

const action = (id: string, overrides: Partial<SignalAction> = {}): SignalAction => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  operation: { op: "github/pr.review", input: {} },
  ...overrides,
});

describe("nameSignalSource", () => {
  it("names a plugin kind's plugin, or its id when the plugin is not listed", () => {
    expect(nameSignalSource(buildSignal("a"), PLUGINS, RAISERS)).toBe("GitHub");
    expect(nameSignalSource(buildSignal("a", { kind: "jira/assigned" }), PLUGINS, RAISERS)).toBe(
      "jira",
    );
  });

  it("names who raised a core signal", () => {
    const raisedBy = (actor: string) =>
      nameSignalSource(
        buildSignal("a", {
          kind: "proposal",
          origin: { type: "api", actor, eventIds: [], reason: "r" },
        }),
        PLUGINS,
        RAISERS,
      );
    expect(raisedBy("user")).toBe("You");
    expect(raisedBy("system")).toBe("Hercule");
    expect(raisedBy("plugin:slack")).toBe("Slack");
    expect(raisedBy("run:01a06d02-7300-7000-8000-000000000001")).toBe("A workflow");
    expect(raisedBy("session:01a06d02-7300-7000-8000-000000000001")).toBe("An agent");
  });

  it("names the workflow of a run and the assistant of a session, or stays general when they are gone", () => {
    const raisedBy = (ids: {
      readonly runId?: string;
      readonly workflowId?: string;
      readonly assistantId?: string;
    }) =>
      nameSignalSource(
        buildSignal("a", {
          kind: "offer",
          origin: {
            type: "api",
            actor: "session:01a06d02-7300-7000-8000-000000000001",
            eventIds: [],
            reason: "r",
            ...ids,
          },
        }),
        PLUGINS,
        RAISERS,
      );
    const runId = "01a06d02-7d00-7000-8000-000000000001";
    const gone = "01a06d02-7c00-7000-8000-000000000001";
    expect(raisedBy({ runId, workflowId: TRIAGE_ID })).toBe("Triage");
    expect(raisedBy({ runId, workflowId: gone })).toBe("A workflow");
    // A run of a sent workflow has no stored workflow to name.
    expect(raisedBy({ runId })).toBe("A workflow");
    expect(raisedBy({ assistantId: ADA_ID })).toBe("Ada");
    expect(raisedBy({ assistantId: gone })).toBe("An agent");
  });

  it("names Hercule for a core kind raised from an event", () => {
    expect(nameSignalSource(buildSignal("a", { kind: "fyi" }), PLUGINS, RAISERS)).toBe("Hercule");
  });
});

describe("describeSignalProvenance", () => {
  it("joins the source and the kind's label", () => {
    expect(describeSignalProvenance(buildSignal("a"), PLUGINS, RAISERS)).toBe("GitHub · Mentioned");
    expect(
      describeSignalProvenance(
        buildSignal("a", { kind: "proposal", origin: fromUser() }),
        PLUGINS,
        RAISERS,
      ),
    ).toBe("You · Proposal");
  });

  it("makes a plugin kind's word into a label, and labels the core kinds by hand", () => {
    const labelKind = (kind: string) =>
      describeSignalProvenance(buildSignal("a", { kind }), PLUGINS, RAISERS).split(" · ")[1];
    expect(labelKind("github/review-requested")).toBe("Review requested");
    expect(labelKind("fyi")).toBe("FYI");
    expect(labelKind("unsure")).toBe("Unsure");
  });
});

describe("decidePluginMark", () => {
  it("draws the paths of the mark the plugin declares", () => {
    const plugins = [{ id: "sentry", displayName: "Sentry", mark: { paths: ["M0 0h16v16H0z"] } }];
    expect(decidePluginMark("sentry", plugins)).toEqual({
      _tag: "paths",
      paths: ["M0 0h16v16H0z"],
    });
  });

  it("draws the initial of the plugin's name when it declares no mark", () => {
    expect(decidePluginMark("slack", PLUGINS)).toEqual({ _tag: "initial", initial: "S" });
  });

  it("draws the initial of the id of a plugin that is not listed", () => {
    expect(decidePluginMark("jira", PLUGINS)).toEqual({ _tag: "initial", initial: "J" });
  });
});

describe("countToDo and describeOrchestrationSegment", () => {
  it("counts every signal on To do, core signals included", () => {
    expect(
      countToDo([
        buildSignal("a"),
        buildSignal("b", { kind: "slack/mentioned" }),
        buildSignal("c", { kind: "proposal", origin: fromUser() }),
      ]),
    ).toBe(3);
  });

  it("names the count in the segment's accessible name", () => {
    expect(describeOrchestrationSegment(8)).toBe("Hercule, 8 to do");
  });
});

describe("buildIntakeTabs", () => {
  const switchedOn = { intake: { signalKinds: [{ on: true }] } };
  const switchedOff = { intake: { signalKinds: [{ on: false }, { on: false }] } };
  const TAB_PLUGINS = [
    { id: "github", displayName: "GitHub", ...switchedOn },
    { id: "slack", displayName: "Slack", ...switchedOn },
    { id: "linear", displayName: "Linear", ...switchedOff },
  ];

  it("lists All, then each plugin with a signal kind switched on, in the plugins' order, never core signals", () => {
    const tabs = buildIntakeTabs(
      [
        buildSignal("a", { kind: "slack/mentioned" }),
        buildSignal("b"),
        buildSignal("c"),
        buildSignal("d", { kind: "proposal", origin: fromUser() }),
      ],
      TAB_PLUGINS,
      null,
      0,
    );
    expect(tabs).toEqual([
      { pluginId: null, label: "All", count: 4 },
      { pluginId: "github", label: "GitHub", count: 2 },
      { pluginId: "slack", label: "Slack", count: 1 },
    ]);
  });

  it("keeps a switched-on plugin's tab with no signal, so it survives its last one leaving", () => {
    expect(buildIntakeTabs([], TAB_PLUGINS, null, 0)).toEqual([
      { pluginId: null, label: "All", count: 0 },
      { pluginId: "github", label: "GitHub", count: 0 },
      { pluginId: "slack", label: "Slack", count: 0 },
    ]);
  });

  it("gives a plugin with every kind switched off a tab only while it has a signal or is pressed", () => {
    const labels = (signals: Signal[], pressed: string | null) =>
      buildIntakeTabs(signals, TAB_PLUGINS, pressed, 0).map((tab) => tab.label);
    expect(labels([], null)).not.toContain("Linear");
    expect(labels([buildSignal("a", { kind: "linear/assigned" })], null)).toContain("Linear");
    expect(labels([], "linear")).toContain("Linear");
  });

  it("gives an unlisted plugin a tab named by its id, after the listed ones", () => {
    const tabs = buildIntakeTabs(
      [buildSignal("a", { kind: "jira/assigned" }), buildSignal("b")],
      TAB_PLUGINS,
      null,
      0,
    );
    expect(tabs.map((tab) => tab.label)).toEqual(["All", "GitHub", "Slack", "jira"]);
    expect(buildIntakeTabs([], TAB_PLUGINS, "jira", 0).map((tab) => tab.label)).toContain("jira");
  });

  it("adds the Tracking rows that wait on the user to All's count and to no plugin's", () => {
    const tabs = buildIntakeTabs([buildSignal("a"), buildSignal("b")], TAB_PLUGINS, null, 3);
    expect(tabs).toEqual([
      { pluginId: null, label: "All", count: 5 },
      { pluginId: "github", label: "GitHub", count: 2 },
      { pluginId: "slack", label: "Slack", count: 0 },
    ]);
  });
});

describe("groupSignalsByDay", () => {
  // Sunday 11 October 2026, 10:00 in Amsterdam.
  const now = new Date("2026-10-11T08:00:00.000Z");
  const AMSTERDAM = "Europe/Amsterdam";
  const sectionsOf = (sections: ReturnType<typeof groupSignalsByDay>) =>
    sections.map((section) => [section.label, section.signals.map((signal) => signal.id)]);

  it("groups Later by the date each signal comes back in the user's zone", () => {
    const snoozed = (id: string, until: string) =>
      buildSignal(id, { snooze: { until, snoozedAt: "2026-10-11T07:00:00.000Z" } });
    const later = [
      snoozed("a", "2026-10-11T12:00:00.000Z"),
      // 23:30 tonight in Amsterdam, though already Monday in UTC.
      snoozed("b", "2026-10-11T21:30:00.000Z"),
      snoozed("c", "2026-10-12T07:00:00.000Z"),
      snoozed("d", "2026-10-13T07:00:00.000Z"),
    ];
    expect(sectionsOf(groupSignalsByDay(later, "later", now, AMSTERDAM))).toEqual([
      ["Back today", ["a", "b"]],
      ["Back tomorrow", ["c"]],
      ["Back Tuesday", ["d"]],
    ]);
  });

  it("groups Done by the date each signal was resolved, with a capital", () => {
    const resolvedAt = (id: string, at: string) =>
      buildSignal(id, {
        status: "resolved",
        resolution: { kind: "decided", outcome: "Done", actor: "user", origin: "api", at },
      });
    const done = [
      resolvedAt("a", "2026-10-11T07:00:00.000Z"),
      resolvedAt("b", "2026-10-10T15:00:00.000Z"),
      resolvedAt("c", "2026-10-08T15:00:00.000Z"),
    ];
    const sections = groupSignalsByDay(done, "done", now, AMSTERDAM);
    expect(sectionsOf(sections)).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["Thursday", ["c"]],
    ]);
    expect(sections.map((section) => section.key)).toEqual(["day:0", "day:-1", "day:-3"]);
  });
});

describe("groupSignalsIntoSections", () => {
  it("puts urgent signals in Now and every other one in Signals, leaving out an empty section", () => {
    const sections = groupSignalsIntoSections(
      [
        buildSignal("a"),
        buildSignal("b", { priority: "urgent" }),
        buildSignal("c", { priority: "high" }),
      ],
      null,
    );
    expect(sections.map((section) => [section.label, section.signals.map((s) => s.id)])).toEqual([
      ["Now", ["b"]],
      ["Signals", ["a", "c"]],
    ]);
    expect(groupSignalsIntoSections([buildSignal("a")], null).map((s) => s.key)).toEqual([
      "signals",
    ]);
  });

  it("orders the signals back from a snooze first, by when the snooze ended, then the oldest first", () => {
    const back = (id: string, until: string) =>
      buildSignal(id, {
        createdAt: "2026-10-01T00:00:00.000Z",
        snooze: { until, snoozedAt: "2026-10-09T00:00:00.000Z" },
      });
    const sections = groupSignalsIntoSections(
      [
        buildSignal("new", { createdAt: "2026-10-10T10:00:00.000Z" }),
        back("back-late", "2026-10-10T09:00:00.000Z"),
        buildSignal("old", { createdAt: "2026-10-09T10:00:00.000Z" }),
        back("back-early", "2026-10-10T08:00:00.000Z"),
      ],
      null,
    );
    expect(sections[0]!.signals.map((signal) => signal.id)).toEqual([
      "back-early",
      "back-late",
      "old",
      "new",
    ]);
  });

  it("shows only the plugin's signals on its tab", () => {
    const sections = groupSignalsIntoSections(
      [buildSignal("a"), buildSignal("b", { kind: "slack/mentioned", priority: "urgent" })],
      "github",
    );
    expect(sections.map((section) => section.signals.map((s) => s.id))).toEqual([["a"]]);
  });
});

describe("isBackFromSnooze", () => {
  it("is true for a signal on To do that carries a snooze", () => {
    expect(isBackFromSnooze(buildSignal("a"))).toBe(false);
    expect(
      isBackFromSnooze(
        buildSignal("a", {
          snooze: { until: "2026-10-10T08:00:00.000Z", snoozedAt: "2026-10-09T08:00:00.000Z" },
        }),
      ),
    ).toBe(true);
  });
});

describe("describeSignalRow", () => {
  it("joins who asks, the kind in lower case and where", () => {
    expect(
      describeSignalRow(
        buildSignal("a", {
          kind: "github/review-requested",
          asker: "Marta",
          place: "acme/webshop#1296",
        }),
        PLUGINS,
        RAISERS,
      ),
    ).toBe("Marta · review requested · acme/webshop#1296");
  });

  it("names a core signal's source when it has no asker", () => {
    expect(
      describeSignalRow(
        buildSignal("a", { kind: "proposal", origin: fromUser() }),
        PLUGINS,
        RAISERS,
      ),
    ).toBe("You · proposal");
  });

  it("keeps an acronym kind in capitals", () => {
    expect(
      describeSignalRow(buildSignal("a", { kind: "fyi", origin: fromUser() }), PLUGINS, RAISERS),
    ).toBe("You · FYI");
  });

  it("leaves the kind out of an unsure row, which carries its own label", () => {
    expect(
      describeSignalRow(
        buildSignal("a", { kind: "unsure", origin: fromUser(), place: "#ops" }),
        PLUGINS,
        RAISERS,
      ),
    ).toBe("You · #ops");
  });
});

describe("describeSignalAsker", () => {
  it("says who asks and where, or whichever the signal names", () => {
    expect(describeSignalAsker(buildSignal("a", { asker: "Marta", place: "acme#1" }))).toBe(
      "Marta asks in acme#1",
    );
    expect(describeSignalAsker(buildSignal("a", { asker: "Marta" }))).toBe("Marta asks");
    expect(describeSignalAsker(buildSignal("a", { place: "acme#1" }))).toBe("In acme#1");
    expect(describeSignalAsker(buildSignal("a"))).toBeNull();
  });
});

describe("describeBuildFailure", () => {
  it("names the plugin that could not draw the signal", () => {
    expect(
      describeBuildFailure(
        buildSignal("a", { buildError: { message: "boom", at: "2026-10-10T09:00:00.000Z" } }),
        PLUGINS,
        RAISERS,
      ),
    ).toBe("GitHub couldn't draw this signal. Showing the event as it came in.");
    expect(describeBuildFailure(buildSignal("a"), PLUGINS, RAISERS)).toBeNull();
  });
});

describe("describeNotScreened", () => {
  it("says no workflow screened a signal the core raised without a Screener", () => {
    const signal = buildSignal("a", {
      origin: { ...EVENT_ORIGIN, notScreened: { reason: "no-screener" } },
    });
    expect(describeNotScreened(signal)).toBe("Not screened: no workflow screens signals");
  });

  it("returns null for a screened signal, one that needed no Screening, and a raised one", () => {
    const screened = buildSignal("a", {
      origin: { ...EVENT_ORIGIN, screened: { runId: TRIAGE_ID, reason: "Marta asks" } },
    });
    expect(describeNotScreened(screened)).toBeNull();
    expect(describeNotScreened(buildSignal("b"))).toBeNull();
    expect(
      describeNotScreened(buildSignal("c", { kind: "proposal", origin: fromUser() })),
    ).toBeNull();
  });
});

describe("buildSignalAnswers", () => {
  const signal = buildSignal("a", {
    actions: [
      action("done", { label: "Done", operation: null }),
      action("hand-to-bugfix", {
        label: "Hand to Bugfix",
        operation: { op: "run.start", input: {} },
      }),
      action("rerun", { label: "Run again", operation: { op: "run.start", input: {} } }),
      action("approve", { primary: true }),
      action("reply", { label: "Reply…", field: { name: "body", placeholder: "Write a reply" } }),
      action("dismiss", { label: "Dismiss", operation: null }),
    ],
  });
  const answers = buildSignalAnswers(signal);

  it("orders the actions the plugin gave, then Hand to an agent, then Done", () => {
    // `rerun` binds run.start too, but the raiser gave it, so it keeps its place.
    expect(answers.map((answer) => answer.action.id)).toEqual([
      "rerun",
      "approve",
      "reply",
      "dismiss",
      "hand-to-bugfix",
      "done",
    ]);
  });

  it("styles each answer by what it does", () => {
    expect(answers.map((answer) => answer.style)).toEqual([
      "plain",
      "plain",
      "reply",
      "quiet",
      "plain",
      "done",
    ]);
  });

  // Signals written before `signal.handOff` existed keep their `run.start` answers.
  it.each([
    ["signal.handOff", (workflowId: string) => ({ signalId: "b", workflowId })],
    ["run.start", (workflowId: string) => ({ workflowId, inputs: { signal: "b" } })],
  ] as const)(
    "gives a Hand to an agent answer that binds %s the workflow it starts, and no other answer one",
    (op, buildInput) => {
      const workflowId = "01a0ec64-6e80-7000-8000-0000000000f8";
      const [handOff] = buildSignalAnswers(
        buildSignal("b", {
          actions: [
            action(`hand-to-${workflowId}`, {
              operation: { op, input: buildInput(workflowId) },
            }),
          ],
        }),
      );
      expect(handOff?.workflowId).toBe(workflowId);
      expect(answers.every((answer) => answer.workflowId === null)).toBe(true);
    },
  );

  it("finds the primary action as the suggested answer, and the first text box", () => {
    expect(findSuggestedAnswer(answers)?.action.id).toBe("approve");
    expect(findReplyAnswer(answers)?.action.id).toBe("reply");
    expect(findSuggestedAnswer(buildSignalAnswers(buildSignal("b")))).toBeUndefined();
  });

  it("names what the foot's keys do", () => {
    expect(describeAnswerKey(answers[1]!, "↩")).toBe("approve");
    expect(describeAnswerKey(answers[2]!, "R")).toBe("reply");
    expect(describeAnswerKey(answers[2]!, "↩")).toBe("write the reply");
  });

  it("drops only an ellipsis at the end of a label", () => {
    expect(trimAnswerEllipsis("Reply…")).toBe("Reply");
    expect(trimAnswerEllipsis("Approve")).toBe("Approve");
    expect(trimAnswerEllipsis("Wait… then go")).toBe("Wait… then go");
  });
});

describe("describeSignalOutcome and describeResolvedElsewhere", () => {
  const resolved = (actor: string, kind: "decided" | "withdrawn" = "decided") =>
    buildSignal("a", {
      status: "resolved",
      resolution: {
        kind,
        outcome: "Approved #1293",
        actor,
        origin: "web",
        at: "2026-10-10T10:00:00.000Z",
      },
    });

  it("returns null for an open signal", () => {
    expect(describeSignalOutcome(buildSignal("a"), PLUGINS)).toBeNull();
    expect(describeResolvedElsewhere(buildSignal("a"), PLUGINS)).toBeNull();
  });

  it("calls the user's own decision What you did", () => {
    expect(describeSignalOutcome(resolved("user"), PLUGINS)).toEqual({
      label: "What you did",
      outcome: "Approved #1293",
      by: "by you",
      byUser: true,
    });
  });

  it("calls a decision made on the source, or a withdrawal, Left on its own", () => {
    expect(describeSignalOutcome(resolved("plugin:github"), PLUGINS)).toMatchObject({
      label: "Left on its own",
      by: "by GitHub",
      byUser: false,
    });
    expect(
      describeSignalOutcome(resolved("session:01a06d02-7300-7000-8000-000000000001"), PLUGINS)?.by,
    ).toBe("by an agent");
    expect(describeSignalOutcome(resolved("user", "withdrawn"), PLUGINS)?.label).toBe(
      "Left on its own",
    );
  });

  it("says where, when and by whom the signal ended", () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const read = (signal: Signal) =>
      describeSignalOutcomeMoment(signal, PLUGINS, now, "Europe/Amsterdam");
    expect(read(resolved("user"))).toBe("Here · today 12:00 · by you");
    expect(read(resolved("plugin:github"))).toBe("Resolved by GitHub · today 12:00");
    expect(read(resolved("plugin:github", "withdrawn"))).toBe("Withdrawn by GitHub · today 12:00");
    expect(read(buildSignal("b"))).toBeNull();
  });

  it("says the signal was resolved elsewhere, how and by whom", () => {
    expect(describeResolvedElsewhere(resolved("plugin:github"), PLUGINS)).toBe(
      "Resolved elsewhere: approved #1293, by GitHub",
    );
  });

  it("names the plugin, not the core, for an end the core observed on the source", () => {
    const ended = (outcome: string) =>
      buildSignal("a", {
        kind: "github/review-requested",
        status: "resolved",
        resolution: {
          kind: "withdrawn",
          outcome,
          actor: "system",
          origin: "core",
          at: "2026-10-10T10:00:00.000Z",
        },
      });
    expect(describeSignalOutcome(ended("Reviewed on GitHub"), PLUGINS)?.by).toBe("by GitHub");
    expect(describeResolvedElsewhere(ended("Marta removed the request"), PLUGINS)).toBe(
      "Resolved elsewhere: Marta removed the request, by GitHub",
    );
  });

  it("names the core for a core signal the core resolved", () => {
    const resolvedByCore = buildSignal("a", {
      kind: "proposal",
      status: "resolved",
      resolution: {
        kind: "withdrawn",
        outcome: "Replaced by a newer one",
        actor: "system",
        origin: "core",
        at: "2026-10-10T10:00:00.000Z",
      },
    });
    expect(describeSignalOutcome(resolvedByCore, PLUGINS)?.by).toBe("by Hercule");
  });

  it("counts an answer the user gave on the source as the user's own move", () => {
    const reviewed = buildSignal("a", {
      kind: "github/review-requested",
      status: "resolved",
      resolution: {
        kind: "decided",
        actionId: "approve",
        outcome: "Approved on GitHub",
        actor: "system",
        origin: "core",
        at: "2026-10-10T10:00:00.000Z",
      },
    });
    expect(describeSignalOutcome(reviewed, PLUGINS)).toEqual({
      label: "What you did",
      outcome: "Approved on GitHub",
      by: "by you",
      byUser: true,
    });
    expect(describeResolvedElsewhere(reviewed, PLUGINS)).toBe(
      "Resolved elsewhere: Approved on GitHub, by you",
    );
  });

  it("names the core for a plugin's signal a newer one replaced", () => {
    const replaced = buildSignal("a", {
      kind: "github/review-requested",
      status: "resolved",
      replacedBy: "b",
      resolution: {
        kind: "withdrawn",
        outcome: "Replaced by a newer one",
        actor: "system",
        origin: "core",
        at: "2026-10-10T10:00:00.000Z",
      },
    });
    expect(describeSignalOutcome(replaced, PLUGINS)?.by).toBe("by Hercule");
  });
});

describe("listUrgentSignals", () => {
  it("lists the Now signals, oldest first, titled with their source", () => {
    expect(
      listUrgentSignals(
        [
          buildSignal("late", { priority: "urgent", createdAt: "2026-10-10T10:00:00.000Z" }),
          buildSignal("calm"),
          buildSignal("early", {
            kind: "slack/mentioned",
            priority: "urgent",
            title: "Checkout is down",
            createdAt: "2026-10-10T08:00:00.000Z",
          }),
        ],
        PLUGINS,
      ),
    ).toEqual([
      { signalId: "early", title: "Slack", body: "Checkout is down" },
      { signalId: "late", title: "GitHub", body: "Signal late" },
    ]);
  });
});

describe("moveSignalSelection", () => {
  const sections = groupSignalsIntoSections(
    [
      buildSignal("a", { createdAt: "2026-10-10T08:00:00.000Z" }),
      buildSignal("b", { createdAt: "2026-10-10T09:00:00.000Z" }),
      buildSignal("now", { priority: "urgent" }),
    ],
    null,
  );

  it("moves through the sections in the list's order and stops at either end", () => {
    expect(moveSignalSelection(sections, "now", 1)).toBe("a");
    expect(moveSignalSelection(sections, "a", -1)).toBe("now");
    expect(moveSignalSelection(sections, "b", 1)).toBe("b");
    expect(moveSignalSelection(sections, "now", -1)).toBe("now");
  });

  it("starts at the first row going down and the last going up", () => {
    expect(moveSignalSelection(sections, null, 1)).toBe("now");
    expect(moveSignalSelection(sections, "gone", -1)).toBe("b");
    expect(moveSignalSelection([], null, 1)).toBeNull();
  });
});

describe("buildInitials", () => {
  it("takes the first letters of the first and the last word", () => {
    expect(buildInitials("Marta de Vries")).toBe("MV");
  });

  it("takes one letter of a one-word name", () => {
    expect(buildInitials(" sanne ")).toBe("S");
  });
});

describe("the split's widths", () => {
  it("parses a stored width, and falls back to the default for anything else", () => {
    expect(parseIntakeListWidth("500")).toBe(500);
    expect(parseIntakeListWidth(null)).toBe(DEFAULT_INTAKE_LIST_WIDTH);
    expect(parseIntakeListWidth("wide")).toBe(DEFAULT_INTAKE_LIST_WIDTH);
    expect(parseIntakeListWidth("200")).toBe(DEFAULT_INTAKE_LIST_WIDTH);
  });

  it("keeps both columns at their minimums", () => {
    expect(fitIntakeListWidth(200, 1200)).toBe(MIN_INTAKE_LIST_WIDTH);
    expect(fitIntakeListWidth(1000, 1200)).toBe(1200 - MIN_INTAKE_PANE_WIDTH);
    expect(fitIntakeListWidth(500, 1200)).toBe(500);
  });

  it("hides the pane when the two minimums do not fit", () => {
    expect(fitsIntakePane(MIN_INTAKE_LIST_WIDTH + MIN_INTAKE_PANE_WIDTH)).toBe(true);
    expect(fitsIntakePane(MIN_INTAKE_LIST_WIDTH + MIN_INTAKE_PANE_WIDTH - 1)).toBe(false);
  });
});

describe("buildHandlingLabels", () => {
  // Sunday 11 October 2026, 10:00 in Amsterdam.
  const now = new Date("2026-10-11T08:00:00.000Z");
  const AMSTERDAM = "Europe/Amsterdam";
  const NO_FACTS: EventFacts = {
    signals: [],
    resolvedSignals: [],
    ignoredBy: null,
    tasks: [],
    knownBy: [],
  };
  const buildLabels = (facts: Partial<EventFacts>) =>
    buildHandlingLabels({ ...NO_FACTS, ...facts }, now, AMSTERDAM);
  const readWords = (facts: Partial<EventFacts>) =>
    buildLabels(facts).map((label) => [label.lead, label.detail]);
  const MENTIONED = { signalId: "s1", kind: "github/mentioned", title: "Mentioned" } as const;

  it("reads no action for an event that came to nothing", () => {
    expect(buildLabels({})).toEqual([
      {
        handling: "no-action",
        key: "no-action",
        lead: "no action",
        detail: null,
        record: null,
        standing: null,
        target: null,
      },
    ]);
  });

  it("names where a raised signal stands: To do, Later, Done", () => {
    expect(readWords({ signals: [{ ...MENTIONED, status: "open" }] })).toEqual([
      ["→ signal", "on your To do list"],
    ]);
    expect(
      readWords({
        signals: [{ ...MENTIONED, status: "open", snoozedUntil: "2026-10-12T07:00:00.000Z" }],
      }),
    ).toEqual([["→ signal", "Later · back tomorrow"]]);
    expect(
      readWords({
        signals: [{ ...MENTIONED, status: "resolved", outcome: "Replied in Gmail" }],
      }),
    ).toEqual([["→ signal", "Done · Replied in Gmail"]]);
  });

  it("reads a snooze that has run out as on To do", () => {
    expect(
      readWords({
        signals: [{ ...MENTIONED, status: "open", snoozedUntil: "2026-10-11T07:00:00.000Z" }],
      }),
    ).toEqual([["→ signal", "on your To do list"]]);
  });

  it("links a raised signal to the view it is on", () => {
    const [label] = buildLabels({
      signals: [{ ...MENTIONED, status: "open", snoozedUntil: "2026-10-12T07:00:00.000Z" }],
    });
    expect(label!.target).toEqual({ kind: "signal", signalId: "s1", view: "later" });
  });

  it("names a signal the event ended and its outcome", () => {
    const [label] = buildLabels({
      resolvedSignals: [
        {
          signalId: "s2",
          title: "Review #12",
          outcome: "Approved",
        },
      ],
    });
    expect(label).toMatchObject({
      lead: "ended Review #12",
      detail: "Approved",
      target: { kind: "signal", signalId: "s2", view: "done" },
    });
  });

  it("names the Ignore Rule that caught the event and links its kind in Settings", () => {
    const [label] = buildLabels({
      ignoredBy: {
        ruleId: "r1",
        kind: "github/review-requested",
        text: "Review requested · Repo acme/webshop",
        ruleDeleted: false,
      },
    });
    expect(label).toEqual({
      handling: "ignored",
      key: "ignored:r1",
      lead: "→ ignored by a rule",
      detail: null,
      record: "Review requested · Repo acme/webshop",
      standing: "In Settings › Intake",
      target: { kind: "ignore-rule", signalKind: "github/review-requested" },
    });
  });

  it("says a rule is deleted and links nothing once the user deleted it", () => {
    const [label] = buildLabels({
      ignoredBy: {
        ruleId: "r1",
        kind: "github/review-requested",
        text: "Review requested · Repo acme/webshop",
        ruleDeleted: true,
      },
    });
    expect(label).toMatchObject({
      lead: "→ ignored by a deleted rule",
      detail: null,
      record: "Review requested · Repo acme/webshop",
      standing: "Rule deleted",
      target: null,
    });
  });

  it("reads a signal of a core kind as evidence, and one of a plugin's kind as raised", () => {
    expect(
      readWords({
        signals: [
          { signalId: "p", kind: "proposal", status: "open", title: "Fix the flake" },
          { ...MENTIONED, status: "open" },
          { signalId: "f", kind: "fyi", status: "open", title: "Release notes" },
        ],
      }),
    ).toEqual([
      ["→ signal", "on your To do list"],
      ["→ proposal", "Fix the flake"],
      ["→ FYI", "Release notes"],
    ]);
  });

  it("names a Task and links it", () => {
    const [label] = buildLabels({ tasks: [{ taskId: "t1", title: "Ship the release" }] });
    expect(label).toMatchObject({
      lead: "→ Ship the release",
      detail: null,
      target: { kind: "task", taskId: "t1" },
    });
  });

  it("names the session or run that knows the event, with a word for one without a title", () => {
    expect(
      readWords({
        knownBy: [
          { subscriptionId: "a", holder: { kind: "session", id: "x" }, title: "Release thread" },
          { subscriptionId: "b", holder: { kind: "run", id: "y" }, title: null },
          { subscriptionId: "c", holder: { kind: "session", id: "z" }, title: null },
        ],
      }),
    ).toEqual([
      ["known to Release thread", null],
      ["known to a run", null],
      ["known to a Thread", null],
    ]);
  });

  it("tells the pane the record each handling is about and where it stands", () => {
    const readCard = (facts: Partial<EventFacts>) =>
      buildLabels(facts).map((label) => [label.record, label.standing]);
    expect(readCard({ signals: [{ ...MENTIONED, status: "open" }] })).toEqual([
      ["Mentioned", "on your To do list"],
    ]);
    expect(
      readCard({
        resolvedSignals: [
          {
            signalId: "s2",
            title: "Review #12",
            outcome: "Approved",
          },
        ],
      }),
    ).toEqual([["Review #12", "Approved"]]);
    expect(
      readCard({
        signals: [{ signalId: "p", kind: "proposal", status: "open", title: "Fix the flake" }],
      }),
    ).toEqual([["Fix the flake", "Proposal · on your To do list"]]);
    expect(readCard({ tasks: [{ taskId: "t1", title: "Ship the release" }] })).toEqual([
      ["Ship the release", null],
    ]);
    expect(
      readCard({
        knownBy: [
          { subscriptionId: "a", holder: { kind: "session", id: "x" }, title: "Release thread" },
          { subscriptionId: "b", holder: { kind: "run", id: "y" }, title: null },
        ],
      }),
    ).toEqual([
      ["Release thread", "Thread"],
      ["a run", "Run"],
    ]);
    expect(readCard({})).toEqual([[null, null]]);
  });

  it("links the holder of a known event by its kind", () => {
    const labels = buildLabels({
      knownBy: [
        { subscriptionId: "a", holder: { kind: "session", id: "x" }, title: null },
        { subscriptionId: "b", holder: { kind: "run", id: "y" }, title: null },
      ],
    });
    expect(labels.map((label) => label.target)).toEqual([
      { kind: "session", sessionId: "x" },
      { kind: "run", runId: "y" },
    ]);
  });

  it("orders the labels as spec 10 does, whatever order the facts come in", () => {
    const labels = buildLabels({
      knownBy: [{ subscriptionId: "k", holder: { kind: "session", id: "x" }, title: "Thread" }],
      tasks: [{ taskId: "t", title: "Task" }],
      signals: [
        { signalId: "p", kind: "offer", status: "open", title: "Offer" },
        { ...MENTIONED, status: "open" },
      ],
      resolvedSignals: [{ signalId: "e", title: "Old", outcome: "Ok" }],
      ignoredBy: { ruleId: "r", kind: "github/mentioned", text: "Mentioned", ruleDeleted: false },
    });
    expect(labels.map((label) => label.handling)).toEqual([
      "raised-signal",
      "ended-signal",
      "ignored",
      "evidence",
      "on-task",
      "known-work",
    ]);
  });

  it("gives every label a key of its own", () => {
    const labels = buildLabels({
      signals: [
        { ...MENTIONED, signalId: "a", status: "open" },
        { ...MENTIONED, signalId: "b", status: "open" },
      ],
    });
    expect(new Set(labels.map((label) => label.key)).size).toBe(2);
  });
});

describe("cutHandlingLabels", () => {
  const label = (key: string): EventHandlingLabel => ({
    handling: "on-task",
    key,
    lead: key,
    detail: null,
    record: null,
    standing: null,
    target: null,
  });

  it("keeps the first two labels and counts the rest", () => {
    const cut = cutHandlingLabels([label("a"), label("b"), label("c"), label("d")]);
    expect(cut.shown.map((each) => each.key)).toEqual(["a", "b"]);
    expect(cut.more).toBe(2);
  });

  it("counts nothing when there are two or fewer", () => {
    expect(cutHandlingLabels([label("a"), label("b")]).more).toBe(0);
    expect(cutHandlingLabels([label("a")]).shown).toHaveLength(1);
  });
});

describe("EVENT_HANDLING_OPTIONS", () => {
  it("offers every event first, then one caption per handling, never the word handling", () => {
    expect(EVENT_HANDLING_OPTIONS.map((option) => option.handling)).toEqual([
      null,
      ...EVENT_HANDLINGS,
    ]);
    expect(EVENT_HANDLING_OPTIONS[0]!.caption).toBe("All events");
    expect(EVENT_HANDLING_OPTIONS.map((option) => option.caption)).toContain("Ignored by a rule");
    expect(
      EVENT_HANDLING_OPTIONS.some((option) => option.caption.toLowerCase().includes("handling")),
    ).toBe(false);
  });
});

describe("describeHandlingCaption", () => {
  it("gives the caption the filter menu offers the handling by", () => {
    for (const option of EVENT_HANDLING_OPTIONS) {
      if (option.handling !== null) {
        expect(describeHandlingCaption(option.handling)).toBe(option.caption);
      }
    }
  });
});

describe("describeEventHorizon", () => {
  it("counts the days the controller keeps events", () => {
    expect(describeEventHorizon(90)).toBe("Events from the last 90 days");
    expect(describeEventHorizon(1)).toBe("Events from the last day");
  });

  it("reads an unset retention as the default of 90 days", () => {
    expect(describeEventHorizon(undefined)).toBe("Events from the last 90 days");
  });
});

describe("describeEventListEnd", () => {
  it("names the horizon the list stops at", () => {
    expect(describeEventListEnd(90)).toBe("No more events from the last 90 days.");
    expect(describeEventListEnd(1)).toBe("No more events from the last day.");
    expect(describeEventListEnd(undefined)).toBe("No more events from the last 90 days.");
  });
});

describe("computeEventHorizonStart", () => {
  const now = new Date("2026-10-11T08:00:00.000Z");

  it("goes back the retention's days from now", () => {
    expect(computeEventHorizonStart(now, 90)).toBe("2026-07-13T08:00:00.000Z");
    expect(computeEventHorizonStart(now, 1)).toBe("2026-10-10T08:00:00.000Z");
  });

  it("reads an unset retention as the default of 90 days", () => {
    expect(computeEventHorizonStart(now, undefined)).toBe(computeEventHorizonStart(now, 90));
  });
});

describe("groupEventsByDay", () => {
  it("groups events by the date they were received in the user's zone, newest first", () => {
    const now = new Date("2026-10-11T08:00:00.000Z");
    const buildEvent = (id: number, receivedAt: string): EventWithFacts =>
      ({ id, receivedAt, signals: [], resolvedSignals: [], tasks: [], knownBy: [] }) as never;
    const sections = groupEventsByDay(
      [
        buildEvent(4, "2026-10-11T07:00:00.000Z"),
        // 00:30 on Sunday in Amsterdam, though still Saturday in UTC.
        buildEvent(3, "2026-10-10T22:30:00.000Z"),
        buildEvent(2, "2026-10-10T08:00:00.000Z"),
        buildEvent(1, "2026-10-07T08:00:00.000Z"),
      ],
      now,
      "Europe/Amsterdam",
    );
    expect(
      sections.map((section) => [section.label, section.events.map((each) => each.id)]),
    ).toEqual([
      ["Today", [4, 3]],
      ["Yesterday", [2]],
      ["Wednesday", [1]],
    ]);
    expect(sections.map((section) => section.key)).toEqual(["day:0", "day:-1", "day:-4"]);
  });
});

describe("describeEventTitle", () => {
  it("shows the title the source set, or the kind when there is none", () => {
    expect(
      describeEventTitle({ title: "marta requested your review", kind: "github.review" }),
    ).toBe("marta requested your review");
    expect(describeEventTitle({ title: null, kind: "github.issue.opened" })).toBe(
      "github.issue.opened",
    );
  });
});

describe("moveEventSelection", () => {
  const events = [{ id: 9 }, { id: 8 }, { id: 7 }];

  it("steps through the list and stays at either end", () => {
    expect(moveEventSelection(events, 9, 1)).toBe(8);
    expect(moveEventSelection(events, 8, -1)).toBe(9);
    expect(moveEventSelection(events, 7, 1)).toBe(7);
    expect(moveEventSelection(events, 9, -1)).toBe(9);
  });

  it("starts at the first row for J and the last for K when nothing is selected", () => {
    expect(moveEventSelection(events, null, 1)).toBe(9);
    expect(moveEventSelection(events, null, -1)).toBe(7);
    expect(moveEventSelection(events, 42, 1)).toBe(9);
  });

  it("returns null for an empty list", () => {
    expect(moveEventSelection([], null, 1)).toBeNull();
  });
});

describe("describeEventSystem", () => {
  const plugins = [{ id: "github", displayName: "GitHub" }];

  const CONNECTION_ID = "01a06d02-7a00-7000-8000-000000000001";

  it("names a listed plugin by its id and display name", () => {
    expect(describeEventSystem({ source: "github", connectionId: CONNECTION_ID }, plugins)).toEqual(
      { pluginId: "github", name: "GitHub" },
    );
  });

  it("gives a core emitter no plugin id and the core's name", () => {
    expect(describeEventSystem({ source: "cron", connectionId: null }, plugins)).toEqual({
      pluginId: null,
      name: "Hercule",
    });
  });

  it("names a plugin that was removed by its id, because its event came through a Connection", () => {
    expect(describeEventSystem({ source: "jira", connectionId: CONNECTION_ID }, plugins)).toEqual({
      pluginId: "jira",
      name: "jira",
    });
  });
});
