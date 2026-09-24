/**
 * Which spec fields a provider stores but does not act on.
 *
 * A spec field that a harness cannot honour is kept, not dropped: a Codex
 * instance still records which tool families an agent asked to take away. The
 * record the caller reads lists the field, so the user does not first learn
 * about it from the harness's behaviour. The list is computed from the
 * provider's declaration every time, so once an adapter learns to enforce a
 * field, a binary with that adapter stops listing it.
 */
import type { ProviderDefinition } from "@hercule/plugin-host";
import type { UnenforcedSpecField } from "@hercule/contract";
import type { DisallowedTool } from "@hercule/protocol";

/**
 * Returns the spec fields, among those the caller set, that this row's
 * provider ignores. Returns an empty list when:
 *
 * - the tool list is empty, whatever the provider declares
 * - `providerId` is `null`, which means the row's instance is gone
 * - this build no longer has the provider, so nothing is known about what it
 *   enforced
 *
 * It takes the whole catalog rather than one declaration, so one read of the
 * catalog serves a whole page. Agents and sessions both call this function,
 * so the two can never disagree about what a provider enforces.
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
