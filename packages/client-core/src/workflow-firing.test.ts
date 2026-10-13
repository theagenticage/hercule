import { assert, describe, it } from "vitest";
import { firesTriggers } from "./workflow-firing";

describe("firesTriggers", () => {
  it("fires the triggers of an enabled, valid workflow only", () => {
    assert.isTrue(firesTriggers({ enabled: true }));
    assert.isFalse(firesTriggers({ enabled: false }));
    assert.isFalse(firesTriggers({ enabled: true, invalidSince: "2026-10-12T09:00:00.000Z" }));
  });
});
