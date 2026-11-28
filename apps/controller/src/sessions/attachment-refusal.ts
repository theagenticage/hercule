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
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { createValidationError, type Validation } from "@hercule/contract";
import { ATTACHMENTS_CAPABILITY, type ModelDescriptor } from "@hercule/protocol";
import { PluginHost } from "../plugins";
import {
  findModels,
  findRunDescriptor,
  modelCatalogRepository,
  providerAccountRepository,
} from "../provider-accounts";
import { runnerRepository } from "../runners";

/** What the controller knows about where a turn would run. */
export interface AttachmentRecipient {
  readonly runnerName: string;
  /** The capabilities the runner and the controller agreed on at its last hello. */
  readonly capabilities: ReadonlyArray<string>;
  /**
   * What the session's harness runs the turn's model with (`findRunDescriptor`),
   * or `undefined` when nothing says what the model is.
   */
  readonly modelDescriptor: ModelDescriptor | undefined;
  /** The slug of the model the turn runs on. */
  readonly model: string;
}

/** The part of one attachment the check reads: its name for the message, and its size. */
export interface AttachmentSize {
  readonly name: string;
  readonly sizeBytes: number;
}

/** Where one turn runs, and the attachments it carries. */
export interface AttachmentTurn {
  readonly runnerId: string;
  readonly providerAccountId: string;
  readonly harnessId: string;
  /** The slug of the model the turn runs on. */
  readonly model: string;
  readonly attachments: ReadonlyArray<AttachmentSize>;
}

const MEBIBYTE = 1024 * 1024;

/**
 * Formats a byte count in MB (of 1024 * 1024 bytes) with up to three
 * decimals and no trailing zeros: `4 MB`, `3.375 MB`. `round` picks the
 * direction of the last decimal. A limit is rounded down and an image's size
 * up, so an image the message calls no larger than the limit is never the
 * one refused.
 */
const formatMegabytes = (bytes: number, round: (value: number) => number): string =>
  `${String(round((bytes / MEBIBYTE) * 1000) / 1000)} MB`;

/**
 * Returns why a turn with `attachments` cannot go to `recipient`, or
 * `undefined` when it can. `attachments` holds at least one image:
 * `findAttachmentRefusal` never calls this for a turn without any.
 *
 * The checks run in this order, because each makes the next moot:
 *
 * - the runner did not agree to the attachments capability, so it runs an
 *   older build that would drop the images;
 * - nothing says what the model is (it is neither in the runner's reported
 *   models nor declared by the catalog the harness takes), so nothing says it
 *   takes images, and an unknown answer never counts as yes;
 * - the model reported that it takes no images;
 * - an image is larger than the model's own limit. The message names the
 *   first such image.
 */
export const describeAttachmentRefusal = (
  recipient: AttachmentRecipient,
  attachments: ReadonlyArray<AttachmentSize>,
): string | undefined => {
  if (!recipient.capabilities.includes(ATTACHMENTS_CAPABILITY))
    return (
      `Runner \`${recipient.runnerName}\` runs an older Hercule that can't take images. ` +
      "Update the runner or send the prompt without images."
    );
  const model = recipient.modelDescriptor;
  if (model === undefined)
    return (
      `\`${recipient.model}\` is not in the models runner \`${recipient.runnerName}\` reported, ` +
      "so Hercule can't tell whether it accepts images. " +
      "Send the prompt without images or pick another model."
    );
  if (model.imageInput === null) {
    const images = attachments.length === 1 ? "the image" : `the ${attachments.length} images`;
    return (
      `\`${recipient.model}\` does not accept images. ` +
      `Remove ${images} or pick a model that accepts them.`
    );
  }
  const { maxBytes } = model.imageInput;
  const tooLarge =
    maxBytes === null ? undefined : attachments.find((one) => one.sizeBytes > maxBytes);
  if (tooLarge === undefined || maxBytes === null) return undefined;
  return (
    `"${tooLarge.name}" is ${formatMegabytes(tooLarge.sizeBytes, Math.ceil)}; ` +
    `this model accepts images up to ${formatMegabytes(maxBytes, Math.floor)}. ` +
    "Send a smaller image or pick another model."
  );
};

/**
 * Returns why the turn's attachments cannot go to its runner and model, or
 * `undefined` when they can (`describeAttachmentRefusal`). A turn without
 * attachments reads nothing and is never refused.
 *
 * The runner's capabilities are the ones it agreed to at its last hello. The
 * model is described by `findRunDescriptor`: the model as the session's
 * provider account lists it in the session's harness on the session's runner,
 * else the newest list any runner reported (`findModels`), else the account's
 * Model Catalog when the harness takes catalog declarations. All of it is read
 * from the database, so the check also works while the runner is offline. A
 * snapshot or catalog that no longer decodes counts as nothing reported, so
 * the turn is refused with the message for a model that is not in the list:
 * an unknown answer never counts as yes.
 */
export const findAttachmentRefusal = (
  turn: AttachmentTurn,
): Effect.Effect<string | undefined, SqlError, SqlClient.SqlClient | PluginHost> =>
  Effect.gen(function* () {
    if (turn.attachments.length === 0) return undefined;
    // A session's runner row is never deleted while the session exists.
    const runner = Option.getOrThrow(yield* (yield* runnerRepository).read(turn.runnerId));
    const accounts = yield* providerAccountRepository;
    const snapshots = yield* accounts
      .listHarnessSnapshots(turn.providerAccountId, turn.harnessId)
      .pipe(Effect.catchTag("SchemaError", () => Effect.succeed([])));
    const catalog = yield* (yield* modelCatalogRepository)
      .readOne(turn.providerAccountId)
      .pipe(Effect.catchTag("SchemaError", () => Effect.succeed(Option.none())));
    const host = yield* PluginHost;
    const account = Option.getOrUndefined(yield* accounts.one(turn.providerAccountId));
    const modelDescriptor = findRunDescriptor(
      (yield* host.providers()).find((one) => one.id === account?.providerId),
      (yield* host.harnesses()).find((one) => one.id === turn.harnessId),
      findModels(snapshots, turn.runnerId).find((one) => one.slug === turn.model),
      Option.getOrUndefined(catalog)?.models.find((one) => one.slug === turn.model),
    );
    return describeAttachmentRefusal(
      {
        runnerName: runner.name,
        capabilities: runner.negotiatedCapabilities ?? [],
        modelDescriptor,
        model: turn.model,
      },
      turn.attachments,
    );
  });

/**
 * Fails with `Validation`, at the `attachments` field, when the turn's
 * attachments cannot go to its runner and model (`findAttachmentRefusal`).
 * For a caller that stores the input, so a refused input is never stored.
 */
export const refuseUnacceptedAttachments = (
  turn: AttachmentTurn,
): Effect.Effect<void, Validation | SqlError, SqlClient.SqlClient | PluginHost> =>
  Effect.flatMap(findAttachmentRefusal(turn), (refusal) =>
    refusal === undefined
      ? Effect.void
      : Effect.fail(createValidationError([{ path: ["attachments"], message: refusal }])),
  );
