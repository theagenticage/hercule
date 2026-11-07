/** Tests which search results can be linked to the open thing. */
import { describe, expect, it } from "vitest";
import type { EntityLink } from "@hercule/contract";
import type { AddRow } from "../work/add-list";
import { listLinkableRows, MAX_LINK_RESULTS } from "./link-search";

const SELF = "acme:ticket:1";

const row = (ref: string): AddRow => ({
  ref,
  identifier: ref,
  title: `Title of ${ref}`,
  note: undefined,
  state: "",
  taskId: undefined,
});

const link = (toRef: string, type: EntityLink["claim"]["type"]): EntityLink => ({
  fromRef: SELF,
  toRef,
  claim: { type },
  hasPersonClaim: type === "person",
});

describe("listLinkableRows", () => {
  it("leaves out the thing itself and what a source or the user already linked, in either direction", () => {
    const rows = listLinkableRows([row(SELF), row("a"), row("b"), row("c"), row("d")], SELF, [
      link("a", "source"),
      link("b", "person"),
      { fromRef: "c", toRef: SELF, claim: { type: "source" }, hasPersonClaim: false },
    ]);

    expect(rows.map((each) => each.ref)).toEqual(["d"]);
  });

  it("keeps a thing that only a reference in text links, so it can be confirmed", () => {
    const rows = listLinkableRows([row("a")], SELF, [link("a", "text")]);

    expect(rows.map((each) => each.ref)).toEqual(["a"]);
  });

  it("lists no more than the most the search shows, after leaving out what cannot be linked", () => {
    const many = Array.from({ length: 12 }, (_, index) => row(`r${String(index)}`));

    const rows = listLinkableRows([row(SELF), ...many], SELF, []);

    expect(rows.map((each) => each.ref)).toEqual(many.slice(0, MAX_LINK_RESULTS).map((r) => r.ref));
  });
});
