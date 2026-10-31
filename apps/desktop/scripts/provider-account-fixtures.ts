/**
 * Writes Provider Accounts straight into a stopped controller's database, for
 * the desktop end-to-end tests and the perf script.
 *
 * The API cannot make the accounts they need: `providerAccount.create` takes
 * a key the provider accepts, or a sign-in on a real machine, and no
 * operation sets the identity and plan an account shows on its card. A fresh
 * install has no account. Usage readings and a refused key are written the
 * same way, because only a harness reports the first and only a provider
 * refuses the second. The module runs on plain Node, like the perf script.
 *
 * An account can also hold an API key and a Model Catalog that were "read".
 * Creating such an account through the API checks the key with the provider
 * and reads the catalog from it, over the network, and a test has no key a
 * provider accepts.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encryptAccountKey } from "../../../scripts/controller-process.ts";
import type { CatalogModel, UsageReading } from "../../../packages/protocol/src/index";

/** One Provider Account for `writeProviderAccounts` to write. */
export interface ProviderAccountFixture {
  /** The qualified provider, such as `anthropic/anthropic`. */
  readonly providerId: string;
  /** The account kind's id, such as `subscription-per-machine`. */
  readonly kind: string;
  /** The label after the provider's name; absent for an account with none. */
  readonly label?: string;
  /** Who the account is signed in as, such as `rogier@example.com`. */
  readonly identity?: string;
  /** The plan the provider reports, such as `Max`. */
  readonly planLabel?: string;
  /** The qualified harness the account runs in, such as `claude-code/claude-code`. */
  readonly defaultHarnessId: string;
  /** The usage readings the account has, stored as the controller stores a harness's report. */
  readonly usage?: ReadonlyArray<UsageReading>;
  /** The provider's words when it refused the account's key; absent for an account that works. */
  readonly failureMessage?: string;
  /**
   * The API key the account stores, encrypted under the Master Key of the
   * controller's home. A key the provider accepts is not needed: the account
   * also counts as just read for usage, so for the next 15 minutes the
   * controller does not send the key to the provider.
   */
  readonly apiKey?: string;
  /**
   * The models of the account's Model Catalog, stored as if a read had just
   * listed them, with every model first seen at that read. The account then
   * has an empty section in "Main", which is what a Default Selection of
   * `none` leaves after the first read. Because the catalog was just read, the
   * controller does not read it again for hours.
   */
  readonly catalog?: ReadonlyArray<CatalogModel>;
}

/**
 * Returns a new UUID version 7 as the 16 bytes a row's id holds: the
 * controller accepts no other version for an account's id.
 */
function buildUuidV7(at: number): Buffer {
  const id = randomBytes(16);
  id.writeUIntBE(at, 0, 6);
  id[6] = (id[6]! & 0x0f) | 0x70;
  id[8] = (id[8]! & 0x3f) | 0x80;
  return id;
}

/** A section of the profile "Main" as the controller stores it; `entries: null` is a Default Selection not yet applied. */
interface MainSection {
  readonly providerAccountId: string;
  readonly harnessId: string | null;
  readonly entries: ReadonlyArray<unknown> | null;
}

/** Returns the canonical text of the 16 bytes of a stored UUID, such as `01a06d02-8000-7000-8000-000000000a0f`. */
const formatUuid = (id: Uint8Array): string =>
  Buffer.from(id)
    .toString("hex")
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

/**
 * Returns the name that identifies a reading among an account's readings: its
 * window, or `credit`.
 */
const identifyReading = (reading: UsageReading): string =>
  reading.kind === "credit" ? "credit" : reading.window;

/**
 * Writes `fixtures` into the database of the controller whose Hercule Home is
 * `home`. A fixture whose provider and label match an account that is there
 * already (a label that is absent matches an account with none) sets that
 * account's identity and plan. Any other fixture is added as a new account,
 * created a millisecond after the one before, so the new accounts list in the
 * order given and after the old ones.
 *
 * A fixture's usage readings replace the account's, and its `failureMessage`
 * marks the account refused as of now. Its `apiKey` and `catalog` replace the
 * account's key and Model Catalog.
 *
 * Nothing is deleted: assistants and settings may already name an account
 * that is there. The controller must be
 * stopped, because it holds its database locked while it runs. Fails when the
 * write fails.
 */
