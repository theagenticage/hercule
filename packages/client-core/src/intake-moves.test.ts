import { DONE_ACTION_ID, type Signal, type SignalResolution } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  applySignalMove,
  buildSnoozeChoices,
  countClearedToday,
  countClearedTodayByPlugin,
  decideSignalPaneMoves,
  decideSignalRowControls,
  describeBulkDoneTitle,
  describeDoneRowOutcome,
  describeIntakeFoot,
  describeMoveToast,
  describeSnoozeLine,
  hasDoneAction,
  isMoveLeavingView,
  listBulkMoves,
  parsePickedSnoozeTime,
  planSignalMove,
  reachesBeforeToday,
  toggleSignalCheck,
} from "./intake-moves";

// Neither zone is the machine's in practice, and Kolkata's half-hour offset
// puts every correct answer on :30 UTC, where a machine-zone bug cannot land.
const KOLKATA = "Asia/Kolkata";
const AMSTERDAM = "Europe/Amsterdam";
const NEW_YORK = "America/New_York";

const DONE_ACTION = { id: DONE_ACTION_ID, label: "Done", operation: null };

/** Builds an open `github/mentioned` signal, which offers Done, with the given fields changed. */
const buildSignal = (id: string, overrides: Partial<Signal> = {}): Signal => ({
  id,
  kind: "github/mentioned",
  origin: {
    type: "event",
    eventId: 1,
    connectionId: "01a06d02-7200-7000-8000-000000000001",
    threadRef: "acme/webshop#1296",
  },
  title: `Signal ${id}`,
  priority: "normal",
  blocks: [],
  actions: [DONE_ACTION],
  match: {},
  status: "open",
  createdAt: "2026-10-10T09:00:00.000Z",
  ...overrides,
});

/** Builds a signal of a core kind that offers no Done. */
const buildCoreSignal = (id: string, kind: "proposal" | "offer" | "unsure"): Signal =>
  buildSignal(id, { kind, actions: [] });

/** Builds a resolved signal, resolved at `at` with the given resolution fields changed. */
const buildResolved = (
  id: string,
  at: string,
  resolution: Partial<SignalResolution> = {},
  overrides: Partial<Signal> = {},
): Signal =>
  buildSignal(id, {
    status: "resolved",
    resolution: {
      kind: "decided",
      actionId: DONE_ACTION_ID,
      outcome: "Done, nothing sent",
      actor: "user",
      origin: "api",
      at,
      ...resolution,
    },
    ...overrides,
  });

const SNOOZE = { until: "2026-10-19T07:00:00.000Z", snoozedAt: "2026-10-12T08:00:00.000Z" };

describe("hasDoneAction", () => {
  it("checks for the core's done action among the signal's actions", () => {
    expect(hasDoneAction(buildSignal("a"))).toBe(true);
    expect(hasDoneAction(buildCoreSignal("b", "proposal"))).toBe(false);
  });
});

describe("decideSignalRowControls", () => {
  it("gives a To do row Snooze and Done when its kind offers Done", () => {
    expect(decideSignalRowControls(buildSignal("a"), "to-do")).toEqual({
      slots: ["snooze", "done"],
      checkable: true,
    });
  });

  it("keeps Done's place empty on a proposal, an offer or an unsure row", () => {
    for (const kind of ["proposal", "offer", "unsure"] as const) {
      expect(decideSignalRowControls(buildCoreSignal("a", kind), "to-do").slots).toEqual([
        "snooze",
        null,
      ]);
    }
  });

  it("adds Not urgent to a Now row, after Done", () => {
    expect(
      decideSignalRowControls(buildSignal("a", { priority: "urgent" }), "to-do").slots,
    ).toEqual(["snooze", "done", "not-urgent"]);
    expect(
      decideSignalRowControls({ ...buildCoreSignal("b", "proposal"), priority: "urgent" }, "to-do")
        .slots,
    ).toEqual(["snooze", null, "not-urgent"]);
  });

  it("gives a row back from a snooze the controls of its kind", () => {
    const back = buildSignal("a", { snooze: SNOOZE });
    expect(decideSignalRowControls(back, "to-do").slots).toEqual(["snooze", "done"]);
  });

  it("gives a Later row Unsnooze, then Done or its empty place", () => {
    expect(decideSignalRowControls(buildSignal("a", { snooze: SNOOZE }), "later")).toEqual({
      slots: ["unsnooze", "done"],
      checkable: true,
    });
    expect(
      decideSignalRowControls({ ...buildCoreSignal("b", "proposal"), snooze: SNOOZE }, "later")
        .slots,
    ).toEqual(["unsnooze", null]);
  });

  it("gives a Done row no controls and no checkbox", () => {
    expect(decideSignalRowControls(buildResolved("a", "2026-10-12T08:00:00.000Z"), "done")).toEqual(
      { slots: [], checkable: false },
    );
  });
});

