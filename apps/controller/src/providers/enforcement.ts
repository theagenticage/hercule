/**
 * Which spec fields a provider stores but does not act on.
 *
 * A spec field that a harness cannot honour is kept, not dropped: a Codex
 * instance still records which tool families an agent asked to take away. The
 * record the caller reads reports the field, so the user does not learn it
 * first from the harness's behaviour. The answer is read from the provider's
 * declaration every time, so a binary whose adapter learned to enforce a field
 * stops reporting that field.
 */
import type { ProviderDefinition } from "@hercule/plugin-host";
import type { UnenforcedSpecField } from "@hercule/contract";
import type { DisallowedTool } from "@hercule/protocol";

/**
 * Lists the spec fields that this row's provider ignores, of the fields the
 * caller set. An empty tool list gives an empty answer, whatever the provider
 * declares. A `providerId` of `null` is a row whose instance is gone, and a
 * provider this build no longer carries says nothing about what it enforced,
 * so both give an empty answer too.
 *
 * It takes the whole catalog rather than one declaration, so one read of the
 * catalog answers a whole page. Agents and sessions both call this function,
 * so the two can never disagree about what a provider acts on.
 */
export const listUnenforcedFields = (
  definitions: ReadonlyArray<ProviderDefinition>,
  providerId: string | null,
  disallowedTools: ReadonlyArray<DisallowedTool>,
): ReadonlyArray<UnenforcedSpecField> => {
  const definition = definitions.find((candidate) => candidate.id === providerId);
  return definition !== undefined &&
    definition.declared.disallowedTools === "unsupported" &&
    disallowedTools.length > 0
    ? ["disallowedTools"]
    : [];
};
