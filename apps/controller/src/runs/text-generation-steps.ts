/**
 * Text generation steps: the parts of the run engine (`engine.ts`) that only
 * a text generation step has.
 *
 * A text generation step makes one model call through the `TextGeneration`
 * service: its instructions and its input, rendered for this iteration, go
 * in, and a value that matches its `outputSchema` comes out as the step's
 * output. It is not a workspace step: the call runs on whichever runner can
 * take it, so the step never pins its run.
 *
 * - It starts once a runner could take the call. When text generation is off
 *   in Settings, the step fails. When no runner can take the call now, its
 *   record stays pending and the run waits for a runner.
 * - The call is made after the start transaction has committed, outside any
 *   transaction, because it waits on a runner. Its record ends in a
 *   transaction of its own.
 * - A call that finds no runner after all is not a failure: the record stays
 *   running and the step is called again once a runner may take it. Every
 *   call, the first and any later one, waits for that same check to pass.
 * - Nothing is stored before the call, and the call has no effect outside
 *   the audit log, so a record that a restart cut off is simply called again.
 */
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { StepError, WorkflowDefinition } from "@hercule/contract";
import { MAX_TEXT_GENERATION_TEXT_LENGTH } from "@hercule/protocol";
import { nowIso } from "../db";
import { renderTemplate } from "../expressions";
import {
  buildTextGenerationUnavailableReason,
  TextGeneration,
  TextGenerationModels,
  type TextGenerationError,
} from "../text-generation";
import { ENDED, WAITS_FOR_RUNNER } from "./agent-steps";
import {
  runRepository,
  StepRecordEnded,
  type ExecutionFailureReason,
  type StoredRun,
} from "./repository";
import { buildRunContext } from "./run-context";
import type { EngineStepError, InputFailure, StepRecordKey } from "./step";

/** A text generation step of a workflow definition. */
type TextGenerationStep = Extract<
  WorkflowDefinition["steps"][number],
  { readonly kind: "text-generation" }
>;

/**
 * Returns the text generation step of a run's plan with this id, or
 * `undefined` when the step with this id is not a text generation step.
 */
