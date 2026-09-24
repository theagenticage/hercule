import { describe, expect, it } from "vitest";
import { pickName } from "./names";

describe("the name a joining runner gets", () => {
  it("is a name no runner in the fleet has", () => {
    const first = pickName(new Set());
    expect(first).not.toBe("");
    expect(pickName(new Set([first]))).not.toBe(first);
  });

  it("keeps giving distinct names once the pool is used up", () => {
    const taken = new Set<string>();
    // Far more than the list holds, so the numbered fallback names are used by the end.
    for (let i = 0; i < 60; i++) {
      const name = pickName(taken);
      expect(taken.has(name), `${name} was handed out twice`).toBe(false);
      taken.add(name);
    }
    expect(taken.size).toBe(60);
  });
});