describe("listBulkMoves", () => {
  it("offers Snooze on To do, and Done when one checked row has it", () => {
    expect(listBulkMoves([buildCoreSignal("a", "proposal")], "to-do")).toEqual(["snooze"]);
    expect(listBulkMoves([buildCoreSignal("a", "proposal"), buildSignal("b")], "to-do")).toEqual([
      "snooze",
      "done",
    ]);
  });

  it("offers Unsnooze and Done on Later, and nothing on Done", () => {
    expect(listBulkMoves([buildSignal("a", { snooze: SNOOZE })], "later")).toEqual([
      "unsnooze",
      "done",
    ]);
    expect(listBulkMoves([buildResolved("a", "2026-10-12T08:00:00.000Z")], "done")).toEqual([]);
  });
});

describe("planSignalMove", () => {
  it("sends Done only for the rows that offer it, and names the kept rows by kind", () => {
    const checked = [
      buildCoreSignal("p1", "proposal"),
      buildSignal("g1"),
      buildCoreSignal("p2", "proposal"),
      buildSignal("g2"),
      buildSignal("g3"),
    ];
    expect(planSignalMove(checked, "done")).toEqual({
      move: "done",
      acted: [checked[1], checked[3], checked[4]],
      keptIds: ["p1", "p2"],
      preview: "Done 3 · keeps 2 proposals",
      keptLabel: "2 proposals",
    });
  });

  it("lists every kept kind, in the order they first appear", () => {
    const checked = [
      buildCoreSignal("o", "offer"),
      buildCoreSignal("p1", "proposal"),
      buildCoreSignal("u", "unsure"),
      buildCoreSignal("p2", "proposal"),
      buildSignal("g"),
    ];
    expect(planSignalMove(checked, "done").preview).toBe(
      "Done 1 · keeps 1 offer, 2 proposals and 1 unsure signal",
    );
  });

  it("acts on every row with Snooze, so the line is only the count", () => {
    const plan = planSignalMove([buildCoreSignal("p", "proposal"), buildSignal("g")], "snooze");
    expect(plan.acted.map((signal) => signal.id)).toEqual(["p", "g"]);
    expect(plan.keptIds).toEqual([]);
    expect(plan.preview).toBe("Snooze 2");
  });

  it("unsnoozes only snoozed rows and lowers only Now rows", () => {
    const snoozed = buildSignal("s", { snooze: SNOOZE });
    expect(planSignalMove([snoozed, buildSignal("o")], "unsnooze").acted).toEqual([snoozed]);
    const plan = planSignalMove(
      [buildSignal("u", { priority: "urgent" }), buildSignal("n")],
      "not-urgent",
    );
    expect(plan.acted.map((signal) => signal.id)).toEqual(["u"]);
    expect(plan.preview).toBe("Not urgent 1 · keeps 1 mentioned");
  });

  it("names a kept plugin kind by its kind's label", () => {
    const plan = planSignalMove(
      [
        buildSignal("u", { priority: "urgent" }),
        buildSignal("r1", { kind: "github/review-requested" }),
        buildSignal("r2", { kind: "github/review-requested" }),
      ],
      "not-urgent",
    );
    expect(plan.keptLabel).toBe("2 review requested");
  });
});

describe("describeBulkDoneTitle", () => {
  it("names the split when Done leaves rows alone", () => {
    const checked = [
      buildSignal("g"),
      buildCoreSignal("p", "proposal"),
      buildCoreSignal("q", "proposal"),
    ];
    expect(describeBulkDoneTitle(planSignalMove(checked, "done"))).toBe(
      "Marks 1 of 3 done. 2 proposals need their own answer",
    );
    expect(describeBulkDoneTitle(planSignalMove(checked.slice(0, 2), "done"))).toBe(
      "Marks 1 of 2 done. 1 proposal needs its own answer",
    );
  });

  it("returns null when Done acts on every row, and for any other move", () => {
    expect(describeBulkDoneTitle(planSignalMove([buildSignal("g")], "done"))).toBeNull();
    expect(
      describeBulkDoneTitle(planSignalMove([buildCoreSignal("p", "proposal")], "snooze")),
    ).toBeNull();
  });
});

