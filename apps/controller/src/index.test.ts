import { describe, expect, it, vi } from "vitest";
import { run } from "./index";

describe("run", () => {
  it("names its role", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    run([]);
    expect(log).toHaveBeenCalledWith("controller");
    log.mockRestore();
  });
});
