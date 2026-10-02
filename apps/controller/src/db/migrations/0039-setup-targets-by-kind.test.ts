/**
 * Tests the migration that splits a pending token flow's row into two kinds,
 * in both setup tables:
 *
 * - the rows of flows in progress are copied across, and a reconnect row
 *   loses the label, topics and config it never used;
 * - the setup repositories read both kinds of migrated row back;
 * - the table accepts a create row with no label, and a reconnect row with
 *   none of the three;
 * - the table refuses a row that mixes the two kinds.
 *
 * The first tests migrate to the schema before this migration, write rows
 * only that schema allows, and then run the remaining migrations. The rows
 * are written in plain SQL, so the tables' checks are tested on their own
 * rather than behind the repositories that already follow them.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { deviceSetupRepository } from "../../connections/device-setups";
import { oauthSetupRepository } from "../../connections/oauth-setups";
import { MEMORY, openDatabase } from "../client";
import { uuidToString } from "../id";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 39);

const at = "2026-09-01T00:00:00.000Z";

/** When the seeded flows expire: after `at`, so a read at `at` still finds them. */
const expiresAt = "2026-09-01T01:00:00.000Z";

/** The id of the connection the seeded reconnect rows name. */
const CONNECTION_ID = new Uint8Array(16).fill(7);

/** The columns this migration rewrites, as a row of either table holds them. */
interface TargetColumns {
  readonly connection_id: Uint8Array | null;
  readonly label: string | null;
  readonly labels: string | null;
  readonly config: string | null;
}

/**
 * Seeds one create row and one reconnect row in each table on the schema
 * before this migration, migrates to the head, and then runs the effect.
 * Returns what the effect returns.
 */
const seedFlowsAndMigrate = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      yield* sql`
        INSERT INTO oauth_setups
          (state, type, connection_id, label, labels, config, origin, code_verifier,
           expires_at, created_at)
        VALUES
          ('create', 'gmail/gmail', NULL, 'work', '["Code"]', '{"watch":"inbox"}',
           'https://h.test', 'verifier-1', ${expiresAt}, ${at}),
          ('reconnect', 'gmail/gmail', ${CONNECTION_ID}, 'work', '["Code"]', '{}',
           'https://h.test', 'verifier-2', ${expiresAt}, ${at})`;
      yield* sql`
        INSERT INTO device_setups
          (setup_id, type, connection_id, label, labels, config, device_code,
           interval_seconds, next_poll_at, expires_at, created_at)
        VALUES
          ('create', 'github/github', NULL, 'work', '["Code"]', '{"org":"acme"}', 'code-1',
           5, ${at}, ${expiresAt}, ${at}),
          ('reconnect', 'github/github', ${CONNECTION_ID}, 'work', '["Code"]', '{}', 'code-2',
           7, ${at}, ${expiresAt}, ${at})`;
      yield* runMigrations();
      return yield* effect;
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

/** Reads the columns this migration rewrote, in both tables. */
const readTargetColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const oauth = yield* sql<
    TargetColumns & { readonly state: string; readonly code_verifier: string }
  >`
    SELECT state, connection_id, label, labels, config, code_verifier
    FROM oauth_setups ORDER BY state`;
  const device = yield* sql<
    TargetColumns & { readonly setup_id: string; readonly interval_seconds: number }
  >`
    SELECT setup_id, connection_id, label, labels, config, interval_seconds
    FROM device_setups ORDER BY setup_id`;
  return { oauth, device };
});

