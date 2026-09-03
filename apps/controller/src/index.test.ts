import { describe, expect, it } from "vitest";
import { HydraHomeError } from "./config";
import { explain } from "./index";

describe("explain", () => {
  it("says what Hydra was doing to the path, not always creating it", () => {
    const path = "/home/x/.hydra/setup-url";
    const cause = new Error("EACCES: permission denied");
    expect(explain(new HydraHomeError({ action: "create", path, cause }))).toContain(
      `Cannot create ${path}`,
    );
    expect(explain(new HydraHomeError({ action: "write", path, cause }))).toContain(
      `Cannot write ${path}`,
    );
    expect(explain(new HydraHomeError({ action: "remove", path, cause }))).toContain(
      `Cannot remove ${path}`,
    );
    expect(explain(new HydraHomeError({ action: "secure", path, cause }))).toContain(
      `Cannot secure ${path}`,
    );
    expect(explain(new HydraHomeError({ action: "write", path, cause }))).toContain(
      "permission denied",
    );
  });
});