describe("decideSignalPaneMoves", () => {
  const moves = (signal: Signal, view: "to-do" | "later" | "done") =>
    decideSignalPaneMoves(signal, view).map((move) => move.label);

  it("offers Snooze… on To do, and Not urgent for a Now signal", () => {
    expect(moves(buildSignal("a"), "to-do")).toEqual(["Snooze…"]);
    expect(moves(buildSignal("a", { priority: "urgent" }), "to-do")).toEqual([
      "Snooze…",
      "Not urgent",
    ]);
  });

  it("offers Unsnooze and Snooze again… on Later", () => {
    expect(moves(buildSignal("a", { snooze: SNOOZE }), "later")).toEqual([
      "Unsnooze",
      "Snooze again…",
    ]);
  });

  it("offers the newer signal for a replaced one, and nothing for any other resolved one", () => {
    const replaced = buildResolved(
      "a",
      "2026-10-12T08:00:00.000Z",
      { kind: "withdrawn", actor: "system" },
      { replacedBy: "01a06d02-7f00-7000-8000-000000000009" },
    );
    expect(decideSignalPaneMoves(replaced, "done").map((move) => move.move)).toEqual([
      "open-newer",
    ]);
    expect(moves(buildResolved("b", "2026-10-12T08:00:00.000Z"), "done")).toEqual([]);
  });
});

describe("isMoveLeavingView and applySignalMove", () => {
  it("takes a signal out of the lists the move leaves, and nowhere else", () => {
    expect(isMoveLeavingView("snooze", "to-do")).toBe(true);
    expect(isMoveLeavingView("snooze", "later")).toBe(false);
    expect(isMoveLeavingView("done", "later")).toBe(true);
    expect(isMoveLeavingView("unsnooze", "later")).toBe(true);
    expect(isMoveLeavingView("unsnooze", "to-do")).toBe(false);
    expect(isMoveLeavingView("not-urgent", "to-do")).toBe(false);
  });

  it("removes only the moved signals, never the ones the server skipped", () => {
    const list = [buildSignal("a"), buildSignal("b"), buildSignal("c")];
    expect(applySignalMove(list, "to-do", "done", ["a", "c"]).map((s) => s.id)).toEqual(["b"]);
  });

  it("lowers the moved Now signals to high after Not urgent", () => {
    const list = [
      buildSignal("a", { priority: "urgent" }),
      buildSignal("b", { priority: "urgent" }),
    ];
    expect(applySignalMove(list, "to-do", "not-urgent", ["a"]).map((s) => s.priority)).toEqual([
      "high",
      "urgent",
    ]);
  });

  it("returns the list itself when the move keeps every signal as it is", () => {
    const list = [buildSignal("a", { snooze: SNOOZE })];
    expect(applySignalMove(list, "later", "snooze", ["a"])).toBe(list);
  });
});

describe("describeMoveToast", () => {
  const one = [buildSignal("a", { priority: "urgent", snooze: SNOOZE })];
  const three = [buildSignal("a"), buildSignal("b"), buildSignal("c")];
  const ids = (signals: ReadonlyArray<Signal>) => signals.map((signal) => signal.id);

  it("names the time a snooze ends, and counts more than one row", () => {
    expect(describeMoveToast(planSignalMove(one, "snooze"), ["a"], "Monday 09:00")).toBe(
      "Snoozed until Monday 09:00",
    );
    expect(describeMoveToast(planSignalMove(three, "snooze"), ids(three), "Monday 09:00")).toBe(
      "Snoozed 3 until Monday 09:00",
    );
  });

  it("names the one signal Done marked, and counts more with what it kept", () => {
    expect(describeMoveToast(planSignalMove(one, "done"), ["a"])).toBe("Done · Signal a");
    const mixed = [...three, buildCoreSignal("p1", "proposal"), buildCoreSignal("p2", "proposal")];
    expect(describeMoveToast(planSignalMove(mixed, "done"), ids(three))).toBe(
      "Marked 3 done. Kept 2 proposals",
    );
  });

  it("counts what the server moved, not what was sent", () => {
    expect(describeMoveToast(planSignalMove(three, "done"), ["a", "c"])).toBe("Marked 2 done");
    expect(describeMoveToast(planSignalMove(three, "unsnooze"), ["b"])).toBe("Back on To do");
  });

  it("says where Unsnooze and Not urgent moved the rows", () => {
    expect(describeMoveToast(planSignalMove(one, "unsnooze"), ["a"])).toBe("Back on To do");
    expect(describeMoveToast(planSignalMove(one, "not-urgent"), ["a"])).toBe("Moved out of Now");
  });
});

