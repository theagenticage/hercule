import { describe, expect, it } from "vitest";
import { buildProject } from "../threads/workspaces.testing";
import { decideDraftServersPick } from "./draft-servers-pick";
import { LINEAR, SENTRY_HOBBY, SENTRY_WORK, buildViews } from "./testing";

const VIEWS = buildViews([SENTRY_WORK, SENTRY_HOBBY, LINEAR]);
const WEBSHOP = { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-work"] };
const DECIDE = {
  projectId: "p-shop",
  ids: ["s-linear"],
  views: VIEWS,
  project: { kind: "read", value: WEBSHOP },
  defaultIds: { kind: "read", value: [] },
} as const;

describe("decideDraftServersPick", () => {
  it("records the new list, with the project it was made under", () => {
    expect(
      decideDraftServersPick({
        ...DECIDE,
        choice: { kind: "name", name: "sentry", serverId: "s-work", shownServerId: "s-work" },
      }),
    ).toEqual({
      kind: "mcpServers",
      projectId: "p-shop",
      mcpServerIds: ["s-linear", "s-work"],
    });
  });

  it("records nothing for a choice that changes nothing", () => {
    expect(
      decideDraftServersPick({
        ...DECIDE,
        choice: { kind: "name", name: "linear", serverId: "s-linear", shownServerId: "s-linear" },
      }),
    ).toBeUndefined();
  });

  it("goes back to the list the draft starts from, by the same rules as a started thread", () => {
    expect(decideDraftServersPick({ ...DECIDE, choice: { kind: "reset" } })).toEqual({
      kind: "mcpServers",
      projectId: "p-shop",
      mcpServerIds: ["s-work"],
    });
  });

  it("does not reset while where the list started is not read, or the project is gone", () => {
    expect(
      decideDraftServersPick({
        ...DECIDE,
        project: { kind: "pending" },
        choice: { kind: "reset" },
      }),
    ).toBeUndefined();
    expect(
      decideDraftServersPick({
        ...DECIDE,
        project: { kind: "missing" },
        choice: { kind: "reset" },
      }),
    ).toBeUndefined();
  });

  it("refuses a swap over an account the draft's list holds that the control did not show", () => {
    expect(
      decideDraftServersPick({
        ...DECIDE,
        ids: ["s-hobby"],
        choice: { kind: "name", name: "sentry", serverId: null, shownServerId: "s-work" },
      }),
    ).toBeUndefined();
  });
});
