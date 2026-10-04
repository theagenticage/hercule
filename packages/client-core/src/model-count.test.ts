import { describe, expect, it } from "vitest";
import { describeModelCount } from "./model-count";

describe("describeModelCount", () => {
  it("says no models, one model, or how many", () => {
    expect([0, 1, 3].map(describeModelCount)).toEqual(["no models", "1 model", "3 models"]);
  });
});
