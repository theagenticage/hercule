/**
 * The HTTP route a runner uploads an image an agent's tool returned to:
 * `POST TOOL_IMAGE_UPLOAD_PATH?sessionId=<id>`, with the raw bytes as the
 * body.
 *
 * The runner uploads the bytes here before it reports the tool's result, and
 * the event then carries only a reference to the stored image. Like the
 * runner socket, the route is not in the derived operation table: the caller
 * presents a runner's credential, which no operation accepts and no grant
 * applies to.
 *
 * A runner may store an image only in a session placed on it. Any other
 * session id, including one that is not an id at all, gets `404`, so a runner
 * cannot write into, or learn about, other runners' sessions.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  createInternalError,
  createUnauthenticatedError,
  NotFound,
  Validation,
} from "@hercule/contract";
import { TOOL_IMAGE_UPLOAD_PATH } from "@hercule/protocol";
import { AttachmentService } from "../attachments";
import { readBearerToken } from "../http/bearer";
import { buildErrorResponse } from "../http/envelope";
import { RunnerConnections } from "./connections";

const NO_CREDENTIAL = "uploading a tool's image needs a runner's credential";

const UNKNOWN_CREDENTIAL = "unknown credential";

/**
 * Stores the image and returns `201` with its `StoredToolImage`. Returns
 * `401` without a known runner credential, `404` for a session not placed on
 * the runner, and a validation error when the bytes are too large or are not
 * an image. The body is read only after the credential is checked.
 */
export const RunnerToolImageRouteLayer = HttpRouter.add("POST", TOOL_IMAGE_UPLOAD_PATH, (request) =>
  Effect.gen(function* () {
    const connections = yield* RunnerConnections;
    const attachments = yield* AttachmentService;
    const credential = readBearerToken(request);
    if (credential === undefined)
      return buildErrorResponse(createUnauthenticatedError(NO_CREDENTIAL));
    return yield* Effect.gen(function* () {
      const runnerId = yield* connections.admits(credential);
      if (Option.isNone(runnerId))
        return buildErrorResponse(createUnauthenticatedError(UNKNOWN_CREDENTIAL));
      const { sessionId } = yield* HttpServerRequest.ParsedSearchParams;
      const stored = yield* attachments.storeToolImage(
        typeof sessionId === "string" ? sessionId : "",
        runnerId.value,
        new Uint8Array(yield* request.arrayBuffer),
      );
      return HttpServerResponse.jsonUnsafe(stored, { status: 201 });
    }).pipe(
      Effect.catch((error) =>
        error instanceof NotFound || error instanceof Validation
          ? Effect.succeed(buildErrorResponse(error))
          : Effect.as(
              Effect.logError("A runner's tool image upload failed", error),
              buildErrorResponse(createInternalError("something went wrong")),
            ),
      ),
    );
    // The derived routes get their span from the router middleware, which this
    // route sits outside of.
  }).pipe(Effect.withSpan("runner.toolImage")),
);
