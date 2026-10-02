/**
 * The part of a pending token flow that both setup tables store the same way:
 * the connection the flow will write. `oauth_setups` holds redirect flows and
 * `device_setups` holds device flows; each adds the columns of its own flow.
 */
import type * as Schema from "effect/Schema";
import { uuidToString } from "../db";

/** What a token flow writes when it creates a connection, or keeps when it reconnects one. */
export interface SetupTarget {
  readonly label: string;
  readonly labels: ReadonlyArray<string>;
  readonly config: Record<string, Schema.Json>;
}

/** The connection a pending token flow will write, with its JSON columns read. */
export interface StoredSetupTarget extends SetupTarget {
  /** The qualified connection type, which also identifies the plugin that owns the flow. */
  readonly type: string;
  /** Set when the flow reconnects a connection that already exists. */
  readonly connectionId: string | undefined;
}

/** The columns of {@link StoredSetupTarget}, as both setup tables name them. */
export interface SetupTargetRow {
  readonly type: string;
  readonly connection_id: Uint8Array | null;
  readonly label: string;
  readonly labels: string;
  readonly config: string;
}

/**
 * Parses the shared columns of a setup row. Only the setup repositories write
 * the JSON columns, so a column that does not parse means the database is
 * broken, and `JSON.parse` throws.
 */
export const parseSetupTargetRow = (row: SetupTargetRow): StoredSetupTarget => ({
  type: row.type,
  connectionId: row.connection_id === null ? undefined : uuidToString(row.connection_id),
  label: row.label,
  labels: JSON.parse(row.labels) as ReadonlyArray<string>,
  config: JSON.parse(row.config) as Record<string, Schema.Json>,
});
