/**
 * Tests what the Add sheet says: the line under the search, which list shows
 * for each outcome of a search with its exact sentence, the suggestion
 * groups, and the line that reports an add.
 */
import { describe, expect, it } from "vitest";
import type { EntitySearchReply, EntitySearchResult, EntitySuggestions } from "@hercule/contract";
import {
  buildResultRows,
  buildSuggestionGroups,
  decideAddList,
  describeAddedLine,
  describeSearchLine,
  describeSearchPlaceholder,
  type AddListView,
  type SearchState,
} from "./add-list";
import { buildPlace } from "./cards.testing";

const NAMES = new Map([
  ["relay", "Relay"],
  ["acme", "Acme"],
  ["sentry", "Sentry"],
]);
const BASKET: Parameters<typeof describeSearchLine>[0]["scope"] = {
  ref: "relay:project:basket",
  title: "Basket rebuild",
  label: "Basket rebuild (project)",
};

const buildResult = (overrides: Partial<EntitySearchResult> = {}): EntitySearchResult => ({
  ref: "relay:issue:301",
  kind: "relay/issue",
  noun: "Issue",
  identifier: "WEB-301",
  title: "Gift message is cut off at 140 characters",
  location: "Gift cards",
  status: { shape: "dashed", tone: "quiet", label: "Backlog" },
  standing: "new",
  ...overrides,
});

/** Returns a result of a link that no Connection can read: no title, identifier or address. */
const buildUnreadableResult = (): EntitySearchResult => ({
  ref: "relay:issue:301",
  kind: "relay/issue",
  noun: "Issue",
  standing: "new",
});

const buildReply = (overrides: Partial<EntitySearchReply> = {}): EntitySearchReply => ({
  source: "relay",
  outcome: "results",
  results: [buildResult()],
  incomplete: false,
  linkSources: [],
  ...overrides,
});

const answered = (overrides: Partial<EntitySearchReply> = {}): SearchState => ({
  status: "answered",
  reply: buildReply(overrides),
});

/** Decides the list for a search on "Relay", with the words "toaster" unless `input` says otherwise. */
const decide = (
  search: SearchState,
  input: Partial<Parameters<typeof decideAddList>[0]> = {},
): AddListView =>
  decideAddList({
    sourceName: "Relay",
    names: NAMES,
    text: "toaster",
    isLink: false,
    isOffline: false,
    scope: undefined,
    search,
    ...input,
  });

describe("describeSearchLine", () => {
  it("says the search reaches all of the source, or one context of it", () => {
    expect(
      describeSearchLine({
        sourceName: "Relay",
        scope: undefined,
        isOffline: false,
        isLink: false,
      }),
    ).toEqual({ kind: "scope", lead: "Searches", allLabel: "all of Relay", trailing: null });
    expect(
      describeSearchLine({ sourceName: "Relay", scope: BASKET, isOffline: false, isLink: false }),
    ).toEqual({ kind: "scope", lead: "Searches", allLabel: "all of Relay", trailing: "in Relay" });
  });

  it("says the source cannot be searched while offline", () => {
    expect(
      describeSearchLine({ sourceName: "Relay", scope: BASKET, isOffline: true, isLink: true }),
    ).toEqual({
      kind: "offline",
      text: "You are offline, so Relay cannot be searched. Typing only narrows the suggestions.",
    });
  });

  it("says a pasted link is read, and from which source once that is known", () => {
    const base = { sourceName: "Relay", scope: undefined, isOffline: false, isLink: true };

    expect(describeSearchLine(base)).toEqual({ kind: "link", text: "Reading this link." });
    expect(describeSearchLine({ ...base, linkSourceName: "Acme" })).toEqual({
      kind: "link",
      text: "Reading this link from Acme.",
    });
  });

  it("names the source in what the field is for", () => {
    expect(describeSearchPlaceholder("Relay")).toBe("Search Relay, or paste a link");
  });
});

