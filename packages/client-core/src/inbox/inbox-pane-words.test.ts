import { describe, expect, it } from "vitest";
import { buildInboxAsk, buildInboxThing } from "./cards.testing";
import {
  describeAnswerFailure,
  describeAnswerSending,
  describeAnswerSent,
  describeAnswerTooLate,
  describeDismissAll,
  describeDismissalReturn,
  describeHandOff,
  describeHandOffLabel,
  describeDoneEffect,
  describeHeldSignalAnswer,
  describeHiddenAsks,
  describeHolderStrip,
  describeMarkedDone,
  describeSelectedThings,
  describeUnreadable,
  describeUnsentSignalAnswer,
} from "./inbox-pane-words";

const NOW = new Date("2026-11-12T09:00:00.000Z");
const DISMISSED = "2026-11-11T08:00:00.000Z";
const after = "2026-11-12T01:00:00.000Z";

describe("describeHeldSignalAnswer", () => {
  it("says what is done and that it sends in 8s", () => {
    expect(
      describeHeldSignalAnswer({ label: "Approve", identifier: "ENG-1", sourceName: "GitHub" }),
    ).toEqual({ text: "Approve ENG-1 on GitHub", note: "Sends in 8s" });
  });

  it("names who a typed reply goes to", () => {
    expect(
      describeHeldSignalAnswer({
        label: "Reply",
        identifier: "ENG-1",
        sourceName: "GitHub",
        replyTo: "Mei",
      }).text,
    ).toBe("Reply to Mei on GitHub");
  });
});

describe("the sent, too late and failed lines", () => {
  it("name the source they were given", () => {
    expect(describeAnswerSent("Linear")).toBe("Sent to Linear.");
    expect(describeAnswerTooLate("Linear")).toBe(
      "Already sent to Linear, so it can’t be taken back here. Answer again on Linear if it needs changing.",
    );
    expect(describeAnswerSending("Linear")).toBe(
      "It is being sent to Linear, so it can’t be taken back here.",
    );
    expect(
      describeAnswerFailure(
        { label: "Approve", identifier: "ENG-1", sourceName: "Linear" },
        "no access",
      ),
    ).toBe("Approve ENG-1 was not sent to Linear: no access. Try again.");
  });
});

describe("describeUnsentSignalAnswer", () => {
  const answer = { label: "Approve", identifier: "ENG-1", sourceName: "GitHub" };

  it("tells apart an answer that never left from one that may have", () => {
    expect(describeUnsentSignalAnswer(answer, { reason: "interrupted", message: "" })).toBe(
      "The app closed before it was sent.",
    );
    expect(
      describeUnsentSignalAnswer(answer, { reason: "interrupted-while-sending", message: "" }),
    ).toBe("The app closed while it was being sent, so it may have been sent.");
  });

  it("carries the message of a failed send", () => {
    expect(
      describeUnsentSignalAnswer(answer, { reason: "send-failed", message: "no access" }),
    ).toBe("Approve ENG-1 was not sent to GitHub: no access. Try again.");
  });
});

describe("describeDismissalReturn", () => {
  const thing = (
    asks: ReturnType<typeof buildInboxAsk>[],
    dismissedAt: string | null = DISMISSED,
  ) => buildInboxThing("1", { asks, ...(dismissedAt === null ? {} : { dismissedAt }) });
  const mention = (asker: string | null, createdAt: string) =>
    buildInboxAsk(`m-${asker ?? "system"}`, asker, { noun: "mention", createdAt });

  it("returns nothing for a thing never dismissed", () => {
    expect(describeDismissalReturn(thing([mention("Kwame", after)], null), NOW)).toBeUndefined();
  });

  it("names the one ask raised after the dismissal", () => {
    expect(describeDismissalReturn(thing([mention("Kwame", after)]), NOW)).toBe(
      "Dismissed 1 day ago, back for Kwame’s mention",
    );
  });

  it("ignores asks that were open at the dismissal", () => {
    const asks = [mention("Kwame", after), mention("Omar", "2026-11-10T00:00:00.000Z")];
    expect(describeDismissalReturn(thing(asks), NOW)).toBe(
      "Dismissed 1 day ago, back for Kwame’s mention",
    );
  });

  it("joins several, oldest first, and names a system ask without an asker", () => {
    const asks = [
      mention(null, "2026-11-12T03:00:00.000Z"),
      mention("Kwame", "2026-11-12T01:00:00.000Z"),
      mention("Omar", "2026-11-12T02:00:00.000Z"),
    ];
    expect(describeDismissalReturn(thing(asks), NOW)).toBe(
      "Dismissed 1 day ago, back for Kwame’s mention, Omar’s mention and the mention",
    );
    expect(describeDismissalReturn(thing(asks.slice(0, 2)), NOW)).toBe(
      "Dismissed 1 day ago, back for Kwame’s mention and the mention",
    );
  });

  it("says only when it was dismissed when no listed ask came after", () => {
    expect(describeDismissalReturn(thing([]), NOW)).toBe("Dismissed 1 day ago");
  });
});

describe("describeHolderStrip", () => {
  it.each([
    ["the user's own Task", { liveWorkflows: [], takenOn: true }, "Your Task"],
    [
      "a live workflow",
      { liveWorkflows: [{ workflowId: "w", name: "Review PR" }], takenOn: true },
      "Review PR has it",
    ],
    ["nobody", { liveWorkflows: [], takenOn: false }, undefined],
  ])("reads %s", (_name, thing, expected) => {
    expect(describeHolderStrip(thing)).toBe(expected);
  });
});

describe("the lines of the pane's other moments", () => {
  it("name the source Done does not tell", () => {
    expect(describeDoneEffect("GitHub")).toBe("Ends this ask here. GitHub is not told.");
    expect(describeMarkedDone("GitHub")).toBe(
      "Marked done. GitHub was not told, and it can’t be undone here.",
    );
  });

  it("count the hidden asks without calling them asks", () => {
    expect(describeHiddenAsks(3)).toBe("3 more");
  });

  it("count the selected things", () => {
    expect(describeSelectedThings(1)).toBe("1 thing selected");
    expect(describeSelectedThings(4)).toBe("4 things selected");
  });

  it("name the button that dismisses a selection", () => {
    expect(describeDismissAll(3)).toBe("Dismiss all 3");
  });

  it("name the hand-off button for one workflow and for several", () => {
    const one = { kind: "one", name: "Triage", faceSeed: "w1" } as const;
    const several = { kind: "several", faceSeeds: ["w1", "w2"] } as const;
    expect(describeHandOff(one)).toBe("Hand to Triage");
    expect(describeHandOffLabel(one)).toBe("Triage");
    expect(describeHandOff(several)).toBe("Hand to…");
    expect(describeHandOffLabel(several)).toBe("Hand to…");
  });

  it("say why a part could not be read", () => {
    expect(describeUnreadable("ask", "The runner is away.")).toBe(
      "This ask could not be read. The runner is away.",
    );
  });
});
