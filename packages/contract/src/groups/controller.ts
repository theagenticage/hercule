/**
 * The controller's own identity, what its text generation runs on, and the
 * one thing a caller may set about it.
 *
 * `defaultRunnerId` is the runner that placement falls back to when no runner
 * is chosen. It is null rather than absent when there is none, so a client
 * reads one shape either way. Update availability belongs here too, but there
 * is no update check yet, so it has no field; the field is added once the
 * check is built.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { closedStruct } from "../closed";
import { Conflict, Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { Authenticated } from "../security";
import { InstanceModel } from "./settings";

/** The reasons a text generation fails, the same in the record and in the status. */
export const TextGenerationFailureReason = Schema.Literals([
  "unavailable",
  "timeout",
  "invalid-output",
]);

export type TextGenerationFailureReason = Schema.Schema.Type<typeof TextGenerationFailureReason>;

/**
 * What text generation does now, so Settings can show it beside the
 * `textGeneration.model` setting. Both fields are worked out on every read;
 * nothing stores them.
 */
export const TextGenerationStatus = Schema.Struct({
  /**
   * The instance and model text generations run on now: the chosen one, or
   * what `automatic` resolves to. Null when text generation is off, by the
   * setting or because `automatic` found no match.
   */
  model: Schema.NullOr(InstanceModel),
  /**
   * Why the last text generation failed, or null when it succeeded, none has
   * run since the controller started, or it ran on another setting value or
   * another resolved model than `model` now (for example before the user
   * chose a different model, or before `automatic` began to resolve to one).
   */
  lastFailure: Schema.NullOr(
    Schema.Struct({
      reason: TextGenerationFailureReason,
      message: Schema.NonEmptyString,
      at: Timestamp,
    }),
  ),
});

export type TextGenerationStatus = Schema.Schema.Type<typeof TextGenerationStatus>;

export const ControllerInfo = Schema.Struct({
  id: Id,
  /** The controller's Ed25519 public key, base64. Runners verify against it. */
  publicKey: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  /** The runner a placement falls back to, or null while none is chosen. */
  defaultRunnerId: Schema.NullOr(Id),
  /**
   * The runner this controller started on its own machine, or null while it
   * has not joined yet or when this controller starts none. Read from the
   * running child on every call; nothing stores it, so it cannot be set.
   */
  localRunnerId: Schema.NullOr(Id),
  textGeneration: TextGenerationStatus,
});

export type ControllerInfo = Schema.Schema.Type<typeof ControllerInfo>;

/**
 * The payload of `controller.update`. An empty patch is accepted and changes
 * nothing. Any other key is rejected rather than ignored, because the
 * controller itself sets everything else that `controller.read` returns.
 */
export const ControllerUpdateInput = closedStruct({
  /** `null` removes the default, leaving placement with no fallback. */
  defaultRunnerId: Schema.optionalKey(Schema.NullOr(Id)),
});

export type ControllerUpdateInput = Schema.Schema.Type<typeof ControllerUpdateInput>;

/**
 * Shown here and nowhere else: the controller keeps only its hash. The
 * controller does not know the address another machine reaches it at, so the
 * answer carries none; the CLI prints the address it reached the controller at.
 */
export const MintedPromotionToken = Schema.Struct({
  token: Schema.NonEmptyString,
  expiresAt: Timestamp,
});

export type MintedPromotionToken = Schema.Schema.Type<typeof MintedPromotionToken>;

export const controller = HttpApiGroup.make("controller")
  .add(
    HttpApiEndpoint.get("read", "/controller", {
      success: ControllerInfo,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.patch("update", "/controller", {
      payload: ControllerUpdateInput,
      success: ControllerInfo,
      error: [Unauthenticated, Forbidden, Validation, Conflict, Internal],
    }),
    HttpApiEndpoint.post("createPromotionToken", "/controller/promotion-tokens", {
      success: HttpApiSchema.status(201)(MintedPromotionToken),
      error: [Unauthenticated, Forbidden, Internal],
    }),
  )
  .middleware(Authenticated);
