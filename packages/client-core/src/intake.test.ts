import type { Signal, SignalAction } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  buildIntakeTabs,
  buildSignalAnswers,
  countToDo,
  describeAnswerKey,
  describeBuildFailure,
  describeHerculeSegment,
  describeResolvedElsewhere,
  describeSignalAsker,
  describeSignalOutcome,
  describeSignalProvenance,
  describeSignalRow,
  findReplyAnswer,
  findSuggestedAnswer,
  groupSignalsIntoSections,
  isBackFromSnooze,
  listUrgentSignals,
  moveSignalSelection,
  nameSignalKind,
  nameSignalSource,
  readSignalPluginId,
} from "./intake";

const PLUGINS = [
  { id: "github", displayName: "GitHub" },
  { id: "slack", displayName: "Slack" },
];

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

describe("readSignalPluginId", () => {
  it("returns the plugin before the slash of a plugin kind", () => {
    expect(readSignalPluginId("github/review-requested")).toBe("github");
  });

  it("returns null for a core kind", () => {
    expect(readSignalPluginId("proposal")).toBeNull();
  });
});

describe("nameSignalKind", () => {
  it("makes a plugin kind's word into a label", () => {
    expect(nameSignalKind("github/mentioned")).toBe("Mentioned");
    expect(nameSignalKind("github/review-requested")).toBe("Review requested");
  });

  it("labels the core kinds by hand", () => {
    expect(nameSignalKind("proposal")).toBe("Proposal");
    expect(nameSignalKind("fyi")).toBe("FYI");
    expect(nameSignalKind("unsure")).toBe("Unsure");
  });
});

describe("nameSignalSource", () => {
  it("names a plugin kind's plugin, or its id when the plugin is not listed", () => {
    expect(nameSignalSource(buildSignal("a"), PLUGINS)).toBe("GitHub");
    expect(nameSignalSource(buildSignal("a", { kind: "jira/assigned" }), PLUGINS)).toBe("jira");
  });

  it("names who raised a core signal", () => {
    const raisedBy = (actor: string) =>
      nameSignalSource(
        buildSignal("a", {
          kind: "proposal",
          origin: { type: "api", actor, eventIds: [], reason: "r" },
        }),
        PLUGINS,
      );
    expect(raisedBy("user")).toBe("You");
    expect(raisedBy("system")).toBe("Hercule");
    expect(raisedBy("plugin:slack")).toBe("Slack");
    expect(raisedBy("run:01a06d02-7300-7000-8000-000000000001")).toBe("A workflow");
    expect(raisedBy("session:01a06d02-7300-7000-8000-000000000001")).toBe("An agent");
  });

  it("names Hercule for a core kind raised from an event", () => {
    expect(nameSignalSource(buildSignal("a", { kind: "fyi" }), PLUGINS)).toBe("Hercule");
  });
});

describe("describeSignalProvenance", () => {
  it("joins the source and the kind's label", () => {
    expect(describeSignalProvenance(buildSignal("a"), PLUGINS)).toBe("GitHub · Mentioned");
    expect(
      describeSignalProvenance(buildSignal("a", { kind: "proposal", origin: fromUser() }), PLUGINS),
    ).toBe("You · Proposal");
  });
});

describe("countToDo and describeHerculeSegment", () => {
  const signals = [
    buildSignal("a"),
    buildSignal("b", { kind: "slack/mentioned" }),
    buildSignal("c", { kind: "proposal", origin: fromUser() }),
  ];

  it("counts every signal for All, core signals included, and a plugin's own for its tab", () => {
    expect(countToDo(signals, null)).toBe(3);
    expect(countToDo(signals, "github")).toBe(1);
  });

  it("names the count in the segment's accessible name, and leaves it out at zero", () => {
    expect(describeHerculeSegment(8)).toBe("Hercule, 8 to do");
    expect(describeHerculeSegment(0)).toBe("Hercule");
  });
});

