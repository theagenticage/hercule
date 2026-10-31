/**
 * Turns every Provider Instance into a Provider Account (spec 06 section 19,
 * spec 04 "Provider account rows", ADR 0048).
 *
 * Every instance becomes one account with the same id, and nothing is dropped
 * or split per runner. The instance's harness decides the provider and the
 * account kind:
 *
 * - `claude-code/claude-code`: Anthropic, `subscription-per-machine`
 * - `codex/codex`: OpenAI, `subscription-per-machine`
 * - `pi/pi`: Z.ai, `api-key`
 *
 * An instance of any other harness id makes the migration fail. Instances are
 * only ever created for the three harnesses above, so such a row can come
 * only from a hand-edited database, and there is no provider to give it.
 * Guessing one would hide the problem. The message names the instance, and
 * the pre-migration backup is untouched.
 *
 * What the migration writes, by table:
 *
 * - `provider_accounts` is new. The instance id is the account id. The
 *   instance's harness is the account's default harness, and also its legacy
 *   home harness; the instance id is its legacy home folder, because the
 *   runners keep each harness home where it is (moving one breaks Codex
 *   resume and Claude Code's login).
 * - The label follows spec 06 section 15.3. An instance named after its
 *   harness gets no label, and a name the user typed becomes the label. When
 *   two accounts of one provider would share a label (or both have none),
 *   the one created later takes its instance's name, and " 2", " 3" and so on
 *   is added while that still clashes. A name too long to take the suffix is
 *   shortened.
 * - The identity comes from the instance's snapshots, but only when every
 *   snapshot that reports one names the same person. The plan comes from the
 *   most recently probed of those snapshots.
 * - `capability_snapshots` is rebuilt, keyed by (account, harness, runner).
 * - `sessions` and `agents` (so assistants too) rename `instance_id` to
 *   `provider_account_id` and gain `harness_id`. A session's stored `spec`
 *   JSON renames its `instanceId` key. A session's `harness_id` is NOT NULL.
 *   There is no foreign key from a session to its account: a session is
 *   history and must survive the deletion of its account. A session whose
 *   instance was deleted long before this migration has no known harness, and
 *   keeps the column's default, `unknown`. SQLite cannot remove a default
 *   from a column, and rebuilding `sessions` would cascade-delete rows in the
 *   tables that reference it, so the default stays. The repository always
 *   writes the column.
 * - Each user's setting `thread.instanceId` (a row of `user_settings`) becomes
 *   `thread.providerAccountId` beside a new `thread.harnessId`, and the controller setting
 *   `textGeneration.model` renames `instanceId` to `providerAccountId` and
 *   gains `harnessId`. Agents get their instance's harness in `harness_id` as
 *   well, so every reference keeps meaning the harness it ran in even if the
 *   account's default harness is edited later.
 * - `secrets`: pi's `zaiApiKey` (owner kind `provider-instance`) becomes the
 *   Z.ai account's `apiKey` (owner kind `provider-account`). The owner and
 *   name are the value's associated data, so each value is decrypted and
 *   encrypted again with the Master Key, which the boot opens before the
 *   migrations run. A value that does not decrypt, or a Master Key that is
 *   missing while such a value exists, fails the migration. Any other
 *   `provider-instance` row was never readable (an instance could only read
 *   the secret fields its harness declares, and only pi declared one), so it
 *   is deleted. The table is rebuilt because SQLite cannot change the CHECK
 *   that lists the owner kinds.
 * - `provider_instances` is dropped.
 *
 * The audit log (`events.payload`) is not touched: it records what was true
 * when it was written.
 *
 * The cipher is written out here instead of imported from the secrets domain
 * on purpose: a migration that has shipped never changes, and the secrets
 * domain imports the database folder.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { uuidToString } from "../id";
import { MigrationMasterKey } from "../migration-master-key";

/** The migration cannot convert this database. The boot prints the message after the migration's name. */
class ProviderAccountMigrationError extends Data.TaggedError("ProviderAccountMigrationError")<{
  readonly message: string;
}> {}

/** What an instance of one harness becomes: its provider, its account kind, and its default name. */
const SHIPPED_HARNESSES: Readonly<
  Record<
    string,
    { readonly providerId: string; readonly kind: string; readonly displayName: string }
  >
> = {
  "claude-code/claude-code": {
    providerId: "anthropic/anthropic",
    kind: "subscription-per-machine",
    displayName: "Claude Code",
  },
  "codex/codex": {
    providerId: "openai/openai",
    kind: "subscription-per-machine",
    displayName: "Codex",
  },
  "pi/pi": { providerId: "zai/zai", kind: "api-key", displayName: "pi" },
};

