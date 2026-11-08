/** Tests which refs the open card's search must not offer. */
import { describe, expect, it } from "vitest";
import type { EntityLink } from "@hercule/contract";
import { listLinkedRefs } from "./link-search";

const SELF = "acme:ticket:1";

const link = (toRef: string, type: EntityLink["claim"]["type"]): EntityLink => ({
  fromRef: SELF,
  toRef,
  claim: { type },
  hasPersonClaim: type === "person",
});

describe("listLinkedRefs", () => {
  it("names the thing itself and what a source or the user linked to it, in either direction", () => {
    const refs = listLinkedRefs(SELF, [
      link("a", "source"),
      link("b", "person"),
      { fromRef: "c", toRef: SELF, claim: { type: "source" }, hasPersonClaim: false },
    ]);

    expect(new Set(refs)).toEqual(new Set([SELF, "a", "b", "c"]));
  });
});
