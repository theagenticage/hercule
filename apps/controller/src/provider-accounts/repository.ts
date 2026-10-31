/**
 * Provider Account rows and their Capability Snapshots. An install has only a
 * handful of accounts, so listings read the whole table.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { ModelDescriptor, type ProbeResult } from "@hercule/protocol";
import { mintUuid, uuidFromString, uuidToString } from "../db";

/**
 * An account as it is stored. The two `legacyHome` fields are read by
 * `resolveHarnessHome` alone; nothing else may look at them, and they never
 * reach the public record.
 */
export interface StoredProviderAccount {
  readonly id: string;
  /** The qualified id of the provider, such as `anthropic/anthropic`. */
  readonly providerId: string;
  /** The id of one of the provider's account kinds. */
  readonly kind: string;
  readonly label: string | null;
  /**
   * Who the account is signed in as, such as an email address. Null until
   * a probe reports an identity for the account (or the upgrade from the
   * previous version sets it from the snapshots runners reported). Once set, a
   * probe that reports another person is stored as unauthenticated.
   */
  readonly identity: string | null;
  /** The plan the account is on. Set the same way as `identity`. */
  readonly planLabel: string | null;
  /** The qualified id of the harness a session uses when it names none. */
  readonly defaultHarnessId: string;
  /**
   * When the account's token stops working, or null. Set only for an account
   * whose credential is a token Hercule made.
   */
  readonly credentialExpiresAt: string | null;
  /**
   * Counts the credentials the account has had: it goes up whenever a new
   * key or token is stored and whenever a sign-in is accepted. A probe
   * carries the number it was sent under, so an answer to a probe sent before
   * the change is told apart from one that describes the current credential.
   */
  readonly credentialGeneration: number;
  /** The folder name under `providers/` that an account made by the upgrade from the previous version keeps, or null. */
  readonly legacyHomeFolder: string | null;
  /** The qualified id of the harness that folder belongs to, or null. Null exactly when the folder is. */
  readonly legacyHomeHarnessId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface NewProviderAccount {
  readonly providerId: string;
  readonly kind: string;
  readonly label: string | null;
  readonly defaultHarnessId: string;
  readonly at: string;
}

/** The columns an update may set. An absent field leaves its column unchanged. */
interface ProviderAccountEdit {
  readonly label?: string | null;
  readonly defaultHarnessId?: string;
}

interface ProviderAccountRow {
  readonly id: Uint8Array;
  readonly provider_id: string;
  readonly kind: string;
  readonly label: string | null;
  readonly identity: string | null;
  readonly plan_label: string | null;
  readonly default_harness_id: string;
  readonly credential_expires_at: string | null;
  readonly credential_generation: number;
  readonly legacy_home_folder: string | null;
  readonly legacy_home_harness_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const ACCOUNT_COLUMNS =
  "id, provider_id, kind, label, identity, plan_label, default_harness_id, " +
  "credential_expires_at, credential_generation, legacy_home_folder, legacy_home_harness_id, created_at, updated_at";

const toStoredProviderAccount = (row: ProviderAccountRow): StoredProviderAccount => ({
  id: uuidToString(row.id),
  providerId: row.provider_id,
  kind: row.kind,
  label: row.label,
  identity: row.identity,
  planLabel: row.plan_label,
  defaultHarnessId: row.default_harness_id,
  credentialExpiresAt: row.credential_expires_at,
  credentialGeneration: row.credential_generation,
  legacyHomeFolder: row.legacy_home_folder,
  legacyHomeHarnessId: row.legacy_home_harness_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** What one runner found out about one account in one harness, the last time it probed. */
export interface StoredSnapshot {
  readonly providerAccountId: string;
  /** The qualified id of the harness that was probed. */
  readonly harnessId: string;
  readonly runnerId: string;
  readonly probedAt: string;
  readonly harnessVersion: string | null;
  readonly auth: ProbeResult["auth"];
  readonly models: ProbeResult["models"];
}

interface SnapshotRow {
  readonly provider_account_id: Uint8Array;
  readonly harness_id: string;
  readonly runner_id: Uint8Array;
  readonly probed_at: string;
  readonly harness_version: string | null;
  readonly auth_status: string;
  readonly auth_identity: string | null;
  readonly auth_plan_label: string | null;
  readonly auth_backend: string | null;
  readonly auth_message: string | null;
  readonly models: string;
}

/** What a snapshot says while the probe that checks a new sign-in has not answered. */
const SIGN_IN_PENDING_MESSAGE = "Checking the sign-in…";

const SNAPSHOT_COLUMNS =
  "provider_account_id, harness_id, runner_id, probed_at, harness_version, auth_status, " +
  "auth_identity, auth_plan_label, auth_backend, auth_message, models";

const decodeModels = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ModelDescriptor)),
);

/** Converts a null column to an absent key, because the wire schema has no nulls. */
const toProbeAuth = (row: SnapshotRow): ProbeResult["auth"] => ({
  status: row.auth_status as ProbeResult["auth"]["status"],
  ...(row.auth_identity === null ? {} : { identity: row.auth_identity }),
  ...(row.auth_plan_label === null ? {} : { planLabel: row.auth_plan_label }),
  ...(row.auth_backend === null ? {} : { backend: row.auth_backend }),
  ...(row.auth_message === null ? {} : { message: row.auth_message }),
});

const toSnapshot = (row: SnapshotRow): Effect.Effect<StoredSnapshot, Schema.SchemaError> =>
  Effect.map(decodeModels(row.models), (models) => ({
    providerAccountId: uuidToString(row.provider_account_id),
    harnessId: row.harness_id,
    runnerId: uuidToString(row.runner_id),
    probedAt: row.probed_at,
    harnessVersion: row.harness_version,
    auth: toProbeAuth(row),
    models,
  }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Returns every account, oldest first and then by id, so two listings match. */
    list: (): Effect.Effect<ReadonlyArray<StoredProviderAccount>, SqlError> =>
      Effect.map(
        sql<ProviderAccountRow>`
          SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM provider_accounts
          ORDER BY created_at, id
        `,
        (rows) => rows.map(toStoredProviderAccount),
      ),

    one: (id: string): Effect.Effect<Option.Option<StoredProviderAccount>, SqlError> =>
      Effect.map(
        sql<ProviderAccountRow>`
          SELECT ${sql.literal(ACCOUNT_COLUMNS)} FROM provider_accounts
          WHERE id = ${uuidFromString(id)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toStoredProviderAccount),
      ),

    /** Returns whether the controller has any account at all. */
    hasAny: (): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly one: number }>`SELECT 1 AS one FROM provider_accounts LIMIT 1`,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns whether another account of the provider already has this label.
     * `null` stands for no label, which counts as one value, so an account
     * with no label clashes with another account of the provider that has
     * none. The account `exceptId` is left out, so an account never clashes
     * with itself.
     */
    isLabelTaken: (
      providerId: string,
      label: string | null,
      exceptId: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly one: number }>`
          SELECT 1 AS one FROM provider_accounts
          WHERE provider_id = ${providerId}
            AND coalesce(label, '') = ${label ?? ""}
            AND id <> ${uuidFromString(exceptId)}
          LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /** Inserts an account with a new id. A fresh account has no legacy home. */
    insert: (account: NewProviderAccount): Effect.Effect<StoredProviderAccount, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO provider_accounts
            (id, provider_id, kind, label, default_harness_id, created_at, updated_at)
          VALUES (${id}, ${account.providerId}, ${account.kind}, ${account.label},
                  ${account.defaultHarnessId}, ${account.at}, ${account.at})
        `;
        return {
          id: uuidToString(id),
          providerId: account.providerId,
          kind: account.kind,
          label: account.label,
          identity: null,
          planLabel: null,
          defaultHarnessId: account.defaultHarnessId,
          credentialExpiresAt: null,
          credentialGeneration: 0,
          legacyHomeFolder: null,
          legacyHomeHarnessId: null,
          createdAt: account.at,
          updatedAt: account.at,
        };
      }),

    update: (id: string, edit: ProviderAccountEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.label !== undefined) sets.push(sql`label = ${edit.label}`);
      if (edit.defaultHarnessId !== undefined) {
        sets.push(sql`default_harness_id = ${edit.defaultHarnessId}`);
      }
      return Effect.asVoid(
        sql`UPDATE provider_accounts SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /**
     * Sets when the account's token stops working. Does nothing when the
     * account does not exist.
     */
    setCredentialExpiry: (
      id: string,
      expiresAt: string,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE provider_accounts SET credential_expires_at = ${expiresAt}, updated_at = ${at}
        WHERE id = ${uuidFromString(id)}
      `),

    /**
     * Clears the account's identity and plan label, so the next `ok` probe
     * that reports an identity sets them again. Used when the account gets a
     * new credential, which may belong to someone else. Does nothing when the
     * account does not exist.
     */
    clearIdentity: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE provider_accounts SET identity = NULL, plan_label = NULL, updated_at = ${at}
        WHERE id = ${uuidFromString(id)}
      `),

    /**
     * Adds one to the account's credential generation. Call it in the
     * transaction that stores a new credential or accepts a sign-in, so a
     * probe sent before it is recognised as stale. Does nothing when the
     * account does not exist.
     */
    advanceCredentialGeneration: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE provider_accounts
        SET credential_generation = credential_generation + 1, updated_at = ${at}
        WHERE id = ${uuidFromString(id)}
      `),

    /**
     * Marks the runner's snapshot of the account in the harness as not signed
     * in, with the message "Checking the sign-in…", and leaves its time
     * unchanged. Placement uses only snapshots that are signed in, so the
     * runner is not placed on until a probe stores a newer snapshot. Does
     * nothing when there is no such snapshot.
     */
    markSnapshotSignInPending: (
      providerAccountId: string,
      harnessId: string,
      runnerId: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE capability_snapshots
        SET auth_status = 'unauthenticated', auth_message = ${SIGN_IN_PENDING_MESSAGE}
        WHERE provider_account_id = ${uuidFromString(providerAccountId)}
          AND harness_id = ${harnessId}
          AND runner_id = ${uuidFromString(runnerId)}
      `),

    /** Deletes the account. Its snapshots are deleted with it, by the foreign key. */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM provider_accounts WHERE id = ${uuidFromString(id)}`),

    /** Lists the snapshots of every account in one query, ordered by account, harness and runner. */
    listAllSnapshots: (): Effect.Effect<
      ReadonlyArray<StoredSnapshot>,
      SqlError | Schema.SchemaError
    > =>
      Effect.flatMap(
        sql<SnapshotRow>`
          SELECT ${sql.literal(SNAPSHOT_COLUMNS)} FROM capability_snapshots
          ORDER BY provider_account_id, harness_id, runner_id
        `,
        (rows) => Effect.forEach(rows, toSnapshot),
      ),

    /**
     * Lists which runner is signed in to which account in which harness, as
     * one row per snapshot whose auth status is `ok`, with the identity that
     * snapshot reported (`null` when it reported none). It reads four columns
     * and no model list, so a caller that only needs to know where an account
     * can run does not decode every model.
     */
    listSignedIn: (): Effect.Effect<
      ReadonlyArray<{
        readonly providerAccountId: string;
        readonly harnessId: string;
        readonly runnerId: string;
        readonly identity: string | null;
      }>,
      SqlError
    > =>
      Effect.map(
        sql<{
          readonly provider_account_id: Uint8Array;
          readonly harness_id: string;
          readonly runner_id: Uint8Array;
          readonly auth_identity: string | null;
        }>`
          SELECT provider_account_id, harness_id, runner_id, auth_identity FROM capability_snapshots
          WHERE auth_status = 'ok'
        `,
        (rows) =>
          rows.map((row) => ({
            providerAccountId: uuidToString(row.provider_account_id),
            harnessId: row.harness_id,
            runnerId: uuidToString(row.runner_id),
            identity: row.auth_identity,
          })),
      ),

    listSnapshots: (
      providerAccountId: string,
    ): Effect.Effect<ReadonlyArray<StoredSnapshot>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<SnapshotRow>`
          SELECT ${sql.literal(SNAPSHOT_COLUMNS)} FROM capability_snapshots
          WHERE provider_account_id = ${uuidFromString(providerAccountId)}
          ORDER BY harness_id, runner_id
        `,
        (rows) => Effect.forEach(rows, toSnapshot),
      ),

    /** Lists the snapshots of the account in one harness, one per runner, ordered by runner. */
    listHarnessSnapshots: (
      providerAccountId: string,
      harnessId: string,
    ): Effect.Effect<ReadonlyArray<StoredSnapshot>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<SnapshotRow>`
          SELECT ${sql.literal(SNAPSHOT_COLUMNS)} FROM capability_snapshots
          WHERE provider_account_id = ${uuidFromString(providerAccountId)}
            AND harness_id = ${harnessId}
          ORDER BY runner_id
        `,
        (rows) => Effect.forEach(rows, toSnapshot),
      ),

    /**
     * Returns the snapshot one runner reported for the account in one harness,
     * or `none` when that runner has not reported one.
     */
    readSnapshot: (
      providerAccountId: string,
      harnessId: string,
      runnerId: string,
    ): Effect.Effect<Option.Option<StoredSnapshot>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<SnapshotRow>`
          SELECT ${sql.literal(SNAPSHOT_COLUMNS)} FROM capability_snapshots
          WHERE provider_account_id = ${uuidFromString(providerAccountId)}
            AND harness_id = ${harnessId}
            AND runner_id = ${uuidFromString(runnerId)}
        `,
        (rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(toSnapshot(rows[0]), Option.some),
      ),

    /**
     * Sets the account's identity and plan label, only when the account has no
     * identity yet. It is one statement, so when two first sign-ins race, the
     * second one changes nothing. The caller reads the account afterwards to
     * learn which identity won.
     */
    setIdentityIfUnset: (
      id: string,
      identity: string,
      planLabel: string | undefined,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE provider_accounts
        SET identity = ${identity}, plan_label = ${planLabel ?? null}, updated_at = ${at}
        WHERE id = ${uuidFromString(id)} AND identity IS NULL
      `),

    /**
     * Stores a runner's probe result for an account in one harness, replacing
     * the previous one. A snapshot caches the last probe result, and keeps no
     * history.
     */
    recordSnapshot: (
      providerAccountId: string,
      harnessId: string,
      runnerId: string,
      result: ProbeResult,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO capability_snapshots (${sql.literal(SNAPSHOT_COLUMNS)})
        VALUES (${uuidFromString(providerAccountId)}, ${harnessId}, ${uuidFromString(runnerId)},
                ${at}, ${result.harnessVersion}, ${result.auth.status},
                ${result.auth.identity ?? null}, ${result.auth.planLabel ?? null},
                ${result.auth.backend ?? null}, ${result.auth.message ?? null},
                ${JSON.stringify(result.models)})
        ON CONFLICT (provider_account_id, harness_id, runner_id) DO UPDATE SET
          probed_at = excluded.probed_at,
          harness_version = excluded.harness_version,
          auth_status = excluded.auth_status,
          auth_identity = excluded.auth_identity,
          auth_plan_label = excluded.auth_plan_label,
          auth_backend = excluded.auth_backend,
          auth_message = excluded.auth_message,
          models = excluded.models
      `),
  };
});

export const providerAccountRepository = make;
