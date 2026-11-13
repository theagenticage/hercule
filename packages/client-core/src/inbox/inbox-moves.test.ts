/** Tests which moves of the Inbox are refused, and what the undo line says about the rest. */
import { MAX_INBOX_MOVED_THINGS, MAX_TASK_TITLE_LENGTH, type InboxThing } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { NO_OFFERS } from "./card-hand-off";
import { buildInboxAsk, buildInboxThing, buildWorkflowOffer } from "./cards.testing";
import {
  buildGroupLinkEnd,
  buildHandedThing,
  buildLinkPairs,
  describeInboxLinkFailure,
  describeInboxTargetDismissal,
  describeInboxUnlinkFailure,
  didTakeOnTogetherChange,
  findSingleThing,
  listTargetThings,
  buildTakeOnTogether,
  describeInboxDismissal,
  describeInboxGroupDismissal,
  describeInboxLink,
  describeInboxTakeOnTogether,
  describeInboxTakeOnTogetherUndone,
  TAKE_ON_UNDONE,
  describeInboxUnlink,
  type InboxMoveTarget,
  describeInboxDismissalFailure,
  describeInboxHandOff,
  describeInboxTakeOn,
  planInboxMove,
} from "./inbox-moves";

const thing = buildInboxThing("1", { title: "Cache delivery slot lookups" });
const held = buildInboxThing("2", { taskId: "t-1", takenOn: true });
const online = { isOffline: false, offers: NO_OFFERS } as const;
const oneOffer = { available: [buildWorkflowOffer("Review PR", [])], unavailable: [] };

const reasonOf = (plan: ReturnType<typeof planInboxMove>): string =>
  plan.kind === "refuse" ? plan.reason : "";

const one = (row: InboxThing): InboxMoveTarget => ({ kind: "thing", row, groupMemberRefs: [] });
const selection = (...rows: InboxThing[]): InboxMoveTarget => ({ kind: "selection", rows });
const groupOf = (
  count: number,
  overrides: Partial<Extract<InboxMoveTarget, { kind: "group" }>> = {},
): InboxMoveTarget => {
  const members = Array.from({ length: count }, (_, n) => ({
    id: `id-${n}`,
    ref: `acme:ticket:${n}`,
    matches: true,
  }));
  return {
    kind: "group",
    labelRef: "acme:ticket:1",
    label: "Checkout is slow",
    members,
    rows: [],
    size: count,
    isFresh: false,
    ...overrides,
  };
};

