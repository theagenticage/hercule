/** Tests the Work board's Filter menu: its rows, the cards each row has, what each value would leave. */
import { describe, expect, it } from "vitest";
import { countFacetValues, dropEmptyValues, filterItems, toggleFilterValue } from "../desk/filter";
import { buildCard, buildBoard, FAILURE, listIds, QUESTION } from "./cards.testing";
import { buildWorkFacets } from "./facets";
import { buildLanes } from "./lanes";

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

const FACETS = buildWorkFacets(buildLanes(BOARD, PROJECTS));
const [STATE, PROJECT] = FACETS;

describe("buildWorkFacets", () => {
  it("lists the state rows with the design's words, and the Projects of the lanes", () => {
    expect(STATE?.values.map((value) => value.name)).toEqual([
      "Has a question",
      "Failed",
      "With an agent",
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
    expect(STATE?.values.map((value) => value.liftsItself)).toEqual([true, true, undefined]);
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
    });
  });

  it("does not exclude a failed card from With an agent", () => {
    const failedAndBusy = buildCard("both", { failure: FAILURE, workingSessionId: "s3" });
    const facets = buildWorkFacets(buildLanes(buildBoard(failedAndBusy), PROJECTS));
    expect(listIds(filterItems([failedAndBusy], { state: ["agent"] }, facets))).toEqual(["both"]);
  });
});