describe("the flows in progress during the upgrade", () => {
  it("are copied across, and a reconnect row keeps only the connection it names", async () => {
    const { oauth, device } = await seedFlowsAndMigrate(readTargetColumns);

    expect(oauth).toEqual([
      {
        state: "create",
        connection_id: null,
        label: "work",
        labels: '["Code"]',
        config: '{"watch":"inbox"}',
        code_verifier: "verifier-1",
      },
      {
        state: "reconnect",
        connection_id: CONNECTION_ID,
        label: null,
        labels: null,
        config: null,
        code_verifier: "verifier-2",
      },
    ]);
    expect(device).toEqual([
      {
        setup_id: "create",
        connection_id: null,
        label: "work",
        labels: '["Code"]',
        config: '{"org":"acme"}',
        interval_seconds: 5,
      },
      {
        setup_id: "reconnect",
        connection_id: CONNECTION_ID,
        label: null,
        labels: null,
        config: null,
        interval_seconds: 7,
      },
    ]);
  });

  it("read back through the setup repositories as a create and a reconnect", async () => {
    const read = await seedFlowsAndMigrate(
      Effect.gen(function* () {
        const oauth = yield* oauthSetupRepository;
        const device = yield* deviceSetupRepository;
        return {
          oauthCreate: yield* oauth.consume("create", at),
          oauthReconnect: yield* oauth.consume("reconnect", at),
          deviceCreate: yield* device.claimPoll("create", at),
          deviceReconnect: yield* device.claimPoll("reconnect", at),
        };
      }),
    );

    const reconnect = { kind: "reconnect", connectionId: uuidToString(CONNECTION_ID) };
    expect(Option.getOrThrow(read.oauthCreate)).toMatchObject({
      kind: "create",
      label: "work",
      labels: ["Code"],
      config: { watch: "inbox" },
    });
    expect(Option.getOrThrow(read.oauthReconnect)).toMatchObject(reconnect);
    expect(read.deviceCreate).toMatchObject({
      _tag: "claimed",
      setup: { kind: "create", label: "work", labels: ["Code"], config: { org: "acme" } },
    });
    expect(read.deviceReconnect).toMatchObject({ _tag: "claimed", setup: reconnect });
  });
});

/**
 * Inserts one row into the table with these target columns, every other
 * column valid, and returns `accepted`, or SQLite's error message when a
 * constraint refuses the row.
 */
const insertTarget = (table: "oauth_setups" | "device_setups", id: string, row: TargetColumns) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const insert =
      table === "oauth_setups"
        ? sql`
            INSERT INTO oauth_setups
              (state, type, connection_id, label, labels, config, origin, code_verifier,
               expires_at, created_at)
            VALUES
              (${id}, 'gmail/gmail', ${row.connection_id}, ${row.label}, ${row.labels},
               ${row.config}, 'https://h.test', 'a-verifier', ${at}, ${at})`
        : sql`
            INSERT INTO device_setups
              (setup_id, type, connection_id, label, labels, config, device_code,
               interval_seconds, next_poll_at, expires_at, created_at)
            VALUES
              (${id}, 'github/github', ${row.connection_id}, ${row.label}, ${row.labels},
               ${row.config}, 'a-device-code', 5, ${at}, ${at}, ${at})`;
    return yield* Effect.match(insert, {
      // The SQL error wraps a constraint error, which wraps SQLite's own
      // error, and only SQLite's message names the constraint.
      onFailure: (error) => String(error.cause.cause),
      onSuccess: () => "accepted",
    });
  });

const CREATE: TargetColumns = { connection_id: null, label: "work", labels: "[]", config: "{}" };
const RECONNECT: TargetColumns = {
  connection_id: CONNECTION_ID,
  label: null,
  labels: null,
  config: null,
};

/** Inserts each row into a freshly migrated table, and returns each row's result in order. */
const insertAll = (table: "oauth_setups" | "device_setups", rows: ReadonlyArray<TargetColumns>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations();
      return yield* Effect.forEach(rows, (row, index) => insertTarget(table, String(index), row));
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe.each(["oauth_setups", "device_setups"] as const)("the %s table", (table) => {
  it("accepts a create row with or without a label, and a reconnect row with none of the three", async () => {
    const results = await insertAll(table, [CREATE, { ...CREATE, label: null }, RECONNECT]);

    expect(results).toEqual(["accepted", "accepted", "accepted"]);
  });

  it("refuses a create row with no topics or no config", async () => {
    const results = await insertAll(table, [
      { ...CREATE, labels: null },
      { ...CREATE, config: null },
    ]);

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses a reconnect row that holds a label, topics or config", async () => {
    const results = await insertAll(table, [
      { ...RECONNECT, label: "work" },
      { ...RECONNECT, labels: "[]" },
      { ...RECONNECT, config: "{}" },
    ]);

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });

  it("refuses topics or config that are not valid JSON", async () => {
    const results = await insertAll(table, [
      { ...CREATE, labels: "[not json" },
      { ...CREATE, config: "{not json" },
    ]);

    for (const result of results) expect(result).toContain("CHECK constraint failed");
  });
});
