/**
 * Tests `findOldestOpenRequest`, which picks the Request a screen shows for
 * a session that waits on several.
 */
import { describe, expect, it } from "vitest";
import type { SessionRequest } from "@hercule/contract";
import { findOldestOpenRequest } from "./oldest-request";
import { buildSession } from "./workspaces.testing";

const buildRequest = (requestId: string, subagentId?: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
  ...(subagentId === undefined ? {} : { subagentId }),
});

describe("findOldestOpenRequest", () => {
  it("returns null when nothing waits on the user", () => {
    expect(findOldestOpenRequest(buildSession({ id: "s-1" }))).toBeNull();
  });

  it("returns the oldest Request, whichever agent asked it", () => {
    const session = buildSession({
      id: "s-1",
      openRequests: [buildRequest("r-1", "agent-1"), buildRequest("r-2")],
    });

    expect(findOldestOpenRequest(session)?.requestId).toBe("r-1");
  });
});
