/** Tests how the Thread is told about tools a server lists that are not offered (spec 21 section 3.4). */
import { describe, expect, it } from "vitest";
import { buildLeftOutToolsWarning, claimLeftOutWarnings } from "./left-out-tools";

const key = (serverName: string, tool: string) => ({ serverName, tool });

describe("buildLeftOutToolsWarning", () => {
  it("names the server and the number of tools, and says why", () => {
    const warning = buildLeftOutToolsWarning({ serverName: "notion", count: 2 });
    expect(warning).toContain('"notion"');
    expect(warning).toContain("2 tools");
    expect(warning).toContain(
      "not valid text or another tool of the server would get the same name",
    );
  });

  it("reads right for one tool", () => {
    expect(buildLeftOutToolsWarning({ serverName: "notion", count: 1 })).toContain(
      "1 tool that is not offered",
    );
  });
});

describe("claimLeftOutWarnings", () => {
  it("returns each server with tools left out, in order by name, with its count", () => {
    const told = new Map<string, string>();
    expect(
      claimLeftOutWarnings(told, [key("sentry", "a"), key("notion", "b"), key("sentry", "c")]),
    ).toEqual([
      { serverName: "notion", count: 1 },
      { serverName: "sentry", count: 2 },
    ]);
  });

  it("returns a server once while its set stays the same, whatever the order of the tools", () => {
    const told = new Map<string, string>();
    expect(claimLeftOutWarnings(told, [key("notion", "a"), key("notion", "b")])).toHaveLength(1);
    expect(claimLeftOutWarnings(told, [key("notion", "b"), key("notion", "a")])).toEqual([]);
  });

  it("returns a server again when its set changes", () => {
    const told = new Map<string, string>();
    claimLeftOutWarnings(told, [key("notion", "a"), key("notion", "b")]);
    expect(claimLeftOutWarnings(told, [key("notion", "a"), key("notion", "c")])).toEqual([
      { serverName: "notion", count: 2 },
    ]);
  });

  it("returns a server again after it had nothing left out in between", () => {
    const told = new Map<string, string>();
    claimLeftOutWarnings(told, [key("notion", "a")]);
    expect(claimLeftOutWarnings(told, [])).toEqual([]);
    expect(claimLeftOutWarnings(told, [key("notion", "a")])).toEqual([
      { serverName: "notion", count: 1 },
    ]);
  });

  it("does not return a server whose set another server's change leaves alone", () => {
    const told = new Map<string, string>();
    claimLeftOutWarnings(told, [key("notion", "a"), key("sentry", "x")]);
    expect(claimLeftOutWarnings(told, [key("notion", "a"), key("sentry", "y")])).toEqual([
      { serverName: "sentry", count: 1 },
    ]);
  });
});
