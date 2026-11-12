/** Tests how the Inbox search field turns typing into tokens, free text and suggestions. */
import { describe, expect, it } from "vitest";
import {
  EMPTY_INBOX_SEARCH,
  addInboxClause,
  commitInboxSearch,
  describeInboxClause,
  listInboxSuggestions,
  removeInboxClause,
  takeInboxSuggestion,
  typeInboxSearch,
  type InboxField,
  type InboxSearch,
  type InboxSearchContext,
} from "./inbox-search";

const FIELDS: InboxField[] = [
  { key: "team", label: "Team", type: "enum", source: "linear" },
  { key: "team", label: "Team", type: "enum", source: "sentry" },
  { key: "project", label: "Project", type: "text", source: "linear" },
  { key: "events", label: "Events", type: "number", source: "sentry" },
  { key: "waiting", label: "Waiting", type: "age" },
  { key: "asks", label: "Asks", type: "bool" },
  { key: "from", label: "From", type: "person" },
];

const CONTEXT: InboxSearchContext = {
  fields: FIELDS,
  suggestedValues: {
    team: [
      { value: "Payments", count: 3 },
      { value: "Checkout", count: 9 },
      { value: "Checkout revamp", count: 2 },
    ],
    project: [
      { value: "Checkout revamp", count: 4 },
      { value: "Checkout", count: 1 },
    ],
  },
};

function type(input: string, from: InboxSearch = EMPTY_INBOX_SEARCH): InboxSearch {
  return typeInboxSearch(from, input, CONTEXT);
}

describe("typing", () => {
  it("turns a finished token into a clause with no source, so it is cross-source", () => {
    const search = type("team:Payments ");
    expect(search.clauses).toEqual([{ key: "team", op: "is", value: "Payments" }]);
    expect(search.input).toBe("");
  });

  it("keeps free text and searches it", () => {
    const search = type("login bug team:Payments ");
    expect(search.clauses).toHaveLength(1);
    expect(search.input).toBe("login bug ");
    expect(search.text).toBe("login bug");
  });

  it("keeps the last clause open until a space finishes it", () => {
    const search = type("team:Check");
    expect(search.clauses).toEqual([]);
    expect(search.open).toEqual({ key: "team", typed: "Check" });
  });

  it("lets a value hold spaces when a suggested value goes on past the space", () => {
    const search = type("project:Checkout ");
    expect(search.clauses).toEqual([]);
    expect(search.open?.typed).toBe("Checkout ");
    expect(type("project:Checkout revamp ").clauses).toEqual([
      { key: "project", op: "is", value: "Checkout revamp" },
    ]);
  });

  it("takes a value that is exactly suggested as typed", () => {
    expect(type("team:Payments ").clauses[0]?.value).toBe("Payments");
  });

  it("completes a partial value to the most common suggestion on space", () => {
    expect(type("team:Check ").clauses).toEqual([{ key: "team", op: "is", value: "Checkout" }]);
  });

  it("takes a value nothing starts with as typed", () => {
    expect(type("team:Zebra ").clauses[0]?.value).toBe("Zebra");
  });

  it("ends an earlier value at the next key", () => {
    const search = type("team:Payments from:Ana Smith");
    expect(search.clauses).toEqual([{ key: "team", op: "is", value: "Payments" }]);
    expect(search.open).toEqual({ key: "from", typed: "Ana Smith" });
  });

  it("never searches a half-typed field name as free text", () => {
    expect(type("fix wai").text).toBe("fix");
    expect(type("wa").text).toBe("");
  });

  it("searches a short or unrelated word as free text", () => {
    expect(type("w").text).toBe("w");
    expect(type("wxyz").text).toBe("wxyz");
  });

  it("turns yes and no into booleans", () => {
    expect(type("asks:yes ").clauses).toEqual([{ key: "asks", op: "is", value: true }]);
    expect(type("asks:no ").clauses).toEqual([{ key: "asks", op: "is", value: false }]);
    expect(type("asks:y ").clauses).toEqual([{ key: "asks", op: "is", value: true }]);
  });
});

