/**
 * The part of a pending token flow that both setup tables store the same way:
 * what the flow does once the provider hands over tokens. `oauth_setups` holds
 * redirect flows and `device_setups` holds device flows; each adds the columns
 * of its own flow.
 */
import type * as Schema from "effect/Schema";
import { uuidFromString, uuidToString } from "../db";

/**
 * What a token flow does once it has tokens.
 *
 * - `create`: writes a new connection with this label, these topics and this
 *   config. A missing label is decided when the connection is written, from
 *   the account name the type's `validate` returns.
 * - `reconnect`: replaces the tokens of an existing connection, and keeps its
 *   label, topics and config.
 */
export type SetupTarget =
  | {
      readonly kind: "create";
      readonly label: string | undefined;
      readonly labels: ReadonlyArray<string>;
      readonly config: Record<string, Schema.Json>;
    }
  | { readonly kind: "reconnect"; readonly connectionId: string };

/** A {@link SetupTarget} as a setup table stores it, with the type the flow signs in to. */
export type StoredSetupTarget = SetupTarget & {
  /** The qualified connection type, which also identifies the plugin that owns the flow. */
  readonly type: string;
};

/**
 * The columns of {@link StoredSetupTarget}, as both setup tables name them. A
 * reconnect row has `connection_id` and NULL in the other three; a create row
 * has no `connection_id`, and always has `labels` and `config`. The tables'
 * CHECK constraints hold both rules.
 */
export interface SetupTargetRow {
  readonly type: string;
  readonly connection_id: Uint8Array | null;
  readonly label: string | null;
  readonly labels: string | null;
  readonly config: string | null;
}

/** Builds the shared columns of a setup row from the target it stores. */
export const buildSetupTargetRow = (target: StoredSetupTarget): SetupTargetRow =>
  target.kind === "create"
    ? {
        type: target.type,
        connection_id: null,
        label: target.label ?? null,
        labels: JSON.stringify(target.labels),
        config: JSON.stringify(target.config),
      }
    : {
        type: target.type,
        connection_id: uuidFromString(target.connectionId),
        label: null,
        labels: null,
        config: null,
      };

/**
 * Parses the shared columns of a setup row. Only the setup repositories write
 * the JSON columns, and the table refuses a create row without them, so a
 * column that is missing or does not parse means the database is broken, and
 * `JSON.parse` throws.
 */
export const parseSetupTargetRow = (row: SetupTargetRow): StoredSetupTarget =>
  row.connection_id === null
    ? {
        type: row.type,
        kind: "create",
        label: row.label ?? undefined,
        labels: JSON.parse(row.labels ?? "") as ReadonlyArray<string>,
        config: JSON.parse(row.config ?? "") as Record<string, Schema.Json>,
      }
    : { type: row.type, kind: "reconnect", connectionId: uuidToString(row.connection_id) };
