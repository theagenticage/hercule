/**
 * Decides whether a turn with attachments can go to its runner and model.
 *
 * Attachments are refused, never dropped: a runner on an older build would
 * run the text alone, and a model that takes no images would fail the turn
 * or, worse, answer as if the user had sent no picture. So the controller
 * checks before it stores an input with attachments and again before it
 * sends one.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { createValidationError, type Validation } from "@hercule/contract";
import { ATTACHMENTS_CAPABILITY, type ModelDescriptor } from "@hercule/protocol";
import { providerRepository } from "../providers";
import { runnerRepository } from "../runners";

/** What the controller knows about where a turn would run. */
export interface AttachmentRecipient {
  readonly runnerName: string;
  /** The capabilities the runner and the controller agreed on at its last hello. */
  readonly capabilities: ReadonlyArray<string>;
  /**
   * The models the runner last reported for the session's provider instance.
   * Empty when it has reported none.
   */
  readonly models: ReadonlyArray<ModelDescriptor>;
  /** The slug of the model the turn runs on. */
  readonly model: string;
}

/** Where one turn runs, and how many attachments it carries. */
export interface AttachmentTurn {
  readonly runnerId: string;
  readonly instanceId: string;
  /** The slug of the model the turn runs on. */
  readonly model: string;
  readonly attachmentCount: number;
}

/**
 * Returns why a turn with `attachmentCount` attachments cannot go to
 * `recipient`, or `undefined` when it can. A turn without attachments is
 * never refused.
 *
 * The checks run in this order, because each makes the next moot:
 *
 * - the runner did not agree to the attachments capability, so it runs an
 *   older build that would drop the images;
 * - the model is not among those the runner reported, so nothing says it
 *   takes images, and an unknown answer never counts as yes;
 * - the model reported that it takes no images.
 */
export const describeAttachmentRefusal = (
  recipient: AttachmentRecipient,
  attachmentCount: number,
): string | undefined => {
  if (attachmentCount === 0) return undefined;
  if (!recipient.capabilities.includes(ATTACHMENTS_CAPABILITY))
    return (
      `Runner \`${recipient.runnerName}\` runs an older Hercule that can't take images. ` +
      "Update the runner or send the prompt without images."
    );
  const model = recipient.models.find((descriptor) => descriptor.slug === recipient.model);
  if (model === undefined)
    return (
      `\`${recipient.model}\` is not in the models runner \`${recipient.runnerName}\` reported, ` +
      "so Hercule can't tell whether it accepts images. " +
      "Send the prompt without images or pick another model."
    );
  if (model.acceptsImages) return undefined;
  const images = attachmentCount === 1 ? "the image" : `the ${attachmentCount} images`;
  return (
    `\`${recipient.model}\` does not accept images. ` +
    `Remove ${images} or pick a model that accepts them.`
  );
};

/**
 * Returns why the turn's attachments cannot go to its runner and model, or
 * `undefined` when they can (`describeAttachmentRefusal`). A turn without
 * attachments reads nothing and is never refused.
 *
 * The runner's capabilities are the ones it agreed to at its last hello, and
 * its models are the ones it last reported for the session's provider
 * instance. Both are read from the database, so the check also works while
 * the runner is offline. A snapshot that no longer decodes counts as no
 * models reported, so the turn is refused with the message for a model that
 * is not in the list: an unknown answer never counts as yes.
 */
export const findAttachmentRefusal = (
  turn: AttachmentTurn,
): Effect.Effect<string | undefined, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    if (turn.attachmentCount === 0) return undefined;
    // A session's runner row is never deleted while the session exists.
    const runner = Option.getOrThrow(yield* (yield* runnerRepository).read(turn.runnerId));
    const snapshot = yield* (yield* providerRepository)
      .readSnapshot(turn.instanceId, turn.runnerId)
      .pipe(Effect.catchTag("SchemaError", () => Effect.succeed(Option.none())));
    return describeAttachmentRefusal(
      {
        runnerName: runner.name,
        capabilities: runner.negotiatedCapabilities ?? [],
        models: Option.match(snapshot, { onNone: () => [], onSome: (found) => found.models }),
        model: turn.model,
      },
      turn.attachmentCount,
    );
  });

/**
 * Fails with `Validation`, at the `attachments` field, when the turn's
 * attachments cannot go to its runner and model (`findAttachmentRefusal`).
 * For a caller that stores the input, so a refused input is never stored.
 */
export const refuseUnacceptedAttachments = (
  turn: AttachmentTurn,
): Effect.Effect<void, Validation | SqlError, SqlClient.SqlClient> =>
  Effect.flatMap(findAttachmentRefusal(turn), (refusal) =>
    refusal === undefined
      ? Effect.void
      : Effect.fail(createValidationError([{ path: ["attachments"], message: refusal }])),
  );
