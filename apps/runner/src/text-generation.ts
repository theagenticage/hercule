/**
 * The runner's side of a text generation (spec 06 section 14): finds the
 * provider adapter and its binary, gives the call a scratch directory of its
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
  MAX_MESSAGE_LENGTH,
  type TextGenerationOutcome,
  type TextGenerationRequest,
} from "@hercule/protocol";
import {
  describeMissingAdapter,
  type ProviderAdapter,
  type ProviderRunnerContext,
} from "./providers";
import { truncateMessage } from "./providers/text";
import { describeCause } from "./report";

/**
 * How many text generations run at once on this runner. It equals the limit
 * the controller keeps per runner, so a controller that works as designed never
 * reaches it. It stops a controller that sends more from starting more harness
 * processes than the machine was sized for: a Claude Code harness alone uses
 * about 1 GiB of memory.
 */
export const MAX_CONCURRENT_TEXT_GENERATIONS = 10;

/** The reason given when a harness ended a call without giving any. */
const NO_REASON = "the harness gave no reason";

export interface TextGeneratorOptions {
  /** The directory each call makes its scratch directory in. The runner deletes leftovers at start. */
  readonly scratchDir: string;
  /** Finds the adapter for a provider id, or undefined when this build has none. */
  readonly findAdapter: (providerId: string) => ProviderAdapter | undefined;
  /** Builds the context of one provider instance, with the binary the runner found for the adapter. */
  readonly buildContext: (
    adapter: ProviderAdapter,
    instanceId: string,
    secrets: Readonly<Record<string, string>>,
  ) => ProviderRunnerContext;
  /** How long a call may run before the runner stops it and answers `timeout`. */
  readonly deadline: Duration.Duration;
}

/** Builds a `failed` outcome. Its message is cut to the protocol's limit and is never empty. */
const buildFailedOutcome = (message: string): TextGenerationOutcome => ({
  outcome: "failed",
  message: truncateMessage(message) || NO_REASON,
});

/**
 * Returns the outcome with a reason the protocol accepts: a `failed` message
 * or an `invalid-output` reason that is cut to the limit and never empty. A
 * harness can report an empty error message, and the protocol refuses an empty
 * one, which would turn the call's real outcome into a decoding failure.
 */
const ensureReason = (outcome: TextGenerationOutcome): TextGenerationOutcome => {
  switch (outcome.outcome) {
    case "failed":
      return buildFailedOutcome(outcome.message);
    case "invalid-output":
      return {
        outcome: "invalid-output",
        reason: truncateMessage(outcome.reason) || NO_REASON,
      };
    default:
      return outcome;
  }
};

/**
 * Builds the function that makes one text generation. The function never fails
 * and always returns within `deadline` (plus the time the adapter needs to stop
 * its harness): every way the call can end is an outcome.
 *
 * - `failed`: no adapter, no binary, no free slot, no scratch directory, an
 *   adapter error, or an unexpected defect;
 * - `timeout`: the call ran past the deadline and the adapter was interrupted;
 * - anything the adapter returns, with its reason checked by `ensureReason`.
 *
 * The call's scratch directory is removed on every path. A removal that fails
 * is logged and changes nothing about the outcome: the call already has its
 * answer, and the runner deletes the whole scratch directory at start.
 *
 * At most `MAX_CONCURRENT_TEXT_GENERATIONS` calls run at once. A call over the
 * limit fails at once instead of waiting: the controller never queues a text
 * generation either, and a waiting call would hold its 64 KiB input in memory
 * for nothing.
 */
export const makeTextGenerator = (
  options: TextGeneratorOptions,
): ((request: TextGenerationRequest) => Effect.Effect<TextGenerationOutcome>) => {
  const slots = Semaphore.makeUnsafe(MAX_CONCURRENT_TEXT_GENERATIONS);

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
      const adapter = options.findAdapter(request.providerId);
      if (adapter === undefined) {
        return buildFailedOutcome(describeMissingAdapter(request.providerId));
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
          Effect.map(ensureReason),
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
              `this runner already makes ${String(MAX_CONCURRENT_TEXT_GENERATIONS)} text generations`,
            ),
          ),
        ),
      );
};
