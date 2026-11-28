/** Tests which search results can be linked, which refs the search leaves out, and how a link is reversed. */
import { describe, expect, it } from "vitest";
import type { EntityLink } from "@hercule/contract";
import type { AddRow } from "../work/add-list";
import {
  listLinkableRows,
  listRefsNotToOffer,
  MAX_LINK_RESULTS,
  reverseLinkDirection,
} from "./link-search";

const row = (ref: string): AddRow => ({
  ref,
  identifier: ref,
  title: `Title of ${ref}`,
  note: undefined,
  state: "",
  taskId: undefined,
});

describe("listLinkableRows", () => {
  it("leaves out what the caller says is linked already", () => {
    const rows = listLinkableRows([row("a"), row("b"), row("c")], ["a", "c"]);

    expect(rows.map((each) => each.ref)).toEqual(["b"]);
  });

  it("lists no more than the most the search shows, after leaving out what cannot be linked", () => {
    const many = Array.from({ length: 12 }, (_, index) => row(`r${String(index)}`));

    const rows = listLinkableRows([row("self"), ...many], ["self"]);

    expect(rows.map((each) => each.ref)).toEqual(many.slice(0, MAX_LINK_RESULTS).map((r) => r.ref));
  });
});

const SELF = "acme:ticket:1";

const link = (toRef: string, type: EntityLink["claim"]["type"]): EntityLink => ({
  fromRef: SELF,
  toRef,
  claim: { type },
  hasPersonClaim: type === "person",
});

describe("listRefsNotToOffer", () => {
  it("names the thing itself and what a source or the user linked to it, in either direction", () => {
    const refs = listRefsNotToOffer(SELF, [
      link("a", "source"),
      link("b", "person"),
      { fromRef: "c", toRef: SELF, claim: { type: "source" }, hasPersonClaim: false },
    ]);

    expect(new Set(refs)).toEqual(new Set([SELF, "a", "b", "c"]));
  });
});

describe("reverseLinkDirection", () => {
  it("reverses a link by removing it and a removal by linking", () => {
    expect(reverseLinkDirection("link")).toBe("unlink");
    expect(reverseLinkDirection("unlink")).toBe("link");
  });
});
