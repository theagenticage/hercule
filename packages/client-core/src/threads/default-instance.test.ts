/**
 * `defaultInstanceId(instances)` picks the instance the composer and
 * Settings > Threads both prefill from: the first with a logged-in snapshot,
 * else the first instance, else none.
 */
import { describe, expect, it } from "vitest";
import { instance, snapshot } from "../providers.testing";
import { defaultInstanceId } from "./default-instance";

describe("defaultInstanceId", () => {
  it("picks the first instance with a logged-in snapshot, not necessarily the first instance", () => {
    const instances = [
      instance("claude-code", "First", [snapshot({ auth: { status: "unauthenticated" } })]),
      instance("codex", "Second", [snapshot()]),
    ];

    expect(defaultInstanceId(instances)).toBe(instances[1]!.id);
  });

  it("falls back to the first instance when none is logged in", () => {
    const instances = [
      instance("claude-code", "First", [snapshot({ auth: { status: "unauthenticated" } })]),
      instance("codex", "Second", []),
    ];

    expect(defaultInstanceId(instances)).toBe(instances[0]!.id);
  });

  it("is null when there are no instances", () => {
    expect(defaultInstanceId([])).toBeNull();
  });
});
