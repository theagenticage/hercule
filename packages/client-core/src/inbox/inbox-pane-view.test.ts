/** Tests what the pane draws besides its asks: the meta line, the linked things and what happened. */
import { describe, expect, it } from "vitest";
import { buildFakeInboxDetail, buildInboxThing } from "./cards.testing";
import { describePaneMeta, listPaneHistory, listPaneLinks } from "./inbox-pane-view";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const detail = buildFakeInboxDetail(buildInboxThing("1"));

describe("describePaneMeta", () => {
  const words = (items: ReturnType<typeof describePaneMeta>): string[] =>
    items.flatMap((item) => (item.kind === "words" ? [item.words] : []));

  it("says an assigned thing is assigned to the user, and when it last changed", () => {
    const assigned: typeof detail = {
      ...detail,
      concerns: ["assigned"],
      sourceUpdatedAt: "2026-11-07T10:00:00.000Z",
    };
    expect(words(describePaneMeta(assigned, { now: NOW }))).toEqual([
      "Assigned to you",
      "Updated 2 hours ago",
    ]);
  });

  it("names the person of a thing that is not the user's", () => {
    const theirs: typeof detail = {
      ...detail,
      concerns: ["review-requested"],
      person: { name: "Mei" },
      sourceUpdatedAt: "2026-11-07T11:59:30.000Z",
    };
    expect(words(describePaneMeta(theirs, { now: NOW }))).toEqual(["Mei’s", "Updated just now"]);
  });

  it("leaves out the priority bars, which only the open card draws", () => {
    const urgent: typeof detail = { ...detail, facts: [{ form: "bars", level: 2 }] };
    expect(describePaneMeta(urgent, { now: NOW }).some((item) => item.kind === "fact")).toBe(false);
  });

  it("adds the account and the dismissal words after the record's own items", () => {
    const items = describePaneMeta(detail, {
      now: NOW,
      account: "northwind-bot",
      dismissalReturn: "Dismissed 1d ago",
    });
    expect(items.slice(-2)).toEqual([
      { kind: "words", words: "in northwind-bot" },
      { kind: "words", words: "Dismissed 1d ago" },
    ]);
  });

  it("adds neither account nor dismissal words when there are none", () => {
    expect(words(describePaneMeta(detail, { now: NOW }))).toEqual([
      expect.stringMatching(/^Updated /),
    ]);
  });
});

describe("listPaneHistory", () => {
  it("lists what changed at the source newest first, with each time as an age", () => {
    const lines = listPaneHistory(
      {
        timeline: [
          {
            reason: "moved",
            at: "2026-11-07T09:00:00.000Z",
            sentence: { say: "Moved to Doing", tone: "plain" },
          },
          {
            reason: "reassigned",
            at: "2026-11-07T11:00:00.000Z",
            sentence: { say: "Reassigned to Mei", tone: "plain" },
          },
        ],
      },
      NOW,
    );
    expect(lines).toEqual([
      { when: "1h", sentence: "Reassigned to Mei" },
      { when: "3h", sentence: "Moved to Doing" },
    ]);
  });
});

describe("listPaneLinks", () => {
  it("has no links for a thing nothing links to", () => {
    expect(listPaneLinks(detail, [])).toEqual([]);
  });
});
