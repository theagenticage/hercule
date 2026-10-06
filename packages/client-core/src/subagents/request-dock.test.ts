/**
 * Tests `buildRequestDock`, which decides which open Request the dock shows,
 * the pager around it, and who asked it.
 */
import { describe, expect, it } from "vitest";
import { buildRequestDock } from "./request-dock";
import { buildRequest, buildSubagent } from "./subagents.testing";

const PARENT = buildSubagent({ id: "a", description: "Check the iDEAL redirect" });
const CHILD = buildSubagent({ id: "a1", parentSubagentId: "a", description: "Read the docs" });
const SUBAGENTS = [PARENT, CHILD];

const MAIN = buildRequest("r-main");
const FROM_CHILD = buildRequest("r-child", "a1");
const FROM_PARENT = buildRequest("r-parent", "a");

describe("buildRequestDock", () => {
  it("returns null when no Request is open", () => {
    expect(buildRequestDock([], SUBAGENTS, undefined)).toBeNull();
  });

  it("shows a lone Request of the main agent with no pager and no asker line", () => {
    expect(buildRequestDock([MAIN], SUBAGENTS, undefined)).toEqual({
      request: MAIN,
      position: null,
      previousRequestId: undefined,
      nextRequestId: undefined,
      asker: null,
      showsAskerLine: false,
    });
  });

  it("names the asker and its parent for a lone subagent Request, with no pager", () => {
    expect(buildRequestDock([FROM_CHILD], SUBAGENTS, undefined)).toMatchObject({
      position: null,
      asker: { subagentId: "a1", name: "Read the docs", parentName: "Check the iDEAL redirect" },
      showsAskerLine: true,
    });
  });

  it("names the main agent as the parent of a subagent the main agent started", () => {
    expect(buildRequestDock([FROM_PARENT], SUBAGENTS, undefined)?.asker?.parentName).toBe(
      "the main agent",
    );
  });

  it("shows the oldest when none is named, and pages to the next", () => {
    expect(buildRequestDock([MAIN, FROM_CHILD, FROM_PARENT], SUBAGENTS, undefined)).toMatchObject({
      request: MAIN,
      position: { at: 1, of: 3 },
      previousRequestId: undefined,
      nextRequestId: "r-child",
      asker: null,
      showsAskerLine: true,
    });
  });

  it("shows the named Request, with both neighbours", () => {
    expect(buildRequestDock([MAIN, FROM_CHILD, FROM_PARENT], SUBAGENTS, "r-child")).toMatchObject({
      request: FROM_CHILD,
      position: { at: 2, of: 3 },
      previousRequestId: "r-main",
      nextRequestId: "r-parent",
    });
  });

  it("falls back to the oldest once the named Request has closed", () => {
    expect(buildRequestDock([MAIN, FROM_PARENT], SUBAGENTS, "r-child")?.request).toBe(MAIN);
  });

  it("names an asker whose record is not read yet as A subagent, with no known parent", () => {
    expect(buildRequestDock([FROM_CHILD], [], undefined)?.asker).toEqual({
      subagentId: "a1",
      name: "A subagent",
      parentName: null,
    });
  });
});
