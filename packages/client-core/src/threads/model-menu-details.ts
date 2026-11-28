/**
 * Builds the detail the model menu shows beside a row's name, after " · ".
 * Both apps draw it, each in its own way, so the rule for what it says lives
 * here once.
 */
import type { ModelMenuRow } from "./model-menu";

/**
 * Returns the detail beside a model's name, joined with " · ": "in pi" when
 * the entry runs in another harness than its lane's, then "default" for the
 * profile's default entry. Returns `null` when there is neither. The current
 * entry is not marked "default", because its check mark already says it is
 * the one in use.
 */
export const describeModelRow = (
  row: Pick<ModelMenuRow, "inHarness" | "isDefault" | "isCurrent">,
): string | null => {
  const parts = [
    row.inHarness === null ? null : `in ${row.inHarness}`,
    row.isDefault && !row.isCurrent ? "default" : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
};
