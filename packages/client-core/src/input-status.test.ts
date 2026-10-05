import { assert, describe, it } from "vitest";
import { describeInputStatus } from "./input-status";

describe("describeInputStatus", () => {
  it("says a sent input was never confirmed", () => {
    assert.strictEqual(describeInputStatus("sent"), "sent, not confirmed");
  });

  it.each(["queued", "delivered", "cancelled"] as const)("returns %s as it is", (status) => {
    assert.strictEqual(describeInputStatus(status), status);
  });
});
