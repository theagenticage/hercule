import type { Signal, SignalAction } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTAKE_LIST_WIDTH,
  MIN_INTAKE_LIST_WIDTH,
  MIN_INTAKE_PANE_WIDTH,
  buildInitials,
  buildIntakeTabs,
  buildSignalAnswers,
  countToDo,
  decidePluginMark,
  describeAnswerKey,
  describeBuildFailure,
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
  groupSignalsByDay,
  groupSignalsIntoSections,
  isBackFromSnooze,
  listUrgentSignals,
  moveSignalSelection,
  nameSignalSource,
  parseIntakeListWidth,
  parseSignalPluginId,
  trimAnswerEllipsis,
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

describe("parseSignalPluginId", () => {
  it("returns the plugin before the slash of a plugin kind", () => {
    expect(parseSignalPluginId("github/review-requested")).toBe("github");
  });

  it("returns null for a core kind", () => {
    expect(parseSignalPluginId("proposal")).toBeNull();
  });
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
  it("lists All, then each plugin with a signal, in the plugins' order, never core signals", () => {
    const { tabs } = buildIntakeTabs(
      [
        buildSignal("a", { kind: "slack/mentioned" }),
        buildSignal("b"),
        buildSignal("c"),
        buildSignal("d", { kind: "proposal", origin: fromUser() }),
      ],
      PLUGINS,
      new Set(),
    );
    expect(tabs).toEqual([
      { pluginId: null, label: "All", count: 4 },
      { pluginId: "github", label: "GitHub", count: 2 },
      { pluginId: "slack", label: "Slack", count: 1 },
    ]);
  });

  it("keeps a plugin's tab after its last signal leaves", () => {
    const first = buildIntakeTabs(
      [buildSignal("a", { kind: "slack/mentioned" })],
      PLUGINS,
      new Set(),
    );
    const later = buildIntakeTabs([buildSignal("b")], PLUGINS, first.seenSourceIds);
    expect(later.tabs).toEqual([
      { pluginId: null, label: "All", count: 1 },
      { pluginId: "github", label: "GitHub", count: 1 },
      { pluginId: "slack", label: "Slack", count: 0 },
    ]);
  });

  it("returns the same seen set when no new plugin appears, so the caller stores nothing", () => {
    const seen = new Set(["github"]);
    expect(buildIntakeTabs([buildSignal("a")], PLUGINS, seen).seenSourceIds).toBe(seen);
    expect(buildIntakeTabs([], PLUGINS, seen).seenSourceIds).toBe(seen);
  });

  it("gives an unlisted plugin a tab named by its id, after the listed ones", () => {
    const { tabs } = buildIntakeTabs(
      [buildSignal("a", { kind: "jira/assigned" }), buildSignal("b")],
      PLUGINS,
      new Set(),
    );
    expect(tabs.map((tab) => tab.label)).toEqual(["All", "GitHub", "jira"]);
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

  it("gives a Hand to an agent answer the workflow it starts, and no other answer one", () => {
    const workflowId = "01a0ec64-6e80-7000-8000-0000000000f8";
    const [handOff] = buildSignalAnswers(
      buildSignal("b", {
        actions: [
          action(`hand-to-${workflowId}`, {
            operation: { op: "run.start", input: { workflowId, inputs: { signal: "b" } } },
          }),
        ],
      }),
    );
    expect(handOff?.workflowId).toBe(workflowId);
    expect(answers.every((answer) => answer.workflowId === null)).toBe(true);
  });

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
