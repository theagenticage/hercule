import { describe, expect, it } from "vitest";
import type { McpServer } from "@hercule/contract";
import {
  buildMcpServerViews,
  describeConnectionRowProblem,
  describeReconnect,
  describeRemoveEffect,
  describeServerPageFields,
  describeSignInRow,
  describeSourceChip,
  isCheckDisabled,
} from "./views";
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

  it("gives a server added by URL no plugin and its whole address as its account", () => {
    const [view] = buildViews([
      buildServer("s-url", "docs", "", {
        source: {
          kind: "url",
          url: "https://mcp.docs.example.com/v1",
          signIn: "none",
          signInOffered: null,
        },
      }),
    ]);

    expect(view).toMatchObject({
      pluginId: null,
      connection: undefined,
      account: "https://mcp.docs.example.com/v1",
      typeName: "",
      secondLine: "https://mcp.docs.example.com/v1 · 2 tools",
    });
  });

  it("writes the address of a server added by URL whole, and gives no count before the first check", () => {
    const [checked, unchecked] = buildViews(
      [
        { tools: [{ name: "a", description: "" }] },
        { tools: [], checkedAt: null, status: "checking" as const },
      ].map((overrides, index) =>
        buildServer(`s-${String(index)}`, "docs", "", {
          source: {
            kind: "url",
            url: "https://docs.example.com:8443/mcp?team=a",
            signIn: "token",
            signInOffered: null,
          },
          ...overrides,
        }),
      ),
    );

    expect(checked?.secondLine).toBe("https://docs.example.com:8443/mcp?team=a · 1 tool");
    expect(unchecked?.secondLine).toBe("https://docs.example.com:8443/mcp?team=a");
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

describe("isCheckDisabled", () => {
  it.each([
    ["checking", true],
    ["off", true],
    ["ready", false],
    ["needs-sign-in", false],
    ["unreachable", false],
    ["error", false],
  ] as const)("for a server that is %s is %s", (displayStatus, disabled) => {
    const status = displayStatus === "off" ? "ready" : displayStatus;
    const [view] = buildViews([{ ...SENTRY_WORK, status, enabled: displayStatus !== "off" }]);

    expect(isCheckDisabled(view!)).toBe(disabled);
  });
});

describe("describeConnectionRowProblem", () => {
  it("returns the short word, not the sentence, for a server that needs sign-in", () => {
    const [view] = buildViews([
      { ...SENTRY_WORK, status: "needs-sign-in", statusDetail: "revoked 09:12" },
    ]);

    expect(describeConnectionRowProblem(view!)).toBe("needs sign-in");
  });

  it("returns null for a server that does not need sign-in", () => {
    const [view] = buildViews([{ ...SENTRY_WORK, status: "unreachable" }]);

    expect(describeConnectionRowProblem(view!)).toBeNull();
  });
});

const URL_SERVER = (overrides: Partial<McpServer> = {}) =>
  buildServer("s-docs", "docs", "", {
    source: {
      kind: "url",
      url: "https://docs.example.com/mcp",
      signIn: "token",
      signInOffered: "token",
    },
    ...overrides,
  });

describe("the page of a server added by URL", () => {
  it("is chipped by its source", () => {
    const [url, plugin] = buildViews([URL_SERVER(), SENTRY_WORK]);

    expect(describeSourceChip(url!)).toBe("Added by URL");
    expect(describeSourceChip(plugin!)).toBe("From the Sentry plugin");
    expect(describeSourceChip(plugin!, "Sentry for teams")).toBe(
      "From the Sentry for teams plugin",
    );
  });

  it("shows its whole address and no account beside the name", () => {
    const [url] = buildViews([URL_SERVER()]);

    expect(describeServerPageFields(url!, OFFERING_PLUGINS)).toEqual({
      address: "https://docs.example.com/mcp",
      account: null,
    });
  });

  it("shows a plugin's server with the host its plugin offers and its Connection's label as the account", () => {
    const [plugin] = buildViews([SENTRY_WORK]);

    expect(describeServerPageFields(plugin!, OFFERING_PLUGINS)).toEqual({
      address: "mcp.sentry.example",
      account: "work",
    });
  });

  it("shows no address for a plugin's server whose plugin no longer offers it, and no account without its Connection", () => {
    const orphan = buildViews([SENTRY_WORK])[0]!;

    expect(describeServerPageFields({ ...orphan, account: undefined }, [])).toEqual({
      address: null,
      account: null,
    });
  });

  it("says what removing it takes along", () => {
    const [url, plugin] = buildViews([URL_SERVER(), SENTRY_WORK]);

    expect(describeRemoveEffect(url!)).toBe(
      "Deletes the server and its sign-in. Projects that name it stop naming it.",
    );
    expect(describeRemoveEffect(plugin!)).toBe(
      "Deletes the server. Projects that name it stop naming it. The Connection Sentry · work stays.",
    );
  });

  it("shows a Sign-in row with Replace token… or Sign in again… only while the server holds a sign-in and works", () => {
    const row = (server: McpServer) => describeSignInRow(buildViews([server])[0]!);

    expect(row(URL_SERVER())).toEqual({
      value: "A token",
      action: { kind: "replace-token", label: "Replace token…" },
    });
    expect(row(URL_SERVER({ status: "unreachable" }))?.action).not.toBeNull();
    // The band holds the one button while the server needs sign-in.
    expect(row(URL_SERVER({ status: "needs-sign-in" }))).toEqual({
      value: "A token",
      action: null,
    });
    expect(
      row(
        URL_SERVER({
          source: {
            kind: "url",
            url: "https://a.example/mcp",
            signIn: "none",
            signInOffered: null,
          },
        }),
      ),
    ).toEqual({ value: "None needed", action: null });
    expect(
      row(
        URL_SERVER({
          source: {
            kind: "url",
            url: "https://a.example/mcp",
            signIn: "oauth",
            signInOffered: "oauth",
          },
        }),
      ),
    ).toEqual({ value: "OAuth", action: { kind: "sign-in-again", label: "Sign in again…" } });
    // As for a token, the band holds the one button while the server needs sign-in.
    expect(
      row(
        URL_SERVER({
          status: "needs-sign-in",
          source: {
            kind: "url",
            url: "https://a.example/mcp",
            signIn: "oauth",
            signInOffered: "oauth",
          },
        }),
      ),
    ).toEqual({ value: "OAuth", action: null });
    expect(row(SENTRY_WORK)).toBeNull();
  });
});
