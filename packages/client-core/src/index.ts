import * as Schema from "effect/Schema";
import { Health } from "@hydra/contract";

const decodeHealth = Schema.decodeUnknownPromise(Health);

/**
 * Decode a `/health` payload into a plain typed object.
 *
 * Decoding happens here so components never see a schema: `client-core` is the
 * only client package that writes Effect code.
 */
export function parseHealth(input: unknown): Promise<Health> {
  return decodeHealth(input);
}
