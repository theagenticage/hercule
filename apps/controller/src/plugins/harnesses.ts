import type { HarnessDefinition } from "@hercule/plugin-host";

/**
 * A harness a plugin registered at boot: the plugin's declaration, with `id`
 * replaced by the qualified `<pluginId>/<word>` id the host minted at
 * registration. Every lookup, stored row and catalog entry uses that id, so
 * the declaration's own `id`, the bare word, no longer appears.
 */
export type RegisteredHarness = Omit<HarnessDefinition, "id"> & { readonly id: string };