describe("thresholds", () => {
  it("reads a number threshold", () => {
    expect(type("events:>1000 ").clauses).toEqual([{ key: "events", op: "over", value: 1000 }]);
    expect(type("events:<5 ").clauses).toEqual([{ key: "events", op: "under", value: 5 }]);
  });

  it("converts durations to seconds", () => {
    const value = (typed: string) => type(`waiting:${typed} `).clauses[0];
    expect(value(">30m")).toEqual({ key: "waiting", op: "over", value: 1800 });
    expect(value(">4h")).toEqual({ key: "waiting", op: "over", value: 14_400 });
    expect(value(">2d")).toEqual({ key: "waiting", op: "over", value: 172_800 });
    expect(value("<1w")).toEqual({ key: "waiting", op: "under", value: 604_800 });
  });

  it("keeps a value that is no threshold in the field, searching nothing", () => {
    const search = type("events:abc ");
    expect(search.clauses).toEqual([]);
    expect(commitInboxSearch(search, CONTEXT).input).toBe("events:abc ");
    expect(commitInboxSearch(search, CONTEXT).clauses).toEqual([]);
  });

  it("offers the drawing's hints, with words", () => {
    const events = listInboxSuggestions(type("events:"), CONTEXT).items;
    expect(events.map((i) => i.kind === "value" && i.value)).toEqual([">100", ">1000", ">10000"]);
    expect(events[1]).toMatchObject({ hint: "more than 1,000" });
    const waiting = listInboxSuggestions(type("waiting:"), CONTEXT).items;
    expect(waiting.map((i) => i.kind === "value" && i.value)).toEqual([">4h", ">1d", ">2d", ">1w"]);
    expect(waiting[2]).toMatchObject({ hint: "waiting longer than 2d" });
  });

  it("lists a threshold typed in full first, as typed", () => {
    const items = listInboxSuggestions(type("events:>10"), CONTEXT).items;
    expect(items.map((i) => i.kind === "value" && i.value)).toEqual([
      ">10",
      ">100",
      ">1000",
      ">10000",
    ]);
    const whole = listInboxSuggestions(type("events:>1000"), CONTEXT).items;
    expect(whole[0]).toMatchObject({ value: ">1000" });
    expect(whole).toHaveLength(2);
  });
});

describe("leaving the field", () => {
  it("takes a value as typed when the suggestions hold it, not the highlighted one", () => {
    const search = type("team:Checkout");
    const highlighted = listInboxSuggestions(search, CONTEXT).items[0];
    const left = commitInboxSearch(search, CONTEXT, {
      ...highlighted!,
      value: "Payments",
    } as never);
    expect(left.clauses).toEqual([{ key: "team", op: "is", value: "Checkout" }]);
  });

  it("takes a whole threshold as typed", () => {
    const left = commitInboxSearch(type("waiting:>2d"), CONTEXT);
    expect(left.clauses).toEqual([{ key: "waiting", op: "over", value: 172_800 }]);
    expect(left.input).toBe("");
  });

  it("takes the highlighted suggestion for a partial value", () => {
    const search = type("team:Pay");
    const menu = listInboxSuggestions(search, CONTEXT);
    const left = commitInboxSearch(search, CONTEXT, menu.items[menu.highlighted]);
    expect(left.clauses).toEqual([{ key: "team", op: "is", value: "Payments" }]);
    expect(left.input).toBe("");
  });

  it("takes a partial value as typed when nothing is highlighted", () => {
    expect(commitInboxSearch(type("team:Pay"), CONTEXT).clauses[0]?.value).toBe("Pay");
  });

  it("searches a half-typed field name as free text", () => {
    expect(commitInboxSearch(type("fix wai"), CONTEXT).text).toBe("fix wai");
  });
});

