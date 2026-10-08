/**
 * The HTTP route a runner fetches an input's image from:
 * `GET /api/v1/runners/attachments/:id`.
 *
 * A frame on the runner socket carries only a reference to each image, so the
 * runner fetches the bytes here before it hands the turn to the harness. Like
 * the runner socket, the route is not in the derived operation table: the
 * caller presents a runner's credential, which no operation accepts and no
 * grant applies to.
 *
 * A runner may fetch only an image that an input of a session placed on it
 * references. Any other id gets `404`, so a runner cannot learn which images
 * exist on other runners' sessions.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { createInternalError, createUnauthenticatedError, NotFound } from "@hercule/contract";
import { AttachmentService } from "../attachments";
import { buildAttachmentResponse } from "../http/attachment-response";
import { readBearerToken } from "../http/bearer";
import { buildErrorResponse } from "../http/envelope";
import { RunnerConnections } from "./connections";

const ATTACHMENT_PATH = "/api/v1/runners/attachments/:id";

const NO_CREDENTIAL = "fetching an attachment needs a runner's credential";

const UNKNOWN_CREDENTIAL = "unknown credential";

/**
 * Streams the image's file (`buildAttachmentResponse`). Returns `401`
 * without a known runner credential and `404` for an image the runner may not
 * fetch.
 */
export const RunnerAttachmentRouteLayer = HttpRouter.add("GET", ATTACHMENT_PATH, (request) =>
  Effect.gen(function* () {
    const connections = yield* RunnerConnections;
    const attachments = yield* AttachmentService;
    const credential = readBearerToken(request);
    if (credential === undefined)
      return buildErrorResponse(createUnauthenticatedError(NO_CREDENTIAL));
    const { id } = yield* HttpRouter.params;
    return yield* Effect.gen(function* () {
      const runnerId = yield* connections.admits(credential);
      if (Option.isNone(runnerId))
        return buildErrorResponse(createUnauthenticatedError(UNKNOWN_CREDENTIAL));
      return yield* buildAttachmentResponse(
        yield* attachments.readForRunner(id ?? "", runnerId.value),
      );
    }).pipe(
      Effect.catch((error) =>
        error instanceof NotFound
          ? Effect.succeed(buildErrorResponse(error))
          : Effect.as(
              Effect.logError("A runner's attachment fetch failed", error),
              buildErrorResponse(createInternalError("something went wrong")),
            ),
      ),
    );
    // The derived routes get their span from the router middleware, which this
    // route sits outside of.
  }).pipe(Effect.withSpan("runner.attachment")),
);
