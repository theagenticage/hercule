/**
 * The models of a Provider Account: what a harness probe lists, and what a
 * provider's own catalog adds to it.
 */
import { Effect, Schema } from "effect";

import { Fact, MAX_FACT_ITEMS, Timestamp } from "./primitives";

/**
 * One choice the composer offers for a model: a select over named values, or a
 * switch. Each harness decides what it accepts per model, so this is probed
 * from the harness rather than written by hand.
 */
export const ModelOption = Schema.Struct({
  id: Fact,
  label: Fact,
  kind: Schema.Literals(["select", "boolean"]),
  choices: Schema.optionalKey(
    Schema.Array(Schema.Struct({ value: Fact, label: Fact })).check(
      Schema.isMaxLength(MAX_FACT_ITEMS),
    ),
  ),
  default: Schema.Union([Schema.String, Schema.Boolean]),
});

export type ModelOption = Schema.Schema.Type<typeof ModelOption>;

/**
 * What a model takes as image input. `maxBytes` is the largest image the
 * model accepts, or `null` when it sets no limit of its own beyond the
 * controller's 10 MiB per upload.
 */
export const ImageInputCapability = Schema.Struct({
  maxBytes: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});

export type ImageInputCapability = Schema.Schema.Type<typeof ImageInputCapability>;

/** One model a harness offers, and the per-model choices that come with it. */
export const ModelDescriptor = Schema.Struct({
  slug: Fact,
  name: Fact,
  isDefault: Schema.optionalKey(Schema.Boolean),
  /** A model the harness no longer lists but still forwards to the API. */
  isLegacy: Schema.optionalKey(Schema.Boolean),
  /**
   * Whether the model takes images as input, and how large, or `null` when it
   * takes none. The composer and the controller refuse images for a model
   * whose value is `null`.
   *
   * The capability is one field per kind of input, not one flag for all
   * attachments, for two reasons:
   *
   * - harnesses declare input support per modality (text, image, and so on);
   * - the limits differ per kind, so each kind carries its own.
   *
   * A later kind, such as documents, gets a field of its own beside this one
   * (`documentInput`).
   *
   * A missing answer must never count as yes, so the field is required on the
   * decoded type and every adapter sets it. A descriptor without it decodes as
   * `null`: a runner on an older build sends none, and neither do the
   * snapshots the controller stored before the field existed.
   */
  imageInput: Schema.NullOr(ImageInputCapability).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  options: Schema.Array(ModelOption).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
});

export type ModelDescriptor = Schema.Schema.Type<typeof ModelDescriptor>;

/**
 * What a provider's own catalog says about a model beyond what a harness probe
 * reports. The controller shows and filters on these, and the pi adapter turns
 * some of them into `models.json` entries. Every key is optional, because a
 * provider gives only some of them and an absent key means unknown.
 */
export const ModelDetails = Schema.Struct({
  /** Who made the model, such as `Anthropic`, as the catalog groups models by maker. */
  maker: Schema.optionalKey(Fact),
  /** The most tokens the model reads in one request. */
  contextWindow: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** The most tokens the model writes in one answer. */
  outputLimit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  /** US dollars per million input tokens. 0 means free. */
  inputPrice: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  /** US dollars per million output tokens. 0 means free. */
  outputPrice: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  /** When the provider released the model. */
  releasedAt: Schema.optionalKey(Timestamp),
  /** Whether the model can call tools. */
  tools: Schema.optionalKey(Schema.Boolean),
  /** Whether the model can reason before it answers. */
  reasoning: Schema.optionalKey(Schema.Boolean),
});

export type ModelDetails = Schema.Schema.Type<typeof ModelDetails>;

/**
 * One model of a Model Catalog as the controller stores it: a probe's
 * descriptor plus the details a provider's catalog gives. A `ModelDescriptor`
 * is a valid `CatalogModel` with no details, so a catalog read by probing and
 * one read from the provider's API share one shape.
 */
export const CatalogModel = Schema.Struct({
  ...ModelDescriptor.fields,
  ...ModelDetails.fields,
});

export type CatalogModel = Schema.Schema.Type<typeof CatalogModel>;

/**
 * The most models one Model Catalog may hold when the controller reads it from
 * a provider's API, and so the most catalog models a `SessionStart` or a
 * `TextGenerationRequest` may carry in `unlistedModels`. OpenRouter lists about
 * 450 models, so this leaves room to grow. A catalog model with its details is
 * a few hundred bytes as JSON, so 1024 of them keep a frame well under
 * `MAX_FRAME_BYTES` (2 MiB). The catalog read keeps at most this many and says
 * so, so a frame never has to cut the list.
 */
export const MAX_CATALOG_MODELS = 1024;