describe("planInboxMove", () => {
  it("lets Dismiss take a thing or a selection, and refuses past the most one call takes, saying how many", () => {
    expect(planInboxMove({ move: "dismiss", target: one(thing), ...online }).kind).toBe("go");
    expect(planInboxMove({ move: "dismiss", target: selection(thing, held), ...online }).kind).toBe(
      "go",
    );
    const many = Array.from({ length: MAX_INBOX_MOVED_THINGS + 1 }, (_, n) =>
      buildInboxThing(String(n)),
    );
    expect(
      reasonOf(planInboxMove({ move: "dismiss", target: selection(...many), ...online })),
    ).toBe(
      "Dismiss takes up to 1,000 things at once, and 1,001 are selected. Select fewer, then press E again.",
    );
  });

  it("lets Dismiss take a whole group", () => {
    expect(planInboxMove({ move: "dismiss", target: groupOf(3), ...online }).kind).toBe("go");
  });

  it("refuses Dismiss on a group of more than the most one call takes, and says what to do instead", () => {
    const reason = reasonOf(
      planInboxMove({
        move: "dismiss",
        target: groupOf(MAX_INBOX_MOVED_THINGS, { size: 1_400 }),
        ...online,
      }),
    );

    expect(reason).toBe(
      "This group has 1,400 things, and Dismiss takes up to 1,000 at once. Open the group, select some of its things, then press E.",
    );
  });

  it("refuses Dismiss on a group that came under the keys a moment ago, and says E again dismisses all", () => {
    expect(
      reasonOf(
        planInboxMove({ move: "dismiss", target: groupOf(3, { isFresh: true }), ...online }),
      ),
    ).toBe("The group “Checkout is slow” is under the keys now. E again dismisses all 3.");
  });

  it("makes one Task for a group or a selection, and refuses a group too large to name its things", () => {
    expect(planInboxMove({ move: "takeOn", target: groupOf(3), ...online }).kind).toBe("go");
    expect(planInboxMove({ move: "takeOn", target: selection(thing, held), ...online }).kind).toBe(
      "go",
    );
    expect(
      reasonOf(
        planInboxMove({
          move: "takeOn",
          target: groupOf(MAX_INBOX_MOVED_THINGS, { size: 1_001 }),
          ...online,
        }),
      ),
    ).toContain("Take on takes up to 1,000 at once");
  });

  it("treats a selection of one row as that row", () => {
    expect(reasonOf(planInboxMove({ move: "takeOn", target: selection(held), ...online }))).toBe(
      "You have this already. G goes to its Task.",
    );
  });

  it("refuses the hand-off for a group or a selection, and says what to do instead", () => {
    expect(
      reasonOf(
        planInboxMove({
          move: "handOff",
          target: selection(thing, held),
          ...online,
          offers: oneOffer,
        }),
      ),
    ).toBe(
      "Hand-off takes one thing at a time. Press Esc to clear the selection, then H on the thing you want.",
    );
    expect(
      reasonOf(planInboxMove({ move: "handOff", target: groupOf(3), ...online, offers: oneOffer })),
    ).toBe("Hand-off takes one thing at a time. Open the group and pick one.");
  });

  it("lets Take on join a Task the user did not take on, such as a signal's", () => {
    const signalsTask = buildInboxThing("4", { taskId: "t-3", takenOn: false });

    expect(planInboxMove({ move: "takeOn", target: one(signalsTask), ...online }).kind).toBe("go");
  });

  it("refuses Take on for a thing the user took on, naming who has it", () => {
    expect(reasonOf(planInboxMove({ move: "takeOn", target: one(held), ...online }))).toBe(
      "You have this already. G goes to its Task.",
    );
    const handed = buildInboxThing("3", {
      taskId: "t-2",
      takenOn: true,
      liveWorkflows: [{ workflowId: "w", name: "Review PR" }],
    });
    expect(reasonOf(planInboxMove({ move: "takeOn", target: one(handed), ...online }))).toBe(
      "Review PR has this already. G goes to its Task.",
    );
  });

  it("hands a thing a workflow can take, even one a Task holds, and refuses one none can take", () => {
    expect(
      planInboxMove({ move: "handOff", target: one(held), ...online, offers: oneOffer }).kind,
    ).toBe("go");
    expect(reasonOf(planInboxMove({ move: "handOff", target: one(thing), ...online }))).toBe(
      "No workflow can take this ticket yet.",
    );
  });

  it("refuses Go to its Task for a thing with no Task, and lets it go for one with a Task", () => {
    expect(reasonOf(planInboxMove({ move: "goToTask", target: one(thing), ...online }))).toBe(
      "This has no Task yet. T takes it on.",
    );
    expect(planInboxMove({ move: "goToTask", target: one(held), ...online }).kind).toBe("go");
    expect(reasonOf(planInboxMove({ move: "goToTask", target: groupOf(3), ...online }))).toBe(
      "Go to its Task takes one thing at a time.",
    );
  });

  it("links a selection of two or more, and asks the screen to pick for one thing, one selected thing or a group", () => {
    expect(planInboxMove({ move: "link", target: selection(thing, held), ...online })).toEqual({
      kind: "go",
    });
    for (const target of [one(thing), selection(thing), groupOf(3)]) {
      expect(planInboxMove({ move: "link", target, ...online })).toEqual({ kind: "pick" });
    }
  });

  it("refuses Link when nothing is selected to link", () => {
    expect(reasonOf(planInboxMove({ move: "link", target: selection(), ...online }))).toBe(
      "There is nothing selected to link. Select two or more with X, then press L.",
    );
  });

  it("refuses every move but Go to its Task while offline", () => {
    for (const move of ["dismiss", "takeOn", "handOff", "link"] as const) {
      expect(
        reasonOf(planInboxMove({ move, target: one(thing), isOffline: true, offers: oneOffer })),
      ).toContain("You are offline");
    }
    expect(
      planInboxMove({ move: "goToTask", target: one(held), isOffline: true, offers: NO_OFFERS })
        .kind,
    ).toBe("go");
  });
});

describe("buildTakeOnTogether", () => {
  it("lists the label's thing first for a group, and titles the Task with the group's label", () => {
    expect(buildTakeOnTogether(groupOf(3))).toEqual({
      ids: ["id-1", "id-0", "id-2"],
      title: "Checkout is slow",
    });
  });

  it("cuts a title to the longest a Task takes", () => {
    const title = buildTakeOnTogether(groupOf(2, { label: "x".repeat(600) }))?.title;

    expect(title).toHaveLength(MAX_TASK_TITLE_LENGTH);
  });

  it("lists a selection's rows in order and titles the Task with the first row's title", () => {
    expect(buildTakeOnTogether(selection(thing, held))).toEqual({
      ids: [thing.id, held.id],
      title: "Cache delivery slot lookups",
    });
  });

  it("answers null for one thing and for a selection of one", () => {
    expect(buildTakeOnTogether(one(thing))).toBeNull();
    expect(buildTakeOnTogether(selection(thing))).toBeNull();
  });
});

