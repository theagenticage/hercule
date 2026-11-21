import { describe, expect, it } from "vitest";
import type { McpServerLeftOutReason } from "@hercule/protocol";
import { buildLeftOutWarning, decideLeftOutReason, type StartDelivery } from "./left-out";
import { buildMcpServerView, type ViewFacts } from "./testing";

const CAN_DELIVER: StartDelivery = {
  runnerReachesMcpServers: true,
  harnessPassthrough: "native",
  profileGrantsMcpUse: true,
};

// What the state of the server alone gives is covered in `catalogue.test.ts`.
describe("decideLeftOutReason", () => {
  const brokenServer: ViewFacts = { enabled: false, status: "error" };

  it.each<{
    readonly name: string;
    readonly delivery: Partial<StartDelivery>;
    readonly server: ViewFacts;
    readonly expected: McpServerLeftOutReason | null;
  }>([
    { name: "a ready server is callable", delivery: {}, server: {}, expected: null },
    {
      name: "a native harness on a runner without its capability wins over everything",
      delivery: { runnerReachesMcpServers: false, profileGrantsMcpUse: false },
      server: brokenServer,
      expected: "runner-too-old",
    },
    {
      name: "an unsupported harness wins over a missing grant and the server's state",
      delivery: { harnessPassthrough: "unsupported", profileGrantsMcpUse: false },
      server: brokenServer,
      expected: "harness-unsupported",
    },
    {
      name: "an unsupported harness is unsupported whatever its runner negotiated",
      delivery: { runnerReachesMcpServers: false, harnessPassthrough: "unsupported" },
      server: {},
      expected: "harness-unsupported",
    },
    {
      name: "a missing mcp.use wins over the server's state",
      delivery: { profileGrantsMcpUse: false },
      server: brokenServer,
      expected: "missing-grant",
    },
  ])("$name", ({ delivery, server, expected }) => {
    expect(decideLeftOutReason({ ...CAN_DELIVER, ...delivery }, buildMcpServerView(server))).toBe(
      expected,
    );
  });
});

describe("buildLeftOutWarning", () => {
  it("names each server and its reason in words, and each server for a client", () => {
    const warning = buildLeftOutWarning([
      { mcpServerId: "id-sentry", name: "sentry", sourceKind: "plugin", reason: "runner-too-old" },
      { mcpServerId: "id-linear", name: "linear", sourceKind: "plugin", reason: "needs-sign-in" },
      { mcpServerId: "id-docs", name: "docs", sourceKind: "url", reason: "needs-sign-in" },
    ]);

    expect(warning).toEqual({
      message:
        "MCP servers not available in this session: sentry (its runner is too old to reach MCP servers), linear (needs sign-in), docs (needs sign-in: paste a token or sign in in Settings > MCP servers)",
      mcpServers: [
        { mcpServerId: "id-sentry", reason: "runner-too-old" },
        { mcpServerId: "id-linear", reason: "needs-sign-in" },
        { mcpServerId: "id-docs", reason: "needs-sign-in" },
      ],
    });
  });

  const buildLeftOut = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      mcpServerId: `id-${String(index)}`,
      name: `server-${String(index)}`,
      sourceKind: "plugin" as const,
      reason: "unreachable" as const,
    }));

  it("names 20 servers in the message and counts the rest, but gives a client every server up to its limit", () => {
    const warning = buildLeftOutWarning(buildLeftOut(64));

    expect(warning.mcpServers).toHaveLength(64);
    expect(warning.message.endsWith("server-19 (unreachable), and 44 more")).toBe(true);
    expect(warning.message).not.toContain("server-20");
  });

  it("gives a client the first 64 servers of a longer list, and says in the message how many have no entry", () => {
    const warning = buildLeftOutWarning(buildLeftOut(70));

    expect(warning.mcpServers.map(({ mcpServerId }) => mcpServerId)).toEqual(
      buildLeftOut(64).map(({ mcpServerId }) => mcpServerId),
    );
    expect(warning.message.endsWith(", and 50 more (6 of them are not given a fix button)")).toBe(
      true,
    );
  });
});
