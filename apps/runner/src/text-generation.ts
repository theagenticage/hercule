/**
 * The runner's side of a text generation (spec 06 section 14): finds the
 * harness adapter and its binary, gives the call a scratch directory of its
 * own, stops the call at its deadline, and turns every way it can end into one
 * `TextGenerationOutcome`. An adapter does only the work specific to its
 * harness.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join as joinPath } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import {
  MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER,
  MAX_MESSAGE_LENGTH,
  type TextGenerationOutcome,
  type TextGenerationRequest,
} from "@hercule/protocol";
import {
  describeMissingAdapter,
  type HarnessAdapter,
  type HarnessRunnerContext,
} from "./harnesses";
import { truncateMessage } from "./harnesses/text";
import { describeCause } from "./report";

/** The message given when a harness ended a call without giving a usable one. */
const NO_REASON = "the harness gave no reason";

/**
 * The reason every `invalid-output` outcome carries. The adapter's own reason
 * can quote what the model wrote: a schema violation names the keys and values
 * the model chose. The controller stores a failure and shows it to the user,
 * and the text of a call must not reach either, so the model's answer is never
 * described.
 */
const INVALID_OUTPUT_REASON = "the model's answer does not match the output schema";

export interface TextGeneratorOptions {
  /** The directory each call makes its scratch directory in. The runner deletes leftovers at start. */
  readonly scratchDir: string;
  /** Finds the adapter for a harness id, or undefined when this build has none. */
  readonly findAdapter: (harnessId: string) => HarnessAdapter | undefined;
  /** Builds the context of one provider instance, with the binary the runner found for the adapter. */
  readonly buildContext: (
    adapter: HarnessAdapter,
    instanceId: string,
    secrets: Readonly<Record<string, string>>,
  ) => HarnessRunnerContext;
  /** How long a call may run before the runner stops it and answers `timeout`. */
  readonly deadline: Duration.Duration;
}

/**
 * Builds a `failed` outcome. Its message is cut to the protocol's limit and is
 * never blank. The protocol refuses an empty or whitespace-only message, and
 * a harness can report one, which would turn the call's real outcome into a
 * decoding failure.
 */
const buildFailedOutcome = (message: string): TextGenerationOutcome => {
  const cut = truncateMessage(message);
  return { outcome: "failed", message: cut.trim() === "" ? NO_REASON : cut };
};

/**
 * Returns the outcome with text the protocol accepts and the controller may
 * store: a `failed` message that is cut to the limit and never blank, and an
 * `invalid-output` reason that is the fixed `INVALID_OUTPUT_REASON`.
 */
const cleanOutcomeText = (outcome: TextGenerationOutcome): TextGenerationOutcome => {
  switch (outcome.outcome) {
    case "failed":
      return buildFailedOutcome(outcome.message);
    case "invalid-output":
      return { outcome: "invalid-output", reason: INVALID_OUTPUT_REASON };
    default:
      return outcome;
  }
};

/**
 * Builds the function that makes one text generation. The function never fails
 * and always returns within `deadline` plus the time the adapter needs to stop
 * its harness: every way the call can end is an outcome.
 *
 * - `failed`: no adapter, no binary, no free slot, no scratch directory, an
 *   adapter error, or an unexpected defect;
 * - `timeout`: the call ran past the deadline and the adapter was interrupted;
 * - anything the adapter returns, with its text checked by `cleanOutcomeText`.
 *
 * The call's slot is freed and its scratch directory is removed on every path,
 * and only after the adapter has returned, which means its harness process has
 * exited. A removal that fails is logged and changes nothing about the
 * outcome: the call already has its answer, and the runner deletes the whole
 * scratch directory at start.
 *
 * At most `MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER` calls run at once. A
 * call over the limit fails at once instead of waiting. The controller does
 * queue a call until it has a free slot for the runner, and it frees a slot
 * only when the runner has answered or after a hold that outlasts the
 * deadline, so it never sends an 11th call while ten run. The runner refuses
 * anyway, so that a controller that breaks this rule cannot start more harness
 * processes than the machine was sized for (a Claude Code harness alone uses
 * about 1 GiB of memory). A waiting call would also hold its input in memory
 * for nothing.
 */
export const makeTextGenerator = (
  options: TextGeneratorOptions,
): ((request: TextGenerationRequest) => Effect.Effect<TextGenerationOutcome>) => {
  const slots = Semaphore.makeUnsafe(MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER);

  const makeScratchDirectory = Effect.promise(async () => {
    await mkdir(options.scratchDir, { recursive: true, mode: 0o700 });
    // `mkdtemp` creates the directory readable by this user only.
    return mkdtemp(joinPath(options.scratchDir, "text-generation-"));
  });

  const removeScratchDirectory = (scratch: string) =>
    Effect.promise(() => rm(scratch, { recursive: true, force: true })).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning(
          `Could not remove the scratch directory ${scratch} of a text generation`,
          defect,
        ),
      ),
    );

  const generate = (request: TextGenerationRequest) =>
    Effect.gen(function* () {
      const adapter = options.findAdapter(request.harnessId);
      if (adapter === undefined) {
        return buildFailedOutcome(describeMissingAdapter(request.harnessId));
      }
      const context = options.buildContext(adapter, request.instanceId, request.secrets);
      const binary = context.binary;
      if (binary === undefined) {
        return buildFailedOutcome(`no ${adapter.binaryName} on this machine`);
      }
      return yield* Effect.acquireUseRelease(
        makeScratchDirectory,
        (cwd) => adapter.generateText({ ...context, binary, cwd }, request.config, request.spec),
        removeScratchDirectory,
      );
    });

  return (request) =>
    slots
      .withPermitsIfAvailable(1)(
        generate(request).pipe(
          Effect.map(cleanOutcomeText),
          // The adapters fail with a message. A defect is a bug, and it is
          // reported as a failed call too, so the controller always has an
          // answer.
          Effect.catch((message: string) => Effect.succeed(buildFailedOutcome(message))),
          Effect.catchCause((cause) =>
            Effect.succeed(buildFailedOutcome(describeCause(cause, MAX_MESSAGE_LENGTH))),
          ),
          Effect.timeoutOption(options.deadline),
          Effect.map(Option.getOrElse((): TextGenerationOutcome => ({ outcome: "timeout" }))),
        ),
      )
      .pipe(
        Effect.map(
          Option.getOrElse((): TextGenerationOutcome =>
            buildFailedOutcome(
              `this runner already makes ${String(MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER)} text generations`,
            ),
          ),
        ),
      );
};
