import { describe, expect, it } from "vitest";
import type { McpServer } from "@hercule/contract";
import { decideDisplayStatus, needsSignIn } from "./display-status";
import { MCP_SERVER_STATUS_FACTS } from "./status";
import { buildServer } from "./testing";

const STATUSES: readonly McpServer["status"][] = [
  "ready",
  "checking",
  "needs-sign-in",
  "unreachable",
  "error",
];

describe("needsSignIn", () => {
  it.each(STATUSES.flatMap((status) => [true, false].map((enabled) => ({ status, enabled }))))(
    "agrees with the table of status facts for a server whose status is $status and enabled is $enabled",
    ({ status, enabled }) => {
      const server = buildServer("s-1", "sentry", "c-1", { status, enabled });

      expect(needsSignIn(server)).toBe(
        MCP_SERVER_STATUS_FACTS[decideDisplayStatus(server)].needsSignIn,
      );
    },
  );

  it("is false for a server switched off, whatever its status was", () => {
    expect(
      needsSignIn(buildServer("s-1", "sentry", "c-1", { status: "needs-sign-in", enabled: false })),
    ).toBe(false);
  });
});