/**
 * The longest label an account may have, counted in UTF-16 code units: the
 * way the API's label check counts a JavaScript string, and so the way a label
 * must be measured for the API to accept it again. The table's CHECK counts
 * characters (code points) with SQLite's `length()`, which never exceeds the
 * unit count, so a label that passes the API's check always passes the CHECK.
 * The migration therefore follows the API, not the CHECK.
 */
const MAX_LABEL_LENGTH = 128;

interface InstanceRow {
  readonly id: Uint8Array;
  readonly harness_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Returns the label of `name` with " 2", " 3" and so on added until `isTaken`
 * no longer holds. The name is shortened so that the result fits the limit,
 * and is never cut between the two halves of a surrogate pair (one emoji).
 */
const addNumber = (name: string, isTaken: (label: string) => boolean): string => {
  for (let number = 2; ; number += 1) {
    const suffix = ` ${number}`;
    let cut = Math.min(name.length, MAX_LABEL_LENGTH - suffix.length);
    const lastKept = name.charCodeAt(cut - 1);
    if (cut < name.length && lastKept >= 0xd800 && lastKept <= 0xdbff) cut -= 1;
    const label = name.slice(0, cut) + suffix;
    if (!isTaken(label)) return label;
  }
};

/**
 * Works out each account's label from its instances, oldest first (spec 06
 * section 19). Returns the label by instance id, `null` for no label.
 */
const assignLabels = (instances: ReadonlyArray<InstanceRow>): Map<string, string | null> => {
  const labels = new Map<string, string | null>();
  // The labels taken so far, per provider. Labels are never empty, so the
  // empty string stands for "no label", which counts as one value.
  const takenByProvider = new Map<string, Set<string>>();
  for (const instance of instances) {
    const shipped = SHIPPED_HARNESSES[instance.harness_id]!;
    const taken = takenByProvider.get(shipped.providerId) ?? new Set<string>();
    takenByProvider.set(shipped.providerId, taken);
    const natural = instance.name === shipped.displayName ? null : instance.name;
    let label = natural;
    if (taken.has(label ?? "")) {
      label = taken.has(instance.name)
        ? addNumber(instance.name, (candidate) => taken.has(candidate))
        : instance.name;
    }
    taken.add(label ?? "");
    labels.set(uuidToString(instance.id), label);
  }
  return labels;
};

/** Parses the JSON text of a stored setting. Returns `undefined` for text that is not JSON. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const encoder = new TextEncoder();

const buildAssociatedData = (kind: string, id: string, name: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(`${kind}|${id}|${name}`);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const instances = yield* sql<InstanceRow>`
    SELECT id, provider_id AS harness_id, name, created_at, updated_at
    FROM provider_instances
    ORDER BY created_at, id`;
  for (const instance of instances) {
    if (SHIPPED_HARNESSES[instance.harness_id] === undefined) {
      return yield* new ProviderAccountMigrationError({
        message:
          `The provider instance ${uuidToString(instance.id)} ("${instance.name}") runs the ` +
          `harness "${instance.harness_id}", which this version has no provider for. Only ` +
          `claude-code/claude-code, codex/codex and pi/pi instances can become Provider ` +
          `Accounts. Delete that instance with the previous version, then start this one again.`,
      });
    }
  }

  const labels = assignLabels(instances);
  const harnessByAccount = new Map(
    instances.map((instance) => [uuidToString(instance.id), instance.harness_id]),
  );

  // The latest snapshots, newest probe first, so the first row for an
  // instance is the one the plan comes from.
  const identified = yield* sql<{
    readonly instance_id: Uint8Array;
    readonly auth_identity: string;
    readonly auth_plan_label: string | null;
  }>`
    SELECT instance_id, auth_identity, auth_plan_label
    FROM capability_snapshots
    WHERE auth_identity IS NOT NULL AND auth_identity <> ''
    ORDER BY probed_at DESC, runner_id`;
  const signedIn = new Map<string, { identity: string; planLabel: string | null }>();
  const disagreeing = new Set<string>();
  for (const row of identified) {
    const id = uuidToString(row.instance_id);
    const first = signedIn.get(id);
    if (first === undefined) {
      signedIn.set(id, { identity: row.auth_identity, planLabel: row.auth_plan_label });
    } else if (first.identity !== row.auth_identity) {
      disagreeing.add(id);
    }
  }

  yield* sql`
    CREATE TABLE provider_accounts (
      id BLOB PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 128),
      label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 128),
      identity TEXT,
      plan_label TEXT,
      default_harness_id TEXT NOT NULL CHECK (length(default_harness_id) BETWEEN 1 AND 128),
      -- Both set, or both null: the folder an account kept from its Provider
      -- Instance, and the harness that folder belongs to.
      legacy_home_folder TEXT,
      legacy_home_harness_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((legacy_home_folder IS NULL) = (legacy_home_harness_id IS NULL))
    )
  `;
  // Labels are unique per provider, and no label counts as one value. A label
  // is never empty (the CHECK above), so '' stands for none.
  yield* sql`
    CREATE UNIQUE INDEX provider_accounts_label ON provider_accounts (provider_id, coalesce(label, ''))
  `;
  for (const instance of instances) {
    const id = uuidToString(instance.id);
    const shipped = SHIPPED_HARNESSES[instance.harness_id]!;
    const who = disagreeing.has(id) ? undefined : signedIn.get(id);
    yield* sql`
      INSERT INTO provider_accounts
        (id, provider_id, kind, label, identity, plan_label, default_harness_id,
         legacy_home_folder, legacy_home_harness_id, created_at, updated_at)
      VALUES
        (${instance.id}, ${shipped.providerId}, ${shipped.kind}, ${labels.get(id) ?? null},
         ${who?.identity ?? null}, ${who?.planLabel ?? null}, ${instance.harness_id},
         ${id}, ${instance.harness_id}, ${instance.created_at}, ${instance.updated_at})`;
  }

  yield* sql`
    CREATE TABLE capability_snapshots_new (
      provider_account_id BLOB NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
      harness_id TEXT NOT NULL CHECK (length(harness_id) BETWEEN 1 AND 128),
      runner_id BLOB NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
      probed_at TEXT NOT NULL,
      harness_version TEXT,
      auth_status TEXT NOT NULL CHECK (auth_status IN ('ok', 'unauthenticated', 'error')),
      auth_identity TEXT,
      auth_plan_label TEXT,
      auth_backend TEXT,
      auth_message TEXT,
      models TEXT NOT NULL CHECK (json_valid(models)),
      PRIMARY KEY (provider_account_id, harness_id, runner_id)
    )
  `;
  yield* sql`
    INSERT INTO capability_snapshots_new
      (provider_account_id, harness_id, runner_id, probed_at, harness_version, auth_status,
       auth_identity, auth_plan_label, auth_backend, auth_message, models)
    SELECT s.instance_id, i.provider_id, s.runner_id, s.probed_at, s.harness_version,
           s.auth_status, s.auth_identity, s.auth_plan_label, s.auth_backend, s.auth_message,
           s.models
    FROM capability_snapshots AS s
    JOIN provider_instances AS i ON i.id = s.instance_id
  `;
  yield* sql`DROP TABLE capability_snapshots`;
  yield* sql`ALTER TABLE capability_snapshots_new RENAME TO capability_snapshots`;

  yield* sql`ALTER TABLE sessions RENAME COLUMN instance_id TO provider_account_id`;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN harness_id TEXT NOT NULL DEFAULT 'unknown'
      CHECK (length(harness_id) BETWEEN 1 AND 128)
  `;
  yield* sql`
    UPDATE sessions
    SET harness_id = (SELECT default_harness_id FROM provider_accounts
                      WHERE provider_accounts.id = sessions.provider_account_id)
    WHERE provider_account_id IN (SELECT id FROM provider_accounts)
  `;
  yield* sql`
    UPDATE sessions
    SET spec = json_set(
      json_remove(spec, '$.instanceId'),
      '$.providerAccountId', json_extract(spec, '$.instanceId')
    )
    WHERE json_type(spec, '$.instanceId') = 'text'
  `;

  yield* sql`ALTER TABLE agents RENAME COLUMN instance_id TO provider_account_id`;
  yield* sql`
    ALTER TABLE agents ADD COLUMN harness_id TEXT
      CHECK (harness_id IS NULL OR length(harness_id) BETWEEN 1 AND 128)
  `;
  yield* sql`
    UPDATE agents
    SET harness_id = (SELECT default_harness_id FROM provider_accounts
                      WHERE provider_accounts.id = agents.provider_account_id)
    WHERE provider_account_id IN (SELECT id FROM provider_accounts)
  `;

  // Every user's default account for a new Thread. A value that is not a JSON
  // string was already ignored by the settings reader, so it is only removed.
  const threadDefaults = yield* sql<{
    readonly user_id: Uint8Array;
    readonly value: string;
    readonly updated_at: string;
  }>`SELECT user_id, value, updated_at FROM user_settings WHERE key = 'thread.instanceId'`;
  yield* sql`DELETE FROM user_settings WHERE key = 'thread.instanceId'`;
  for (const row of threadDefaults) {
    const accountId = parseJson(row.value);
    if (typeof accountId !== "string") continue;
    yield* sql`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (${row.user_id}, 'thread.providerAccountId', ${row.value}, ${row.updated_at}),
             (${row.user_id}, 'thread.harnessId',
              ${JSON.stringify(harnessByAccount.get(accountId) ?? null)}, ${row.updated_at})`;
  }

  const textGeneration = yield* sql<{ readonly value: string }>`
    SELECT value FROM settings WHERE scope = 'controller' AND key = 'textGeneration.model'`;
  for (const row of textGeneration) {
    const chosen = parseJson(row.value);
    if (typeof chosen !== "object" || chosen === null || !("instanceId" in chosen)) continue;
    const { instanceId, ...rest } = chosen as { instanceId: string };
    const harnessId = harnessByAccount.get(instanceId);
    yield* sql`
      UPDATE settings
      SET value = ${JSON.stringify({
        providerAccountId: instanceId,
        ...(harnessId === undefined ? {} : { harnessId }),
        ...rest,
      })}
      WHERE scope = 'controller' AND key = 'textGeneration.model'`;
  }

  const held = yield* sql<{
    readonly id: Uint8Array<ArrayBuffer>;
    readonly owner_id: string;
    readonly name: string;
    readonly nonce: Uint8Array<ArrayBuffer>;
    readonly ciphertext: Uint8Array<ArrayBuffer>;
    readonly created_at: string;
    readonly rotated_at: string | null;
  }>`
    SELECT id, owner_id, name, nonce, ciphertext, created_at, rotated_at
    FROM secrets WHERE owner_kind = 'provider-instance'`;
  const zaiKeys = held.filter(
    (secret) => secret.name === "zaiApiKey" && harnessByAccount.get(secret.owner_id) === "pi/pi",
  );
  const key = Option.map(yield* Effect.serviceOption(MigrationMasterKey), (master) => master.key);
  if (zaiKeys.length > 0 && Option.isNone(key)) {
    return yield* new ProviderAccountMigrationError({
      message:
        `${zaiKeys.length} Z.ai API ${zaiKeys.length === 1 ? "key has" : "keys have"} to be ` +
        `encrypted again for its Provider Account, which needs the Master Key, and this ` +
        `machine has none. Restore the key this machine had, then start this version again.`,
    });
  }
  const moved: Array<{
    readonly secret: (typeof zaiKeys)[number];
    readonly nonce: Uint8Array<ArrayBuffer>;
    readonly ciphertext: Uint8Array<ArrayBuffer>;
  }> = [];
  if (Option.isSome(key)) {
    for (const secret of zaiKeys) {
      const plaintext = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: secret.nonce,
              additionalData: buildAssociatedData(
                "provider-instance",
                secret.owner_id,
                "zaiApiKey",
              ),
            },
            key.value,
            secret.ciphertext,
          ),
        catch: () =>
          new ProviderAccountMigrationError({
            message:
              `The Z.ai API key of the provider instance ${secret.owner_id} did not decrypt. ` +
              `Either the Master Key is not the one it was written under, or the row was ` +
              `edited outside Hercule. Restore the right key, or delete that instance with the ` +
              `previous version, then start this one again.`,
          }),
      });
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = yield* Effect.promise(() =>
        crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: buildAssociatedData("provider-account", secret.owner_id, "apiKey"),
          },
          key.value,
          plaintext,
        ),
      );
      moved.push({ secret, nonce, ciphertext: new Uint8Array(encrypted) });
    }
  }

  yield* sql`
    CREATE TABLE secrets_new (
      id BLOB PRIMARY KEY NOT NULL,
      owner_kind TEXT NOT NULL CHECK (
        owner_kind IN ('connection', 'plugin', 'runner', 'core', 'provider-account')
      ),
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      created_at TEXT NOT NULL,
      rotated_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO secrets_new (id, owner_kind, owner_id, name, nonce, ciphertext, created_at, rotated_at)
    SELECT id, owner_kind, owner_id, name, nonce, ciphertext, created_at, rotated_at
    FROM secrets WHERE owner_kind <> 'provider-instance'
  `;
  for (const { secret, nonce, ciphertext } of moved) {
    yield* sql`
      INSERT INTO secrets_new
        (id, owner_kind, owner_id, name, nonce, ciphertext, created_at, rotated_at)
      VALUES
        (${secret.id}, 'provider-account', ${secret.owner_id}, 'apiKey', ${nonce}, ${ciphertext},
         ${secret.created_at}, ${secret.rotated_at})`;
  }
  yield* sql`DROP TABLE secrets`;
  yield* sql`ALTER TABLE secrets_new RENAME TO secrets`;
  // Dropping a table drops its indexes, so every index the table had is made
  // again: `secrets_owner_name` (0001) and `secrets_name` (0002).
  yield* sql`CREATE UNIQUE INDEX secrets_owner_name ON secrets (owner_kind, owner_id, name)`;
  yield* sql`CREATE INDEX secrets_name ON secrets (name, id)`;

  yield* sql`DROP TABLE provider_instances`;
});