describe("buildSnoozeChoices", () => {
  /** Returns the choices built at `now` in `timezone`, as `[label, timeLabel, until, disabled]`. */
  const readChoices = (now: string, timezone: string) =>
    buildSnoozeChoices(new Date(now), timezone).map((choice) => [
      choice.key,
      choice.label,
      choice.timeLabel,
      choice.until,
      choice.disabled,
    ]);

  it("builds the five choices in the user's zone, never the machine's", () => {
    // Tuesday 13 October, 09:30 in Kolkata.
    expect(readChoices("2026-10-13T04:00:00.000Z", KOLKATA)).toEqual([
      [1, "In 1 hour", "10:30", "2026-10-13T05:00:00.000Z", false],
      [2, "This afternoon", "14:00", "2026-10-13T08:30:00.000Z", false],
      [3, "Tomorrow", "Wed 09:00", "2026-10-14T03:30:00.000Z", false],
      [4, "Monday", "Mon 09:00", "2026-10-19T03:30:00.000Z", false],
      [5, "Pick a time…", null, null, false],
    ]);
  });

  it("turns the afternoon into the evening at 13:00, and greys it out from 17:00", () => {
    const second = (now: string) => readChoices(now, KOLKATA)[1];
    expect(second("2026-10-13T07:29:00.000Z")).toEqual([
      2,
      "This afternoon",
      "14:00",
      "2026-10-13T08:30:00.000Z",
      false,
    ]);
    expect(second("2026-10-13T07:30:00.000Z")).toEqual([
      2,
      "This evening",
      "18:00",
      "2026-10-13T12:30:00.000Z",
      false,
    ]);
    expect(second("2026-10-13T11:29:00.000Z")?.[4]).toBe(false);
    expect(second("2026-10-13T11:30:00.000Z")).toEqual([2, "This evening", "18:00", null, true]);
  });

  it("names the day of an hour that runs past midnight", () => {
    // Tuesday 23:30 in Kolkata.
    expect(readChoices("2026-10-13T18:00:00.000Z", KOLKATA)[0]).toEqual([
      1,
      "In 1 hour",
      "Wed 00:30",
      "2026-10-13T19:00:00.000Z",
      false,
    ]);
  });

  it("puts Monday a week ahead on a Monday", () => {
    // Monday 12 October, 10:00 in Amsterdam.
    expect(readChoices("2026-10-12T08:00:00.000Z", AMSTERDAM).slice(2, 4)).toEqual([
      [3, "Tomorrow", "Tue 09:00", "2026-10-13T07:00:00.000Z", false],
      [4, "Monday", "Mon 09:00", "2026-10-19T07:00:00.000Z", false],
    ]);
  });

  it("puts Monday eight days ahead on a Sunday, so it is never the same time as Tomorrow", () => {
    // Sunday 11 October, 10:00 in Amsterdam.
    expect(readChoices("2026-10-11T08:00:00.000Z", AMSTERDAM).slice(2, 4)).toEqual([
      [3, "Tomorrow", "Mon 09:00", "2026-10-12T07:00:00.000Z", false],
      [4, "Monday", "19 Oct 09:00", "2026-10-19T07:00:00.000Z", false],
    ]);
  });

  it("keeps 09:00 on the next day across the night the clocks go forward", () => {
    // Saturday 28 March, 21:00 in Amsterdam; the clocks go forward that night.
    const choices = readChoices("2026-03-28T20:00:00.000Z", AMSTERDAM);
    expect(choices[2]?.[3]).toBe("2026-03-29T07:00:00.000Z");
    expect(choices[3]?.[3]).toBe("2026-03-30T07:00:00.000Z");
    // Saturday 7 March, 18:00 in New York; the clocks go forward that night.
    expect(readChoices("2026-03-07T23:00:00.000Z", NEW_YORK)[2]?.[3]).toBe(
      "2026-03-08T13:00:00.000Z",
    );
  });

  it("disables a choice whose time the clock never reads", () => {
    // Thursday 29 December 2011, 10:00 in Samoa, which skipped the 30th.
    expect(readChoices("2011-12-29T20:00:00.000Z", "Pacific/Apia")[2]).toEqual([
      3,
      "Tomorrow",
      null,
      null,
      true,
    ]);
  });

  it("keeps 09:00 on the next day across the night the clocks go back", () => {
    // Saturday 24 October, 22:00 in Amsterdam; the clocks go back that night.
    expect(readChoices("2026-10-24T20:00:00.000Z", AMSTERDAM)[2]?.[3]).toBe(
      "2026-10-25T08:00:00.000Z",
    );
  });
});

