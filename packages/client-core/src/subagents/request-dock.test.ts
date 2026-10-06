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
    expect(buildRequestDock([], SUBAGENTS, undefined, undefined)).toBeNull();
  });

  it("shows a lone Request of the main agent with no pager and no asker line", () => {
    expect(buildRequestDock([MAIN], SUBAGENTS, undefined, undefined)).toEqual({
      request: MAIN,
      position: null,
      previousRequestId: undefined,
      nextRequestId: undefined,
      asker: { kind: "main agent" },
      showsAskerLine: false,
    });
  });

  it("names the asker and its parent for a lone subagent Request, with no pager", () => {
    expect(buildRequestDock([FROM_CHILD], SUBAGENTS, undefined, undefined)).toMatchObject({
      position: null,
      asker: {
        kind: "subagent",
        subagentId: "a1",
        name: "Read the docs",
        parentName: "Check the iDEAL redirect",
      },
      showsAskerLine: true,
    });
  });

  it("names the main agent as the parent of a subagent the main agent started", () => {
    expect(buildRequestDock([FROM_PARENT], SUBAGENTS, undefined, undefined)).toMatchObject({
      asker: { parentName: "the main agent" },
    });
  });

  it("shows the oldest when none is named, and pages to the next", () => {
    expect(
      buildRequestDock([MAIN, FROM_CHILD, FROM_PARENT], SUBAGENTS, undefined, undefined),
    ).toMatchObject({
      request: MAIN,
      position: { at: 1, of: 3 },
      previousRequestId: undefined,
      nextRequestId: "r-child",
      asker: { kind: "main agent" },
      showsAskerLine: true,
    });
  });

  it("shows the named Request, with both neighbours", () => {
    expect(
      buildRequestDock([MAIN, FROM_CHILD, FROM_PARENT], SUBAGENTS, undefined, "r-child"),
    ).toMatchObject({
      request: FROM_CHILD,
      position: { at: 2, of: 3 },
      previousRequestId: "r-main",
      nextRequestId: "r-parent",
    });
  });

  it("falls back to the oldest once the named Request has closed", () => {
    expect(buildRequestDock([MAIN, FROM_PARENT], SUBAGENTS, undefined, "r-child")?.request).toBe(
      MAIN,
    );
  });

  it("names an asker whose record is not read yet by the name on its Request, with no known parent", () => {
    const named = { ...FROM_CHILD, subagentName: "Read the docs" };
    expect(buildRequestDock([named], [], undefined, undefined)?.asker).toEqual({
      kind: "subagent",
      subagentId: "a1",
      name: "Read the docs",
      parentName: null,
    });
  });

  it("names an asker with no record read and no name on its Request as A subagent", () => {
    expect(buildRequestDock([FROM_CHILD], [], undefined, undefined)?.asker).toEqual({
      kind: "subagent",
      subagentId: "a1",
      name: "A subagent",
      parentName: null,
    });
  });

  it("pages through only the subagent's own Requests on its page, naming no asker", () => {
    const OTHER_CHILD = buildRequest("r-child-2", "a1");
    expect(
      buildRequestDock([MAIN, FROM_CHILD, FROM_PARENT, OTHER_CHILD], SUBAGENTS, "a1", undefined),
    ).toMatchObject({
      request: FROM_CHILD,
      position: { at: 1, of: 2 },
      nextRequestId: "r-child-2",
      asker: null,
      showsAskerLine: true,
    });
  });

  it("draws no line on a subagent's page while only one of its Requests is open", () => {
    expect(buildRequestDock([MAIN, FROM_CHILD], SUBAGENTS, "a1", undefined)).toMatchObject({
      request: FROM_CHILD,
      position: null,
      asker: null,
      showsAskerLine: false,
    });
  });

  it("returns null on a subagent's page when none of the open Requests is its own", () => {
    expect(buildRequestDock([MAIN, FROM_PARENT], SUBAGENTS, "a1", undefined)).toBeNull();
  });
});
