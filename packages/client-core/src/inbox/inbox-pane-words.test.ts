import { describe, expect, it } from "vitest";
import { buildInboxAsk, buildInboxThing } from "./cards.testing";
import {
  describeAnswerFailure,
  describeAnswerSending,
  describeAnswerSent,
  describeAnswerTooLate,
  describeDismissalReturn,
  describeHeldAnswer,
  describeHolderStrip,
  describeInterruptedAnswer,
} from "./inbox-pane-words";

const NOW = new Date("2026-11-12T09:00:00.000Z");
const DISMISSED = "2026-11-11T08:00:00.000Z";
const after = "2026-11-12T01:00:00.000Z";

describe("describeHeldAnswer", () => {
  it("says what is done and that it sends in 8s", () => {
    expect(
      describeHeldAnswer({ label: "Approve", identifier: "ENG-1", sourceName: "GitHub" }),
    ).toEqual({ text: "Approve ENG-1 on GitHub", note: "Sends in 8s" });
  });

  it("names who a typed reply goes to", () => {
    expect(
      describeHeldAnswer({
        label: "Reply",
        identifier: "ENG-1",
        sourceName: "GitHub",
        replyTo: "Mei",
      }).text,
    ).toBe("Reply sent to Mei on GitHub");
  });
});

describe("the sent, too late and failed lines", () => {
  it("name the source they were given", () => {
    expect(describeAnswerSent("Linear")).toBe("Sent to Linear.");
    expect(describeAnswerTooLate("Linear")).toBe(
      "Already sent to Linear, so it can’t be taken back here. Answer again on Linear if it needs changing.",
    );
    expect(describeAnswerSending("Linear")).toBe(
      "It is being sent to Linear, so it can't be taken back here.",
    );
    expect(
      describeAnswerFailure(
        { label: "Approve", identifier: "ENG-1", sourceName: "Linear" },
        "no access",
      ),
    ).toBe("Approve ENG-1 was not sent to Linear: no access. Try again.");
  });
});

describe("describeInterruptedAnswer", () => {
  it("tells apart an answer that never left from one that may have", () => {
    expect(describeInterruptedAnswer("before-sending", "GitHub")).toBe(
      "Not sent: the app closed before it was sent.",
    );
    expect(describeInterruptedAnswer("while-sending", "GitHub")).toBe(
      "The app closed while it was being sent; it may have reached GitHub.",
    );
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