describe("buildLinkPairs", () => {
  it("links the first row to each of the others", () => {
    const third = buildInboxThing("3");

    expect(buildLinkPairs(selection(thing, held, third))).toEqual([
      { fromRef: thing.ref, toRef: held.ref },
      { fromRef: thing.ref, toRef: third.ref },
    ]);
  });

  it("has no pair for a thing, a group or a selection of one", () => {
    for (const target of [one(thing), groupOf(3), selection(thing)])
      expect(buildLinkPairs(target)).toEqual([]);
  });
});

describe("what the undo line says", () => {
  it("puts the title last for one thing, and counts several", () => {
    expect(describeInboxDismissal([thing])).toEqual({
      text: "Dismissed",
      title: "Cache delivery slot lookups",
    });
    expect(describeInboxDismissal([thing, held])).toEqual({
      text: "Dismissed 2 things",
      title: null,
    });
    expect(describeInboxHandOff(thing, "Review PR")).toEqual({
      text: "Handed to Review PR",
      title: "Cache delivery slot lookups",
    });
  });

  it("says a Take on that made no Task made none", () => {
    expect(describeInboxTakeOn(thing, true).text).toBe("Took on, a Task on Work");
    expect(describeInboxTakeOn(thing, false).text).toContain("no new one was made");
  });

  it("says why a dismissal failed and that the things are back", () => {
    expect(describeInboxDismissalFailure([thing, held], "the controller is busy")).toBe(
      "2 things were not dismissed, so they are back: the controller is busy. Try again.",
    );
  });
});

describe("the undo line for linking, groups and take on together", () => {
  it("names a dismissed group, and how many of its things were not in the list", () => {
    const target = (matches: boolean[]) =>
      groupOf(matches.length, {
        members: matches.map((m, n) => ({ id: `id-${n}`, ref: `acme:ticket:${n}`, matches: m })),
      }) as Extract<InboxMoveTarget, { kind: "group" }>;
    expect(describeInboxGroupDismissal(target([true, true, true, true, true])).text).toBe(
      "Dismissed the group “Checkout is slow”: 5 things",
    );
    expect(describeInboxGroupDismissal(target([true, true, true, false, false])).text).toBe(
      "Dismissed the group “Checkout is slow”: 5 things, 2 of them not in this list",
    );
  });

  const shop = buildInboxThing("1", { identifier: "SHOP-150" });
  const pr = buildInboxThing("2", { identifier: "#6251" });
  const bare = buildInboxThing("3", { identifier: "", title: "No identifier here" });

  it("says what a link did by identifiers, falls back to the quoted title, and says a repeat changed nothing", () => {
    expect(describeInboxLink([shop, pr], true)).toEqual({
      text: "Linked",
      title: "SHOP-150 and #6251",
    });
    expect(describeInboxLink([shop, bare], true).title).toBe("SHOP-150 and “No identifier here”");
    expect(describeInboxLink([shop, pr, bare], true).text).toBe("Linked 3 things");
    expect(describeInboxLink([shop, pr], false).text).toBe("These are linked already.");
  });

  it("says what an unlink did, and that the source still links the pair", () => {
    expect(describeInboxUnlink(shop, pr, { removed: true })).toEqual({
      text: "Unlinked",
      title: "SHOP-150 and #6251",
    });
    expect(describeInboxUnlink(shop, pr, { removed: true, remaining: "source" }).text).toBe(
      "Unlinked, but the source still links them",
    );
    expect(describeInboxUnlink(shop, pr, { removed: false }).text).toBe(
      "You had not linked these, so nothing changed",
    );
  });

  it("says what undoing a take on together did", () => {
    expect(describeInboxTakeOnTogetherUndone(true)).toBe(TAKE_ON_UNDONE);
    expect(describeInboxTakeOnTogetherUndone(false)).toBe("Taken back off the Task.");
  });

  it("says whether a take on together made the Task or joined one, with the title last", () => {
    const made = { created: true, added: ["a", "b"], taken: ["a", "b"] };
    const joined = { created: false, added: ["b"], taken: ["a", "b"] };
    expect(describeInboxTakeOnTogether("Checkout is slow", made)).toEqual({
      text: "Took on, a Task on Work",
      title: "Checkout is slow",
    });
    expect(describeInboxTakeOnTogether("Checkout is slow", joined).text).toBe(
      "Added to its Task on Work",
    );
  });

  it("says a take on together that changed nothing is on its Task already, with nothing to undo", () => {
    const nothing = { created: false, added: [], taken: [] };
    expect(didTakeOnTogetherChange(nothing)).toBe(false);
    expect(describeInboxTakeOnTogether("Checkout is slow", nothing).text).toBe(
      "Already on its Task on Work, so nothing changed",
    );
    expect(didTakeOnTogetherChange({ ...nothing, taken: ["a"] })).toBe(true);
  });
});

