/**
 * Tests `dropClosedRequestDrafts`, which drops the drafts of Requests the
 * controller has closed.
 */
import { describe, expect, it } from "vitest";
import type { SessionRequest } from "@hercule/contract";
import { dropClosedRequestDrafts } from "./request-drafts";

const buildRequest = (requestId: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "ls" },
});

describe("dropClosedRequestDrafts", () => {
  it("drops the drafts of Requests that are no longer open, and keeps the other fields", () => {
    const drafts = {
      shownRequestId: "r-2",
      requests: new Map([
        ["r-1", "first"],
        ["r-2", "second"],
      ]),
    };

    const kept = dropClosedRequestDrafts(drafts, [buildRequest("r-2"), buildRequest("r-3")]);

    expect([...kept.requests]).toEqual([["r-2", "second"]]);
    expect(kept.shownRequestId).toBe("r-2");
  });

  it("returns the drafts themselves when every draft's Request is still open", () => {
    const drafts = { requests: new Map([["r-1", "first"]]) };

    expect(dropClosedRequestDrafts(drafts, [buildRequest("r-1")])).toBe(drafts);
  });

  it("drops every draft once no Request is open", () => {
    const drafts = { requests: new Map([["r-1", "first"]]) };

    expect(dropClosedRequestDrafts(drafts, []).requests.size).toBe(0);
  });
});
