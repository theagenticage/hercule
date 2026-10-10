/**
 * The HTTP routes of a promotion transfer: POST streams it, DELETE cancels it.
 * The GET that previews it is served by the controller daemon, because the
 * preview lists the runners. None is in the derived operation table, because
 * the caller is not a user: a machine holding a promotion token has no
 * credential, no grant and no profile, and the token allows exactly these
 * calls.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { createUnauthenticatedError } from "@hercule/contract";
import { readBearerToken } from "../http/bearer";
import { buildErrorResponse, respondToFailures } from "../http/envelope";
import { TRANSFER_PATH } from "./exchange";
import { PromotionTransfer } from "./transfer";

const NO_TOKEN = "a promotion transfer needs a promotion token as the bearer credential";

/**
 * Adds a route that reads the bearer token and answers with `respond`. A
 * refusal becomes its error envelope; anything else is logged and becomes an
 * internal error, so no detail of a failed copy reaches the caller.
 */
const addTransferRoute = <E>(
  method: "POST" | "DELETE",
  span: string,
  respond: (
    transfer: PromotionTransfer["Service"],
    token: string,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
) =>
  HttpRouter.add(method, TRANSFER_PATH, (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const token = readBearerToken(request);
      if (token === undefined) return buildErrorResponse(createUnauthenticatedError(NO_TOKEN));
      return yield* respond(yield* PromotionTransfer, token).pipe(
        respondToFailures("A promotion transfer request failed"),
      );
    }).pipe(Effect.withSpan(span)),
  );

export const PromotionTransferRouteLayer = Layer.mergeAll(
  addTransferRoute("POST", "controller.promotionTransfer", (transfer, token) =>
    Effect.map(transfer.open(token), (stream) =>
      HttpServerResponse.stream(stream, {
        contentType: "application/octet-stream",
        headers: { "cache-control": "no-store" },
      }),
    ),
  ),
  addTransferRoute("DELETE", "controller.promotionCancel", (transfer, token) =>
    Effect.as(transfer.cancel(token), HttpServerResponse.empty({ status: 204 })),
  ),
);
