/** Tests how the ends of a link are found and named. */
import { describe, expect, it } from "vitest";
import { isLinkBetween, nameLinkedThing, readOtherRef } from "./link-ends";

const LINK = { fromRef: "acme:review:1", toRef: "acme:ticket:2" };

describe("readOtherRef", () => {
  it.each([
    ["from", "acme:review:1", "acme:ticket:2"],
    ["to", "acme:ticket:2", "acme:review:1"],
  ])("returns the other end when asked from the %s end", (_end, ref, expected) => {
    expect(readOtherRef(LINK, ref)).toBe(expected);
  });
});

describe("isLinkBetween", () => {
  it.each([
    ["in the order of the link", "acme:review:1", "acme:ticket:2", true],
    ["in the other order", "acme:ticket:2", "acme:review:1", true],
    ["for one end and a stranger", "acme:review:1", "acme:ticket:3", false],
    ["for two strangers", "acme:ticket:3", "acme:ticket:4", false],
  ])("answers %s", (_case, a, b, expected) => {
    expect(isLinkBetween(LINK, a, b)).toBe(expected);
  });
});

describe("nameLinkedThing", () => {
  it.each([
    ["its identifier first", { identifier: "OPS-47", title: "Fix it", noun: "Ticket" }, "OPS-47"],
    ["its title without an identifier", { title: "Fix it", noun: "Ticket" }, "Fix it"],
    ["its noun when it has neither", { noun: "Pull request" }, "Pull request"],
  ])("names a thing by %s", (_case, thing, expected) => {
    expect(nameLinkedThing(thing)).toBe(expected);
  });
});
