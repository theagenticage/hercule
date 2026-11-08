/** Tests the Work board's Filter menu: its rows, the cards each row has, what each value would leave. */
import { describe, expect, it } from "vitest";
import { countFacetValues, dropEmptyValues, filterItems, toggleFilterValue } from "../desk/filter";
import { buildCard, buildBoard, buildPlace, FAILURE, listIds, QUESTION } from "./cards.testing";
import { buildWorkFacets, FAILED_FILTER } from "./facets";
import { buildLanes } from "./lanes";

const BLOCKER = { id: "b", title: "Add a refund button", stage: "building" as const };

const PROJECTS = [
  { id: "depots", name: "Depot returns" },
  { id: "pricing", name: "Pricing rules" },
];

const BOARD = buildBoard(
  buildCard("asks", { projectId: "depots", openQuestion: QUESTION, workingSessionId: "s1" }),
  buildCard("broke", { projectId: "depots", failure: FAILURE }),
  buildCard("busy", { projectId: "pricing", workingSessionId: "s2" }),
  buildCard("quiet", { projectId: "pricing" }),
  buildCard("orphan", { projectId: "deleted" }),
  buildCard("loose"),
);

const FACETS = buildWorkFacets(buildLanes(BOARD, PROJECTS), BOARD, [], []);
const [STATE, PROJECT] = FACETS;

describe("buildWorkFacets", () => {
  it("lists the state rows with the design's words, and the Projects of the lanes", () => {
    expect(STATE?.values.map((value) => value.name)).toEqual([
      "Has a question",
      "Failed",
      "With an agent",
      "Blocked",
    ]);
    expect(STATE?.caption).toBe("");
    expect(PROJECT?.caption).toBe("Project");
    expect(PROJECT?.values.map((value) => value.name)).toEqual([
      "Depot returns",
      "Pricing rules",
      "No project",
    ]);
  });

  it("lifts Has a question and Failed by themselves, and With an agent never", () => {
    expect(STATE?.values.map((value) => value.liftsItself)).toEqual([
      true,
      true,
      undefined,
      undefined,
    ]);
    const filter = toggleFilterValue(toggleFilterValue({}, "state", "agent"), "state", "failed");
    expect(dropEmptyValues(filter, FACETS, [buildCard("quiet")])).toEqual({ state: ["agent"] });
  });

  it.each([
    ["Has a question", "state", "question", ["asks"]],
    ["Failed", "state", "failed", ["broke"]],
    ["With an agent", "state", "agent", ["asks", "busy"]],
    ["a Project", "project", "pricing", ["busy", "quiet"]],
    [
      "No project, which also holds a deleted Project's card",
      "project",
      "no-project",
      ["orphan", "loose"],
    ],
  ])("leaves the cards that have %s", (_, facetId, valueId, expected) => {
    expect(listIds(filterItems(BOARD.cards, { [facetId]: [valueId] }, FACETS))).toEqual(expected);
  });

  it("counts what each value would leave, with the other facets narrowing", () => {
    const [, project] = FACETS;
    const filter = { state: ["agent"] };
    expect(countFacetValues(BOARD.cards, filter, FACETS, project!)).toEqual({
      depots: 1,
      pricing: 1,
      "no-project": 0,
    });
    const [state] = FACETS;
    expect(countFacetValues(BOARD.cards, { project: ["pricing"] }, FACETS, state!)).toEqual({
      question: 0,
      failed: 0,
      agent: 1,
      blocked: 0,
    });
  });

  it("has a ready-made filter that leaves only the cards with a failed run", () => {
    expect(listIds(filterItems(BOARD.cards, FAILED_FILTER, FACETS))).toEqual(["broke"]);
  });

  it("does not exclude a failed card from With an agent", () => {
    const failedAndBusy = buildCard("both", { failure: FAILURE, workingSessionId: "s3" });
    const facets = buildWorkFacets(
      buildLanes(buildBoard(failedAndBusy), PROJECTS),
      buildBoard(failedAndBusy),
      [],
      [],
    );
    expect(listIds(filterItems([failedAndBusy], { state: ["agent"] }, facets))).toEqual(["both"]);
  });
});