describe("describeSnoozeLine", () => {
  // Tuesday 13 October, 09:30 in Kolkata.
  const now = new Date("2026-10-13T04:00:00.000Z");

  it("names when the snooze was set and when it ends, leaving out today's date", () => {
    const snoozed = buildSignal("a", {
      snooze: { snoozedAt: "2026-10-13T04:14:00.000Z", until: "2026-10-13T08:30:00.000Z" },
    });
    expect(describeSnoozeLine(snoozed, now, KOLKATA, "GitHub")).toBe(
      "Snoozed at 09:44 until today 14:00. Answered on GitHub before then, it goes to Done.",
    );
  });

  it("names another day, and leaves out the source when there is none", () => {
    const snoozed = buildSignal("a", {
      snooze: { snoozedAt: "2026-10-12T10:40:00.000Z", until: "2026-10-19T03:30:00.000Z" },
    });
    expect(describeSnoozeLine(snoozed, now, KOLKATA, null)).toBe(
      "Snoozed yesterday at 16:10 until Monday 09:00.",
    );
    expect(describeSnoozeLine(buildSignal("b"), now, KOLKATA, null)).toBeNull();
  });
});

describe("parsePickedSnoozeTime", () => {
  const now = new Date("2026-10-13T04:00:00.000Z");

  it("converts a wall-clock time in the user's zone to an instant", () => {
    expect(parsePickedSnoozeTime("2026-10-20T09:00", now, KOLKATA)).toBe(
      "2026-10-20T03:30:00.000Z",
    );
  });

  it("returns null for text that is not a time, or a date that does not exist", () => {
    expect(parsePickedSnoozeTime("tomorrow", now, KOLKATA)).toBeNull();
    expect(parsePickedSnoozeTime("2026-02-31T09:00", now, KOLKATA)).toBeNull();
    expect(parsePickedSnoozeTime("2026-10-20T24:00", now, KOLKATA)).toBeNull();
  });

  it("returns null for a time not after now", () => {
    expect(parsePickedSnoozeTime("2026-10-13T09:30", now, KOLKATA)).toBeNull();
    expect(parsePickedSnoozeTime("2026-10-12T12:00", now, KOLKATA)).toBeNull();
  });

  it("returns null for the hour the clocks skip, and the later instant of the hour they repeat", () => {
    const march = new Date("2026-03-01T00:00:00.000Z");
    expect(parsePickedSnoozeTime("2026-03-29T02:30", march, AMSTERDAM)).toBeNull();
    expect(parsePickedSnoozeTime("2026-10-25T02:30", now, AMSTERDAM)).toBe(
      "2026-10-25T01:30:00.000Z",
    );
  });
});

describe("countClearedToday", () => {
  // 00:30 on Tuesday 13 October in Amsterdam, still Monday in UTC.
  const now = new Date("2026-10-12T22:30:00.000Z");

  it("counts the signals resolved since midnight in the user's zone", () => {
    const done = [
      buildResolved("a", "2026-10-12T22:20:00.000Z"),
      buildResolved("b", "2026-10-12T22:10:00.000Z", { kind: "withdrawn", actor: "system" }),
      // 23:30 on Monday in Amsterdam, though the same UTC day as `now`.
      buildResolved("c", "2026-10-12T21:30:00.000Z"),
    ];
    expect(countClearedToday(done, now, AMSTERDAM)).toEqual({ cleared: 2, leftOnTheirOwn: 1 });
  });

  it("counts a decision made on the source as left on its own", () => {
    const done = [
      buildResolved("a", "2026-10-12T22:20:00.000Z", {
        actor: "system",
        origin: "core",
        outcome: "Reviewed on GitHub",
      }),
    ];
    expect(countClearedToday(done, now, AMSTERDAM)).toEqual({ cleared: 1, leftOnTheirOwn: 1 });
  });

  it("does not count a replaced signal", () => {
    const replaced = buildResolved(
      "a",
      "2026-10-12T22:20:00.000Z",
      { kind: "withdrawn", actor: "system", outcome: "Replaced by a newer one" },
      { replacedBy: "01a06d02-7f00-7000-8000-000000000009" },
    );
    expect(countClearedToday([replaced], now, AMSTERDAM)).toEqual({
      cleared: 0,
      leftOnTheirOwn: 0,
    });
  });
});

