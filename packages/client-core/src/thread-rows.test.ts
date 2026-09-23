import { describe, expect, it } from "vitest";
import { THREAD_ROWS_DEFAULT, resolveThreadRowsMode } from "./thread-rows";

describe("the thread-row mode", () => {
  it("is meta when the setting has never been written", () => {
    expect(resolveThreadRowsMode(undefined)).toBe("meta");
    expect(THREAD_ROWS_DEFAULT).toBe("meta");
  });

  it("is whatever the user chose once they have chosen", () => {
    expect(resolveThreadRowsMode("plain")).toBe("plain");
    expect(resolveThreadRowsMode("meta")).toBe("meta");
  });
});
