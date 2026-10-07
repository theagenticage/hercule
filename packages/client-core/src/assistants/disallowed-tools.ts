/** An assistant's disallowed tools as Settings > Assistants edits them, one family at a time. */
import type { DisallowedTool } from "@hercule/contract";

/**
 * Returns `tools` with `family` added at the end when `disallowed` is true,
 * and removed when it is false. Returns `tools` itself when it already says
 * so.
 *
 * The section saves one family's change onto the stored list rather than the
 * whole list it showed, so a change another writer made to another family
 * in the meantime is kept.
 */
export const setDisallowedTool = (
  tools: readonly DisallowedTool[],
  family: DisallowedTool,
  disallowed: boolean,
): readonly DisallowedTool[] => {
  if (tools.includes(family) === disallowed) return tools;
  return disallowed ? [...tools, family] : tools.filter((tool) => tool !== family);
};
