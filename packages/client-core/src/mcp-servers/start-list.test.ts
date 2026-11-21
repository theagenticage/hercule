import { describe, expect, it } from "vitest";
import type { ThreadPicks } from "../threads/config";
import { buildProject } from "../threads/workspaces.testing";
import { decideThreadStartList, describeStartLine, resolveDraftMcpServerIds } from "./start-list";
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
    });
  });

  it("starts from the project's list even when it is empty, and not from the default", () => {
    expect(decideThreadStartList("p-empty", [EMPTY], ["s-linear"], VIEWS)).toEqual({
      mcpServerIds: [],
      source: { kind: "project", projectName: "empty" },
    });
  });

  it("starts a thread in no project from the default list, without servers deleted since", () => {
    expect(decideThreadStartList(null, [WEBSHOP], ["s-gone", "s-linear"], VIEWS)).toEqual({
      mcpServerIds: ["s-linear"],
      source: { kind: "default" },
    });
  });

  it("has no source when a thread in no project has an empty default list", () => {
    expect(decideThreadStartList(null, [WEBSHOP], [], VIEWS)).toEqual({
      mcpServerIds: [],
      source: { kind: "none" },
    });
    expect(decideThreadStartList(null, [], ["s-gone"], VIEWS).source).toEqual({ kind: "none" });
  });
});

describe("describeStartLine", () => {
  it("words the foot line and the reset button for each source", () => {
    const line = (source: Parameters<typeof describeStartLine>[0]["source"]) =>
      describeStartLine({ mcpServerIds: [], source });

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

describe("resolveDraftMcpServerIds", () => {
  const KNOWN = new Set(["s-linear", "s-hobby", "s-work"]);
  const pick = (projectId: string | null, mcpServerIds: string[]): ThreadPicks => ({
    mcpServers: { projectId, mcpServerIds },
  });

  it("is undefined for an untouched draft, so it sends no list", () => {
    expect(resolveDraftMcpServerIds({}, "p-shop", KNOWN)).toBeUndefined();
  });

  it("returns the picked list while the draft is in the project it was picked under", () => {
    expect(resolveDraftMcpServerIds(pick("p-shop", ["s-hobby"]), "p-shop", KNOWN)).toEqual([
      "s-hobby",
    ]);
    expect(resolveDraftMcpServerIds(pick(null, ["s-hobby"]), null, KNOWN)).toEqual(["s-hobby"]);
  });

  it("ignores a pick made under another project, so the draft is untouched again", () => {
    expect(resolveDraftMcpServerIds(pick("p-shop", ["s-hobby"]), "p-blog", KNOWN)).toBeUndefined();
    expect(resolveDraftMcpServerIds(pick("p-shop", ["s-hobby"]), null, KNOWN)).toBeUndefined();
  });

  it("keeps an explicit empty list empty", () => {
    expect(resolveDraftMcpServerIds(pick(null, []), null, KNOWN)).toEqual([]);
  });

  it("drops ids that are not known servers, but nothing while the servers are unread", () => {
    expect(resolveDraftMcpServerIds(pick(null, ["s-gone", "s-linear"]), null, KNOWN)).toEqual([
      "s-linear",
    ]);
    expect(resolveDraftMcpServerIds(pick(null, ["s-gone", "s-linear"]), null, undefined)).toEqual([
      "s-gone",
      "s-linear",
    ]);
  });
});
