/** Tests for building an agent step's outcome from the end of its turn. */
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_LENGTH, type ExitReason, type StructuredResult } from "@hercule/protocol";
import { buildAgentStepOutcome, type StepTurnEnding } from "./step-outcome";

const base = { eventId: "event-1", sessionId: "session-1", at: "2026-10-04T10:00:00.000Z" };

const buildTurnEnd = (
  state: "completed" | "failed" | "interrupted",
  extra: { readonly error?: string; readonly structuredResult?: StructuredResult } = {},
): StepTurnEnding => ({ ...base, _tag: "turn.completed", turnId: "turn-1", state, ...extra });

const buildExit = (reason: ExitReason, message?: string): StepTurnEnding => ({
  ...base,
  _tag: "session.exited",
  reason,
  ...(message === undefined ? {} : { message }),
});

const WITH_SCHEMA = { hasOutputSchema: true, text: "" };
const WITHOUT_SCHEMA = { hasOutputSchema: false, text: "All tests pass." };

describe("buildAgentStepOutcome", () => {
  it("completes with the structured value of a completed turn", () => {
    const ending = buildTurnEnd("completed", {
      structuredResult: { outcome: "ok", value: { verdict: "approve" } },
    });
    expect(buildAgentStepOutcome(ending, WITH_SCHEMA)).toEqual({
      status: "completed",
      output: { verdict: "approve" },
    });
  });

  it("completes with the final message of a completed turn when the session has no schema", () => {
    expect(buildAgentStepOutcome(buildTurnEnd("completed"), WITHOUT_SCHEMA)).toEqual({
      status: "completed",
      output: { text: "All tests pass.", exitStatus: "completed" },
    });
  });

  it("completes with empty text when a turn without a schema wrote no message", () => {
    expect(
      buildAgentStepOutcome(buildTurnEnd("completed"), { hasOutputSchema: false, text: "" }),
    ).toEqual({ status: "completed", output: { text: "", exitStatus: "completed" } });
  });

  it("fails with schema_failure and the harness's reason when the result did not match", () => {
    const ending = buildTurnEnd("completed", {
      structuredResult: { outcome: "schema-failure", reason: "missing property verdict" },
    });
    expect(buildAgentStepOutcome(ending, WITH_SCHEMA)).toEqual({
      status: "failed",
      code: "schema_failure",
      message: "The turn's result did not match the step's output schema: missing property verdict",
    });
  });

  it("fails with schema_failure when a failed turn reports a schema failure, as Codex does", () => {
    const ending = buildTurnEnd("failed", {
      error: "turn failed",
      structuredResult: { outcome: "schema-failure", reason: "schema is unsatisfiable" },
    });
    expect(buildAgentStepOutcome(ending, WITH_SCHEMA)).toMatchObject({
      status: "failed",
      code: "schema_failure",
    });
  });

  it("fails with schema_failure when a session with a schema completes a turn with no result", () => {
    expect(buildAgentStepOutcome(buildTurnEnd("completed"), WITH_SCHEMA)).toEqual({
      status: "failed",
      code: "schema_failure",
      message: "The step's turn completed without a result for the step's output schema.",
    });
  });

  it("fails with session_failed and the turn's error when the turn failed", () => {
    const ending = buildTurnEnd("failed", { error: "rate limited" });
    expect(buildAgentStepOutcome(ending, WITHOUT_SCHEMA)).toEqual({
      status: "failed",
      code: "session_failed",
      message: "The step's turn failed: rate limited",
    });
  });

  it("fails with session_failed when the turn was interrupted", () => {
    expect(buildAgentStepOutcome(buildTurnEnd("interrupted"), WITH_SCHEMA)).toEqual({
      status: "failed",
      code: "session_failed",
      message: "The step's turn was interrupted before it finished.",
    });
  });

  it.each<[ExitReason, string]>([
    ["stopped", "it was stopped"],
    ["process_exit", "its harness process exited"],
    ["idle_unload", "it was unloaded for being idle"],
    ["runner_restart", "the runner shut down"],
    ["crash", "it crashed"],
    ["inactivity_timeout", "it reported nothing for longer than its inactivity timeout"],
    ["absolute_timeout", "it ran past its absolute time limit"],
    ["workspace_failed", "its workspace could not be made"],
  ])("fails with session_failed naming why the session ended: %s", (reason, why) => {
    expect(buildAgentStepOutcome(buildExit(reason), WITH_SCHEMA)).toEqual({
      status: "failed",
      code: "session_failed",
      message: `The session ended before the step's turn finished, because ${why}.`,
    });
  });

  it("adds the exit's own message after the reason", () => {
    expect(buildAgentStepOutcome(buildExit("crash", "exit code 137"), WITH_SCHEMA)).toEqual({
      status: "failed",
      code: "session_failed",
      message:
        "The session ended before the step's turn finished, because it crashed: exit code 137",
    });
  });

  it("cuts a long message to the protocol's limit", () => {
    const ending = buildTurnEnd("failed", { error: "x".repeat(MAX_MESSAGE_LENGTH) });
    const outcome = buildAgentStepOutcome(ending, WITHOUT_SCHEMA);
    expect(outcome.status === "failed" && outcome.message.length).toBe(MAX_MESSAGE_LENGTH);
  });
});
