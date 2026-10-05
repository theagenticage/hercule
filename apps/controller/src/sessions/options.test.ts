/**
 * Unit tests for the model option rules, the timeouts and the continuing spec
 * alone, with no fleet. Which catalog each operation reads, and that a
 * rejected request writes nothing, are tested end to end in
 * `sessions.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import type { ModelDescriptor, SessionSpec } from "@hercule/protocol";
import {
  buildContinuingSpec,
  buildStepSessionTimeouts,
  validateOptions,
  type ModelOptions,
} from "./options";

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

/** Runs `validateOptions`, expects it to fail, and returns the path and message of each issue. */
const readValidationIssues = (
  models: ReadonlyArray<ModelDescriptor>,
  model: string,
  given: ModelOptions,
): ReadonlyArray<{ readonly path: ReadonlyArray<string>; readonly message: string }> => {
  const exit = Effect.runSyncExit(validateOptions(models, model, given));
  if (Exit.isSuccess(exit))
    throw new Error(`expected a validation error, got ${JSON.stringify(exit.value)}`);
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return error?.error.details.issues ?? [];
};

describe("validateOptions", () => {
  it.each([
    ["an option the model does not offer", "clever", { nope: true }, "options.nope"],
    [
      "a string where a boolean option needs true or false",
      "clever",
      { fastMode: "yes" },
      "options.fastMode",
    ],
    ["a value the select does not offer", "clever", { effort: "extreme" }, "options.effort"],
    ["a model the catalog does not describe", "unknown", { effort: "high" }, "options.effort"],
  ])("rejects %s", (_what, model, given, path) => {
    const issues = readValidationIssues(MODELS, model, given);

    expect(issues.map((issue) => issue.path.join("."))).toEqual([path]);
  });

  it("blames the runner for a model it reported no descriptor for, and the model for every other error", () => {
    expect(readValidationIssues(MODELS, "unknown", { effort: "high" })[0]?.message).toBe(
      "the runner reported no descriptor for unknown",
    );
    expect(readValidationIssues([], "clever", { effort: "high" })[0]?.message).toBe(
      "the runner reported no descriptor for clever",
    );
    expect(readValidationIssues(MODELS, "clever", { nope: true })[0]?.message).toBe(
      "clever has no option named nope",
    );
  });

  it("reports every invalid option at once, not just the first", () => {
    const issues = readValidationIssues(MODELS, "clever", { effort: "extreme", fastMode: "yes" });

    expect(issues.map((issue) => issue.path.join("."))).toEqual([
      "options.effort",
      "options.fastMode",
    ]);
  });

  it.each([
    ["values the model offers", MODELS, { effort: "low", fastMode: true }],
    ["no options at all, even against an empty catalog", [], {}],
  ])("passes %s", (_what, models, given) => {
    expect(Exit.isSuccess(Effect.runSyncExit(validateOptions(models, "clever", given)))).toBe(true);
  });
});

const MINUTE_MS = 60_000;

/** Controller settings with every timeout set, each to a different value. */
const CONTROLLER = {
  "session.inactivityTimeoutMinutes": 10,
  "session.absoluteTimeoutMinutes": 60,
  "session.idleUnloadMinutes": 5,
};

describe("buildStepSessionTimeouts", () => {
  it("unloads the session five seconds after its turn ends, whatever the idle unload setting", () => {
    expect(buildStepSessionTimeouts(CONTROLLER)).toEqual({
      inactivityMs: 10 * MINUTE_MS,
      absoluteMs: 60 * MINUTE_MS,
      idleMs: 5_000,
    });
  });
});

describe("buildContinuingSpec", () => {
  const CONVERSATION_ID = "0199e0e7-0000-7000-8000-0000000000c1";
  const RUN_ID = "0199e0e7-0000-7000-8000-0000000000a1";
  const buildParent = (timeouts: SessionSpec["timeouts"]): SessionSpec => ({
    instanceId: "0199e0e7-0000-7000-8000-0000000000f1",
    workspaceId: null,
    modelSelection: { model: "clever", options: {} },
    accessMode: "full-access",
    timeouts,
  });

  it.each([
    {
      does: "answers a conversation",
      session: { conversationId: CONVERSATION_ID, runId: null },
      idleMs: 5 * MINUTE_MS,
    },
    {
      does: "runs a workflow run's agent step",
      session: { conversationId: null, runId: RUN_ID },
      idleMs: 5_000,
    },
  ])(
    "gives the idle unload to a session that $does, whatever the parent's spec held",
    ({ session, idleMs }) => {
      const spec = buildContinuingSpec(
        buildParent({ inactivityMs: MINUTE_MS, absoluteMs: MINUTE_MS }),
        CONTROLLER,
        { model: "clever", options: {} },
        { nativeSessionId: "native-1", mode: "resume" },
        session,
      );

      expect(spec.timeouts).toEqual({
        inactivityMs: 10 * MINUTE_MS,
        absoluteMs: 60 * MINUTE_MS,
        idleMs,
      });
    },
  );

  it("gives no idle unload to a session that answers no conversation and runs no step, even from a parent that had one", () => {
    const spec = buildContinuingSpec(
      buildParent({ inactivityMs: MINUTE_MS, absoluteMs: MINUTE_MS, idleMs: MINUTE_MS }),
      CONTROLLER,
      { model: "clever", options: {} },
      { nativeSessionId: "native-1", mode: "fork" },
      { conversationId: null, runId: null },
    );

    expect(spec.timeouts).toEqual({ inactivityMs: 10 * MINUTE_MS, absoluteMs: 60 * MINUTE_MS });
  });
});
