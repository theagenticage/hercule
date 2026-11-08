/** Tests which search results can be linked. */
import { describe, expect, it } from "vitest";
import type { AddRow } from "../work/add-list";
import { listLinkableRows, MAX_LINK_RESULTS } from "./link-search";

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
