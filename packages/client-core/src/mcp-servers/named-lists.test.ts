import { describe, expect, it } from "vitest";
import { chooseNamedServer, groupServersByName } from "./named-lists";
import { LINEAR, SENTRY_HOBBY, SENTRY_WORK, buildViews } from "./testing";

// The controller lists servers by name, so the two Sentry accounts are adjacent.
const VIEWS = buildViews([LINEAR, SENTRY_WORK, SENTRY_HOBBY]);

describe("groupServersByName", () => {
  it("groups the accounts of one name, sorted by account label, in the order the names first appear", () => {
    expect(
      groupServersByName(VIEWS).map((group) => [
        group.name,
        group.views.map((view) => view.server.id),
      ]),
    ).toEqual([
      ["linear", ["s-linear"]],
      ["sentry", ["s-hobby", "s-work"]],
    ]);
  });
});

describe("chooseNamedServer", () => {
  it("switches a name on with the chosen account", () => {
    expect(chooseNamedServer(["s-linear"], VIEWS, "sentry", "s-work")).toEqual([
      "s-linear",
      "s-work",
    ]);
  });

  it("swaps the account of a name in one list, in the old one's place, never holding both", () => {
    expect(chooseNamedServer(["s-work", "s-linear"], VIEWS, "sentry", "s-hobby")).toEqual([
      "s-hobby",
      "s-linear",
    ]);
    expect(chooseNamedServer(["s-linear", "s-work"], VIEWS, "sentry", "s-hobby")).toEqual([
      "s-linear",
      "s-hobby",
    ]);
  });

  it("switches a name off with null, and keeps the other names", () => {
    expect(chooseNamedServer(["s-work", "s-linear"], VIEWS, "sentry", null)).toEqual(["s-linear"]);
  });

  it("keeps ids no view knows, so a write never erases a server the catalogue has not read yet", () => {
    expect(chooseNamedServer(["s-new", "s-linear"], VIEWS, "sentry", "s-work")).toEqual([
      "s-new",
      "s-linear",
      "s-work",
    ]);
    expect(chooseNamedServer(["s-new", "s-work"], VIEWS, "sentry", null)).toEqual(["s-new"]);
    expect(chooseNamedServer(["s-new", "s-work"], VIEWS, "sentry", "s-hobby")).toEqual([
      "s-new",
      "s-hobby",
    ]);
  });

  it("returns the list unchanged, not switched off, when the server is not one of that name", () => {
    expect(chooseNamedServer(["s-work"], VIEWS, "sentry", "s-linear")).toEqual(["s-work"]);
    expect(chooseNamedServer(["s-work"], VIEWS, "sentry", "s-gone")).toEqual(["s-work"]);
  });

  it("never holds two servers of one name, even from a list that already did", () => {
    expect(
      chooseNamedServer(["s-work", "s-linear", "s-hobby"], VIEWS, "sentry", "s-hobby"),
    ).toEqual(["s-hobby", "s-linear"]);
  });
});