describe("decideAddList", () => {
  it("lists suggestions before anything is searched, and says they are not everything", () => {
    expect(decide({ status: "idle" }, { text: "" })).toEqual({
      kind: "suggestions",
      title: "Suggestions",
      text: "Things that concern you, with no Task yet. Search to reach everything else.",
    });
  });

  it("lists suggestions offline whatever is typed, without the offer to search", () => {
    expect(decide({ status: "pending" }, { isOffline: true })).toEqual({
      kind: "suggestions",
      title: "Suggestions",
      text: "Things that concern you, with no Task yet.",
    });
  });

  it("shows bars while a search waits, with no spinner", () => {
    expect(decide({ status: "pending" })).toEqual({ kind: "searching", text: "Searching Relay…" });
    expect(decide({ status: "pending" }, { isLink: true })).toEqual({
      kind: "searching",
      text: "Reading this link…",
    });
  });

  it("says the search failed, with the reason", () => {
    expect(decide({ status: "failed", reason: "The controller did not answer." })).toMatchObject({
      kind: "message",
      text: "Could not search Relay. The controller did not answer.",
    });
  });

  it("heads results with the source and counts them", () => {
    const view = decide(
      answered({
        results: [buildResult(), buildResult({ ref: "relay:issue:302", identifier: "WEB-302" })],
      }),
    );

    expect(view).toMatchObject({ kind: "results", heading: "From Relay", caption: "2 results" });
    expect(decide(answered())).toMatchObject({ caption: "1 result" });
  });

  it("says a link's result was found from the link", () => {
    expect(decide(answered(), { isLink: true })).toMatchObject({
      kind: "results",
      caption: "Found from the link",
    });
  });

  it("warns that a list may be short when a connection did not answer", () => {
    const note = "Not every Relay account answered, so this list may be short.";

    expect(decide(answered({ incomplete: true }))).toMatchObject({ note });
    expect(
      decide(answered({ outcome: "incomplete", results: [], incomplete: true })),
    ).toMatchObject({ kind: "message", text: note });
  });

  it.each([
    ["no match", answered({ outcome: "no-match", results: [] })],
    ["a link or identifier that is not found", answered({ outcome: "not-found", results: [] })],
    ["a source that cannot tell", answered({ outcome: "unknown", results: [] })],
  ])("says the source has nothing for words, for %s", (_name, search) => {
    expect(decide(search)).toEqual({
      kind: "message",
      text: 'Relay has nothing that matches "toaster".',
      widenLabel: undefined,
      lockedHint: undefined,
    });
  });

  it("names the context in a narrowed search and offers to search all of the source", () => {
    expect(decide(answered({ outcome: "no-match", results: [] }), { scope: BASKET })).toEqual({
      kind: "message",
      text: 'Nothing in Basket rebuild matches "toaster".',
      widenLabel: "Search all of Relay",
      lockedHint: undefined,
    });
  });

  it("says a link you cannot open, as a lock with no title", () => {
    const search = answered({
      outcome: "inaccessible",
      results: [buildUnreadableResult()],
    });

    expect(decide(search, { isLink: true })).toEqual({
      kind: "message",
      text: "You cannot open this Relay issue.",
      widenLabel: undefined,
      lockedHint:
        "It exists, but your connection to Relay has no access to it. Ask for access, then paste the link again.",
    });
  });

  it("says a link to nothing", () => {
    expect(decide(answered({ outcome: "not-found", results: [] }), { isLink: true })).toMatchObject(
      {
        text: "Relay found nothing at this link. It may be wrong, or the thing may be gone.",
      },
    );
    expect(decide(answered({ outcome: "unknown", results: [] }), { isLink: true })).toMatchObject({
      text: "Relay found nothing at this link. It may be wrong, or the thing may be gone.",
    });
  });

  it("names the sources that can read links when a link is from elsewhere", () => {
    const search = answered({
      outcome: "unknown-link",
      results: [],
      linkSources: ["relay", "acme", "sentry"],
    });

    expect(decide(search, { isLink: true })).toMatchObject({
      text: "This link is not from a connected source. Hercule can read links from Relay, Acme, Sentry.",
    });
  });

  it("says a source with no connection cannot be searched", () => {
    expect(decide(answered({ outcome: "source-unavailable", results: [] }))).toMatchObject({
      text: "Relay has no connection to search. Add one in Connections.",
    });
  });

  it("says an identifier is ambiguous", () => {
    expect(
      decide(answered({ outcome: "ambiguous", results: [] }), { text: "SHOP-1" }),
    ).toMatchObject({
      text: '"SHOP-1" names different things in different workspaces of Relay. Paste its link instead.',
    });
  });
});

describe("buildResultRows", () => {
  it("says where a thing sits, and that Hercule has not seen it", () => {
    expect(buildResultRows([buildResult()])).toEqual([
      {
        ref: "relay:issue:301",
        identifier: "WEB-301",
        title: "Gift message is cut off at 140 characters",
        note: "Gift cards · New to Hercule",
        state: "Backlog",
        taskId: undefined,
      },
    ]);
  });

  it("gives a thing that is on Work its Task, so a click opens it", () => {
    const [row] = buildResultRows([buildResult({ standing: "on-work", taskId: "task-1" })]);

    expect(row).toMatchObject({ taskId: "task-1", note: "Gift cards" });
  });

  it("leaves out a result with no title", () => {
    expect(buildResultRows([buildUnreadableResult()])).toEqual([]);
  });
});

