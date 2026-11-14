/** Tests the bounds of the input of `externalEntity.readCards`: a list of 1 to 50 distinct ids. */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EntityCardsQuery } from "./external-entity";

const idOf = (index: number) => `0199e0e7-1111-7000-8000-${String(index).padStart(12, "0")}`;

describe("EntityCardsQuery", () => {
  const decode = Schema.decodeUnknownExit(EntityCardsQuery);

  it("accepts one id and fifty ids", () => {
    for (const count of [1, 50]) {
      const ids = Array.from({ length: count }, (_, index) => idOf(index));
      expect(Schema.decodeUnknownSync(EntityCardsQuery)({ ids })).toEqual({ ids });
    }
  });

  it.each([
    ["an empty list", [], "at least 1"],
    ["a repeated id", [idOf(1), idOf(1)], "remove the repeated entity id"],
    ["more than fifty ids", Array.from({ length: 51 }, (_, index) => idOf(index)), "50"],
    ["a value that is not an id", ["SHOP-142"], "ids"],
  ])("refuses %s", (_name, ids, reason) => {
    const exit = decode({ ids });
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain(reason);
  });
});
