import { describe, expect, it } from "vitest";
import { opensModelBrowser } from "./opens-model-browser";

describe("opensModelBrowser", () => {
  it("opens for a catalog of more than 40 models", () => {
    expect(opensModelBrowser(40)).toBe(false);
    expect(opensModelBrowser(41)).toBe(true);
  });
});
