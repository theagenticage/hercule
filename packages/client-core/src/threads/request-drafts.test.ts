/**
 * Tests `changeRequestDraft`, which changes the draft of one Request, and
 * `dropClosedRequestDrafts`, which drops the drafts of Requests the
 * controller has closed.
 */
import { describe, expect, it } from "vitest";
import type { SessionRequest } from "@hercule/contract";
import {
  EMPTY_REQUEST_DRAFT,
  changeRequestDraft,
  dropClosedRequestDrafts,
  type RequestDraft,
} from "./request-drafts";

const buildRequest = (requestId: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "ls" },
});

describe("changeRequestDraft", () => {
  it("starts an untouched Request from the empty draft", () => {
    const drafts = { requests: new Map<string, RequestDraft>() };

    const changed = changeRequestDraft(drafts, "r-1", (draft) => ({ ...draft, answered: true }));

    expect(changed.requests.get("r-1")).toEqual({ ...EMPTY_REQUEST_DRAFT, answered: true });
    expect(drafts.requests.size).toBe(0);
  });

  it("changes the draft already there, and keeps the other drafts and fields as they were", () => {
    const other: RequestDraft = { ...EMPTY_REQUEST_DRAFT, shownQuestionIndex: 2 };
    const drafts = {
      shownRequestId: "r-2",
      requests: new Map<string, RequestDraft>([
        ["r-1", { ...EMPTY_REQUEST_DRAFT, answered: true }],
        ["r-2", other],
      ]),
    };

    const changed = changeRequestDraft(drafts, "r-1", (draft) => ({ ...draft, answered: false }));

    expect(changed.requests.get("r-1")).toEqual(EMPTY_REQUEST_DRAFT);
    expect(changed.requests.get("r-2")).toBe(other);
    expect(changed.shownRequestId).toBe("r-2");
  });
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
