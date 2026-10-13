/**
 * Tests the limits of a Linear Connection's config.
 */
import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { LinearConnectionConfig, MAX_CONFIG_VALUES } from "./connection-type";

const decodeConfig = Schema.decodeUnknownResult(LinearConnectionConfig);

const buildIds = (count: number) => Array.from({ length: count }, (_, index) => `id-${index}`);

describe("LinearConnectionConfig", () => {
  it("accepts a list of as many values as one Linear page holds", () => {
    expect(Result.isSuccess(decodeConfig({ teams: buildIds(MAX_CONFIG_VALUES) }))).toBe(true);
  });

  it.each(["teams", "projects", "projectMilestones", "labels", "assignees"])(
    "refuses a %s list longer than one Linear page, saying how many values fit",
    (field) => {
      const result = decodeConfig({ [field]: buildIds(MAX_CONFIG_VALUES + 1) });

      expect(Result.isFailure(result) && result.failure.message).toContain(
        "Choose at most 250 values.",
      );
    },
  );
});
