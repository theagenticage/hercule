import { describe, expect, it } from "vitest";
import type { McpServerLeftOutReason } from "@hercule/protocol";
import { buildLeftOutWarning, decideLeftOutReason, type StartDelivery } from "./left-out";

const CAN_DELIVER: StartDelivery = {
  runnerReachesMcpServers: true,
  harnessPassthrough: "native",
  profileGrantsMcpUse: true,
};

describe("decideLeftOutReason", () => {
  const readyServer = { enabled: true, status: "ready" } as const;

  it.each<{
    readonly name: string;
    readonly delivery: Partial<StartDelivery>;
    readonly server: Parameters<typeof decideLeftOutReason>[1];
    readonly expected: McpServerLeftOutReason | null;
  }>([
    { name: "a ready server is callable", delivery: {}, server: readyServer, expected: null },
    {
      name: "a runner without the capability wins over everything",
      delivery: {
        runnerReachesMcpServers: false,
        harnessPassthrough: "unsupported",
        profileGrantsMcpUse: false,
      },
      server: { enabled: false, status: "error" },
      expected: "runner-too-old",
    },
    {
      name: "an unsupported harness wins over a missing grant, a switch and a status",
      delivery: { harnessPassthrough: "unsupported", profileGrantsMcpUse: false },
      server: { enabled: false, status: "error" },
      expected: "harness-unsupported",
    },
    {
      name: "a missing mcp.use wins over a switch and a status",
      delivery: { profileGrantsMcpUse: false },
      server: { enabled: false, status: "error" },
      expected: "missing-grant",
    },
    {
      name: "a switched-off server wins over its status",
      delivery: {},
      server: { enabled: false, status: "needs-sign-in" },
      expected: "switched-off",
    },
    {
      name: "a server whose first list has not ended is checking",
      delivery: {},
      server: { enabled: true, status: "checking" },
      expected: "checking",
    },
    {
      name: "needs-sign-in is its own reason",
      delivery: {},
      server: { enabled: true, status: "needs-sign-in" },
      expected: "needs-sign-in",
    },
    {
      name: "unreachable is its own reason",
      delivery: {},
      server: { enabled: true, status: "unreachable" },
      expected: "unreachable",
    },
    {
      name: "error is its own reason",
      delivery: {},
      server: { enabled: true, status: "error" },
      expected: "error",
    },
  ])("$name", ({ delivery, server, expected }) => {
    expect(decideLeftOutReason({ ...CAN_DELIVER, ...delivery }, server)).toBe(expected);
  });
});

describe("buildLeftOutWarning", () => {
  it("names each server and its reason in words, and each server for a client", () => {
    const warning = buildLeftOutWarning([
      { mcpServerId: "id-sentry", name: "sentry", reason: "runner-too-old" },
      { mcpServerId: "id-linear", name: "linear", reason: "needs-sign-in" },
    ]);

    expect(warning).toEqual({
      message:
        "MCP servers not available in this session: sentry (its runner is too old to reach MCP servers), linear (needs sign-in)",
      mcpServers: [
        { mcpServerId: "id-sentry", reason: "runner-too-old" },
        { mcpServerId: "id-linear", reason: "needs-sign-in" },
      ],
    });
  });

  it("names the first 20 servers and counts the rest, so the warning stays within its bounds", () => {
    const leftOut = Array.from({ length: 70 }, (_, index) => ({
      mcpServerId: `id-${String(index)}`,
      name: `server-${String(index)}`,
      reason: "unreachable" as const,
    }));

    const warning = buildLeftOutWarning(leftOut);

    expect(warning.mcpServers).toHaveLength(20);
    expect(warning.message.endsWith(", and 50 more")).toBe(true);
  });
});
