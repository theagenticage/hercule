import { describe, expect, it } from "vitest";
import { buildProject } from "../threads/workspaces.testing";
import { decideThreadStartList, describeStartLine } from "./start-list";
import { LINEAR, SENTRY_HOBBY, SENTRY_WORK, buildViews } from "./testing";

const VIEWS = buildViews([SENTRY_WORK, SENTRY_HOBBY, LINEAR]);
const WEBSHOP = { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-work"] };
const EMPTY = buildProject("p-empty", "empty");

describe("decideThreadStartList", () => {
  it("drops from a project's list the servers deleted since", () => {
    const shop = { ...WEBSHOP, mcpServerIds: ["s-gone", "s-work"] };

    expect(decideThreadStartList("p-shop", [shop], [], VIEWS).mcpServerIds).toEqual(["s-work"]);
  });

  it("starts from the project's list", () => {
    expect(decideThreadStartList("p-shop", [WEBSHOP], ["s-linear"], VIEWS)).toEqual({
      mcpServerIds: ["s-work"],
      source: { kind: "project", projectName: "webshop" },
      complete: true,
    });
  });

  it("is incomplete while the source holds an id no view knows, in a project or in the default list", () => {
    const shop = { ...WEBSHOP, mcpServerIds: ["s-gone", "s-work"] };

    expect(decideThreadStartList("p-shop", [shop], [], VIEWS).complete).toBe(false);
    expect(decideThreadStartList(null, [], ["s-gone", "s-linear"], VIEWS).complete).toBe(false);
    expect(decideThreadStartList(null, [], ["s-linear"], VIEWS).complete).toBe(true);
  });

  it("starts from the project's list even when it is empty, and not from the default", () => {
    expect(decideThreadStartList("p-empty", [EMPTY], ["s-linear"], VIEWS)).toEqual({
      mcpServerIds: [],
      source: { kind: "project", projectName: "empty" },
      complete: true,
    });
  });

  it("starts a thread in no project from the default list, without servers deleted since", () => {
    expect(decideThreadStartList(null, [WEBSHOP], ["s-gone", "s-linear"], VIEWS)).toEqual({
      mcpServerIds: ["s-linear"],
      source: { kind: "default" },
      complete: false,
    });
  });

  it("has no source when a thread in no project has an empty default list", () => {
    expect(decideThreadStartList(null, [WEBSHOP], [], VIEWS)).toEqual({
      mcpServerIds: [],
      source: { kind: "none" },
      complete: true,
    });
    expect(decideThreadStartList(null, [], ["s-gone"], VIEWS).source).toEqual({ kind: "none" });
  });
});

describe("describeStartLine", () => {
  it("words the foot line and the reset button for each source", () => {
    const line = (source: Parameters<typeof describeStartLine>[0]["source"]) =>
      describeStartLine({ mcpServerIds: [], source, complete: true });

    expect(line({ kind: "project", projectName: "webshop" })).toEqual({
      line: "Starts from webshop's list. Changes are for this thread only.",
      resetLabel: "Back to webshop's list",
    });
    expect(line({ kind: "default" })).toEqual({
      line: "Starts from the default list. Changes are for this thread only.",
      resetLabel: "Back to the default list",
    });
    expect(line({ kind: "none" })).toEqual({
      line: "A thread in no project starts with no servers. Switch on what this one needs.",
      resetLabel: "Switch all off",
    });
  });
});
