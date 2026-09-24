import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { buildHomePaths, HerculeHome } from "../config";
import { withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { masterKeyLayer } from "./masterKey";
import { CORE_OWNER, Secrets, secretsLayer, type SecretOwner } from "./repository";

const CONNECTION: SecretOwner = { kind: "connection", id: "0198e4b0-0000-7000-8000-000000000001" };
const TOKEN = "ghp_a-real-looking-token";

let homes: Array<string> = [];

/** Builds a new temporary home with its own master key file, so each home has a different key. */
const buildHomeLayer = (): Layer.Layer<HerculeHome> => {
  const home = mkdtempSync(join(tmpdir(), "hercule-secrets-"));
  homes.push(home);
  return Layer.succeed(HerculeHome, HerculeHome.of(buildHomePaths(home, join(home, "data"))));
};

/** Builds the real repository over a `:memory:` database with the real migrations. */
const buildStack = (home: Layer.Layer<HerculeHome> = buildHomeLayer()) =>
  secretsLayer.pipe(
    Layer.provide(masterKeyLayer("file").pipe(Layer.provide(home))),
    Layer.provideMerge(TestDatabase),
  );

const run = <A, E>(
  effect: Effect.Effect<A, E, Secrets | SqlClient.SqlClient>,
  layer = buildStack(),
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

const runExit = <A, E>(
  effect: Effect.Effect<A, E, Secrets | SqlClient.SqlClient>,
  layer = buildStack(),
) => Effect.runPromiseExit(effect.pipe(Effect.provide(layer)));

/** Returns what a log line or a template literal would print for a value. */
const printValue = (value: { readonly toString: () => string }): string => value.toString();

/** Returns the typed error of a failed exit, so a test asserts on the tag, not the message. */
const findFailure = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

beforeEach(() => {
  homes = [];
});

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("secrets", () => {
  it("round-trips a value", async () => {
    const value = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
        return yield* secrets.get(CONNECTION, "pat");
      }),
    );
    expect(Option.isSome(value)).toBe(true);
    expect(Redacted.value(Option.getOrThrow(value))).toBe(TOKEN);
  });

  it("returns None for a name the owner does not store", async () => {
    const value = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        return yield* secrets.get(CONNECTION, "absent");
      }),
    );
    expect(Option.isNone(value)).toBe(true);
  });

  it("gives two writes of the same value a different nonce and ciphertext", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const sql = yield* SqlClient.SqlClient;
        yield* secrets.set(CONNECTION, "a", Redacted.make(TOKEN));
        yield* secrets.set({ ...CONNECTION, id: "other" }, "a", Redacted.make(TOKEN));
        return yield* sql<{
          readonly nonce: Uint8Array;
          readonly ciphertext: Uint8Array;
        }>`SELECT nonce, ciphertext FROM secrets ORDER BY owner_id`;
      }),
    );
    expect(rows).toHaveLength(2);
    expect(Buffer.from(rows[0]!.nonce)).toHaveLength(12);
    expect(Buffer.from(rows[0]!.nonce).equals(Buffer.from(rows[1]!.nonce))).toBe(false);
    expect(Buffer.from(rows[0]!.ciphertext).equals(Buffer.from(rows[1]!.ciphertext))).toBe(false);
  });

  it("stores ciphertext, never the plaintext", async () => {
    const stored = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const sql = yield* SqlClient.SqlClient;
        yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
        const rows = yield* sql<{
          readonly ciphertext: Uint8Array;
        }>`SELECT ciphertext FROM secrets`;
        return Buffer.from(rows[0]!.ciphertext);
      }),
    );
    expect(stored.toString("utf8")).not.toContain(TOKEN);
    expect(stored.toString("binary")).not.toContain(TOKEN);
  });

  it("rewrites the row in place on the second set, and stamps rotatedAt", async () => {
    const { first, second, value, count } = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
        const second = yield* secrets.set(CONNECTION, "pat", Redacted.make("rotated"));
        const value = yield* secrets.get(CONNECTION, "pat");
        const rows = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM secrets`;
        return { first, second, value, count: rows[0]!.n };
      }),
    );
    expect(count).toBe(1);
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(first.rotatedAt).toBeNull();
    expect(second.rotatedAt).not.toBeNull();
    expect(Redacted.value(Option.getOrThrow(value))).toBe("rotated");
  });

  it("keeps one owner's values out of another owner's reads", async () => {
    const { mine, theirs } = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
        yield* secrets.set(CORE_OWNER, "pat", Redacted.make("core"));
        return {
          mine: yield* secrets.get(CONNECTION, "pat"),
          theirs: yield* secrets.get(CORE_OWNER, "pat"),
        };
      }),
    );
    expect(Redacted.value(Option.getOrThrow(mine))).toBe(TOKEN);
    expect(Redacted.value(Option.getOrThrow(theirs))).toBe("core");
  });

  it("rejects a name that would make the associated data ambiguous, on write and on read", async () => {
    const written = await runExit(
      Effect.flatMap(Secrets, (secrets) =>
        secrets.set(CONNECTION, "oauth|token", Redacted.make(TOKEN)),
      ),
    );
    expect(findFailure(written)?._tag).toBe("SecretNameError");

    const read = await runExit(
      Effect.flatMap(Secrets, (secrets) => secrets.get(CONNECTION, "oauth|token")),
    );
    expect(findFailure(read)?._tag).toBe("SecretNameError");
  });

  it("fails to decrypt a row whose owner or name was edited directly in the database", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const sql = yield* SqlClient.SqlClient;
        yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
        yield* sql`UPDATE secrets SET name = 'renamed'`;
        return yield* secrets.get(CONNECTION, "renamed");
      }),
    );
    expect(findFailure(exit)?._tag).toBe("SecretDecryptError");
    expect(String(exit)).not.toContain(TOKEN);
  });

  it("fails to decrypt under a different master key", async () => {
    const database = TestDatabase;
    const written = secretsLayer.pipe(
      Layer.provide(masterKeyLayer("file").pipe(Layer.provide(buildHomeLayer()))),
      Layer.provideMerge(database),
    );

    // Write under one key, then read the same rows through a repository built
    // on a second machine's key.
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          readonly nonce: Uint8Array;
          readonly ciphertext: Uint8Array;
        }>`SELECT nonce, ciphertext FROM secrets`;
        return rows[0]!;
      }).pipe(Effect.provide(written)),
    );
    const row = Exit.isSuccess(exit) ? exit.value : undefined;
    expect(row).toBeDefined();

    const other = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO secrets
            (id, owner_kind, owner_id, name, nonce, ciphertext, created_at, rotated_at)
          VALUES (${new Uint8Array(16).fill(1)}, ${CONNECTION.kind}, ${CONNECTION.id}, 'pat',
                  ${row!.nonce}, ${row!.ciphertext}, '2026-01-01T00:00:00.000Z', ${null})
        `;
        return yield* secrets.get(CONNECTION, "pat");
      }).pipe(
        Effect.provide(
          secretsLayer.pipe(
            Layer.provide(masterKeyLayer("file").pipe(Layer.provide(buildHomeLayer()))),
            Layer.provideMerge(TestDatabase),
          ),
        ),
      ),
    );
    expect(findFailure(other)?._tag).toBe("SecretDecryptError");
  });

  it("keeps values out of returned records, strings and JSON", async () => {
    const { ref, value } = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const ref = yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
        const value = yield* secrets.get(CONNECTION, "pat");
        return { ref, value: Option.getOrThrow(value) };
      }),
    );
    expect(JSON.stringify(ref)).not.toContain(TOKEN);
    expect(printValue(value)).toBe("<redacted>");
    expect(JSON.stringify(value)).not.toContain(TOKEN);
  });

  it("joins the caller's transaction and rolls back with it", async () => {
    const after = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
            return yield* Effect.fail(new Error("the operation failed after the write"));
          }),
        ).pipe(Effect.ignore);
        return yield* secrets.get(CONNECTION, "pat");
      }),
    );
    expect(Option.isNone(after)).toBe(true);
  });
});
