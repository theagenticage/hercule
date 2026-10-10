/**
 * The HTTP exchange between the new machine and the old controller during a
 * promotion: the paths, the bodies they carry, and how an announce address is
 * written. The old controller serves these paths and `hercule promote` calls
 * them, so both import their spelling from here.
 *
 * None of them is an operation: the caller holds a promotion token, not a
 * user credential.
 */
import * as Schema from "effect/Schema";
import { Id } from "@hercule/contract";

/** GET previews a transfer, POST streams it, DELETE cancels it. */
export const TRANSFER_PATH = "/api/v1/controller/promotion-transfer";

/** POST seals the old controller and points its runners at the new address. */
export const SWITCH_PATH = "/api/v1/controller/promotion-switch";

/** What the new machine shows before the user confirms a promotion. */
export const PromotionPreview = Schema.Struct({
  controllerId: Id,
  runners: Schema.Array(Schema.Struct({ name: Schema.String, connectivity: Schema.String })),
});

export type PromotionPreview = Schema.Schema.Type<typeof PromotionPreview>;

/** The body the new machine sends when it asks the old controller to seal. */
export const SwitchRequest = Schema.Struct({
  newAddress: Schema.String,
});

export type SwitchRequest = Schema.Schema.Type<typeof SwitchRequest>;

/** The old controller's answer to a switch: the address it sealed to. */
export const SwitchAnswer = Schema.Struct({
  newAddress: Schema.NonEmptyString,
});

export type SwitchAnswer = Schema.Schema.Type<typeof SwitchAnswer>;

/**
 * Returns `text` as an http(s) origin, or `undefined` when it is not a
 * controller URL. Userinfo is refused: an announce address is a location,
 * not a credential.
 */
export const canonicalizeAnnounceAddress = (text: string): string | undefined => {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};
