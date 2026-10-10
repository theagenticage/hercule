/**
 * The two HTTP routes a runner reaches attachments through:
 *
 * - `GET RUNNER_ATTACHMENTS_PATH/:id` fetches an input's image. A frame on
 *   the runner socket carries only a reference to each image, so the runner
 *   fetches the bytes here before it hands the turn to the harness.
 * - `POST RUNNER_ATTACHMENTS_PATH?sessionId=<id>`, with the raw bytes as the
 *   body, uploads an image from a tool's result. The runner uploads the bytes
 *   here before it reports the tool's result, and the event then carries only
 *   a reference to the stored attachment.
 *
 * Like the runner socket, the routes are not in the derived operation table:
 * the caller presents a runner's credential, which no operation accepts and
 * no grant applies to.
 *
 * A runner reaches only the attachments of sessions placed on it. It may
 * fetch an image only when an input of such a session references it, and
 * store one only in such a session. Any other id gets `404`, so a runner
 * cannot learn about, or write into, other runners' sessions.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  createInternalError,
  createNotFoundError,
  createUnauthenticatedError,
  NotFound,
  Validation,
} from "@hercule/contract";
import { RUNNER_ATTACHMENTS_PATH } from "@hercule/protocol";
import { AttachmentService } from "../attachments";
import { buildAttachmentResponse } from "../http/attachment-response";
import { readBearerToken } from "../http/bearer";
import { buildErrorResponse } from "../http/envelope";
import { RunnerConnections } from "./connections";

const UNKNOWN_CREDENTIAL = "unknown credential";

const NO_SESSION_ID =
  "the upload names no session: give the session's id as the sessionId query parameter";

/**
 * Checks the runner credential the request carries, then runs `respond` with
 * the id of the runner that holds it, and returns `respond`'s response.
 * `action` names what the runner is doing, as in "fetching an attachment",
 * for the messages. Returns:
 *
 * - `401` without a credential, or with one no runner holds;
 * - the error envelope when `respond` fails with `NotFound` or `Validation`;
 * - `500` for any other failure, which is logged.
 */
const respondToRunner = <E, R>(
  request: HttpServerRequest.HttpServerRequest,
  action: string,
  respond: (runnerId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const credential = readBearerToken(request);
    if (credential === undefined)
      return buildErrorResponse(
        createUnauthenticatedError(`${action} needs a runner's credential`),
      );
    const runnerId = yield* (yield* RunnerConnections).admits(credential);
    if (Option.isNone(runnerId))
      return buildErrorResponse(createUnauthenticatedError(UNKNOWN_CREDENTIAL));
    return yield* respond(runnerId.value);
  }).pipe(
    Effect.catch((error) =>
      error instanceof NotFound || error instanceof Validation
        ? Effect.succeed(buildErrorResponse(error))
        : Effect.as(
            Effect.logError(`A runner failed ${action}`, error),
            buildErrorResponse(createInternalError("something went wrong")),
          ),
    ),
  );

/**
 * Both routes. The derived routes get their span from the router middleware,
 * which these routes sit outside of, so each route opens its own.
 *
 * - The fetch streams the image's file (`buildAttachmentResponse`), or
 *   returns `404` for an image the runner may not fetch.
 * - The upload stores the image and returns `201` with its
 *   `ToolResultAttachment`. It returns `404` without a session id or for a
 *   session not placed on the runner, and a validation error when the bytes
 *   are too large or are not an image. The body is read only after the
 *   credential is checked.
 */
export const RunnerAttachmentRoutesLayer = HttpRouter.addAll([
  HttpRouter.route("GET", `${RUNNER_ATTACHMENTS_PATH}/:id`, (request) =>
    respondToRunner(request, "fetching an attachment", (runnerId) =>
      Effect.gen(function* () {
        const attachments = yield* AttachmentService;
        const { id } = yield* HttpRouter.params;
        return yield* buildAttachmentResponse(yield* attachments.readForRunner(id ?? "", runnerId));
      }),
    ).pipe(Effect.withSpan("runner.attachment.fetch")),
  ),
  HttpRouter.route("POST", RUNNER_ATTACHMENTS_PATH, (request) =>
    respondToRunner(request, "uploading a tool result's attachment", (runnerId) =>
      Effect.gen(function* () {
        const attachments = yield* AttachmentService;
        const { sessionId } = yield* HttpServerRequest.ParsedSearchParams;
        // A missing or repeated `sessionId` names no one session to store into.
        if (typeof sessionId !== "string")
          return buildErrorResponse(createNotFoundError(NO_SESSION_ID));
        const stored = yield* attachments.storeToolResultAttachment(
          sessionId,
          runnerId,
          new Uint8Array(yield* request.arrayBuffer),
        );
        return HttpServerResponse.jsonUnsafe(stored, { status: 201 });
      }),
    ).pipe(Effect.withSpan("runner.attachment.upload")),
  ),
]);
