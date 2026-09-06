/**
 * What the plugin tests build their fixture plugins out of.
 *
 * A contribution has to be complete before the host will take it - every
 * declared capability, every access mode - so writing one out is a dozen lines
 * that say nothing about the test they sit in. One copy here, and a test names
 * only what it is actually varying.
 */
import * as Schema from "effect/Schema";
import type { ProviderDefinition } from "@hydra/plugin-host";

/** One provider definition, the only contribution shape with a consumer. */
export const providerDefinition = (
  id: string,
  defaultConfig: Schema.Json = {},
): ProviderDefinition => ({
  id,
  displayName: `Provider ${id}`,
  supportsMultipleInstances: true,
  configSchema: Schema.Struct({ token: Schema.String }),
  defaultConfig,
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "native",
      "full-access": "native",
    },
    mcpPassthrough: "native",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
});
