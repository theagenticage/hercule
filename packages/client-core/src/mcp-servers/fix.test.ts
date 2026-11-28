import { describe, expect, it } from "vitest";
import { buildMcpWarningLine, decideStatusBand, decideWarningFix } from "./fix";
import type { McpServerWarningEntry } from "./fix";
import { SENTRY_WORK, buildServer, buildViews } from "./testing";
import { buildMcpServerViews } from "./views";

const VIEWS = buildViews([SENTRY_WORK]);

/** A server added by URL, which has no Connection to reconnect. */
const DOCS = buildServer("s-docs", "docs", "", {
  source: {
    kind: "url",
    url: "https://docs.example.com/mcp",
    signIn: "token",
    signInOffered: "token",
  },
  status: "needs-sign-in",
  statusDetail: "The server refused the token.",
});
const URL_VIEWS = buildViews([DOCS]);

const warn = (reason: McpServerWarningEntry["reason"], mcpServerId = "s-work") => ({
  mcpServerId,
  reason,
});

describe("decideWarningFix", () => {
  it("reconnects the Connection of a server that needs sign-in", () => {
    expect(decideWarningFix(warn("needs-sign-in"), VIEWS)).toEqual({
      kind: "reconnect",
      connectionId: "c-work",
      label: "Reconnect Sentry · work",
    });
  });

  it.each(["unreachable", "error", "switched-off"] as const)(
    "opens the server's page for %s",
    (reason) => {
      expect(decideWarningFix(warn(reason), VIEWS)).toEqual({
        kind: "open-server",
        mcpServerId: "s-work",
        label: "Open server",
      });
    },
  );

  it.each([
    "runner-too-old",
    "harness-unsupported",
    "missing-grant",
    "checking",
    "not-in-list",
    "timed-out",
  ] as const)("gives %s no button, because the line's text says what to do", (reason) => {
    expect(decideWarningFix(warn(reason), VIEWS)).toBeNull();
  });

  it("opens the sign-in of a server added by URL, which has no Connection", () => {
    expect(decideWarningFix(warn("needs-sign-in", "s-docs"), URL_VIEWS)).toEqual({
      kind: "sign-in",
      mcpServerId: "s-docs",
      label: "Sign in…",
    });
  });

  it("opens the page of a server added by URL for the reasons a Connection's server opens it for", () => {
    expect(decideWarningFix(warn("unreachable", "s-docs"), URL_VIEWS)).toEqual({
      kind: "open-server",
      mcpServerId: "s-docs",
      label: "Open server",
    });
  });

  it("gives no button for a server deleted since the line was written", () => {
    expect(decideWarningFix(warn("needs-sign-in", "s-gone"), VIEWS)).toBeNull();
  });

  it("gives no reconnect button when the server's Connection is not in the list", () => {
    expect(
      decideWarningFix(warn("needs-sign-in"), buildMcpServerViews([SENTRY_WORK], [], [])),
    ).toBeNull();
  });
});

describe("buildMcpWarningLine", () => {
  it("is a failure with a button for each entry that has a fix, in the order of the entries", () => {
    const line = buildMcpWarningLine(
      [warn("missing-grant"), warn("error"), warn("needs-sign-in")],
      VIEWS,
    );

    expect(line.tone).toBe("fail");
    expect(line.fixes.map(({ key, fix }) => [key, fix.kind])).toEqual([
      ["s-work:error", "open-server"],
      ["s-work:needs-sign-in", "reconnect"],
    ]);
  });

  it("is quiet with no button when no server has a fix", () => {
    expect(buildMcpWarningLine([warn("missing-grant"), warn("error", "s-gone")], VIEWS)).toEqual({
      tone: "quiet",
      fixes: [],
    });
    expect(buildMcpWarningLine([], VIEWS)).toEqual({ tone: "quiet", fixes: [] });
  });
});

describe("decideStatusBand", () => {
  const decideBandWithOverrides = (overrides: Parameters<typeof buildServer>[3]) =>
    decideStatusBand(buildViews([buildServer("s-work", "sentry", "c-work", overrides)])[0]!);

  it("draws no band for a ready server", () => {
    expect(decideBandWithOverrides({})).toBeNull();
  });

  it("explains a server that is checking, with no button", () => {
    expect(decideBandWithOverrides({ status: "checking" })).toEqual({
      tone: "quiet",
      heading: null,
      text: "Checking: asking the server for its tools.",
      detail: null,
      action: null,
    });
  });

  it("explains a switched-off server whatever its status, with no button", () => {
    expect(decideBandWithOverrides({ enabled: false, status: "needs-sign-in" })).toMatchObject({
      tone: "quiet",
      heading: "Off.",
      text: "No thread gets this server. Its name, its sign-in and the projects that name it are kept.",
      action: null,
    });
  });

  it("offers the Connection's Reconnect for a server that needs sign-in, with the server's reason", () => {
    expect(
      decideBandWithOverrides({ status: "needs-sign-in", statusDetail: "revoked 09:12" }),
    ).toMatchObject({
      tone: "fail",
      detail: "revoked 09:12",
      action: { kind: "reconnect", connectionId: "c-work", label: "Reconnect Sentry · work" },
    });
  });

  it("offers Sign in… for a server added by URL that needs sign-in, with the server's reason", () => {
    expect(decideStatusBand(URL_VIEWS[0]!)).toEqual({
      tone: "fail",
      heading: "Needs sign-in.",
      text: "Paste a new token, and this server comes back with it.",
      detail: "The server refused the token.",
      action: { kind: "sign-in", mcpServerId: "s-docs", label: "Sign in…" },
    });
  });

  it("names the browser first for a server that asks for OAuth, and the pasted token as the other way", () => {
    const [view] = buildViews([
      buildServer("s-docs", "docs", "", {
        source: {
          kind: "url",
          url: "https://docs.example.com/mcp",
          signIn: "none",
          signInOffered: "oauth",
        },
        status: "needs-sign-in",
      }),
    ]);

    expect(decideStatusBand(view!)).toMatchObject({
      text: "Sign in through your browser, or paste a token, and this server comes back with it.",
      action: { kind: "sign-in", mcpServerId: "s-docs", label: "Sign in…" },
    });
  });

  it("offers Check now for an unreachable server and for one in error", () => {
    expect(decideBandWithOverrides({ status: "unreachable" })).toMatchObject({
      tone: "fail",
      text: "Hercule asks again, with a longer wait each time. A thread that starts meanwhile says the server was left out, and gets it once it is ready.",
      action: { kind: "check", label: "Check now" },
    });
    expect(
      decideBandWithOverrides({ status: "error", statusDetail: "refused the token" }),
    ).toMatchObject({
      tone: "fail",
      heading: "Error.",
      text: "The server did not return its tools. Check now asks it again.",
      detail: "refused the token",
      action: { kind: "check", label: "Check now" },
    });
  });

  it("draws no band for a server that needs sign-in when its Connection is not in the list", () => {
    const view = buildMcpServerViews(
      [buildServer("s-work", "sentry", "c-work", { status: "needs-sign-in" })],
      [],
      [],
    )[0]!;

    expect(decideStatusBand(view)).toBeNull();
  });
});
