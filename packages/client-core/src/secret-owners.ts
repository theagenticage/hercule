/**
 * Which secrets the user may write on the Secrets screen. The API refuses a
 * set, a rotate or a delete for two owner kinds, so the screen offers none of
 * them there:
 *
 * - `core` holds the controller's own key material, such as its signing key.
 * - `connection` holds a connection's credentials. New credentials must belong
 *   to the account the connection already signs in as, and only a reconnect
 *   or `connection.setCredentials` checks that.
 */
import type { OwnerKind } from "@hercule/contract";

/** The owner kinds the user may set, rotate and delete secrets for. */
export const WRITABLE_OWNER_KINDS = [
  "plugin",
  "runner",
  "provider-instance",
] as const satisfies ReadonlyArray<OwnerKind>;

/**
 * The note a secret's row shows in place of Rotate and Delete, by owner kind,
 * or `null` for a kind in `WRITABLE_OWNER_KINDS`. The `Record` covers every
 * owner kind, so the build fails when the contract adds one until someone
 * decides whether the user may write it.
 */
const READ_ONLY_NOTES: Readonly<Record<OwnerKind, string | null>> = {
  core: "controller key",
  connection: "connection credential",
  plugin: null,
  runner: null,
  "provider-instance": null,
};

/**
 * Returns the note a secret's row shows in place of Rotate and Delete, or
 * `undefined` when the user may rotate and delete secrets of this owner kind.
 */
export const describeReadOnlySecret = (ownerKind: OwnerKind): string | undefined =>
  READ_ONLY_NOTES[ownerKind] ?? undefined;
