import { Effect, Schema } from "effect";
import {
  HarnessDefinition,
  MAX_HARNESS_HOME_SEGMENT_LENGTH,
  PluginError,
  type HarnessProviderSupport,
  type PluginManifest,
} from "@hercule/plugin-host";
import { toPluginError } from "./errors";
import { mintQualifiedId } from "./qualified-id";
import type { NewContribution } from "./repository";

/**
 * A harness a plugin registered at boot: the plugin's declaration, with `id`
 * replaced by the qualified `<pluginId>/<word>` id the host minted at
 * registration. Every lookup, stored row and catalog entry uses that id, so
 * the declaration's own `id`, the bare word, no longer appears.
 */
export type RegisteredHarness = Omit<HarnessDefinition, "id"> & { readonly id: string };

/** The name of the harness extension point in the catalog. */
const HARNESS = "harness";

// An unknown key fails the decode rather than being stripped: dropping a field
// the host does not know would make an unserializable value look accepted.
const decodeHarness = Schema.decodeUnknownEffect(HarnessDefinition, {
  errors: "all",
  onExcessProperty: "error",
});

/**
 * Returns what is wrong with a harness's `runs`, or `undefined` when it is
 * fine. A provider may be listed once, and an account kind once per provider:
 * finding the entry for an account would otherwise have two answers.
 */
const findRunsProblem = (runs: ReadonlyArray<HarnessProviderSupport>): string | undefined => {
  const providerIds = new Set<string>();
  for (const support of runs) {
    if (providerIds.has(support.providerId)) {
      return `runs lists the provider ${support.providerId} more than once. List each provider once, with all of its account kinds.`;
    }
    providerIds.add(support.providerId);
    const kinds = new Set<string>();
    for (const { kind } of support.kinds) {
      if (kinds.has(kind)) {
        return `runs lists the account kind ${kind} of ${support.providerId} more than once.`;
      }
      kinds.add(kind);
    }
  }
  return undefined;
};

/**
 * Validates a harness definition and adds it to this registration pass: a
 * catalog row in `declared` and the in-memory entry in `live`. Fails with a
 * `PluginError` when:
 *
 * - the definition does not decode, which includes a harness id that cannot
 *   name a folder in a Harness Home;
 * - the plugin id is too long to name a folder there either;
 * - the qualified id is longer than the catalog allows;
 * - `runs` lists a provider or an account kind twice;
 * - the plugin registered the harness twice.
 *
 * `runs` names providers by qualified id and is not checked against the
 * providers that are loaded: the provider's plugin may be absent or disabled,
 * and a harness that runs nothing then simply has no account to run for.
 */
export const registerHarnessContribution = (
  manifest: PluginManifest,
  definition: HarnessDefinition,
  declared: Array<NewContribution>,
  live: Array<RegisteredHarness>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeHarness(definition).pipe(Effect.mapError(toPluginError));
    // The plugin id is the first of the two folder names the harness gets in a
    // Harness Home. Its characters already fit (a plugin id is a lowercase
    // slug), its length does not necessarily.
    if (manifest.id.length > MAX_HARNESS_HOME_SEGMENT_LENGTH) {
      return yield* Effect.fail(
        new PluginError({
          message: `the plugin id ${manifest.id} is ${String(manifest.id.length)} characters long, and a plugin that registers a harness may have at most ${String(MAX_HARNESS_HOME_SEGMENT_LENGTH)}, because the harness's folder in each Harness Home is named after the plugin id. Shorten the plugin id.`,
        }),
      );
    }
    const id = yield* mintQualifiedId(manifest.id, HARNESS, decoded.id);
    const problem = findRunsProblem(decoded.runs);
    if (problem !== undefined) {
      return yield* Effect.fail(new PluginError({ message: `the harness ${id}: ${problem}` }));
    }
    if (declared.some((row) => row.extensionPoint === HARNESS && row.id === id)) {
      return yield* Effect.fail(
        new PluginError({ message: `the ${HARNESS} contribution ${id} is registered twice` }),
      );
    }
    declared.push({
      owner: manifest.id,
      extensionPoint: HARNESS,
      id,
      definition: { ...decoded, id },
    });
    live.push({ ...decoded, id });
  });
