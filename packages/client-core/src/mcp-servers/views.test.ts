import { describe, expect, it } from "vitest";
import { buildMcpServerViews, describeReconnect } from "./views";
import {
  CONNECTIONS,
  LINEAR,
  OFFERING_PLUGINS,
  SENTRY_HOBBY,
  SENTRY_WORK,
  buildServer,
  buildViews,
} from "./testing";

describe("buildMcpServerViews", () => {
  it("joins each server with its Connection and the name of the Connection's type", () => {
    const [work, hobby, linear] = buildViews([SENTRY_WORK, SENTRY_HOBBY, LINEAR]);

    expect(work).toMatchObject({
      pluginId: "sentry",
      account: "work",
      typeName: "Sentry",
      secondLine: "Sentry Connection · 2 tools",
    });
    expect(hobby).toMatchObject({ account: "hobby", typeName: "Sentry" });
    expect(linear).toMatchObject({ pluginId: "linear", account: "acme", typeName: "Linear" });
  });

  it("says '1 tool' for one tool, and gives no count before the first check", () => {
    const [one, unchecked] = buildViews([
      buildServer("s-1", "sentry", "c-work", { tools: [{ name: "a", description: "" }] }),
      buildServer("s-2", "sentry", "c-hobby", { tools: [], checkedAt: null, status: "checking" }),
    ]);

    expect(one?.secondLine).toBe("Sentry Connection · 1 tool");
    expect(unchecked?.secondLine).toBe("Sentry Connection");
  });

  it("reads each status as its word, and only needs-sign-in, unreachable and error as failing", () => {
    const views = buildViews(
      (["ready", "checking", "needs-sign-in", "unreachable", "error"] as const).map((status) =>
        buildServer(`s-${status}`, "sentry", "c-work", {
          status,
          statusDetail: `detail ${status}`,
        }),
      ),
    );

    expect(
      views.map((view) => [view.displayStatus, view.statusWord, view.failing, view.statusDetail]),
    ).toEqual([
      ["ready", "ready", false, null],
      ["checking", "checking", false, null],
      ["needs-sign-in", "needs sign-in", true, "detail needs-sign-in"],
      ["unreachable", "unreachable", true, "detail unreachable"],
      ["error", "error", true, "detail error"],
    ]);
  });

  it("reads a switched-off server as off whatever its status was, and not as failing", () => {
    const [view] = buildViews([
      buildServer("s-off", "sentry", "c-work", { enabled: false, status: "needs-sign-in" }),
    ]);

    expect(view).toMatchObject({
      displayStatus: "off",
      statusWord: "off",
      failing: false,
      statusDetail: null,
    });
  });

  it("keeps a server whose Connection is not in the list, with no account", () => {
    const [view] = buildMcpServerViews(
      [SENTRY_WORK],
      CONNECTIONS.filter((connection) => connection.id !== "c-work"),
      OFFERING_PLUGINS,
    );

    expect(view).toMatchObject({ connection: undefined, account: undefined, typeName: "Sentry" });
  });
});

describe("describeReconnect", () => {
  it("names the Connection to reconnect, with its type and label", () => {
    const [view] = buildViews([SENTRY_WORK]);

    expect(describeReconnect(view!)).toEqual({
      connectionId: "c-work",
      label: "Reconnect Sentry · work",
    });
  });

  it("returns null for a server whose Connection is not in the list", () => {
    const [view] = buildMcpServerViews([SENTRY_WORK], [], OFFERING_PLUGINS);

    expect(describeReconnect(view!)).toBeNull();
  });
});
