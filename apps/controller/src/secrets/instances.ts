/**
 * Decrypts the credentials of one provider instance, for the frame that sends
 * them to the runner that needs them.
 *
 * This is the only place a provider instance's secrets are decrypted. They are
 * read while a frame is built and never stored anywhere else: the plaintext
 * exists in this process only while the frame is built, and then on the wire.
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { listSecretFields, type ProviderDefinition } from "@hercule/plugin-host";
import type { SecretDecryptError } from "./cipher";
import { buildProviderInstanceOwner, Secrets } from "./repository";

/**
 * Returns the instance's secrets, decrypted, keyed by field name. Only the
 * secret fields the provider declares are returned: a row left by a plugin
 * that has since dropped the field, or written by hand, is not a credential
 * and must not be sent to a runner. When this build no longer has the
 * provider, nothing is returned.
 *
 * Fails when a secret cannot be read or decrypted, and the caller fails with
 * it. A probe or a session that went ahead without the key would report that
 * it is not logged in, which would look as if the user never entered one.
 */
export const readInstanceSecrets = (
  secrets: Secrets["Service"],
  definitions: ReadonlyArray<ProviderDefinition>,
  instanceId: string,
  providerId: string,
): Effect.Effect<Record<string, string>, SqlError | SecretDecryptError> => {
  const definition = definitions.find((one) => one.id === providerId);
  const declared =
    definition === undefined
      ? []
      : listSecretFields(definition.configSchema).map((field) => field.name);
  return Effect.map(secrets.values(buildProviderInstanceOwner(instanceId)), (stored) =>
    Object.fromEntries(
      stored
        .filter((held) => declared.includes(held.name))
        .map(({ name, value }) => [name, Redacted.value(value)]),
    ),
  );
};
