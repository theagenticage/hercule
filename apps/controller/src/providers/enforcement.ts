/**
 * What a provider stores but will not act on.
 *
 * A spec field a harness cannot honour is kept rather than dropped - a Codex
 * instance still records which tool families an agent wanted taken away - and
 * the record the caller reads says so instead of letting the harness's
 * behaviour be the first news of it. Read from the provider's own declaration
 * every time, so a binary whose adapter learned to enforce a field stops
 * saying it will not.
 */
import type { ProviderDefinition } from "@hydra/plugin-host";
import type { UnenforcedSpecField } from "@hydra/contract";
import type { DisallowedTool } from "@hydra/protocol";

/**
 * The spec fields this provider will ignore, of those the caller actually set.
 * An empty tool list is nothing to ignore, whatever the provider declares.
 */
export const unenforcedFieldsOf = (
  definition: ProviderDefinition,
  disallowedTools: ReadonlyArray<DisallowedTool>,
): ReadonlyArray<UnenforcedSpecField> =>
  definition.declared.disallowedTools === "unsupported" && disallowedTools.length > 0
    ? ["disallowedTools"]
    : [];
