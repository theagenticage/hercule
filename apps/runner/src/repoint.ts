/**
 * Re-points this runner at the controller a forwarding pointer names.
 *
 * The pointer is signed with the controller identity's Ed25519 key. The
 * runner verifies that signature against the public key pinned in
 * `runner.json` before it rewrites `controllerUrl`. A bad signature is
 * ignored, so a spoofed "controller moved" cannot steal the fleet.
 */
import * as Effect from "effect/Effect";
import { encodeForwardingPointerBytes } from "@hercule/protocol";
import { setController } from "./set-controller";

const ED25519 = { name: "Ed25519" } as const;

/** Decodes base64 into the `Uint8Array<ArrayBuffer>` WebCrypto's types require. */
const decodeBase64 = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
};

/**
 * Returns whether `signature` is a valid Ed25519 signature of the forwarding
 * pointer to `newAddress` under `publicKey`. A key that cannot be imported,
 * or a signature that does not verify, is treated as invalid.
 */
const verifyPointerSignature = (
  publicKey: string,
  newAddress: string,
  signature: string,
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey("spki", decodeBase64(publicKey), ED25519, false, [
      "verify",
    ]);
    return crypto.subtle.verify(
      ED25519,
      key,
      decodeBase64(signature),
      encodeForwardingPointerBytes(newAddress),
    );
  }).pipe(Effect.catchCause(() => Effect.succeed(false)));

export type ControllerMove = "accepted" | "ignored";

/**
 * Verifies a forwarding pointer and, when its signature matches the pinned
 * public key, rewrites `controllerUrl` in `runner.json` the way
 * `hercule runner set-controller` does.
 *
 * Returns `accepted` when the file was written. Returns `ignored`, and the
 * runner stays on its current controller, when the signature does not
 * verify, the address is not http or https, or the file cannot be written.
 */
export const acceptControllerMove = (options: {
  readonly home: string;
  readonly publicKey: string;
  readonly newAddress: string;
  readonly signature: string;
}): Effect.Effect<ControllerMove> =>
  Effect.gen(function* () {
    if (
      !(yield* verifyPointerSignature(options.publicKey, options.newAddress, options.signature))
    ) {
      yield* Effect.logWarning("Ignored a forwarding pointer whose signature did not verify");
      return "ignored";
    }
    return yield* setController({ home: options.home, controllerUrl: options.newAddress }).pipe(
      Effect.tap(() =>
        Effect.logInfo("The runner is pointing at a new controller").pipe(
          Effect.annotateLogs({ controllerUrl: options.newAddress }),
        ),
      ),
      Effect.as("accepted" as const),
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(`Ignored a forwarding pointer: ${error.message}`),
          "ignored" as const,
        ),
      ),
    );
  });
