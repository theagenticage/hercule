import { describe, expect, it } from "vitest";
import { SHOW_ALL } from "@hercule/client-core/inbox";
import {
  buildInboxViewKey,
  DEFAULT_INBOX_VIEW,
  readSavedInboxView,
  writeSavedInboxView,
  type SavedInboxView,
} from "./inbox-view-storage";

const KEY = buildInboxViewKey("http://controller.test", "noa");

const store = (value: unknown): void => localStorage.setItem(KEY, JSON.stringify(value));

describe("the saved Inbox view", () => {
  it("reads as the default when nothing is stored", () => {
    expect(readSavedInboxView(KEY)).toEqual(DEFAULT_INBOX_VIEW);
    expect(DEFAULT_INBOX_VIEW.requestsShow).toBe(SHOW_ALL);
  });

  it("returns what was written", () => {
    const view: SavedInboxView = {
      grouping: "linear/project",
      requestsShow: { kind: "person", name: "River" },
      requestsGrouping: "place",
      requestsSort: "newest",
      collapsedGroups: ["a", "b"],
    };
    writeSavedInboxView(KEY, view);

    expect(readSavedInboxView(KEY)).toEqual(view);
  });

  it("does not write the legacy order", () => {
    writeSavedInboxView(KEY, DEFAULT_INBOX_VIEW);

    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).not.toHaveProperty("requestsOrder");
  });

  it("keeps each user's view apart", () => {
    writeSavedInboxView(KEY, { ...DEFAULT_INBOX_VIEW, grouping: "status" });

    expect(readSavedInboxView(buildInboxViewKey("http://controller.test", "river"))).toEqual(
      DEFAULT_INBOX_VIEW,
    );
  });

  it("reads text that is not JSON as the default", () => {
    localStorage.setItem(KEY, "{nope");

    expect(readSavedInboxView(KEY)).toEqual(DEFAULT_INBOX_VIEW);
  });

  it("keeps the good fields when others are malformed", () => {
    store({
      grouping: "status",
      requestsShow: { kind: "everyone" },
      requestsGrouping: "place",
      requestsSort: "sideways",
      collapsedGroups: "a",
    });

    expect(readSavedInboxView(KEY)).toEqual({
      ...DEFAULT_INBOX_VIEW,
      grouping: "status",
      requestsGrouping: "place",
    });
  });

  describe("the Show choice", () => {
    it.each([{ kind: "all" }, { kind: "mine" }, { kind: "person", name: "River" }])(
      "reads %j",
      (show) => {
        store({ requestsShow: show });

        expect(readSavedInboxView(KEY).requestsShow).toEqual(show);
      },
    );

    it.each([
      { kind: "person" },
      { kind: "person", name: "" },
      { kind: "person", name: 4 },
      "mine",
      null,
    ])("reads %j as All", (show) => {
      store({ requestsShow: show });

      expect(readSavedInboxView(KEY).requestsShow).toEqual(SHOW_ALL);
    });
  });

  describe("the folded groups", () => {
    it("keeps only the entries that are text", () => {
      store({ collapsedGroups: ["a", 3, null, "b", {}] });

      expect(readSavedInboxView(KEY).collapsedGroups).toEqual(["a", "b"]);
    });
  });

  describe("the legacy requests order", () => {
    it.each([
      ["oldest", "none", "oldest"],
      ["place", "place", "oldest"],
      ["mine", "none", "oldest"],
    ] as const)(
      "reads %s as grouping %s and sort %s, with Show staying All",
      (order, grouping, sort) => {
        store({ requestsOrder: order });

        expect(readSavedInboxView(KEY)).toEqual({
          ...DEFAULT_INBOX_VIEW,
          requestsGrouping: grouping,
          requestsSort: sort,
        });
      },
    );

    it("reads an unknown order as the default", () => {
      store({ requestsOrder: "newest" });

      expect(readSavedInboxView(KEY)).toEqual(DEFAULT_INBOX_VIEW);
    });

    it("loses to the new fields when they are valid", () => {
      store({ requestsOrder: "place", requestsGrouping: "none", requestsSort: "newest" });

      expect(readSavedInboxView(KEY)).toMatchObject({
        requestsGrouping: "none",
        requestsSort: "newest",
      });
    });

    it("does not consult the legacy order for a new field that is present but invalid", () => {
      store({ requestsOrder: "place", requestsGrouping: "sideways", requestsSort: "random" });

      expect(readSavedInboxView(KEY)).toEqual(DEFAULT_INBOX_VIEW);
    });

    it("migrates from the legacy order when the new fields are absent", () => {
      store({ requestsOrder: "place" });

      expect(readSavedInboxView(KEY)).toMatchObject({
        requestsGrouping: "place",
        requestsSort: "oldest",
      });
    });

    it("fills only the field the new ones lack", () => {
      store({ requestsOrder: "place", requestsSort: "newest" });

      expect(readSavedInboxView(KEY)).toMatchObject({
        requestsGrouping: "place",
        requestsSort: "newest",
      });
    });
  });
});
