/**
 * How a thread's start list reads the page of projects.
 */
import type { Project } from "@hercule/contract";
import { buildStartRecord, type StartProjectRecord } from "@hercule/client-core/mcp-servers";

/**
 * Returns the record of the project `projectId` when the page of projects
 * decides it, or `null` when the project must be read by its id.
 *
 * The page stops at its first page, so a project missing from it may still
 * exist. The page follows the rule of `buildStartRecord`: after a failed
 * refresh its projects may be obsolete, so the record is `failed`, never the
 * cached project.
 */
export const readListedProject = (
  listed: {
    readonly data: { readonly items: readonly Project[] } | undefined;
    readonly error: Error | null;
  },
  projectId: string,
): StartProjectRecord | null => {
  const record = buildStartRecord(listed, ({ items }) =>
    items.find((each) => each.id === projectId),
  );
  if (record.kind === "failed") return record;
  return record.kind === "read" && record.value !== undefined
    ? { kind: "read", value: record.value }
    : null;
};