describe("buildSuggestionGroups", () => {
  const BASKET_PLACE = buildPlace("relay:project:basket", "Basket rebuild", {
    kind: "relay/project",
    noun: "Project",
    caption: "Relay project",
    status: { shape: "half", tone: "active", label: "In progress" },
    progress: { fraction: 0.4, done: 9, total: 22 },
  });
  const PRICING_PLACE = buildPlace("relay:project:pricing", "Pricing rules", {
    kind: "relay/project",
    caption: "Relay project",
  });
  const suggestion = (
    ref: string,
    identifier: string,
    alsoIn: readonly string[],
    kind = "relay/issue",
  ): EntitySuggestions["suggestions"][number] => ({
    ref,
    kind,
    noun: "Issue",
    identifier,
    title: `Title of ${identifier}`,
    url: `https://relay.example/${identifier}`,
    status: { shape: "dashed", tone: "quiet", label: "Todo" },
    alsoIn: [...alsoIn],
  });
  const REPLY: EntitySuggestions = {
    suggestions: [
      suggestion("relay:issue:1", "WEB-1", [BASKET_PLACE.ref]),
      suggestion("relay:issue:2", "WEB-2", [PRICING_PLACE.ref, BASKET_PLACE.ref]),
      suggestion("relay:issue:3", "WEB-3", [BASKET_PLACE.ref]),
      suggestion("acme:pr:1", "#9", [], "acme/pull-request"),
    ],
    places: [PRICING_PLACE],
    truncated: false,
  };
  const build = (overrides: Partial<Parameters<typeof buildSuggestionGroups>[0]> = {}) =>
    buildSuggestionGroups({
      reply: REPLY,
      places: [BASKET_PLACE],
      sourceId: "relay",
      scopeRef: undefined,
      narrowedBy: "",
      ...overrides,
    });

  it("lists a thing once under its first context, and names its other contexts", () => {
    const groups = build();

    expect(groups.map((group) => [group.ref, group.rows.map((row) => row.identifier)])).toEqual([
      [BASKET_PLACE.ref, ["WEB-1", "WEB-3"]],
      [PRICING_PLACE.ref, ["WEB-2"]],
    ]);
    expect(groups[1]?.rows[0]?.note).toBe("Also in Basket rebuild");
    expect(groups[0]?.rows[0]?.note).toBeUndefined();
  });

  it("heads a group with the context's title, what it says about itself and its progress", () => {
    expect(build()[0]?.heading).toEqual({
      title: "Basket rebuild",
      facts: "Relay project · In progress",
      progress: { fraction: 0.4, words: "9 of 22" },
    });
  });

  it("puts every thing under the chosen context and names all its other contexts", () => {
    const groups = build({ scopeRef: BASKET_PLACE.ref });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.ref).toBe(BASKET_PLACE.ref);
    expect(groups[0]?.rows.find((row) => row.identifier === "WEB-2")?.note).toBe(
      "Also in Pricing rules, Basket rebuild",
    );
  });

  it("lists only the things of the source", () => {
    expect(
      build({ sourceId: "acme" }).flatMap((group) => group.rows.map((row) => row.identifier)),
    ).toEqual(["#9"]);
  });

  it("puts a thing with no context under no heading", () => {
    expect(build({ sourceId: "acme" })[0]?.heading).toBeUndefined();
  });

  it("narrows the things by what is typed, ignoring case", () => {
    const rows = build({ narrowedBy: "title of web-3" }).flatMap((group) => group.rows);

    expect(rows.map((row) => row.identifier)).toEqual(["WEB-3"]);
  });
});

describe("describeAddedLine", () => {
  it("says where the Task went and that Hercule follows a thing it had not seen", () => {
    expect(
      describeAddedLine({
        stage: "exploring",
        identifier: "WEB-301",
        followed: true,
        created: true,
      }),
    ).toBe("Added to Exploring. Hercule now follows WEB-301.");
  });

  it("leaves out the following when the thing already concerned the user", () => {
    expect(
      describeAddedLine({ stage: "in-review", identifier: "#9", followed: false, created: true }),
    ).toBe("Added to In review.");
  });

  it("says a thing that already had a Task is on Work, and adds nothing", () => {
    expect(
      describeAddedLine({ stage: "building", identifier: "#9", followed: false, created: false }),
    ).toBe("#9 is already on Work, in Building.");
  });
});
