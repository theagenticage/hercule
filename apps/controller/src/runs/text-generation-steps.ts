/**
 * Text-generation steps: the parts of the run engine (`engine.ts`) that only
 * a text-generation step has.
 *
 * A text-generation step makes one model call through the `TextGeneration`
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
 *   running and the step is called again once a runner may take it.
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
import { TextGeneration, TextGenerationModels, type TextGenerationError } from "../text-generation";
import { ENDED, WAITS_FOR_RUNNER } from "./agent-steps";
import {
  runRepository,
  StepRecordEnded,
  type ExecutionFailureReason,
  type StoredRun,
} from "./repository";
import { buildRunContext } from "./run-context";
import type { EngineStepError, StepRecordKey } from "./step";

/** A text-generation step of a workflow definition. */
export type TextGenerationStep = Extract<
  WorkflowDefinition["steps"][number],
  { readonly kind: "text-generation" }
>;

/**
 * Returns the text-generation step of a run's plan with this id, or
 * `undefined` when the step with this id is not a text-generation step.
 */
export const findTextGenerationStep = (
  plan: WorkflowDefinition,
  stepId: string,
): TextGenerationStep | undefined => {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  return step?.kind === "text-generation" ? step : undefined;
};

/** The step error of a text-generation step that cannot run because text generation is off. */
const TEXT_GENERATION_OFF: EngineStepError = {
  code: "text_generation_off",
  message:
    "Text generation is off in Settings. Choose a model under Settings > System to run this step.",
};

/**
 * What starting a text-generation step did:
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

/** What a text-generation step needs from the run engine. */
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
 *   `schema-failure`;
 * - `timeout`: `timeout`, and the run fails with `step-failed`;
 * - `failed`: `text_generation_failed`, and the run fails with `step-failed`.
 *
 * The message is the service's own, which never holds the prompt or the
 * output.
 */
const decideCallFailure = (
  error: TextGenerationError,
): { readonly error: EngineStepError; readonly failureReason: ExecutionFailureReason } => {
  switch (error.reason) {
    case "invalid-output":
      return {
        error: {
          code: "schema_failure",
          message: `The model's answer did not match the step's output schema: ${error.message}`,
        },
        failureReason: "schema-failure",
      };
    case "timeout":
      return {
        error: { code: "timeout", message: `The model did not answer in time: ${error.message}` },
        failureReason: "step-failed",
      };
    default:
      return {
        error: {
          code: "text_generation_failed",
          message: `The text generation failed: ${error.message}`,
        },
        failureReason: "step-failed",
      };
  }
};

/**
 * Builds the run engine's text-generation step operations:
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
     * `off` when text generation is off in Settings, `ready` when the model
     * resolves and at least one runner offers it, and `notReady` otherwise.
     * Reads only the database, so it may run inside a transaction.
     */
    const checkReady = (): Effect.Effect<"off" | "ready" | "notReady", SqlError> =>
      Effect.map(models.resolve(), (target) => {
        if (target._tag === "off") return "off";
        return target._tag === "resolved" && target.runnerIds.length > 0 ? "ready" : "notReady";
      });

    return {
      /**
       * Starts a text-generation step's pending record, inside the caller's
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
            yield* writeStepFailure(run.id, record, TEXT_GENERATION_OFF, "step-failed", at);
            return ENDED;
          }
          if (ready === "notReady") return WAITS_FOR_RUNNER;
          yield* runs.startStep(run.id, record, undefined, at);
          return { _tag: "textGenerationStarted", startedAt: at } as const;
        }),

      /**
       * Makes the call of a running text-generation record, outside any
       * transaction, and ends the record with its outcome:
       *
       * - a value: the record completes with it as its output, and the run
       *   is routed, in one transaction;
       * - instructions or an input that cannot be rendered fail the record
       *   with `expression_error`, and ones longer than a call carries fail
       *   it with `input_too_large`, before any call;
       * - a failed call fails the record and the run (see
       *   `decideCallFailure`);
       * - `unavailable`: no runner took the call. The record stays running.
       *   If the ready check passes again, the step is called once more at
       *   once. A second `unavailable`, or a ready check that does not pass,
       *   returns `waitsForRunner`, and the run sleeps until a wake. Text
       *   generation switched off in the meantime fails the record with
       *   `text_generation_off`.
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
          // as a text-generation step, and a run's plan never changes.
          const step = findTextGenerationStep(run.plan, record.stepId);
          if (step === undefined) {
            return yield* Effect.die(
              `the plan of run ${run.id} has no text-generation step ${record.stepId}`,
            );
          }
          const context = buildRunContext(run);
          const texts: Array<string> = [];
          for (const [field, template] of [
            ["instructions", step.instructions],
            ["input", step.input],
          ] as const) {
            const rendered = yield* Effect.result(renderTemplate(template, context));
            if (Result.isFailure(rendered)) {
              yield* failRun(
                run.id,
                record,
                {
                  code: "expression_error",
                  message: `The ${field} of this step could not be rendered: ${rendered.failure.message}`,
                },
                "expression-error",
              );
              return "executed" as const;
            }
            // A template that is exactly one expression renders to the
            // expression's value, which is text only when the value is.
            const text =
              typeof rendered.success === "string"
                ? rendered.success
                : JSON.stringify(rendered.success);
            if (text.length > MAX_TEXT_GENERATION_TEXT_LENGTH) {
              yield* failRun(
                run.id,
                record,
                {
                  code: "input_too_large",
                  message: `The ${field} of this step renders to ${String(text.length)} characters, more than the ${String(MAX_TEXT_GENERATION_TEXT_LENGTH)} a text generation carries. Shorten it, for example by passing only the part of a step's output the model needs.`,
                },
                "step-failed",
              );
              return "executed" as const;
            }
            texts.push(text);
          }
          const [instructions = "", input = ""] = texts;
          const call = Effect.result(
            textGeneration.generate({
              caller: `run:${run.id}`,
              purpose: record.stepId,
              instructions,
              input,
              outputSchema: step.outputSchema,
            }),
          );
          let called = yield* call;
          if (Result.isFailure(called) && called.failure.reason === "unavailable") {
            // A runner may have gone away between the ready check and the
            // call. One more call at once covers a runner that is still there;
            // beyond that the run sleeps until a wake, so a step never calls
            // over and over while no runner can take it.
            const ready = yield* checkReady();
            if (ready === "off") {
              yield* failRun(run.id, record, TEXT_GENERATION_OFF, "step-failed");
              return "executed" as const;
            }
            if (ready === "notReady") return "waitsForRunner" as const;
            called = yield* call;
            if (Result.isFailure(called) && called.failure.reason === "unavailable") {
              return "waitsForRunner" as const;
            }
          }
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
