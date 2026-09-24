import { describe, expect, it } from "vitest";
import { THREAD_ROWS_DEFAULT, resolveThreadRowsMode } from "./thread-rows";

describe("resolveThreadRowsMode", () => {
  it("returns meta when the setting was never set", () => {
    expect(resolveThreadRowsMode(undefined)).toBe("meta");
    expect(THREAD_ROWS_DEFAULT).toBe("meta");
  });

  it("returns the user's choice once they have made one", () => {
    expect(resolveThreadRowsMode("plain")).toBe("plain");
    expect(resolveThreadRowsMode("meta")).toBe("meta");
  });
});
