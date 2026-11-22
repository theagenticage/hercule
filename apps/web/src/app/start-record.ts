/**
 * How a thread's start list reads a query: the one rule for the provider that
 * draws it and the edits that write it.
 */
import { readErrorMessage } from "@hercule/client-core";
import type { Project } from "@hercule/contract";
import type { StartProjectRecord, StartRecord } from "@hercule/client-core/mcp-servers";

/**
 * Returns what a query holds as a start record: `failed` when its last read
 * failed, `read` with the value `pick` makes of its data otherwise, or
 * `pending` while it has read nothing.
 *
 * A failure wins over earlier data. After a failed refresh the data may be
 * obsolete, and a start list built from it could write a list the controller
 * no longer holds, so the list stays unavailable until a read succeeds.
 */
export const buildStartRecord = <Data, Value>(
  query: { readonly data: Data | undefined; readonly error: Error | null },
  pick: (data: Data) => Value,
): StartRecord<Value> => {
  if (query.error !== null) return { kind: "failed", message: readErrorMessage(query.error) };
  return query.data === undefined ? { kind: "pending" } : { kind: "read", value: pick(query.data) };
};

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
