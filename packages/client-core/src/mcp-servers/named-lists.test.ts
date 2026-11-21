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

  it("drops ids no view knows, such as a server deleted since", () => {
    expect(chooseNamedServer(["s-gone", "s-linear"], VIEWS, "sentry", "s-work")).toEqual([
      "s-linear",
      "s-work",
    ]);
  });

  it("leaves the name off when the server is not one of that name", () => {
    expect(chooseNamedServer(["s-linear"], VIEWS, "sentry", "s-linear")).toEqual(["s-linear"]);
  });
});
