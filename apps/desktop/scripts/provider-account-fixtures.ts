/**
 * Writes Provider Accounts straight into a stopped controller's database, for
 * the desktop end-to-end tests and the perf script.
 *
 * The API cannot make the accounts they need: `providerAccount.create` does
 * not exist yet, a fresh install only gets its three default accounts, and no
 * operation sets the identity and plan an account shows on its card. The
 * module runs on plain Node, like the perf script.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
}

/**
 * Returns a new UUID version 7 as the 16 bytes a row's id holds: the
 * controller accepts no other version for an account's id.
 */
function buildAccountId(at: number): Buffer {
  const id = randomBytes(16);
  id.writeUIntBE(at, 0, 6);
  id[6] = (id[6]! & 0x0f) | 0x70;
  id[8] = (id[8]! & 0x3f) | 0x80;
  return id;
}

/**
 * Writes `fixtures` into the database of the controller whose Hercule Home is
 * `home`. A fixture whose provider and label match an account that is there
 * already (a label that is absent matches an account with none) sets that
 * account's identity and plan. Any other fixture is added as a new account,
 * created a millisecond after the one before, so the new accounts list in the
 * order given and after the old ones.
 *
 * Nothing is deleted: the accounts a fresh install seeds stay, because
 * assistants and settings may already name them. The controller must be
 * stopped, because it holds its database locked while it runs. Fails when the
 * write fails.
 */
export function writeProviderAccounts(
  home: string,
  fixtures: ReadonlyArray<ProviderAccountFixture>,
): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    const update = database.prepare(
      "UPDATE provider_accounts SET identity = ?, plan_label = ? " +
        "WHERE provider_id = ? AND label IS ?",
    );
    const insert = database.prepare(
      "INSERT INTO provider_accounts (id, provider_id, kind, label, identity, plan_label, " +
        "default_harness_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    database.exec("BEGIN");
    for (const [index, fixture] of fixtures.entries()) {
      const { providerId, kind, label = null, identity = null, planLabel = null } = fixture;
      const { changes } = update.run(identity, planLabel, providerId, label);
      if (changes > 0) continue;
      const at = new Date(now + index).toISOString();
      insert.run(
        buildAccountId(now + index),
        providerId,
        kind,
        label,
        identity,
        planLabel,
        fixture.defaultHarnessId,
        at,
        at,
      );
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

/**
 * Puts the accounts of the controller whose Hercule Home is `home` back as a
 * fresh install makes them: the accounts that have a label are deleted, with
 * their Capability Snapshots, and every account loses its identity and plan.
 * It undoes `writeProviderAccounts`, for a measurement that wants the
 * accounts only in some launches. The controller must be stopped, as for
 * `writeProviderAccounts`. Fails when the write fails, which includes an
 * account with a label that a session or an Agent still uses.
 */
export function resetProviderAccounts(home: string): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    database.exec("BEGIN");
    database.exec("DELETE FROM provider_accounts WHERE label IS NOT NULL");
    database.exec("UPDATE provider_accounts SET identity = NULL, plan_label = NULL");
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}