export function writeProviderAccounts(
  home: string,
  fixtures: ReadonlyArray<ProviderAccountFixture>,
): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    const find = database.prepare(
      "SELECT id FROM provider_accounts WHERE provider_id = ? AND label IS ?",
    );
    const update = database.prepare(
      "UPDATE provider_accounts SET identity = ?, plan_label = ?, failure_message = ?, failed_at = ? " +
        "WHERE id = ?",
    );
    const insert = database.prepare(
      "INSERT INTO provider_accounts (id, provider_id, kind, label, identity, plan_label, " +
        "default_harness_id, failure_message, failed_at, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const clearReadings = database.prepare(
      "DELETE FROM account_usage_readings WHERE provider_account_id = ?",
    );
    const insertReading = database.prepare(
      "INSERT INTO account_usage_readings (provider_account_id, reading, source, taken_at, value) " +
        "VALUES (?, ?, 'read', ?, ?)",
    );
    const clearKey = database.prepare(
      "DELETE FROM secrets WHERE owner_kind = 'provider-account' AND owner_id = ? AND name = 'apiKey'",
    );
    const insertKey = database.prepare(
      "INSERT INTO secrets (id, owner_kind, owner_id, name, nonce, ciphertext, created_at) " +
        "VALUES (?, 'provider-account', ?, 'apiKey', ?, ?, ?)",
    );
    const markJustRead = database.prepare(
      "INSERT OR REPLACE INTO account_usage_reads (provider_account_id, read_started_at) VALUES (?, ?)",
    );
    const storeCatalog = database.prepare(
      "INSERT OR REPLACE INTO model_catalogs (provider_account_id, models, first_seen, read_at, " +
        "first_read_at, error, models_stamp, attempt_stamp) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    );
    const readMain = database.prepare("SELECT body FROM model_profiles WHERE name = 'Main'");
    const writeMain = database.prepare("UPDATE model_profiles SET body = ? WHERE name = 'Main'");
    const now = Date.now();
    const readAt = new Date(now).toISOString();
    database.exec("BEGIN");
    for (const [index, fixture] of fixtures.entries()) {
      const { providerId, kind, label = null, identity = null, planLabel = null } = fixture;
      const failedAt = fixture.failureMessage === undefined ? null : new Date(now).toISOString();
      const failureMessage = fixture.failureMessage ?? null;
      const at = new Date(now + index).toISOString();
      const existing = find.get(providerId, label) as { id: Uint8Array } | undefined;
      let id: Uint8Array;
      if (existing === undefined) {
        id = buildUuidV7(now + index);
        insert.run(
          id,
          providerId,
          kind,
          label,
          identity,
          planLabel,
          fixture.defaultHarnessId,
          failureMessage,
          failedAt,
          at,
          at,
        );
      } else {
        id = existing.id;
        update.run(identity, planLabel, failureMessage, failedAt, id);
      }
      clearReadings.run(id);
      for (const reading of fixture.usage ?? []) {
        insertReading.run(id, identifyReading(reading), reading.takenAt, JSON.stringify(reading));
      }
      if (fixture.apiKey !== undefined) {
        const key = encryptAccountKey(home, formatUuid(id), fixture.apiKey);
        clearKey.run(formatUuid(id));
        insertKey.run(buildUuidV7(now + index), formatUuid(id), key.nonce, key.ciphertext, readAt);
        markJustRead.run(id, readAt);
      }
      if (fixture.catalog !== undefined) {
        const firstSeen = Object.fromEntries(fixture.catalog.map(({ slug }) => [slug, readAt]));
        storeCatalog.run(
          id,
          JSON.stringify(fixture.catalog),
          JSON.stringify(firstSeen),
          readAt,
          readAt,
          readAt,
          readAt,
        );
        const main = readMain.get() as { body: string } | undefined;
        if (main !== undefined) {
          const body = JSON.parse(main.body) as { accounts: MainSection[] };
          const accountId = formatUuid(id);
          if (!body.accounts.some(({ providerAccountId }) => providerAccountId === accountId)) {
            body.accounts.push({ providerAccountId: accountId, harnessId: null, entries: [] });
            writeMain.run(JSON.stringify(body));
          }
        }
      }
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

/**
 * Puts the accounts of the controller whose Hercule Home is `home` back as the
 * fleet leaves them (`connectFleet` in `fleet.ts` makes one unlabelled
 * Anthropic account, which every thread it spawns runs on): that account stays,
 * every other account is deleted, with its Capability Snapshots, API key and
 * Model Catalog, and the
 * account that stays loses its identity, plan, usage readings and refusal. Every Model
 * Profile but "Main" is deleted, and "Main" keeps only the section of the account that
 * stays. It undoes `writeProviderAccounts` and the profiles that the Providers launch
 * makes, for a measurement that wants the accounts only in some launches. The controller must be stopped, as for
 * `writeProviderAccounts`. Fails when the write fails, which includes an
 * account that a session or an Agent still uses and that is not the one that
 * stays.
 */
export function resetProviderAccounts(home: string): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    database.exec("BEGIN");
    database.exec("DELETE FROM account_usage_readings");
    // The one account that stays has no API key.
    database.exec("DELETE FROM secrets WHERE owner_kind = 'provider-account'");
    database.exec(
      "DELETE FROM provider_accounts WHERE NOT (provider_id = 'anthropic/anthropic' AND label IS NULL)",
    );
    database.exec(
      "UPDATE provider_accounts SET identity = NULL, plan_label = NULL, " +
        "failure_message = NULL, failed_at = NULL",
    );
    database.exec("DELETE FROM model_profiles WHERE name <> 'Main'");
    const kept = new Set(
      (database.prepare("SELECT id FROM provider_accounts").all() as { id: Uint8Array }[]).map(
        ({ id }) => formatUuid(id),
      ),
    );
    const main = database.prepare("SELECT body FROM model_profiles WHERE name = 'Main'").get() as
      | { body: string }
      | undefined;
    if (main !== undefined) {
      const body = JSON.parse(main.body) as { accounts: MainSection[] };
      body.accounts = body.accounts.filter(({ providerAccountId }) => kept.has(providerAccountId));
      database
        .prepare("UPDATE model_profiles SET body = ? WHERE name = 'Main'")
        .run(JSON.stringify(body));
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}