describe("the facets of outside places", () => {
  const mark = (plugin: string, kind: string) => ({ plugin, kind });
  const board = {
    ...buildBoard(
      buildCard("tracked", {
        projectId: "depots",
        entityMarks: [mark("acme", "acme/issue")],
        contextRefs: ["acme:project:returns", "acme:project:pricing"],
      }),
      buildCard("coded", {
        projectId: "depots",
        entityMarks: [mark("relay", "relay/pull-request"), mark("acme", "acme/issue")],
        contextRefs: ["acme:project:pricing"],
      }),
      buildCard("plain", { projectId: "pricing" }),
    ),
    places: [
      buildPlace("acme:project:returns", "Returns at the depots"),
      buildPlace("acme:project:pricing", "Pricing rules"),
    ],
    groupings: [{ kind: "acme/project", caption: "Acme project" }],
  };
  const plugins = [
    { id: "acme", displayName: "Acme Tracker" },
    { id: "relay", displayName: "Relay" },
  ];
  const facets = buildWorkFacets(buildLanes(board, PROJECTS), board, [], plugins);

  it("lists Source and then each groupable kind, after State and Project", () => {
    expect(facets.map((facet) => [facet.id, facet.caption])).toEqual([
      ["state", ""],
      ["project", "Project"],
      ["source", "Source"],
      ["acme/project", "Acme project"],
    ]);
  });

  it("puts only the outside places under the From your sources heading", () => {
    expect(facets.map((facet) => facet.heading)).toEqual([
      undefined,
      undefined,
      undefined,
      "From your sources",
    ]);
  });

  it("has no Source facet when no card links anything outside", () => {
    const plain = buildBoard(buildCard("plain"));
    expect(
      buildWorkFacets(buildLanes(plain, PROJECTS), plain, [], []).map((facet) => facet.id),
    ).toEqual(["state", "project"]);
  });

  it("names the Source values by plugin and ends with No source", () => {
    expect(facets[2]?.values.map((value) => value.name)).toEqual([
      "Acme Tracker",
      "Relay",
      "No source",
    ]);
  });

  it.each([
    ["a plugin", "source", "relay", ["coded"]],
    ["one plugin among two marks", "source", "acme", ["tracked", "coded"]],
    ["no source", "source", "(none)", ["plain"]],
    ["a place", "acme/project", "acme:project:returns", ["tracked"]],
    ["a place above two cards", "acme/project", "acme:project:pricing", ["tracked", "coded"]],
  ])("leaves the cards that have %s", (_, facetId, valueId, expected) => {
    expect(listIds(filterItems(board.cards, { [facetId]: [valueId] }, facets))).toEqual(expected);
  });

  it("only narrows: the cards keep their Project", () => {
    const left = filterItems(board.cards, { "acme/project": ["acme:project:pricing"] }, facets);
    expect(left.map((card) => card.projectId)).toEqual(["depots", "depots"]);
  });

  it("counts what each place would leave, with the other facets narrowing", () => {
    const place = facets[3]!;
    expect(countFacetValues(board.cards, { source: ["relay"] }, facets, place)).toEqual({
      "acme:project:returns": 0,
      "acme:project:pricing": 1,
    });
  });
});

describe("Blocked and Initiative", () => {
  const PLATFORM = { id: "platform", name: "Platform", hue: 245 as const };
  const LAUNCH = { id: "launch", name: "Spring launch", hue: 150 as const };
  const board = buildBoard(
    buildCard("waits", { blockedBy: [BLOCKER], blockedByCount: 1 }),
    buildCard("waits-and-broke", { blockedBy: [BLOCKER], blockedByCount: 1, failure: FAILURE }),
    buildCard("free", { initiativeId: "platform" }),
    buildCard("closed", { initiativeId: "closed-one" }),
  );
  const facets = buildWorkFacets(buildLanes(board, PROJECTS), board, [PLATFORM, LAUNCH], []);

  it("has a Blocked state row that every card with a blocker has, failed or not", () => {
    expect(listIds(filterItems(board.cards, { state: ["blocked"] }, facets))).toEqual([
      "waits",
      "waits-and-broke",
    ]);
  });

  it("lists the open Initiatives in list order with their hue, between Project and the rest", () => {
    expect(facets.map((facet) => facet.id)).toEqual(["state", "project", "initiative"]);
    expect(facets[2]).toMatchObject({
      caption: "Initiative",
      values: [
        { id: "platform", name: "Platform", hue: 245 },
        { id: "launch", name: "Spring launch", hue: 150 },
      ],
    });
  });

  it("filters by an Initiative, and a card on a closed one has no value", () => {
    expect(listIds(filterItems(board.cards, { initiative: ["platform"] }, facets))).toEqual([
      "free",
    ]);
    expect(listIds(filterItems(board.cards, { initiative: ["closed-one"] }, facets))).toEqual([
      "closed",
    ]);
  });

  it("has no Initiative facet when there is no open Initiative", () => {
    expect(buildWorkFacets(buildLanes(board, PROJECTS), board, [], []).map((f) => f.id)).toEqual([
      "state",
      "project",
    ]);
  });

  it("keeps an outside initiative under its own caption and id", () => {
    const outside = {
      ...buildBoard(buildCard("c", { contextRefs: ["linear:init:1"] })),
      places: [
        buildPlace("linear:init:1", "Returns at the depots", {
          kind: "linear/initiative",
          noun: "Initiative",
          caption: "Linear initiative",
        }),
      ],
      groupings: [{ kind: "linear/initiative", caption: "Linear initiative" }],
    };
    const both = buildWorkFacets(buildLanes(outside, PROJECTS), outside, [PLATFORM], []);
    expect(both.map((facet) => [facet.id, facet.caption])).toEqual([
      ["state", ""],
      ["project", "Project"],
      ["initiative", "Initiative"],
      ["linear/initiative", "Linear initiative"],
    ]);
    expect(
      listIds(filterItems(outside.cards, { "linear/initiative": ["linear:init:1"] }, both)),
    ).toEqual(["c"]);
  });
});
