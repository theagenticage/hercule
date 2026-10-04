/**
 * Turns the end of an agent step's turn into the step's outcome. This is the
 * one place that decides how an agent step ended; the supervisor calls it on
 * the event that ended the step's turn.
 */
import {
  MAX_MESSAGE_LENGTH,
  type ExitReason,
  type ProviderEvent,
  type WorkspaceStepOutcome,
} from "@hercule/protocol";

/** An event that ends an agent step's turn: the turn's own end, or the end of its session. */
export type StepTurnEnding = Extract<ProviderEvent, { _tag: "turn.completed" | "session.exited" }>;

/** What the supervisor knows about the step's turn beyond the event that ended it. */
export interface StepTurn {
  /** Whether the session runs under an output schema, so its turns must return a structured result. */
  readonly hasOutputSchema: boolean;
  /** The turn's final assistant message, or an empty string when the turn wrote none. */
  readonly text: string;
}

/** Why a session ended, worded to follow "because". */
const EXIT_REASON_TEXTS: Record<ExitReason, string> = {
  stopped: "it was stopped",
  process_exit: "its harness process exited",
  idle_unload: "it was unloaded for being idle",
  runner_restart: "the runner shut down",
  crash: "it crashed",
  inactivity_timeout: "it reported nothing for longer than its inactivity timeout",
  absolute_timeout: "it ran past its absolute time limit",
  workspace_failed: "its workspace could not be made",
};

/** Returns `text`, followed by `detail` after a colon when there is one, and ends it with a period. */
const appendDetail = (text: string, detail: string | undefined): string =>
  (detail === undefined || detail === "" ? `${text}.` : `${text}: ${detail}`).slice(
    0,
    MAX_MESSAGE_LENGTH,
  );

/**
 * Builds the outcome of an agent step from the event that ended its turn. The
 * rules, in order:
 *
 * - the session ended during the turn: failed with `session_failed`, naming
 *   why it ended;
 * - the turn reported a schema failure: failed with `schema_failure` and the
 *   harness's reason. This comes before the turn's state, because Codex
 *   reports a schema it cannot satisfy on a failed turn, and the schema
 *   failure is the more precise of the two;
 * - the turn failed or was interrupted: failed with `session_failed`;
 * - the turn returned a structured result: completed with that value;
 * - the session has an output schema but the turn returned no result: failed
 *   with `schema_failure`;
 * - otherwise: completed with the turn's final message as
 *   `{ text, exitStatus: "completed" }`, the output of a step without a
 *   schema (spec 07 section 6).
 */
export const buildAgentStepOutcome = (
  ending: StepTurnEnding,
  turn: StepTurn,
): WorkspaceStepOutcome => {
  if (ending._tag === "session.exited") {
    return {
      status: "failed",
      code: "session_failed",
      message: appendDetail(
        `The session ended before the step's turn finished, because ${EXIT_REASON_TEXTS[ending.reason]}`,
        ending.message,
      ),
    };
  }
  const result = ending.structuredResult;
  if (result?.outcome === "schema-failure") {
    return {
      status: "failed",
      code: "schema_failure",
      message: appendDetail(
        "The turn's result did not match the step's output schema",
        result.reason,
      ),
    };
  }
  if (ending.state !== "completed") {
    return {
      status: "failed",
      code: "session_failed",
      message: appendDetail(
        ending.state === "failed"
          ? "The step's turn failed"
          : "The step's turn was interrupted before it finished",
        ending.error,
      ),
    };
  }
  if (result?.outcome === "ok") return { status: "completed", output: result.value };
  if (turn.hasOutputSchema) {
    return {
      status: "failed",
      code: "schema_failure",
      message: "The step's turn completed without a result for the step's output schema.",
    };
  }
  return { status: "completed", output: { text: turn.text, exitStatus: "completed" } };
};
