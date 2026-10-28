/**
 * Text generation steps: one of the three kinds of step the run engine
 * (`engine.ts`) carries out, behind the `StepKind` interface.
 *
 * A text generation step makes one model call through the `TextGeneration`
 * service: its instructions and its input, rendered for this iteration, go
 * in, and a value that matches its `outputSchema` comes out as the step's
 * output. It is not a workspace step: the call runs on whichever runner can
 * take it, so the step never pins its run.
 *
 * - Starting the step moves its record to `running`, with nothing stored on
 *   it. The call is made after the start transaction has committed, outside
 *   any transaction, because it waits on a runner. Its record ends in a
 *   transaction of its own.
 * - When no runner can take the call, the call waits inside the
 *   `TextGeneration` service until one can, and the record stays `running`
 *   meanwhile. Text generation turned off in Settings fails the step.
 * - Nothing is stored before the call, and the call has no effect outside
 *   the audit log, so a record that a restart cut off is simply called again.
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { SqlError } from "effect/sql/SqlError";
import type { StepError, WorkflowDefinition } from "@hercule/contract";
import { MAX_TEXT_GENERATION_TEXT_LENGTH } from "@hercule/protocol";
import { nowIso } from "../db";
import { renderTemplate } from "../expressions";
import { TextGeneration, type TextGenerationError } from "../text-generation";
import { runRepository, type ExecutionFailureReason, type StoredRun } from "./repository";
import { buildRunContext } from "./run-context";
import type { EngineStepError, InputFailure, StepKind, StepRecordKey } from "./step";

/** A text generation step of a workflow definition. */
type TextGenerationStep = Extract<
  WorkflowDefinition["steps"][number],
  { readonly kind: "text-generation" }
>;

/**
 * Returns the text generation step of a run's plan with this id, or
 * `undefined` when the step with this id is not a text generation step.
 */
const findTextGenerationStep = (
  plan: WorkflowDefinition,
  stepId: string,
): TextGenerationStep | undefined => {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  return step?.kind === "text-generation" ? step : undefined;
};

/** The step error of a text generation step that cannot run because text generation is off. */
const TEXT_GENERATION_OFF_STEP_ERROR: EngineStepError = {
  code: "text_generation_off",
  message:
    "Text generation is off in Settings. Choose a model under Settings > System to run this step.",
};

/** What a text generation step needs from the run engine. */
interface TextGenerationStepNeeds {
  /** Fails a step record and its run, in a transaction of its own. */
  readonly failRun: (
    runId: string,
    attempt: StepRecordKey,
    error: StepError,
    failureReason: ExecutionFailureReason,
  ) => Effect.Effect<void, SqlError>;
  /** Routes the run after the step's latest record ended, inside the caller's transaction. */
  readonly routeAfterStep: (
    runId: string,
    stepId: string,
    at: string,
  ) => Effect.Effect<void, SqlError>;
  /** Runs an effect in a transaction of its own once the controller is serving. */
  readonly transactWhenServing: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SqlError, R>;
}

/**
 * Decides the step error, and the reason the run fails with, for a call that
 * failed:
 *
 * - `off`: `text_generation_off`, and the run fails with `step-failed`;
 * - `invalid-output`: `schema_failure`, and the run fails with
 *   `schema-failure`. The message is fixed, because the service's own
 *   message says nothing more.
 * - `timeout`: `timeout`, with the service's message, and the run fails with
 *   `step-failed`;
 * - `failed`: `text_generation_failed`, with the service's message, and the
 *   run fails with `step-failed`. A step's call waits for a runner rather
 *   than fail with `unavailable`, so `unavailable` never reaches here; it is
 *   treated as `failed`.
 *
 * The service's message never holds the prompt or the output.
 */
const decideCallFailure = (
  error: TextGenerationError,
): { readonly error: EngineStepError; readonly failureReason: ExecutionFailureReason } => {
  switch (error.reason) {
    case "off":
      return { error: TEXT_GENERATION_OFF_STEP_ERROR, failureReason: "step-failed" };
    case "invalid-output":
      return {
        error: {
          code: "schema_failure",
          message: "The model's answer did not match the step's output schema.",
        },
        failureReason: "schema-failure",
      };
    case "timeout":
      return {
        error: { code: "timeout", message: capitalize(error.message) },
        failureReason: "step-failed",
      };
    case "failed":
    case "unavailable":
      return {
        error: {
          code: "text_generation_failed",
          message: `The text generation failed: ${error.message}`,
        },
        failureReason: "step-failed",
      };
  }
};

/** Returns `text` with its first letter in upper case. */
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Builds the run engine's text generation steps, as a `StepKind`. A running
 * record that a restart cut off is called again.
 */
