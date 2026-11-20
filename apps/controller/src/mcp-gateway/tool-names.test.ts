/**
 * Tests how the gateway names a session's tools (spec 21 section 3.4): the
 * normalization, the cut at 64 characters, clashes, and that a name a token
 * was sent keeps its meaning when the list changes.
 */
import { describe, expect, it } from "vitest";
import { allocateToolNames } from "./tool-names";

/** What is left of 64 characters after the harness's `mcp__tools__`. */
const MAX_NAME_LENGTH = 52;

describe("allocateToolNames", () => {
  it("names a tool <server>__<tool> with every other character turned into an underscore", () => {
    const { named } = allocateToolNames(
      [{ serverName: "sentry", tools: ["search_issues", "get-issue.details"] }],
      new Map(),
    );
    expect(named.map((one) => one.name)).toEqual([
      "sentry__get_issue_details",
      "sentry__search_issues",
    ]);
  });

  it("orders the names by server name and then by the tool's original name", () => {
    const { named } = allocateToolNames(
      [
        { serverName: "sentry", tools: ["b", "a"] },
        { serverName: "linear", tools: ["z"] },
      ],
      new Map(),
    );
    expect(named.map((one) => `${one.serverName}/${one.tool}`)).toEqual([
      "linear/z",
      "sentry/a",
      "sentry/b",
    ]);
  });

  it("cuts a name that would pass 64 characters behind mcp__tools__ and keeps long names apart by a hash", () => {
    const long = "a".repeat(80);
    const { named } = allocateToolNames(
      [{ serverName: "sentry", tools: [`${long}_one`, `${long}_two`] }],
      new Map(),
    );
    const names = named.map((one) => one.name);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(name).toMatch(/^sentry__a+_[0-9a-f]{6}$/);
    }
  });

  it("gives the second of two tools that normalize alike a clash suffix", () => {
    const { named, leftOut } = allocateToolNames(
      [{ serverName: "sentry", tools: ["a.b", "a-b"] }],
      new Map(),
    );
    // In order by original name "a-b" comes first and takes the plain name.
    expect(named.map((one) => one.tool)).toEqual(["a-b", "a.b"]);
    expect(named[0]?.name).toBe("sentry__a_b");
    expect(named[1]?.name).toMatch(/^sentry__a_b_[0-9a-f]{6}$/);
    expect(leftOut).toEqual([]);
  });

  it("leaves a tool out when its plain name and its clash name are both held by other tools", () => {
    const tool = { serverName: "sentry", tool: "a.b" };
    const other = { serverName: "sentry", tool: "other" };
    const servers = [{ serverName: "sentry", tools: ["a.b"] }];
    // With the plain name held, the tool gets its clash name. Hold that too.
    const clashName = allocateToolNames(servers, new Map([["sentry__a_b", other]])).named[0]!.name;
    const { named, leftOut } = allocateToolNames(
      servers,
      new Map([
        ["sentry__a_b", other],
        [clashName, other],
      ]),
    );
    expect(named).toEqual([]);
    expect(leftOut).toEqual([tool]);
  });

  it("keeps the name a token was sent for a tool when another tool would now take it by order", () => {
    const reservations = new Map([["sentry__a_b", { serverName: "sentry", tool: "a.b" }]]);
    const { named } = allocateToolNames(
      [{ serverName: "sentry", tools: ["a.b", "a-b"] }],
      reservations,
    );
    const nameOf = (tool: string) => named.find((one) => one.tool === tool)?.name;
    expect(nameOf("a.b")).toBe("sentry__a_b");
    expect(nameOf("a-b")).toMatch(/^sentry__a_b_[0-9a-f]{6}$/);
  });

  it("never gives a name that was sent for one tool to another, even after that tool left the list", () => {
    const reservations = new Map([["sentry__a_b", { serverName: "sentry", tool: "a_b" }]]);
    const { named } = allocateToolNames([{ serverName: "sentry", tools: ["a.b"] }], reservations);
    expect(named[0]?.name).toMatch(/^sentry__a_b_[0-9a-f]{6}$/);
  });

  it("gives the same names for the same list every time", () => {
    const servers = [{ serverName: "sentry", tools: ["a.b", "a_b", "x".repeat(70)] }];
    expect(allocateToolNames(servers, new Map())).toEqual(allocateToolNames(servers, new Map()));
  });
});
