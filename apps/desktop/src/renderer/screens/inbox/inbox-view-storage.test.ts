import { describe, expect, it } from "vitest";
import {
  buildInboxViewKey,
  DEFAULT_INBOX_VIEW,
  readSavedInboxView,
  writeSavedInboxView,
} from "./inbox-view-storage";

const KEY = buildInboxViewKey("http://controller.test", "noa");

describe("the saved Inbox view", () => {
  it("reads as the default when nothing is stored", () => {
    expect(readSavedInboxView(KEY)).toEqual(DEFAULT_INBOX_VIEW);
  });

  it("returns what was written", () => {
    const view = { grouping: "linear/project", requestsOrder: "mine" } as const;
    writeSavedInboxView(KEY, view);

    expect(readSavedInboxView(KEY)).toEqual(view);
  });

  it("keeps each user's view apart", () => {
    writeSavedInboxView(KEY, { grouping: "status", requestsOrder: "place" });

    expect(readSavedInboxView(buildInboxViewKey("http://controller.test", "river"))).toEqual(
      DEFAULT_INBOX_VIEW,
    );
  });

  it("reads text that is not JSON as the default", () => {
    localStorage.setItem(KEY, "{nope");

    expect(readSavedInboxView(KEY)).toEqual(DEFAULT_INBOX_VIEW);
  });

  it("keeps the good field when the other is malformed", () => {
    localStorage.setItem(KEY, JSON.stringify({ grouping: "status", requestsOrder: "newest" }));

    expect(readSavedInboxView(KEY)).toEqual({ grouping: "status", requestsOrder: "oldest" });
  });
});
