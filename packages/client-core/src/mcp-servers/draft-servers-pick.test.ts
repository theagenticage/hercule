import { describe, expect, it } from "vitest";
import type { ThreadPicks } from "../threads/config";
import { applyThreadChoice } from "../threads/thread-choice";
import { buildProject } from "../threads/workspaces.testing";
import { decideDraftServersPick } from "./draft-servers-pick";
import { LINEAR, SENTRY_HOBBY, SENTRY_WORK } from "./testing";

// Raw records only: no Connection, plugin or display data is joined to them.
const SERVERS = [SENTRY_WORK, SENTRY_HOBBY, LINEAR];
const WEBSHOP = { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-work"] };
const DECIDE = {
  projectId: "p-shop",
  ids: ["s-linear"],
  servers: SERVERS,
  project: { kind: "read", value: WEBSHOP },
  defaultIds: { kind: "read", value: [] },
} as const;

/** Records `choice` in `picks`, as the draft's store does when the user presses. */
const record = (
  picks: ThreadPicks,
  choice: ReturnType<typeof decideDraftServersPick>,
): ThreadPicks => (choice === undefined ? picks : applyThreadChoice(picks, choice));

describe("decideDraftServersPick", () => {
  it("records the new list, with the project it was made under", () => {
    const choice = decideDraftServersPick({
      ...DECIDE,
      choice: { kind: "name", name: "sentry", serverId: "s-work", shownServerId: "s-work" },
    });

    expect(record({}, choice)).toEqual({
      mcpServers: { projectId: "p-shop", mcpServerIds: ["s-linear", "s-work"] },
    });
  });

  it("records nothing for a choice that changes nothing", () => {
    const choice = decideDraftServersPick({
      ...DECIDE,
      choice: { kind: "name", name: "linear", serverId: "s-linear", shownServerId: "s-linear" },
    });

    expect(record({}, choice)).toEqual({});
  });

  it("keeps both of two choices recorded before the screen draws again", () => {
    // Both are decided from the list the screen shows, ["s-linear"].
    const addWork = decideDraftServersPick({
      ...DECIDE,
      choice: { kind: "name", name: "sentry", serverId: "s-work", shownServerId: "s-work" },
    });
    const dropLinear = decideDraftServersPick({
      ...DECIDE,
      choice: { kind: "name", name: "linear", serverId: null, shownServerId: "s-linear" },
    });

    expect(record(record({}, addWork), dropLinear)).toEqual({
      mcpServers: { projectId: "p-shop", mcpServerIds: ["s-work"] },
    });
  });

  it("applies a choice to the pick the draft holds, not to the list it showed", () => {
    const choice = decideDraftServersPick({
      ...DECIDE,
      choice: { kind: "name", name: "linear", serverId: null, shownServerId: "s-linear" },
    });
    const held: ThreadPicks = {
      mcpServers: { projectId: "p-shop", mcpServerIds: ["s-work", "s-linear"] },
    };

    expect(record(held, choice).mcpServers?.mcpServerIds).toEqual(["s-work"]);
  });

  it("forgets the pick on a reset, so a later change to the start list shows", () => {
    const held: ThreadPicks = {
      options: { effort: "max" },
      mcpServers: { projectId: "p-shop", mcpServerIds: ["s-work"] },
    };
    const choice = decideDraftServersPick({ ...DECIDE, choice: { kind: "reset" } });

    expect(record(held, choice)).toEqual({ options: { effort: "max" } });
  });

  it("resets even while the start list holds a server the catalogue does not know, since nothing is written", () => {
    const held: ThreadPicks = { mcpServers: { projectId: "p-shop", mcpServerIds: ["s-linear"] } };
    const choice = decideDraftServersPick({
      ...DECIDE,
      project: { kind: "read", value: { ...WEBSHOP, mcpServerIds: ["s-work", "s-unknown"] } },
      choice: { kind: "reset" },
    });

    expect(record(held, choice)).toEqual({});
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
    const choice = decideDraftServersPick({
      ...DECIDE,
      ids: ["s-hobby"],
      choice: { kind: "name", name: "sentry", serverId: null, shownServerId: "s-work" },
    });

    expect(record({}, choice)).toEqual({});
  });
});
