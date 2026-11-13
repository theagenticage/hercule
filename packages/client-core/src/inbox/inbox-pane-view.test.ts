/** Tests what the pane draws besides its asks: the meta line, the linked things and what happened. */
import { describe, expect, it } from "vitest";
import { buildFakeInboxDetail, buildInboxThing } from "./cards.testing";
import { describePaneMeta, listPaneHistory, listPaneLinks } from "./inbox-pane-view";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const detail = buildFakeInboxDetail(buildInboxThing("1"));

describe("describePaneMeta", () => {
  it("adds the account and the dismissal words after the record's own items", () => {
    const items = describePaneMeta(detail, {
      account: "northwind-bot",
      dismissalReturn: "Dismissed 1d ago",
    });
    expect(items.slice(-2)).toEqual([
      { kind: "words", words: "in northwind-bot" },
      { kind: "words", words: "Dismissed 1d ago" },
    ]);
  });

  it("adds nothing for a thing with no account to name and no dismissal", () => {
    expect(describePaneMeta(detail, {}).some((item) => item.kind === "words")).toBe(false);
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