describe("editing tokens", () => {
  it("removes the last token, and any token by index", () => {
    const search = type("team:Payments asks:yes events:>5 ");
    expect(search.clauses).toHaveLength(3);
    expect(removeInboxClause(search, 2).clauses.map((c) => c.key)).toEqual(["team", "asks"]);
    expect(removeInboxClause(search, 0).clauses.map((c) => c.key)).toEqual(["asks", "events"]);
    expect(removeInboxClause(EMPTY_INBOX_SEARCH, -1)).toBe(EMPTY_INBOX_SEARCH);
  });

  it("keeps the source and account of a clause picked from Browse or Narrow", () => {
    const picked = {
      key: "team",
      op: "is",
      value: "Checkout",
      source: "linear",
      connectionId: "c1",
    } as const;
    const search = addInboxClause(type("login "), picked);
    expect(search.clauses).toEqual([picked]);
    expect(search.input).toBe("login ");
  });
});

describe("suggestions", () => {
  it("highlights nothing when nothing is typed, and offers up to 8 fields", () => {
    const menu = listInboxSuggestions(EMPTY_INBOX_SEARCH, CONTEXT);
    expect(menu.highlighted).toBe(-1);
    expect(menu.items.map((i) => i.kind)).toEqual(Array(6).fill("field"));
    expect(menu.items.map((i) => i.kind === "field" && i.key)).toEqual([
      "team",
      "project",
      "events",
      "waiting",
      "asks",
      "from",
    ]);
  });

  it("offers the fields matching a partial key, after a free-text row, and highlights the first", () => {
    const menu = listInboxSuggestions(type("fix te"), CONTEXT);
    expect(menu.highlighted).toBe(0);
    expect(menu.items[0]).toMatchObject({ kind: "text", text: "fix te" });
    expect(menu.items[1]).toMatchObject({ kind: "field", key: "team", label: "team:" });
    expect(menu.items).toHaveLength(2);
  });

  it("offers the matching values most common first, with counts", () => {
    const items = listInboxSuggestions(type("team:C"), CONTEXT).items;
    expect(items.map((i) => i.kind === "value" && [i.value, i.count])).toEqual([
      ["Checkout", 9],
      ["Checkout revamp", 2],
    ]);
  });

  it("offers yes and no for a bool field", () => {
    const items = listInboxSuggestions(type("asks:"), CONTEXT).items;
    expect(items.map((i) => i.kind === "value" && i.value)).toEqual(["yes", "no"]);
  });

  it("takes a field suggestion by completing the word being typed", () => {
    const search = type("fix te");
    const field = listInboxSuggestions(search, CONTEXT).items[1]!;
    const taken = takeInboxSuggestion(search, field, CONTEXT);
    expect(taken.input).toBe("fix team:");
    expect(taken.open).toEqual({ key: "team", typed: "" });
  });

  it("takes a value suggestion as a clause and clears the clause being typed", () => {
    const search = type("fix team:Pay");
    const value = listInboxSuggestions(search, CONTEXT).items[0]!;
    const taken = takeInboxSuggestion(search, value, CONTEXT);
    expect(taken.clauses).toEqual([{ key: "team", op: "is", value: "Payments" }]);
    expect(taken.input).toBe("fix ");
    expect(taken.text).toBe("fix");
  });
});

describe("describing a clause", () => {
  it("shows the token as it was typed", () => {
    const d = (c: Parameters<typeof describeInboxClause>[0]) => describeInboxClause(c, FIELDS);
    expect(d({ key: "team", op: "is", value: "Checkout" })).toBe("team:Checkout");
    expect(d({ key: "events", op: "over", value: 1000 })).toBe("events:>1000");
    expect(d({ key: "waiting", op: "over", value: 172_800 })).toBe("waiting:>2d");
    expect(d({ key: "waiting", op: "under", value: 5400 })).toBe("waiting:<90m");
    expect(d({ key: "asks", op: "is", value: false })).toBe("asks:no");
  });
});