export const makeTextGenerationSteps = ({
  failRun,
  routeAfterStep,
  transactWhenServing,
}: TextGenerationStepNeeds) =>
  Effect.gen(function* () {
    const runs = yield* runRepository;
    const textGeneration = yield* TextGeneration;

    /**
     * Renders the instructions or the input of a text generation step for
     * this iteration, and returns the text. A template that is exactly one
     * expression renders to that expression's value, so a value that is not
     * text is written as JSON.
     *
     * Fails with the step error that ends the record: `expression_error`
     * when the template cannot be rendered, and `input_too_large` when the
     * text is longer than a call carries.
     */
    const renderStepText = (
      field: "instructions" | "input",
      template: string,
      context: Record<string, unknown>,
    ): Effect.Effect<string, InputFailure> =>
      Effect.gen(function* () {
        const rendered = yield* Effect.result(renderTemplate(template, context));
        if (Result.isFailure(rendered)) {
          return yield* Effect.fail({
            error: {
              code: "expression_error",
              message: `The ${field} of this step could not be rendered: ${rendered.failure.message}`,
            },
            failureReason: "expression-error",
          } as const);
        }
        const text =
          typeof rendered.success === "string"
            ? rendered.success
            : JSON.stringify(rendered.success);
        if (text.length > MAX_TEXT_GENERATION_TEXT_LENGTH) {
          return yield* Effect.fail({
            error: {
              code: "input_too_large",
              message: `The ${field} of this step renders to ${String(text.length)} characters, more than the ${String(MAX_TEXT_GENERATION_TEXT_LENGTH)} a text generation carries. Shorten it, for example by passing only the part of a step's output the model needs.`,
            },
            failureReason: "step-failed",
          } as const);
        }
        return text;
      });

    /**
     * Makes the call of a running text generation record, outside any
     * transaction, and ends the record with its outcome:
     *
     * - a value: the record completes with it as its output, and the run is
     *   routed, in one transaction;
     * - instructions or an input that cannot be rendered fail the record
     *   with `expression_error`, and ones longer than a call carries fail it
     *   with `input_too_large`, before any call;
     * - a failed call fails the record and the run (see
     *   `decideCallFailure`).
     *
     * The call waits for a runner when none can take it now, for as long as
     * it takes. A record that ended some other way while the call ran, such
     * as by a cancel, keeps that ending. Interrupting this effect cancels the
     * call. Fails only with a database error; a defect of the call is left to
     * the caller, which fails the run with `controller-error`.
     */
    const executeTextGenerationStep = (
      run: StoredRun,
      record: StepRecordKey,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        // The record is a step of this plan that the run engine found to be
        // a text generation step, and a run's plan never changes.
        const step = findTextGenerationStep(run.plan, record.stepId);
        if (step === undefined) {
          return yield* Effect.die(
            `the plan of run ${run.id} has no text generation step ${record.stepId}`,
          );
        }
        const context = buildRunContext(run);
        const texts = yield* Effect.result(
          Effect.all([
            renderStepText("instructions", step.instructions, context),
            renderStepText("input", step.input, context),
          ]),
        );
        if (Result.isFailure(texts)) {
          const { error, failureReason } = texts.failure;
          return yield* failRun(run.id, record, error, failureReason);
        }
        const [instructions, input] = texts.success;
        const called = yield* Effect.result(
          textGeneration.generate({
            caller: `run:${run.id}`,
            purpose: record.stepId,
            instructions,
            input,
            outputSchema: step.outputSchema,
            whenNoRunner: "wait",
          }),
        );
        if (Result.isFailure(called)) {
          const { error, failureReason } = decideCallFailure(called.failure);
          return yield* failRun(run.id, record, error, failureReason);
        }
        const output = called.success;
        yield* Effect.catchTag(
          transactWhenServing(
            Effect.gen(function* () {
              const finishedAt = yield* nowIso;
              yield* runs.finishStep(
                run.id,
                record,
                { status: "completed", output },
                { startedAt: record.startedAt ?? finishedAt, finishedAt },
              );
              yield* routeAfterStep(run.id, record.stepId, finishedAt);
            }),
          ),
          "StepRecordEnded",
          () => Effect.void,
        );
      });

    const textGenerationSteps: StepKind = {
      start: (run, record, at) =>
        Effect.gen(function* () {
          yield* runs.startStep(run.id, record, undefined, at);
          // The call renders the step's templates against the run as read
          // before the start. The start transaction wrote only this record,
          // and the templates read the outputs of finished steps, which
          // could not change in between.
          return {
            _tag: "started",
            execute: executeTextGenerationStep(run, { ...record, startedAt: at }),
          } as const;
        }),
      resume: executeTextGenerationStep,
    };
    return textGenerationSteps;
  });
