import { Effect, Schema } from "effect";
import { PluginError, ProviderDefinition, type PluginManifest } from "@hercule/plugin-host";
import { toPluginError } from "./errors";
import { mintQualifiedId } from "./qualified-id";
import type { NewContribution } from "./repository";

/**
 * A provider a plugin registered at boot: the plugin's declaration, with `id`
 * replaced by the qualified `<pluginId>/<word>` id the host minted at
 * registration (`anthropic/anthropic`). Every lookup, stored row and catalog
 * entry uses that id. An account kind's own id stays the provider's bare
 * word, because a kind belongs to one provider.
 */
export type RegisteredProvider = Omit<ProviderDefinition, "id"> & { readonly id: string };

/** The name of the provider extension point in the catalog. */
const PROVIDER = "provider";

// An unknown key fails the decode rather than being stripped: dropping a field
// the host does not know would make an unserializable value look accepted.
const decodeProvider = Schema.decodeUnknownEffect(ProviderDefinition, {
  errors: "all",
  onExcessProperty: "error",
});

/**
 * Validates a provider definition and adds it to this registration pass: a
 * catalog row in `declared` and the in-memory entry in `live`. Fails with a
 * `PluginError` for a definition that does not decode, whose qualified id is
 * too long, that declares an account kind twice, or that the plugin
 * registered twice.
 *
 * The harnesses an account kind lists are qualified ids and are not checked
 * against the harnesses that are loaded: their plugin may be absent or
 * disabled, and a client then shows the harness as unavailable.
 */
export const registerProviderContribution = (
  manifest: PluginManifest,
  definition: ProviderDefinition,
  declared: Array<NewContribution>,
  live: Array<RegisteredProvider>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeProvider(definition).pipe(Effect.mapError(toPluginError));
    const id = yield* mintQualifiedId(manifest.id, PROVIDER, decoded.id);
    const kindIds = new Set<string>();
    for (const kind of decoded.kinds) {
      if (kindIds.has(kind.id)) {
        return yield* Effect.fail(
          new PluginError({
            message: `the provider ${id} declares the account kind ${kind.id} more than once`,
          }),
        );
      }
      kindIds.add(kind.id);
    }
    if (declared.some((row) => row.extensionPoint === PROVIDER && row.id === id)) {
      return yield* Effect.fail(
        new PluginError({ message: `the ${PROVIDER} contribution ${id} is registered twice` }),
      );
    }
    declared.push({
      owner: manifest.id,
      extensionPoint: PROVIDER,
      id,
      definition: { ...decoded, id },
    });
    live.push({ ...decoded, id });
  });
