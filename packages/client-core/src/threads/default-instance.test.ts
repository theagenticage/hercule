/**
 * Tests `findDefaultInstanceId(instances)`, which picks the instance the
 * composer and Settings > Threads both prefill from: the first logged-in
 * instance, else the first instance, else none.
 */
import { describe, expect, it } from "vitest";
import {
  buildInstance,
  buildSnapshot,
  CLAUDE_CODE_IDENTITY,
  CODEX_IDENTITY,
} from "../providers.testing";
import { findDefaultInstanceId } from "./default-instance";

describe("findDefaultInstanceId", () => {
  it("picks the first instance with a logged-in snapshot, not necessarily the first instance", () => {
    const instances = [
      buildInstance({ ...CLAUDE_CODE_IDENTITY, name: "First" }, [
        buildSnapshot({ auth: { status: "unauthenticated" } }),
      ]),
      buildInstance({ ...CODEX_IDENTITY, name: "Second" }, [buildSnapshot()]),
    ];

    expect(findDefaultInstanceId(instances)).toBe(instances[1]!.id);
  });

  it("falls back to the first instance when none is logged in", () => {
    const instances = [
      buildInstance({ ...CLAUDE_CODE_IDENTITY, name: "First" }, [
        buildSnapshot({ auth: { status: "unauthenticated" } }),
      ]),
      buildInstance({ ...CODEX_IDENTITY, name: "Second" }, []),
    ];

    expect(findDefaultInstanceId(instances)).toBe(instances[0]!.id);
  });

  it("is null when there are no instances", () => {
    expect(findDefaultInstanceId([])).toBeNull();
  });
});
