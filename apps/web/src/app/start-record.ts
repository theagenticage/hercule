/**
 * How a thread's start list reads a query: the one rule for the provider that
 * draws it and the edits that write it.
 */
import { readErrorMessage } from "@hercule/client-core";
import type { StartRecord } from "@hercule/client-core/mcp-servers";

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
