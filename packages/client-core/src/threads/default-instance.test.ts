/**
 * `findDefaultInstanceId(instances)` picks the instance the composer and
 * Settings > Threads both prefill from: the first with a logged-in snapshot,
 * else the first instance, else none.
 */
import { describe, expect, it } from "vitest";
import { buildInstance, buildSnapshot } from "../providers.testing";
import { findDefaultInstanceId } from "./default-instance";

describe("findDefaultInstanceId", () => {
  it("picks the first instance with a logged-in snapshot, not necessarily the first instance", () => {
    const instances = [
      buildInstance("claude-code", "First", [
        buildSnapshot({ auth: { status: "unauthenticated" } }),
      ]),
      buildInstance("codex", "Second", [buildSnapshot()]),
    ];

    expect(findDefaultInstanceId(instances)).toBe(instances[1]!.id);
  });

  it("falls back to the first instance when none is logged in", () => {
    const instances = [
      buildInstance("claude-code", "First", [
        buildSnapshot({ auth: { status: "unauthenticated" } }),
      ]),
      buildInstance("codex", "Second", []),
    ];

    expect(findDefaultInstanceId(instances)).toBe(instances[0]!.id);
  });

  it("is null when there are no instances", () => {
    expect(findDefaultInstanceId([])).toBeNull();
  });
});