describe("buildIntakeTabs", () => {
  it("lists All, then each plugin with a signal, in the plugins' order, never core signals", () => {
    const tabs = buildIntakeTabs(
      [
        buildSignal("a", { kind: "slack/mentioned" }),
        buildSignal("b"),
        buildSignal("c"),
        buildSignal("d", { kind: "proposal", origin: fromUser() }),
      ],
      PLUGINS,
      null,
    );
    expect(tabs).toEqual([
      { pluginId: null, label: "All", count: 4 },
      { pluginId: "github", label: "GitHub", count: 2 },
      { pluginId: "slack", label: "Slack", count: 1 },
    ]);
  });

  it("keeps the selected plugin's tab while it holds nothing", () => {
    expect(buildIntakeTabs([], PLUGINS, "slack")).toEqual([
      { pluginId: null, label: "All", count: 0 },
      { pluginId: "slack", label: "Slack", count: 0 },
    ]);
  });

  it("gives an unlisted plugin a tab named by its id, after the listed ones", () => {
    const tabs = buildIntakeTabs(
      [buildSignal("a", { kind: "jira/assigned" }), buildSignal("b")],
      PLUGINS,
      null,
    );
    expect(tabs.map((tab) => tab.label)).toEqual(["All", "GitHub", "jira"]);
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
      ),
    ).toBe("Marta · review requested · acme/webshop#1296");
  });

  it("names a core signal's source when it has no asker", () => {
    expect(
      describeSignalRow(buildSignal("a", { kind: "proposal", origin: fromUser() }), PLUGINS),
    ).toBe("You · proposal");
  });

  it("leaves the kind out of an unsure row, which carries its own label", () => {
    expect(
      describeSignalRow(
        buildSignal("a", { kind: "unsure", origin: fromUser(), place: "#ops" }),
        PLUGINS,
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
      ),
    ).toBe("GitHub couldn't draw this signal. Showing the event as it came in.");
    expect(describeBuildFailure(buildSignal("a"), PLUGINS)).toBeNull();
  });
});

describe("buildSignalAnswers", () => {
  const signal = buildSignal("a", {
    actions: [
      action("done", { label: "Done", operation: null }),
      action("hand", { label: "Hand to Bugfix", operation: { op: "run.start", input: {} } }),
      action("approve", { primary: true }),
      action("reply", { label: "Reply…", field: { name: "body", placeholder: "Write a reply" } }),
      action("dismiss", { label: "Dismiss", operation: null }),
    ],
  });
  const answers = buildSignalAnswers(signal);

  it("orders the actions the plugin gave, then Hand to an agent, then Done", () => {
    expect(answers.map((answer) => answer.action.id)).toEqual([
      "approve",
      "reply",
      "dismiss",
      "hand",
      "done",
    ]);
  });

  it("styles each answer by what it does", () => {
    expect(answers.map((answer) => answer.style)).toEqual([
      "plain",
      "reply",
      "quiet",
      "plain",
      "done",
    ]);
  });

  it("finds the primary action as the suggested answer, and the first text box", () => {
    expect(findSuggestedAnswer(answers)?.action.id).toBe("approve");
    expect(findReplyAnswer(answers)?.action.id).toBe("reply");
    expect(findSuggestedAnswer(buildSignalAnswers(buildSignal("b")))).toBeUndefined();
  });

  it("names what the foot's keys do", () => {
    expect(describeAnswerKey(answers[0]!, "↩")).toBe("approve");
    expect(describeAnswerKey(answers[1]!, "R")).toBe("reply");
    expect(describeAnswerKey(answers[1]!, "↩")).toBe("write the reply");
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
    expect(describeSignalOutcome(resolved("user", "withdrawn"), PLUGINS)?.label).toBe(
      "Left on its own",
    );
  });

  it("says the signal was resolved elsewhere, how and by whom", () => {
    expect(describeResolvedElsewhere(resolved("plugin:github"), PLUGINS)).toBe(
      "Resolved elsewhere: approved #1293, by GitHub",
    );
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
