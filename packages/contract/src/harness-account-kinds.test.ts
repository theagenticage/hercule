import { describe, expect, it } from "vitest";
import type { Harness } from "./groups/harness";
import { decideAccountKindHarnessSupport } from "./harness-account-kinds";

const PROVIDER = "anthropic/anthropic";
const kind = { id: "api-key", harnesses: ["pi/pi"] };

/** A harness with one `runs` entry per given provider id, each running the given kinds. */
const harnessRunning = (
  ...runs: ReadonlyArray<readonly [providerId: string, kinds: ReadonlyArray<string>]>
): Pick<Harness, "id" | "runs"> => ({
  id: "pi/pi",
  runs: runs.map(([providerId, kinds]) => ({
    providerId,
    kinds: kinds.map((each) => ({ kind: each, modelArgument: `${providerId}:${each}:{model}` })),
    models: "all",
  })),
});

describe("decideAccountKindHarnessSupport", () => {
  it("returns the harness's entry for the provider and kind, past entries that do not match", () => {
    const harness = harnessRunning(
      ["openai/openai", ["subscription"]],
      [PROVIDER, ["subscription", "api-key"]],
    );
    expect(decideAccountKindHarnessSupport(PROVIDER, kind, harness)).toEqual({
      _tag: "runs",
      support: { kind: "api-key", modelArgument: `${PROVIDER}:api-key:{model}` },
    });
  });

  it("refuses when the kind does not list the harness", () => {
    const harness = harnessRunning([PROVIDER, ["api-key"]]);
    expect(
      decideAccountKindHarnessSupport(
        PROVIDER,
        { ...kind, harnesses: ["claude-code/claude-code"] },
        harness,
      ),
    ).toEqual({ _tag: "disallowed-by-provider" });
  });

  it("names the provider's terms first when both conditions fail", () => {
    expect(
      decideAccountKindHarnessSupport(PROVIDER, { ...kind, harnesses: [] }, harnessRunning()),
    ).toEqual({ _tag: "disallowed-by-provider" });
  });

  it("refuses when the provider has only another kind and another provider has this kind", () => {
    const harness = harnessRunning([PROVIDER, ["subscription"]], ["openai/openai", ["api-key"]]);
    expect(decideAccountKindHarnessSupport(PROVIDER, kind, harness)).toEqual({
      _tag: "unsupported-by-harness",
    });
  });
});
