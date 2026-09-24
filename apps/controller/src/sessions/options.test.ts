/**
 * What makes a pick wrong, without a fleet behind it: the rules alone. Which
 * catalog each operation consults, and what a refusal leaves unwritten, are
 * asserted end to end in `sessions.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import type { ModelDescriptor } from "@hercule/protocol";
import { validateOptions, type ModelOptions } from "./options";

const MODELS: ReadonlyArray<ModelDescriptor> = [
  {
    slug: "clever",
    name: "Clever",
    options: [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        choices: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        default: "high",
      },
      { id: "fastMode", label: "Fast mode", kind: "boolean", default: false },
    ],
  },
];

/** The issues one call refused with, as the paths and messages they carry. */
const readValidationIssues = (
  models: ReadonlyArray<ModelDescriptor>,
  model: string,
  given: ModelOptions,
): ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly message: string }> => {
  const exit = Effect.runSyncExit(validateOptions(models, model, given));
  if (Exit.isSuccess(exit))
    throw new Error(`expected a refusal, got ${JSON.stringify(exit.value)}`);
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return error?.error.details.issues ?? [];
};

describe("validateOptions", () => {
  it.each([
    ["an option the model does not offer", "clever", { nope: true }, "options.nope"],
    ["a string where a switch takes a boolean", "clever", { fastMode: "yes" }, "options.fastMode"],
    ["a value the select does not offer", "clever", { effort: "extreme" }, "options.effort"],
    ["a model the catalog does not describe", "unknown", { effort: "high" }, "options.effort"],
  ])("refuses %s", (_what, model, given, path) => {
    const issues = readValidationIssues(MODELS, model, given);

    expect(issues.map((issue) => issue.path.join("."))).toEqual([path]);
  });

  it("blames the machine for a model it reported nothing about, and the model for the rest", () => {
    expect(readValidationIssues(MODELS, "unknown", { effort: "high" })[0]?.message).toBe(
      "the machine reported no descriptor for unknown",
    );
    expect(readValidationIssues([], "clever", { effort: "high" })[0]?.message).toBe(
      "the machine reported no descriptor for clever",
    );
    expect(readValidationIssues(MODELS, "clever", { nope: true })[0]?.message).toBe(
      "clever offers no nope",
    );
  });

  it("names every wrong pick at once, not just the first", () => {
    const issues = readValidationIssues(MODELS, "clever", { effort: "extreme", fastMode: "yes" });

    expect(issues.map((issue) => issue.path.join("."))).toEqual([
      "options.effort",
      "options.fastMode",
    ]);
  });

  it.each([
    ["every value the model offers", MODELS, { effort: "low", fastMode: true }],
    ["no picks at all, which even an empty catalog has nothing to refuse", [], {}],
  ])("passes %s", (_what, models, given) => {
    expect(Exit.isSuccess(Effect.runSyncExit(validateOptions(models, "clever", given)))).toBe(true);
  });
});
