import { describe, expect, it } from "vitest";
import type { ThreadBlock } from "../threads/blocks";
import type { RuntimeNote } from "../threads/turns";
import {
  buildMcpWarningLine,
  decideStatusBand,
  decideWarningFix,
  hasMcpServerBlock,
  hasMcpServerLine,
} from "./fix";
import type { McpServerWarningEntry } from "./fix";
import { SENTRY_WORK, buildServer, buildViews } from "./testing";
import { buildMcpServerViews } from "./views";

const VIEWS = buildViews([SENTRY_WORK]);

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

describe("hasMcpServerLine", () => {
  const note = (mcpServers?: RuntimeNote["mcpServers"]): RuntimeNote => ({
    key: "1:warning",
    severity: "warning",
    message: "left out",
    at: "2026-11-20T09:00:00.000Z",
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });

  it("is false for a transcript with no note, or notes that name no server", () => {
    expect(hasMcpServerLine({ turns: [], outsideRuntimeNotes: [] })).toBe(false);
    expect(
      hasMcpServerLine({ turns: [{ runtimeNotes: [note()] }], outsideRuntimeNotes: [note()] }),
    ).toBe(false);
  });

  it("is true for a note in a turn that names servers", () => {
    expect(
      hasMcpServerLine({
        turns: [{ runtimeNotes: [note([warn("unreachable")])] }],
        outsideRuntimeNotes: [],
      }),
    ).toBe(true);
  });

  it("is true for a note outside every turn that names servers", () => {
    expect(
      hasMcpServerLine({ turns: [], outsideRuntimeNotes: [note([warn("needs-sign-in")])] }),
    ).toBe(true);
  });
});

describe("hasMcpServerBlock", () => {
  const warning = (mcpServers?: McpServerWarningEntry[]): ThreadBlock => ({
    kind: "warning",
    key: "1:warning",
    message: "left out",
    at: "2026-11-20T09:00:00.000Z",
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });

  it("is false for no blocks, or a warning that names no server", () => {
    expect(hasMcpServerBlock([])).toBe(false);
    expect(hasMcpServerBlock([warning()])).toBe(false);
  });

  it("is true for a warning that names servers", () => {
    expect(hasMcpServerBlock([warning(), warning([warn("unreachable")])])).toBe(true);
  });
});
