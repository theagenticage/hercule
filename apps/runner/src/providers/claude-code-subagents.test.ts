import { describe, expect, it } from "vitest";
import {
  buildSubagentRegistry,
  cleanSubagentId,
  collectDescendants,
  markStopsWanted,
  recordAgentCall,
  registerSubagent,
  takeStopsDue,
} from "./claude-code-subagents";

describe("collectDescendants", () => {
  it("returns every subagent below one, at any depth, and not the subagent itself", () => {
    const registry = buildSubagentRegistry([
      { subagentId: "a1", itemId: "call_a1" },
      { subagentId: "b1", itemId: "call_b1", parentSubagentId: "a1" },
      { subagentId: "b2", itemId: "call_b2", parentSubagentId: "a1" },
      { subagentId: "c1", itemId: "call_c1", parentSubagentId: "b1" },
      { subagentId: "a2", itemId: "call_a2" },
    ]);
    expect([...collectDescendants(registry, "a1")].sort()).toEqual(["b1", "b2", "c1"]);
    expect(collectDescendants(registry, "c1")).toEqual([]);
    expect(collectDescendants(registry, "unknown")).toEqual([]);
  });

  it("includes a subagent started in this process below a seeded one", () => {
    const registry = buildSubagentRegistry([{ subagentId: "a1", itemId: "call_a1" }]);
    recordAgentCall(registry, "call_b1", "a1", undefined);
    registerSubagent(registry, "b1", "call_b1");
    expect(collectDescendants(registry, "a1")).toEqual(["b1"]);
  });

  it("ends when the parent links loop back", () => {
    const registry = buildSubagentRegistry([
      { subagentId: "a1", parentSubagentId: "b1" },
      { subagentId: "b1", parentSubagentId: "a1" },
    ]);
    expect(collectDescendants(registry, "a1")).toEqual(["b1"]);
  });
});

describe("stopping subagents", () => {
  it("sends a stop only to a working subagent, once, and keeps an idle one waiting", () => {
    const registry = buildSubagentRegistry([{ subagentId: "a1" }, { subagentId: "a2" }]);
    registry.byId.get("a1")!.turn = { phase: "open", turnId: "turn-1" };
    markStopsWanted(registry, ["a1", "a2", "unknown"]);

    expect(takeStopsDue(registry)).toEqual(["a1"]);
    expect(takeStopsDue(registry)).toEqual([]);
    expect(registry.byId.get("a2")!.stop).toBe("wanted");

    registry.byId.get("a2")!.turn = { phase: "pending", prompt: undefined };
    expect(takeStopsDue(registry)).toEqual(["a2"]);
  });

  it("leaves a stop that was sent, or that the harness reported, as it is", () => {
    const registry = buildSubagentRegistry([{ subagentId: "a1" }, { subagentId: "a2" }]);
    registry.byId.get("a1")!.stop = "sent";
    registry.byId.get("a2")!.stop = "stopped";
    markStopsWanted(registry, ["a1", "a2"]);
    expect(registry.byId.get("a1")!.stop).toBe("sent");
    expect(registry.byId.get("a2")!.stop).toBe("stopped");
  });

  it("wants a subagent stopped when it starts under a parent that was stopped", () => {
    const registry = buildSubagentRegistry([{ subagentId: "a1", itemId: "call_a1" }]);
    markStopsWanted(registry, ["a1"]);
    recordAgentCall(registry, "call_b1", "a1", undefined);
    recordAgentCall(registry, "call_b2", undefined, undefined);
    expect(registerSubagent(registry, "b1", "call_b1").stop).toBe("wanted");
    expect(registerSubagent(registry, "b2", "call_b2").stop).toBe("none");
  });
});

describe("cleanSubagentId", () => {
  it("returns undefined for a missing, empty or non-string id", () => {
    expect(cleanSubagentId(undefined)).toBeUndefined();
    expect(cleanSubagentId("")).toBeUndefined();
    expect(cleanSubagentId(42)).toBeUndefined();
  });

  it("replaces each colon and cuts an id to 512 characters", () => {
    expect(cleanSubagentId("a:b:c")).toBe("a_b_c");
    expect(cleanSubagentId("x".repeat(600))?.length).toBe(512);
  });
});
