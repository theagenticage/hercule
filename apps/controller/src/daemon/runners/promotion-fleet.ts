/**
 * The two steps of a promotion that reach the fleet, as the old controller
 * serves them. The caller is the new machine, authenticated by a promotion
 * token rather than a user credential, so neither step is a public operation.
 *
 * - The preview, at GET on the transfer path, lists the runners the new
 *   machine would take over, before the user confirms. It changes nothing.
 * - The switch seals this controller and points every connected runner at the
 *   new address.
 *
 * Both live in the controller daemon: the preview reads the runners, the
 * switch sends them a frame, and the runners domain sits above promotion,
 * which it asks whether to admit runner work (ADR 0033). The promotion domain
 * still decides whether a token is good and whether this controller serves.
 *
 * The switch persists the seal first, then tells runners, then answers the
 * caller: a switch this controller answered but the caller never heard can be
 * repeated with the same token, and gets the same answer.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createUnauthenticatedError,
  createValidationError,
  type ControllerSealed,
  type InvalidState,
  type PromotionInProgress,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { readBearerToken } from "../../http/bearer";
import { buildErrorResponse, respondToFailures } from "../../http/envelope";
import { ControllerIdentity } from "../../identity";
import {
  buildForwardingPointer,
  canonicalizeAnnounceAddress,
  NO_PROMOTION_TOKEN,
  PromotionState,
  PromotionTokens,
  PromotionTransfer,
  SWITCH_PATH,
  SwitchRequest,
  TRANSFER_PATH,
  type PromotionPreview,
} from "../../promotion";
import { RunnerConnections, runnerRepository } from "../../runners";
import type { SecretNameError } from "../../secrets";

const NO_PREVIEW_TOKEN = "a promotion preview needs a promotion token as the bearer credential";

const NO_SWITCH_TOKEN = "promotion switch needs a spent promotion token as the bearer credential";

const CLOSED = { onExcessProperty: "error" } as const;

/**
 * The switch request's body, decoded. Fails with `Validation` when the body
 * is not JSON or does not match `SwitchRequest`.
 */
const switchRequestBody = Effect.mapError(
  HttpServerRequest.schemaBodyJson(SwitchRequest, CLOSED),
  (error) =>
    error._tag === "SchemaError"
      ? createDecodeValidationError(error)
      : createValidationError([{ path: [], message: "the switch request needs a JSON body" }]),
);

const make = Effect.gen(function* () {
  const tokens = yield* PromotionTokens;
  const promotion = yield* PromotionState;
  const transfer = yield* PromotionTransfer;
  const identity = yield* ControllerIdentity;
  const runners = yield* runnerRepository;
  const connections = yield* RunnerConnections;

  return {
    /**
     * Returns the controller id and the runners the new machine shows before
     * the user confirms. Changes nothing, and does not spend the token. Fails
     * with `Unauthenticated` when the token cannot be spent, and with
     * `PromotionInProgress` or `ControllerSealed` when a transfer would be
     * refused anyway.
     */
    preview: (
      token: string,
    ): Effect.Effect<
      PromotionPreview,
      Unauthenticated | PromotionInProgress | ControllerSealed | SqlError
    > =>
      Effect.gen(function* () {
        yield* transfer.authorizePreview(token);
        const controller = yield* identity.readOrDie;
        return { controllerId: controller.id, runners: yield* runners.listFleet() };
      }),

    /**
     * Seals this controller for the transfer `token` paid for, tells every
     * connected runner the new address, and returns it. Fails with
     * `Unauthenticated` when the token was never spent, with `Validation`
     * when `newAddress` is not an http(s) origin, and with the seal's own
     * errors when the controller is not frozen for that token.
     */
    switchTo: (
      token: string,
      newAddress: string,
    ): Effect.Effect<
      { readonly newAddress: string },
      Unauthenticated | Validation | InvalidState | ControllerSealed | SqlError | SecretNameError
    > =>
      Effect.gen(function* () {
        const canonical = canonicalizeAnnounceAddress(newAddress);
        if (canonical === undefined) {
          return yield* createValidationError([
            { path: ["newAddress"], message: "must be an http or https origin with no userinfo" },
          ]);
        }
        const tokenId = yield* tokens.lookupSpent(token);
        if (Option.isNone(tokenId)) {
          return yield* createUnauthenticatedError(NO_PROMOTION_TOKEN);
        }
        const seal = yield* promotion.seal(tokenId.value, canonical);
        yield* connections.tellConnectedRunners(buildForwardingPointer(seal));
        return { newAddress: seal.newAddress };
      }),
  };
});

export class PromotionFleet extends Context.Service<PromotionFleet, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/runners/PromotionFleet",
) {}

export const PromotionFleetLayer: Layer.Layer<
  PromotionFleet,
  never,
  | PromotionTokens
  | PromotionState
  | PromotionTransfer
  | ControllerIdentity
  | RunnerConnections
  | SqlClient.SqlClient
> = Layer.effect(PromotionFleet)(make);

/** Returns `200` with the preview, or the same error envelope the API uses. */
const previewRoute = HttpRouter.add("GET", TRANSFER_PATH, (request) =>
  Effect.gen(function* () {
    const fleet = yield* PromotionFleet;
    const token = readBearerToken(request);
    if (token === undefined)
      return buildErrorResponse(createUnauthenticatedError(NO_PREVIEW_TOKEN));
    return yield* fleet.preview(token).pipe(
      Effect.map((preview) => HttpServerResponse.jsonUnsafe(preview, { status: 200 })),
      respondToFailures("A promotion preview failed"),
    );
  }).pipe(Effect.withSpan("controller.promotionPreview")),
);

/** Returns `200` with the sealed address, or the same error envelope the API uses. */
const switchRoute = HttpRouter.add("POST", SWITCH_PATH, (request) =>
  Effect.gen(function* () {
    const fleet = yield* PromotionFleet;
    const token = readBearerToken(request);
    if (token === undefined) return buildErrorResponse(createUnauthenticatedError(NO_SWITCH_TOKEN));
    return yield* Effect.flatMap(switchRequestBody, (body) =>
      fleet.switchTo(token, body.newAddress),
    ).pipe(
      Effect.map((answer) => HttpServerResponse.jsonUnsafe(answer, { status: 200 })),
      respondToFailures("A promotion switch could not seal this controller"),
    );
  }).pipe(Effect.withSpan("controller.promotionSwitch")),
);

/** The preview and the switch routes. Like the transfer's own routes, they sit behind no gate. */
export const PromotionFleetRouteLayer = Layer.mergeAll(previewRoute, switchRoute);
