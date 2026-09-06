import { describe, expect, it } from "vitest";
import { pickName } from "./names";

describe("the name a joining machine is given", () => {
  it("is a name nobody in the fleet holds", () => {
    const first = pickName(new Set());
    expect(first).not.toBe("");
    expect(pickName(new Set([first]))).not.toBe(first);
  });

  it("keeps giving distinct names once the pool is used up", () => {
    const taken = new Set<string>();
    // Far past the pool, so the fallback is what is answering by the end.
    for (let i = 0; i < 60; i++) {
      const name = pickName(taken);
      expect(taken.has(name), `${name} was handed out twice`).toBe(false);
      taken.add(name);
    }
    expect(taken.size).toBe(60);
  });
});
