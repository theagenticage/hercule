/**
 * Builds the `detail` fields that report which files a `file_change` item
 * edited. Every adapter writes them the same way, so the runner reads them in
 * one place (spec 19 section 4.1).
 */
import { MAX_FACT_LENGTH } from "@hercule/protocol";

/**
 * Returns the fields `path` (one edited file) or `paths` (several) for a
 * `file_change` item's `detail`, or no fields when no usable path remains.
 *
 * Paths are kept whole: they are never cut with a "…" marker, because a cut
 * path would name another file. A path that is empty or longer than
 * `MAX_FACT_LENGTH` is left out, and the edit is then not observed. Repeated
 * paths are listed once.
 */
export const buildEditedPathFields = (
  paths: ReadonlyArray<string>,
): { readonly path: string } | { readonly paths: ReadonlyArray<string> } | Record<never, never> => {
  const kept = [...new Set(paths)].filter((path) => path !== "" && path.length <= MAX_FACT_LENGTH);
  if (kept.length === 0) return {};
  return kept.length === 1 ? { path: kept[0]! } : { paths: kept };
};
