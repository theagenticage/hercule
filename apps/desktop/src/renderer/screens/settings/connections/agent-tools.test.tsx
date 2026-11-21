/**
 * Tests the words and the target of a Connection's "agent tools" note, one
 * for each state its server can be in.
 */
import { describe, expect, it } from "vitest";
import {
  buildMcpServerSettingsRows,
  type McpServerSettingsRow,
} from "@hercule/client-core/mcp-servers";
import {
  OFFERING_CONNECTIONS,
  OFFERING_PLUGINS,
  SENTRY_HOBBY,
  SENTRY_WORK,
  SENTRY_HOBBY_CONNECTION,
  SENTRY_WORK_CONNECTION,
  LINEAR_CONNECTION,
} from "../mcp-servers/mcp-servers.testing";
import { describeAgentTools, mapAgentToolsByConnection } from "./agent-tools";

/** Returns the rows of the fixture Connections when the servers are `servers`. */
const buildRows = (
  servers: Parameters<typeof buildMcpServerSettingsRows>[0]["servers"],
): McpServerSettingsRow[] =>
  buildMcpServerSettingsRows({
    servers,
    connections: OFFERING_CONNECTIONS,
    plugins: OFFERING_PLUGINS,
    projects: [],
  });

const sentryWorkRow = (
  servers: Parameters<typeof buildMcpServerSettingsRows>[0]["servers"],
): McpServerSettingsRow =>
  buildRows(servers).find((row) => row.connection.id === SENTRY_WORK_CONNECTION.id)!;

describe("describeAgentTools", () => {
  it("says off, with no server to lead to, for a Connection whose server has no record", () => {
    expect(describeAgentTools(sentryWorkRow([]))).toEqual({
      text: "agent tools off",
      tone: "off",
      serverId: null,
    });
  });

  it("says off for a server switched off, whatever its status was", () => {
    const row = sentryWorkRow([{ ...SENTRY_WORK, enabled: false, status: "needs-sign-in" }]);

    expect(describeAgentTools(row)).toEqual({
      text: "agent tools off",
      tone: "off",
      serverId: SENTRY_WORK.id,
    });
  });

  it("says on for a ready server, and checking, with the on mark, for one being checked", () => {
    expect(describeAgentTools(sentryWorkRow([SENTRY_WORK]))).toMatchObject({
      text: "agent tools on",
      tone: "on",
    });
    expect(
      describeAgentTools(sentryWorkRow([{ ...SENTRY_WORK, status: "checking" }])),
    ).toMatchObject({ text: "agent tools: checking", tone: "on" });
  });

  it.each([
    ["needs-sign-in", "agent tools: needs sign-in"],
    ["unreachable", "agent tools: unreachable"],
    ["error", "agent tools: error"],
  ] as const)("says the failing status for a server that is %s", (status, text) => {
    expect(describeAgentTools(sentryWorkRow([{ ...SENTRY_WORK, status }]))).toEqual({
      text,
      tone: "fail",
      serverId: SENTRY_WORK.id,
    });
  });
});

describe("mapAgentToolsByConnection", () => {
  it("holds one entry for each Connection that has a row, by the Connection's id", () => {
    const map = mapAgentToolsByConnection(buildRows([SENTRY_HOBBY]));

    expect([...map.keys()].toSorted()).toEqual(
      [LINEAR_CONNECTION.id, SENTRY_HOBBY_CONNECTION.id, SENTRY_WORK_CONNECTION.id].toSorted(),
    );
    expect(map.get(SENTRY_HOBBY_CONNECTION.id)?.serverId).toBe(SENTRY_HOBBY.id);
    expect(map.get(SENTRY_WORK_CONNECTION.id)?.serverId).toBeNull();
  });
});
