import { describe, expect, it } from "vitest";
import type { Harness } from "./groups/harness";
import { decideAccountKindHarness } from "./harness-account-kinds";

const account = { providerId: "anthropic/anthropic", kind: "api-key" };

/** A harness with one `runs` entry per given provider id, each running the given kinds. */
const harnessRunning = (
  ...runs: ReadonlyArray<readonly [providerId: string, kinds: ReadonlyArray<string>]>
): Pick<Harness, "id" | "runs"> => ({
  id: "pi/pi",
  runs: runs.map(([providerId, kinds]) => ({
    providerId,
    kinds: kinds.map((kind) => ({ kind, modelArgument: "{model}" })),
    models: "all",
  })),
});

describe("decideAccountKindHarness", () => {
  const listed = { harnesses: ["pi/pi"] };
  const unlisted = { harnesses: ["claude-code/claude-code"] };

  it.each([
    [
      "the provider lists the harness and the harness runs the kind",
      listed,
      harnessRunning(["anthropic/anthropic", ["api-key"]]),
      "runs",
    ],
    [
      "the provider lists no harness for the kind",
      { harnesses: [] },
      harnessRunning(["anthropic/anthropic", ["api-key"]]),
      "disallowed-by-provider",
    ],
    [
      "the provider lists only another harness",
      unlisted,
      harnessRunning(["anthropic/anthropic", ["api-key"]]),
      "disallowed-by-provider",
    ],
    [
      "the provider forbids it and the harness does not run it either",
      unlisted,
      harnessRunning(),
      "disallowed-by-provider",
    ],
    ["the harness runs nothing", listed, harnessRunning(), "unsupported-by-harness"],
    [
      "the harness runs only another provider",
      listed,
      harnessRunning(["openai/openai", ["api-key"]]),
      "unsupported-by-harness",
    ],
    [
      "the harness runs the provider with only another kind",
      listed,
      harnessRunning(["anthropic/anthropic", ["subscription"]]),
      "unsupported-by-harness",
    ],
    [
      "the harness runs the provider with no kinds",
      listed,
      harnessRunning(["anthropic/anthropic", []]),
      "unsupported-by-harness",
    ],
    [
      "the harness runs another provider's kind of the same name, then this one",
      listed,
      harnessRunning(["openai/openai", ["api-key"]], ["anthropic/anthropic", ["api-key"]]),
      "runs",
    ],
  ] as const)("when %s", (_name, kind, harness, expected) => {
    expect(decideAccountKindHarness(account, kind, harness)).toBe(expected);
  });
});