describe("reading a target", () => {
  it("finds the one thing of a thing or of a selection of one, and none for a group or several", () => {
    expect(findSingleThing(one(thing))).toBe(thing);
    expect(findSingleThing(selection(thing))).toBe(thing);
    expect(findSingleThing(selection(thing, held))).toBeUndefined();
    expect(findSingleThing(selection())).toBeUndefined();
    expect(findSingleThing(groupOf(3))).toBeUndefined();
  });

  it("lists the things a target stands for", () => {
    expect(listTargetThings(one(thing))).toEqual([thing]);
    expect(listTargetThings(selection(thing, held))).toEqual([thing, held]);
    expect(listTargetThings(groupOf(3, { rows: [thing] }))).toEqual([thing]);
  });

  it("words a dismissal by the kind of target", () => {
    expect(describeInboxTargetDismissal(one(thing))).toEqual({
      text: "Dismissed",
      title: "Cache delivery slot lookups",
    });
    expect(describeInboxTargetDismissal(groupOf(3)).text).toContain("Dismissed the group");
  });

  it("names a group as one end of a link by its label, with no identifier", () => {
    expect(buildGroupLinkEnd({ labelRef: "acme:ticket:1", label: "Checkout is slow" })).toEqual({
      ref: "acme:ticket:1",
      identifier: "",
      title: "Checkout is slow",
    });
  });

  it("words link and unlink failures with one full stop before the advice", () => {
    expect(describeInboxLinkFailure("the controller is busy")).toBe(
      "The link did not save: the controller is busy. Try again.",
    );
    expect(describeInboxUnlinkFailure("the controller is busy")).toBe(
      "The link was not removed: the controller is busy. Try again.",
    );
  });
});

describe("buildHandedThing", () => {
  const asking = buildInboxThing("4", {
    asks: [buildInboxAsk("a1")],
    askCount: 1,
    askKinds: ["acme/review-requested"],
    waitingSince: "2026-11-01T09:00:00.000Z",
  });

  it("takes the asks the workflow answers away, so the thing no longer waits and the workflow has it", () => {
    const handed = buildHandedThing(
      asking,
      buildWorkflowOffer("Review PR", ["acme/review-requested"]),
    );

    expect(handed.asks).toEqual([]);
    expect(handed.askCount).toBe(0);
    expect(handed.waitingSince).toBeUndefined();
    expect(handed.liveWorkflows.map((workflow) => workflow.name)).toEqual(["Review PR"]);
  });

  it("keeps the asks the workflow does not answer, and the wait they hold", () => {
    const handed = buildHandedThing(
      asking,
      buildWorkflowOffer("Repair the build", ["acme/failed"]),
    );

    expect(handed.asks).toHaveLength(1);
    expect(handed.waitingSince).toBe(asking.waitingSince);
    expect(handed.liveWorkflows.map((workflow) => workflow.name)).toEqual(["Repair the build"]);
  });

  it("counts the asks that stay and takes the wait from the oldest of them", () => {
    const thing = buildInboxThing("5", {
      asks: [
        buildInboxAsk("a1", "Mei", { kind: "acme/failed", createdAt: "2026-11-03T09:00:00.000Z" }),
        buildInboxAsk("a2", "Mei", {
          kind: "acme/review-requested",
          createdAt: "2026-11-02T09:00:00.000Z",
        }),
      ],
      askCount: 2,
      askKinds: ["acme/failed", "acme/review-requested"],
      waitingSince: "2026-11-02T09:00:00.000Z",
    });
    const handed = buildHandedThing(
      thing,
      buildWorkflowOffer("Review PR", ["acme/review-requested"]),
    );

    expect(handed.askCount).toBe(1);
    expect(handed.waitingSince).toBe("2026-11-03T09:00:00.000Z");
  });

  it("keeps the wait when older asks are not listed, and lowers the count by what it saw end", () => {
    const thing = buildInboxThing("6", {
      asks: [buildInboxAsk("a1", "Mei", { kind: "acme/review-requested" })],
      askCount: 4,
      askKinds: ["acme/failed", "acme/review-requested"],
      waitingSince: "2026-11-01T09:00:00.000Z",
    });
    const handed = buildHandedThing(
      thing,
      buildWorkflowOffer("Review PR", ["acme/review-requested"]),
    );

    expect(handed.askCount).toBe(3);
    expect(handed.waitingSince).toBe("2026-11-01T09:00:00.000Z");
  });
});
