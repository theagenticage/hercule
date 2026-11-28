/**
 * Adds Model Catalogs and Model Profiles (spec 06 sections 16 and 17, spec 04).
 *
 * `model_catalogs` holds one row per Provider Account, made when the account's
 * first catalog read ends. A row is deleted with its account, by the foreign
 * key. Its columns:
 *
 * - `models`: the models of the last successful read, as a JSON array of
 *   `ModelDescriptor`, in the order the source listed them.
 * - `first_seen`: a JSON object from model slug to the time the model first
 *   appeared in this account's catalog. It is never pruned, so a model that
 *   leaves the catalog and returns keeps its first date.
 * - `read_at`: when the last successful read ended, or NULL.
 * - `error`: why the last read failed, or NULL when it did not. A failed read
 *   keeps `models`.
 * - `models_stamp`: the time the controller sent the probe whose answer
 *   `models` holds, or NULL before the first successful read. A successful
 *   read replaces `models` only if it was sent after this time, so a slow
 *   answer never overwrites the models of a newer one.
 * - `attempt_stamp`: the time the controller sent the newest probe that ended
 *   in a read, successful or not. `error` belongs to that read, so a failure
 *   replaces `error` only if it was sent after this time. The two stamps are
 *   apart because a success sent before a failure still has newer models than
 *   the stored ones, while the failure stays the newest word on the error.
 *
 * `model_profiles` holds one row per Model Profile. Its `id` is a 16-byte
 * UUID like every other id. `body` is JSON of this shape:
 *
 *     {
 *       "accounts": [{ "providerAccountId": "<canonical uuid>", "harnessId": null, "entries": null }],
 *       "defaultEntry": null,
 *       "dismissedNewModels": []
 *     }
 *
 * `entries: null` means the account's Default Selection has not been applied
 * yet, because its Model Catalog has not been read.
 *
 * The migration inserts the profile "Main", always, even with no account. It
 * holds every account in the order the accounts were added, each with no
 * harness override and a pending selection. Catalogs are not filled here: a
 * migration cannot load plugins, so it cannot tell which snapshot is the
 * catalog source. The runners' sweep after the controller starts makes the
 * first reads, which fill the pending selections.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { mintUuid, uuidToString } from "../id";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE model_catalogs (
      provider_account_id BLOB PRIMARY KEY NOT NULL
        REFERENCES provider_accounts (id) ON DELETE CASCADE,
      models TEXT NOT NULL CHECK (json_valid(models)),
      first_seen TEXT NOT NULL CHECK (json_valid(first_seen)),
      read_at TEXT,
      error TEXT,
      models_stamp TEXT,
      attempt_stamp TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE model_profiles (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 128),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      body TEXT NOT NULL CHECK (json_valid(body)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  const accounts = yield* sql<{ readonly id: Uint8Array }>`
    SELECT id FROM provider_accounts ORDER BY created_at, id
  `;
  const body = {
    accounts: accounts.map((account) => ({
      providerAccountId: uuidToString(account.id),
      harnessId: null,
      entries: null,
    })),
    defaultEntry: null,
    dismissedNewModels: [],
  };
  yield* sql`
    INSERT INTO model_profiles (id, name, revision, body, created_at, updated_at)
    VALUES (${mintUuid()}, 'Main', 1, ${JSON.stringify(body)},
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;
});