describe("countClearedTodayByPlugin", () => {
  // 00:30 on Tuesday 13 October in Amsterdam, still Monday in UTC.
  const now = new Date("2026-10-12T22:30:00.000Z");
  const today = "2026-10-12T22:20:00.000Z";

  it("counts each plugin's signals cleared today, in the order the plugins are listed", () => {
    const done = [
      buildResolved("a", today, {}, { kind: "linear/mentioned" }),
      buildResolved("b", today),
      buildResolved("c", today),
      // 23:30 on Monday in Amsterdam: yesterday.
      buildResolved("d", "2026-10-12T21:30:00.000Z", {}, { kind: "linear/mentioned" }),
    ];
    const plugins = [{ id: "sentry" }, { id: "github" }, { id: "linear" }];
    expect(countClearedTodayByPlugin(done, now, AMSTERDAM, plugins)).toEqual([
      { pluginId: "github", cleared: 2 },
      { pluginId: "linear", cleared: 1 },
    ]);
  });

  it("leaves out core and replaced signals, and puts unlisted plugins last, by id", () => {
    const done = [
      buildResolved("a", today, {}, { kind: "slack/mentioned" }),
      buildResolved("b", today, {}, { kind: "proposal" }),
      buildResolved("c", today, {}, { replacedBy: "01a06d02-7f00-7000-8000-000000000009" }),
      buildResolved("d", today, {}, { kind: "linear/mentioned" }),
      buildResolved("e", today, {}, { kind: "github/mentioned" }),
    ];
    expect(countClearedTodayByPlugin(done, now, AMSTERDAM, [{ id: "github" }])).toEqual([
      { pluginId: "github", cleared: 1 },
      { pluginId: "linear", cleared: 1 },
      { pluginId: "slack", cleared: 1 },
    ]);
  });
});

describe("describeIntakeFoot", () => {
  it("names the cleared count, and those left on their own when there are any", () => {
    expect(describeIntakeFoot({ cleared: 7, leftOnTheirOwn: 3 })).toBe(
      "7 cleared today. 3 left on their own: answered elsewhere or withdrawn.",
    );
    expect(describeIntakeFoot({ cleared: 7, leftOnTheirOwn: 0 })).toBe("7 cleared today.");
  });

  it("returns null when nothing was cleared", () => {
    expect(describeIntakeFoot({ cleared: 0, leftOnTheirOwn: 0 })).toBeNull();
  });
});

describe("reachesBeforeToday", () => {
  const now = new Date("2026-10-12T22:30:00.000Z");

  it("checks whether the list holds a signal resolved before midnight in the user's zone", () => {
    const today = buildResolved("a", "2026-10-12T22:20:00.000Z");
    const yesterday = buildResolved("b", "2026-10-12T21:30:00.000Z");
    expect(reachesBeforeToday([today], now, AMSTERDAM)).toBe(false);
    expect(reachesBeforeToday([today, yesterday], now, AMSTERDAM)).toBe(true);
    expect(reachesBeforeToday([], now, AMSTERDAM)).toBe(false);
  });
});

describe("describeDoneRowOutcome", () => {
  it("returns the stored outcome, or the replacement line for a replaced signal", () => {
    expect(describeDoneRowOutcome(buildResolved("a", "2026-10-12T22:20:00.000Z"))).toBe(
      "Done, nothing sent",
    );
    const withdrawn = buildResolved("c", "2026-10-12T22:20:00.000Z", {
      kind: "withdrawn",
      actor: "plugin:github",
      outcome: "Marta removed the request",
    });
    expect(describeDoneRowOutcome(withdrawn)).toBe("Withdrawn · Marta removed the request");
    const replaced = buildResolved(
      "b",
      "2026-10-12T22:20:00.000Z",
      { kind: "withdrawn", actor: "system", outcome: "Superseded" },
      { replacedBy: "01a06d02-7f00-7000-8000-000000000009" },
    );
    expect(describeDoneRowOutcome(replaced)).toBe("Replaced by a newer one");
  });
});

describe("toggleSignalCheck", () => {
  it("checks an unchecked row and unchecks a checked one, leaving the input as it was", () => {
    const checked = new Set(["a"]);
    expect([...toggleSignalCheck(checked, "b")]).toEqual(["a", "b"]);
    expect([...toggleSignalCheck(checked, "a")]).toEqual([]);
    expect([...checked]).toEqual(["a"]);
  });
});