export const findTextGenerationStep = (
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

/**
 * What starting a text generation step did:
 *
 * - `textGenerationStarted`: the record is `running`, and the call is made
 *   once the transaction has committed;
 * - `ended`: the step and its run have failed;
 * - `waitsForRunner`: no runner can take the call now, and the record stays
 *   pending.
 */
export type TextGenerationStepStartOutcome =
  | { readonly _tag: "textGenerationStarted"; readonly startedAt: string }
  | typeof ENDED
  | typeof WAITS_FOR_RUNNER;

/** What a text generation step needs from the run engine. */
interface TextGenerationStepNeeds {
  /** Fails a step record and its run, inside the caller's transaction. */
  readonly writeStepFailure: (
    runId: string,
    attempt: StepRecordKey,
    error: StepError,
    failureReason: ExecutionFailureReason,
    at: string,
  ) => Effect.Effect<void, SqlError>;
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
 * failed with anything but `unavailable`:
 *
 * - `invalid-output`: `schema_failure`, and the run fails with
 *   `schema-failure`. The message is fixed, because the service's own
 *   message says nothing more.
 * - `timeout`: `timeout`, with the service's message, and the run fails with
 *   `step-failed`;
 * - `failed`: `text_generation_failed`, with the service's message, and the
 *   run fails with `step-failed`.
 *
 * The service's message never holds the prompt or the output.
 */
const decideCallFailure = (
  error: TextGenerationError,
): { readonly error: EngineStepError; readonly failureReason: ExecutionFailureReason } => {
  switch (error.reason) {
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
    // The caller handles `unavailable` before it gets here, so only a
    // `failed` call reaches this case in practice.
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
 * Builds the run engine's text generation step operations:
 *
 * - `startTextGenerationStep` starts a pending record, inside the start
 *   transaction;
 * - `executeTextGenerationStep` makes the call for a running record, outside
 *   any transaction, and ends the record.
 */
export const makeTextGenerationSteps = ({
  writeStepFailure,
  failRun,
  routeAfterStep,
  transactWhenServing,
}: TextGenerationStepNeeds) =>
  Effect.gen(function* () {
    const runs = yield* runRepository;
    const textGeneration = yield* TextGeneration;
    const models = yield* TextGenerationModels;

    /**
     * Checks whether a runner could take a text generation now. Returns
     * `off` when text generation is off in Settings, `ready` when
     * `buildTextGenerationUnavailableReason` finds no reason, and `notReady`
     * otherwise. Reads only the database, so it may run inside a
     * transaction.
     */
    const checkReady = (): Effect.Effect<"off" | "ready" | "notReady", SqlError> =>
      Effect.map(models.resolve(), (target) => {
        if (target._tag === "off") return "off";
        return buildTextGenerationUnavailableReason(target) === null ? "ready" : "notReady";
      });

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

    return {
      /**
       * Starts a text generation step's pending record, inside the caller's
       * start transaction, once its condition has held. Checks first whether
       * a runner could take the call:
       *
       * - text generation is off: the record fails with
       *   `text_generation_off`, the run fails with `step-failed`, and this
       *   returns `ended`;
       * - no runner can take the call now: the record stays pending, and this
       *   returns `waitsForRunner`;
       * - a runner can: the record moves to `running` with nothing stored on
       *   it, and this returns `textGenerationStarted`.
       *
       * Fails with `StepRecordEnded` when the record is no longer pending.
       */
      startTextGenerationStep: (
        run: StoredRun,
        record: StepRecordKey,
        at: string,
      ): Effect.Effect<TextGenerationStepStartOutcome, SqlError | StepRecordEnded> =>
        Effect.gen(function* () {
          const ready = yield* checkReady();
          if (ready === "off") {
            yield* writeStepFailure(
              run.id,
              record,
              TEXT_GENERATION_OFF_STEP_ERROR,
              "step-failed",
              at,
            );
            return ENDED;
          }
          if (ready === "notReady") return WAITS_FOR_RUNNER;
          yield* runs.startStep(run.id, record, undefined, at);
          return { _tag: "textGenerationStarted", startedAt: at } as const;
        }),

      /**
       * Makes the call of a running text generation record, outside any
       * transaction, and ends the record with its outcome:
       *
       * - a value: the record completes with it as its output, and the run
       *   is routed, in one transaction;
       * - instructions or an input that cannot be rendered fail the record
       *   with `expression_error`, and ones longer than a call carries fail
       *   it with `input_too_large`, before any call;
       * - before each call, the same check as at the start runs. Text
       *   generation switched off fails the record with
       *   `text_generation_off`, and no runner able to take the call returns
       *   `waitsForRunner` without a call, so the record stays running and
       *   the run sleeps until a wake;
       * - a failed call fails the record and the run (see
       *   `decideCallFailure`);
       * - `unavailable`: no runner took the call after all. The step is
       *   called once more at once, after the check. A second `unavailable`
       *   returns `waitsForRunner`.
       *
       * Returns `executed` otherwise. A record that ended some other way
       * while the call ran, such as by a cancel, keeps that ending.
       * Interrupting this effect cancels the call. Fails only with a
       * database error; a defect of the call is left to the caller, which
       * fails the run with `controller-error`.
       */
      executeTextGenerationStep: (
        run: StoredRun,
        record: StepRecordKey,
      ): Effect.Effect<"executed" | "waitsForRunner", SqlError> =>
        Effect.gen(function* () {
          // The record is a step of this plan that `startStepRecord` started
          // as a text generation step, and a run's plan never changes.
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
            yield* failRun(run.id, record, error, failureReason);
            return "executed" as const;
          }
          const [instructions, input] = texts.success;
          const call = Effect.result(
            textGeneration.generate({
              caller: `run:${run.id}`,
              purpose: record.stepId,
              instructions,
              input,
              outputSchema: step.outputSchema,
            }),
          );
          /**
           * Makes the call if a runner could take it now, and returns its
           * result, or `unavailable` when it found no runner after all.
           * Returns `off` or `notReady` without a call otherwise, so a run
           * woken for an unrelated reason never calls while no runner can
           * take it.
           */
          const callWhenReady = Effect.gen(function* () {
            const ready = yield* checkReady();
            if (ready !== "ready") return ready;
            const result = yield* call;
            return Result.isFailure(result) && result.failure.reason === "unavailable"
              ? ("unavailable" as const)
              : result;
          });
          let called = yield* callWhenReady;
          // A runner may have gone away between the ready check and the call.
          // One more call at once covers another runner that is still there;
          // beyond that the run sleeps until a wake, so a step never calls
          // over and over while no runner can take it.
          if (called === "unavailable") called = yield* callWhenReady;
          if (called === "off") {
            yield* failRun(run.id, record, TEXT_GENERATION_OFF_STEP_ERROR, "step-failed");
            return "executed" as const;
          }
          if (called === "notReady" || called === "unavailable") return "waitsForRunner" as const;
          if (Result.isFailure(called)) {
            const { error, failureReason } = decideCallFailure(called.failure);
            yield* failRun(run.id, record, error, failureReason);
            return "executed" as const;
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
          return "executed" as const;
        }),
    };
  });
