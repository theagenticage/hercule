/** Tests which moves of the Inbox are refused, and what the undo line says about the rest. */
import { MAX_INBOX_MOVED_THINGS } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { NO_OFFERS } from "./card-hand-off";
import { buildInboxAsk, buildInboxThing, buildWorkflowOffer } from "./cards.testing";
import {
  buildHandedThing,
  describeInboxDismissal,
  describeInboxDismissalFailure,
  describeInboxHandOff,
  describeInboxTakeOn,
  planInboxMove,
} from "./inbox-moves";

const thing = buildInboxThing("1", { title: "Cache delivery slot lookups" });
const held = buildInboxThing("2", { taskId: "t-1" });
const online = { isOffline: false, offers: NO_OFFERS } as const;
const oneOffer = { available: [buildWorkflowOffer("Review PR", [])], unavailable: [] };

const reasonOf = (plan: ReturnType<typeof planInboxMove>): string =>
  plan.kind === "refuse" ? plan.reason : "";

describe("planInboxMove", () => {
  it("lets Dismiss take a selection, and refuses past the most one call takes, saying how many", () => {
    expect(planInboxMove({ move: "dismiss", things: [thing, held], ...online }).kind).toBe("go");
    const many = Array.from({ length: MAX_INBOX_MOVED_THINGS + 1 }, (_, n) =>
      buildInboxThing(String(n)),
    );
    expect(reasonOf(planInboxMove({ move: "dismiss", things: many, ...online }))).toBe(
      "Dismiss takes up to 1,000 things at once, and 1,001 are selected. Select fewer, then press E again.",
    );
  });

  it("refuses Take on and the hand-off for a selection, and says what to do instead", () => {
    expect(reasonOf(planInboxMove({ move: "takeOn", things: [thing, held], ...online }))).toContain(
      "Press Esc to clear the selection",
    );
    expect(
      reasonOf(
        planInboxMove({ move: "handOff", things: [thing, held], ...online, offers: oneOffer }),
      ),
    ).toContain("Hand-off takes one thing at a time");
  });

  it("refuses Take on for a thing a Task holds, naming who has it", () => {
    expect(reasonOf(planInboxMove({ move: "takeOn", things: [held], ...online }))).toBe(
      "You have this already. G goes to its Task.",
    );
    const handed = buildInboxThing("3", {
      taskId: "t-2",
      liveWorkflows: [{ workflowId: "w", name: "Review PR" }],
    });
    expect(reasonOf(planInboxMove({ move: "takeOn", things: [handed], ...online }))).toBe(
      "Review PR has this already. G goes to its Task.",
    );
  });

  it("hands a thing a workflow can take, even one a Task holds, and refuses one none can take", () => {
    expect(
      planInboxMove({ move: "handOff", things: [held], ...online, offers: oneOffer }).kind,
    ).toBe("go");
    expect(reasonOf(planInboxMove({ move: "handOff", things: [thing], ...online }))).toBe(
      "No workflow can take this ticket yet.",
    );
  });

  it("refuses Go to its Task for a thing with no Task, and lets it go for one with a Task", () => {
    expect(reasonOf(planInboxMove({ move: "goToTask", things: [thing], ...online }))).toBe(
      "This has no Task yet. T takes it on.",
    );
    expect(planInboxMove({ move: "goToTask", things: [held], ...online }).kind).toBe("go");
  });

  it("refuses every move but Go to its Task while offline", () => {
    for (const move of ["dismiss", "takeOn", "handOff"] as const) {
      expect(
        reasonOf(planInboxMove({ move, things: [thing], isOffline: true, offers: oneOffer })),
      ).toContain("You are offline");
    }
    expect(
      planInboxMove({ move: "goToTask", things: [held], isOffline: true, offers: NO_OFFERS }).kind,
    ).toBe("go");
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
});
