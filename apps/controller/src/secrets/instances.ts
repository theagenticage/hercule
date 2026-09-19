/**
 * The credentials of one provider instance, in the clear, for the frame that
 * carries them to the machine that needs them.
 *
 * The only place a provider instance's secrets are decrypted. They are read as
 * a frame is built and never stored anywhere else: plaintext lives in this
 * process for the length of that build, and then on the wire.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { secretFields, type ProviderDefinition } from "@hydra/plugin-host";
import { providerInstanceOwner, Secrets, type SecretDecryptError } from "./repository";

/**
 * Only the fields the provider declares travel: a row left under this owner by
 * a plugin that has since dropped the field, or written there by hand, is
 * nobody's credential and has no business on a machine. A provider this build
 * no longer carries declares nothing, so nothing of the instance's travels.
 *
 * A read that fails takes its caller with it. A probe or a session that went on
 * without the key would report itself as not logged in, which reads as the user
 * never having entered one.
 */
export const instanceSecrets = (
  secrets: Secrets["Service"],
  definitions: ReadonlyArray<ProviderDefinition>,
  instanceId: string,
  providerId: string,
): Effect.Effect<Record<string, string>, SqlError | SecretDecryptError> => {
  const definition = definitions.find((one) => one.id === providerId);
  const declared =
    definition === undefined
      ? []
      : secretFields(definition.configSchema).map((field) => field.name);
  return Effect.map(secrets.values(providerInstanceOwner(instanceId)), (stored) =>
    Object.fromEntries(
      stored
        .filter((held) => declared.includes(held.name))
        .map(({ name, value }) => [name, Redacted.value(value)]),
    ),
  );
};
