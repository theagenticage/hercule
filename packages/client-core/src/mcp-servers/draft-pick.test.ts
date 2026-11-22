import { describe, expect, it } from "vitest";
import type { ThreadPicks } from "../threads/config";
import { resolveDraftMcpServerIds } from "./draft-pick";

describe("resolveDraftMcpServerIds", () => {
  const pick = (projectId: string | null, mcpServerIds: string[]): ThreadPicks => ({
    mcpServers: { projectId, mcpServerIds },
  });

  it("is undefined for an untouched draft, so it sends no list", () => {
    expect(resolveDraftMcpServerIds({}, "p-shop")).toBeUndefined();
  });

  it("returns the picked list while the draft is in the project it was picked under", () => {
    expect(resolveDraftMcpServerIds(pick("p-shop", ["s-hobby"]), "p-shop")).toEqual(["s-hobby"]);
    expect(resolveDraftMcpServerIds(pick(null, ["s-hobby"]), null)).toEqual(["s-hobby"]);
  });

  it("ignores a pick made under another project, so the draft is untouched again", () => {
    expect(resolveDraftMcpServerIds(pick("p-shop", ["s-hobby"]), "p-blog")).toBeUndefined();
    expect(resolveDraftMcpServerIds(pick("p-shop", ["s-hobby"]), null)).toBeUndefined();
  });

  it("keeps an explicit empty list empty", () => {
    expect(resolveDraftMcpServerIds(pick(null, []), null)).toEqual([]);
  });
});
