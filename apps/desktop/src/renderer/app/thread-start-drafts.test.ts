/** Tests which unsent start-thread drafts are kept when their dialog closes. */
import { describe, expect, it } from "vitest";
import { buildInboxThing } from "@hercule/client-core/inbox/testing";
import { buildThreadStartDraft, isWorthKeeping, type SentThread } from "./thread-start-drafts";

const fresh = buildThreadStartDraft([buildInboxThing("1", {})]);

describe("isWorthKeeping", () => {
  it("drops a draft nobody changed or sent", () => {
    expect(isWorthKeeping(fresh)).toBe(false);
  });

  it("keeps an edited draft, a sent one and a failed one", () => {
    expect(isWorthKeeping({ ...fresh, isEdited: true })).toBe(true);
    expect(isWorthKeeping({ ...fresh, attempt: {} as SentThread })).toBe(true);
    expect(isWorthKeeping({ ...fresh, failure: "refused" })).toBe(true);
  });
});
