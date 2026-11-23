/**
 * Tests the words and the target of a Connection's "agent tools" note, one
 * for each state its server can be in.
 */
import { describe, expect, it } from "vitest";
import { joinOfferedServers, type OfferedServer } from "@hercule/client-core/mcp-servers";
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

/** Returns what the fixture Connections offer when the servers are `servers`. */
const buildOffered = (servers: Parameters<typeof joinOfferedServers>[0]["servers"]) =>
  joinOfferedServers({
    servers,
    connections: OFFERING_CONNECTIONS,
    plugins: OFFERING_PLUGINS,
  });

const sentryWorkRow = (
  servers: Parameters<typeof joinOfferedServers>[0]["servers"],
): OfferedServer =>
  buildOffered(servers).find(({ connection }) => connection.id === SENTRY_WORK_CONNECTION.id)!;

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
  it("holds one entry for each Connection that has an offer, by the Connection's id", () => {
    const map = mapAgentToolsByConnection(buildOffered([SENTRY_HOBBY]));

    expect([...map.keys()].toSorted()).toEqual(
      [LINEAR_CONNECTION.id, SENTRY_HOBBY_CONNECTION.id, SENTRY_WORK_CONNECTION.id].toSorted(),
    );
    expect(map.get(SENTRY_HOBBY_CONNECTION.id)?.map((note) => note.serverId)).toEqual([
      SENTRY_HOBBY.id,
    ]);
    expect(map.get(SENTRY_WORK_CONNECTION.id)?.map((note) => note.serverId)).toEqual([null]);
  });

  it("holds one note for each server a Connection's plugins offer", () => {
    const [offered] = buildOffered([SENTRY_WORK]);
    const second = { ...offered!, offer: { ...offered!.offer, contributionId: "sentry/second" } };

    const map = mapAgentToolsByConnection([offered!, { ...second, server: null }]);

    expect(map.get(SENTRY_WORK_CONNECTION.id)?.map((note) => note.text)).toEqual([
      "agent tools on",
      "agent tools off",
    ]);
  });
});
