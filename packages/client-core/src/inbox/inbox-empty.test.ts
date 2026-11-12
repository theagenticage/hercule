/** Tests which empty state the Inbox shows. */
import { describe, expect, it } from "vitest";
import { buildInboxCounts } from "./cards.testing";
import { decideInboxEmpty } from "./inbox-empty";

const counts = (everything: number, updates: number) =>
  buildInboxCounts({
    savedQueries: [
      { id: "waits", name: "Someone waits on me", order: "waiting", count: 0 },
      { id: "updates", name: "Updates", order: "newest", count: updates },
      { id: "everything", name: "Everything", order: "newest", count: everything },
    ],
  });

describe("decideInboxEmpty", () => {
  it("says nothing matches whenever a search is on, whatever the list", () => {
    expect(
      decideInboxEmpty({ isSearching: true, savedQueryId: "waits", counts: counts(0, 0) }),
    ).toEqual({
      kind: "nothing-matches",
    });
  });

  it("clears the whole Inbox only when nothing is held anywhere", () => {
    expect(
      decideInboxEmpty({ isSearching: false, savedQueryId: "waits", counts: counts(0, 0) }).kind,
    ).toBe("all-clear");
    expect(
      decideInboxEmpty({ isSearching: false, savedQueryId: "waits", counts: counts(4, 2) }),
    ).toEqual({
      kind: "nobody-waits",
      updatesCount: 2,
    });
  });

  it("says another list holds nothing, for a saved query or a Browse value", () => {
    expect(
      decideInboxEmpty({ isSearching: false, savedQueryId: "mine", counts: counts(4, 2) }).kind,
    ).toBe("nothing-in-list");
    expect(
      decideInboxEmpty({ isSearching: false, savedQueryId: null, counts: counts(4, 2) }).kind,
    ).toBe("nothing-in-list");
  });
});
