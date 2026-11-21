import { describe, expect, it } from "vitest";
import type { ThreadPicks } from "../threads/config";
import { resolveDraftMcpServerIds } from "./draft-pick";

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
