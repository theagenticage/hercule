/**
 * Helpers for tests that run near a promotion:
 *
 * - `ServingPromotionStateLayer`, the promotion state for tests whose
 *   controller never promotes;
 * - `freezeController` and `sealController`, which take a running controller
 *   through a promotion over HTTP, as the new machine would;
 * - `pullTransfer` and `receiveTransferIntoHome`, which copy a running
 *   controller's data into a new Home, as `hercule promote` does;
 * - helpers to create promotion tokens, request transfers and find a free port.
 */
import { writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { HomePaths } from "@hercule/home";
import { post } from "../http/testing";
import { AuditLogLayer } from "../events";
import { ControllerIdentity } from "../identity";
import { decodePromotionToken } from "./crypto";
import { SWITCH_PATH, TRANSFER_PATH, type PromotionPreview } from "./exchange";
import { receiveTransfer, reserveHome } from "./receive";
import { PromotionStateLayer, type PromotionState } from "./state";

const NO_IDENTITY =
  "this test's promotion state has no controller identity, so it cannot seal. " +
  "Provide PromotionStateLayer with controllerIdentityLayer instead";

/**
 * The promotion state for tests whose controller never promotes: it starts
 * serving, so every request is admitted and every loop runs. A test that
 * freezes or seals provides `PromotionStateLayer` with a real identity
 * instead, because a seal is signed with the controller's key.
 */
export const ServingPromotionStateLayer: Layer.Layer<PromotionState, never, SqlClient.SqlClient> =
  PromotionStateLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ControllerIdentity, {
          ensure: Effect.die(NO_IDENTITY),
          readOrDie: Effect.die(NO_IDENTITY),
          sign: () => Effect.die(NO_IDENTITY),
        }),
        AuditLogLayer,
      ),
    ),
  );

/**
 * Creates a promotion token on the controller at `base`, signed in as `user`,
 * and returns it. Fails when the controller does not answer 201.
 */
export const createPromotionToken = async (base: string, user: string): Promise<string> => {
  const response = await post(base, "/api/v1/controller/promotion-tokens", {}, user);
  if (response.status !== 201)
    throw new Error(`creating a promotion token answered ${String(response.status)}`);
  return ((await response.json()) as { token: string }).token;
};

/**
 * Sends `method` to the transfer path of the controller at `base`, with
 * `token` as the bearer credential, and returns the response. GET previews,
 * POST pulls the transfer, and DELETE cancels it.
 */
export const requestTransfer = (
  base: string,
  token: string,
  method: "GET" | "POST" | "DELETE" = "POST",
  signal?: AbortSignal,
): Promise<Response> =>
  fetch(`${base}${TRANSFER_PATH}`, {
    method,
    headers: { authorization: `Bearer ${token}`, connection: "close" },
    ...(signal === undefined ? {} : { signal }),
  });

/** The address of the new machine that tests seal a controller with. */
export const NEW_CONTROLLER_ADDRESS = "http://hercule.example:9";

/**
 * Starts the transfer from the controller at `base` with `promotionToken`,
 * and returns the response with its body unread. Fails unless the controller
 * answers 200.
 */
const startTransfer = async (base: string, promotionToken: string): Promise<Response> => {
  const response = await requestTransfer(base, promotionToken);
  if (response.status !== 200)
    throw new Error(`the transfer answered ${String(response.status)}: ${await response.text()}`);
  return response;
};

/**
 * Freezes the controller at `base` the way a promotion does: creates a
 * promotion token signed in as `user`, pulls the transfer with it, and reads
 * the transfer to its end. Returns the promotion token. Fails when the
 * controller refuses the token or the transfer.
 *
 * The controller stays frozen, and its database refuses writes, until the
 * transfer is cancelled or the controller is sealed. Reading to the end
 * matters: a transfer stream that breaks off ends the freeze.
 */
export const freezeController = async (base: string, user: string): Promise<string> => {
  const promotionToken = await createPromotionToken(base, user);
  await (await startTransfer(base, promotionToken)).arrayBuffer();
  return promotionToken;
};

/**
 * Copies the controller at `base` the way `hercule promote` does: creates a
 * promotion token signed in as `user`, previews the transfer to learn the
 * controller id, pulls the transfer, and saves it to `transferFile`. Returns
 * the promotion token and the previewed controller id. Fails when the
 * controller refuses the token, the preview or the transfer.
 *
 * The preview comes first because a frozen controller answers no preview.
 * Like `freezeController`, it leaves the controller frozen.
 */
export const pullTransfer = async (
  base: string,
  user: string,
  transferFile: string,
): Promise<{ readonly promotionToken: string; readonly controllerId: string }> => {
  const promotionToken = await createPromotionToken(base, user);
  const preview = await requestTransfer(base, promotionToken, "GET");
  if (preview.status !== 200)
    throw new Error(`the preview answered ${String(preview.status)}: ${await preview.text()}`);
  const { controllerId } = (await preview.json()) as PromotionPreview;
  const response = await startTransfer(base, promotionToken);
  writeFileSync(transferFile, new Uint8Array(await response.arrayBuffer()));
  return { promotionToken, controllerId };
};

/**
 * Receives the transfer saved at `transferFile` into the empty Home at
 * `paths`, with a file-backed Master Key, as the new machine does. Fails when
 * the Home is not empty, when `promotionToken` is not a promotion token or
 * does not decrypt the transfer, or when the transfer is not from
 * `controllerId`.
 */
export const receiveTransferIntoHome = async (
  paths: HomePaths,
  promotionToken: string,
  controllerId: string,
  transferFile: string,
): Promise<void> => {
  const tokenBytes = decodePromotionToken(promotionToken);
  if (tokenBytes === undefined) throw new Error(`not a promotion token: ${promotionToken}`);
  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(reserveHome(paths, "file"), (home) =>
        receiveTransfer(home, tokenBytes, controllerId, transferFile),
      ),
    ).pipe(Effect.asVoid),
  );
};

/**
 * Seals the controller at `base`, frozen by `promotionToken`, as the new
 * machine does once it has taken over, with {@link NEW_CONTROLLER_ADDRESS}.
 * Fails unless the switch answers 200.
 *
 * A sealed controller answers no request and its database refuses every
 * write, so a test reads its database directly from then on.
 */
export const sealController = async (base: string, promotionToken: string): Promise<void> => {
  const response = await fetch(`${base}${SWITCH_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${promotionToken}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({ newAddress: NEW_CONTROLLER_ADDRESS }),
  });
  if (response.status !== 200)
    throw new Error(`the switch answered ${String(response.status)}: ${await response.text()}`);
};

/** Returns a port on 127.0.0.1 that nothing listened on a moment ago. */
export const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
