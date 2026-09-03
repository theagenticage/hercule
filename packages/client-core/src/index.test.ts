import { describe, expect, it } from "vitest";
import { parseHealth } from "./index";

describe("parseHealth", () => {
  it("returns a plain object", async () => {
    await expect(parseHealth({ status: "ok", apiVersion: 1 })).resolves.toEqual({
      status: "ok",
      apiVersion: 1,
    });
  });

  it("rejects a malformed payload", async () => {
    await expect(parseHealth({ status: "ok" })).rejects.toThrow();
  });
});
