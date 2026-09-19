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
 * The spec fields the provider a row names will ignore, of those the caller
 * actually set. An empty tool list is nothing to ignore, whatever the provider
 * declares, and an instance that is gone or a provider this build no longer
 * carries says nothing about what it would have enforced.
 *
 * It takes the catalog rather than one declaration, so a page is answered from
 * one read of it; `null` is a row whose instance is gone; and agents and
 * sessions both read it here rather than each having their own copy, so two
 * readers of one provider can never disagree about what it will act on.
 */
export const unenforcedFieldsIn = (
  definitions: ReadonlyArray<ProviderDefinition>,
  providerId: string | null,
  disallowedTools: ReadonlyArray<DisallowedTool>,
): ReadonlyArray<UnenforcedSpecField> => {
  const definition = definitions.find((one) => one.id === providerId);
  return definition !== undefined &&
    definition.declared.disallowedTools === "unsupported" &&
    disallowedTools.length > 0
    ? ["disallowedTools"]
    : [];
};
