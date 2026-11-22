/**
 * Tests how the gateway names a session's tools (spec 21 section 3.4): a name
 * is a pure function of the tool, a valid original name stays as it is, every
 * changed name ends in a hash, and the whole name fits behind `mcp__tools__`.
 */
import { describe, expect, it } from "vitest";
import { buildToolName, buildToolNames, findOriginalToolName } from "./tool-names";

/** What is left of 64 characters after the harness's `mcp__tools__`. */
const MAX_NAME_LENGTH = 52;

/** A changed name ends in `_` and six hex characters. */
const CHANGED_ENDING = /_[0-9a-f]{6}$/;

const nameOf = (tool: string, serverName = "sentry"): string => buildToolName({ serverName, tool });

describe("buildToolName", () => {
  it("keeps an original name of letters, digits, underscores and hyphens as it is", () => {
    expect(nameOf("search_issues")).toBe("sentry__search_issues");
    expect(nameOf("search-pages")).toBe("sentry__search-pages");
    expect(nameOf("GetIssue2")).toBe("sentry__GetIssue2");
  });

  it("changes a name with any other character: the character becomes an underscore and a hash follows", () => {
    expect(nameOf("get-issue.details")).toMatch(/^sentry__get-issue_details_[0-9a-f]{6}$/);
    expect(nameOf("a b")).toMatch(/^sentry__a_b_[0-9a-f]{6}$/);
    expect(nameOf("")).toMatch(CHANGED_ENDING);
  });

  it("gives a changed name its hash even when no other tool would clash with it", () => {
    expect(nameOf("a.b")).toMatch(CHANGED_ENDING);
  });

  it("changes an original that ends in an underscore and six hex characters, so it never equals a changed name", () => {
    const original = "list_abc123";
    expect(nameOf(original)).toMatch(/^sentry__list_abc123_[0-9a-f]{6}$/);
    // The changed name of another tool is exactly such a name, and is not this one's.
    expect(nameOf("list.")).not.toBe(nameOf(original));
    // Capital letters are not the hash's alphabet, so they are not reserved.
    expect(nameOf("list_ABCDEF")).toBe("sentry__list_ABCDEF");
  });

  it("cuts a name that passes the limit behind mcp__tools__, keeps the hash and keeps long names apart", () => {
    const long = "a".repeat(80);
    const names = [nameOf(`${long}_one`), nameOf(`${long}_two`)];
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name.length).toBe(MAX_NAME_LENGTH);
      expect(name).toMatch(/^sentry__a+_[0-9a-f]{6}$/);
    }
  });

  it("keeps a name of exactly the limit and changes one a character longer", () => {
    const room = MAX_NAME_LENGTH - "sentry__".length;
    expect(nameOf("a".repeat(room))).toBe(`sentry__${"a".repeat(room)}`);
    expect(nameOf("a".repeat(room + 1))).toMatch(CHANGED_ENDING);
    expect(nameOf("a".repeat(room + 1)).length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
  });

  it("fits the limit for the longest server name and the longest tool name", () => {
    const name = nameOf("x".repeat(500), "a".repeat(16));
    expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(name).toMatch(CHANGED_ENDING);
  });

  it("gives tools that differ only in a replaced character different names", () => {
    expect(nameOf("a.b")).not.toBe(nameOf("a b"));
  });
});

describe("buildToolNames", () => {
  it("gives a tool the same name whatever else is in the list", () => {
    const alone = buildToolNames([{ serverName: "notion", tools: ["search_pages"] }]);
    const crowded = buildToolNames([
      { serverName: "notion", tools: ["search-pages", "search.pages", "search_pages"] },
      { serverName: "linear", tools: ["search_pages"] },
    ]);
    const find = (names: typeof alone, serverName: string, tool: string) =>
      names.named.find((one) => one.serverName === serverName && one.tool === tool)?.name;
    expect(find(alone, "notion", "search_pages")).toBe("notion__search_pages");
    expect(find(crowded, "notion", "search_pages")).toBe("notion__search_pages");
    expect(find(crowded, "notion", "search-pages")).toBe("notion__search-pages");
    expect(find(crowded, "notion", "search.pages")).toMatch(/^notion__search_pages_[0-9a-f]{6}$/);
    expect(crowded.leftOut).toEqual([]);
  });

  it("orders the names by server name and then by the tool's original name", () => {
    const { named } = buildToolNames([
      { serverName: "sentry", tools: ["b", "a"] },
      { serverName: "linear", tools: ["z"] },
    ]);
    expect(named.map((one) => `${one.serverName}/${one.tool}`)).toEqual([
      "linear/z",
      "sentry/a",
      "sentry/b",
    ]);
  });

  it("leaves out both tools of one server whose names coincide, and names the others", () => {
    // A real clash needs two 24-bit hashes that agree, which a test cannot find, so the list names one tool twice.
    const { named, leftOut } = buildToolNames([
      { serverName: "sentry", tools: ["echo", "twin", "twin"] },
    ]);
    expect(named.map((one) => one.tool)).toEqual(["echo"]);
    expect(leftOut).toEqual([
      { serverName: "sentry", tool: "twin" },
      { serverName: "sentry", tool: "twin" },
    ]);
  });
});

describe("a tool whose original name is not well-formed Unicode", () => {
  // Two different lone surrogates both become the replacement character when hashed or normalized.
  const first = "a\uD800b";
  const second = "a\uD801b";

  it("is left out of the list, and is not counted as a tool that clashes", () => {
    const { named, leftOut } = buildToolNames([
      { serverName: "notion", tools: [first, "smile\u{1F600}", "search", second] },
    ]);
    // A character outside the basic plane is a pair of surrogates, and is well-formed.
    expect(named.map((one) => one.tool)).toEqual(["search", "smile\u{1F600}"]);
    expect(leftOut).toEqual([
      { serverName: "notion", tool: first },
      { serverName: "notion", tool: second },
    ]);
  });

  it("never matches a name in lookup, not even the name the other lone surrogate would give", () => {
    const name = buildToolName({ serverName: "notion", tool: first });
    expect(name).toBe(buildToolName({ serverName: "notion", tool: second }));
    expect(findOriginalToolName("notion", [first, second], name)).toBeUndefined();
    expect(findOriginalToolName("notion", [first, "search"], "notion__search")).toBe("search");
  });
});

describe("findOriginalToolName", () => {
  const listed = ["search_pages", "search-pages", "search.pages"];

  it("returns the original name of the listed tool the gateway name stands for", () => {
    for (const tool of listed) {
      expect(findOriginalToolName("notion", listed, nameOf(tool, "notion"))).toBe(tool);
    }
  });

  it("returns undefined for a name no listed tool has, after the tool left the list", () => {
    expect(
      findOriginalToolName("notion", ["search-pages"], nameOf("search_pages", "notion")),
    ).toBeUndefined();
  });

  it("returns undefined when two listed tools have the name, because neither is offered", () => {
    expect(findOriginalToolName("notion", ["twin", "twin"], "notion__twin")).toBeUndefined();
  });
});
