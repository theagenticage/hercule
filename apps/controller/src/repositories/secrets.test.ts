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
import { homePaths, HydraHome } from "../config";
import { TestDatabase, withTransaction } from "../db";
import { masterKeyLayer } from "../keys";
import { CORE_OWNER, Secrets, secretsLayer, type SecretOwner } from "./secrets";

const CONNECTION: SecretOwner = { kind: "connection", id: "0198e4b0-0000-7000-8000-000000000001" };
const TOKEN = "ghp_a-real-looking-token";

let homes: Array<string> = [];

/** A master key file in its own temporary home; a second home is a different key. */
const keyIn = (): Layer.Layer<HydraHome> => {
  const home = mkdtempSync(join(tmpdir(), "hydra-secrets-"));
  homes.push(home);
  return Layer.succeed(HydraHome, HydraHome.of(homePaths(home, join(home, "data"))));
};

/** The real repository over a `:memory:` database with the real migrations. */
const stack = (home: Layer.Layer<HydraHome> = keyIn()) =>
  secretsLayer.pipe(
    Layer.provide(masterKeyLayer("file").pipe(Layer.provide(home))),
    Layer.provideMerge(TestDatabase),
  );

const run = <A, E>(effect: Effect.Effect<A, E, Secrets | SqlClient.SqlClient>, layer = stack()) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

const runExit = <A, E>(
  effect: Effect.Effect<A, E, Secrets | SqlClient.SqlClient>,
  layer = stack(),
) => Effect.runPromiseExit(effect.pipe(Effect.provide(layer)));

/** What a log line or a template literal would print for a value. */
const printed = (value: { readonly toString: () => string }): string => value.toString();

/** The typed error a failed exit carries, so a test asserts on the tag, not on prose. */
const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
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

  it("lists the owner's names and nobody else's", async () => {
    const names = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        yield* secrets.set(CONNECTION, "clientSecret", Redacted.make("a"));
        yield* secrets.set(CONNECTION, "pat", Redacted.make("b"));
        yield* secrets.set(CORE_OWNER, "elsewhere", Redacted.make("c"));
        return yield* secrets.listNames(CONNECTION);
      }),
    );
    expect(names).toEqual(["clientSecret", "pat"]);
  });

  it("deletes the row, and deleting nothing is a no-op", async () => {
    const after = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
        yield* secrets.delete(CONNECTION, "pat");
        yield* secrets.delete(CONNECTION, "pat");
        return yield* secrets.get(CONNECTION, "pat");
      }),
    );
    expect(Option.isNone(after)).toBe(true);
  });

  it("refuses an owner id or name that would make the associated data ambiguous", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        return yield* secrets.set(CONNECTION, "oauth|token", Redacted.make(TOKEN));
      }),
    );
    expect(failureOf(exit)?._tag).toBe("SecretNameError");
  });

  it("fails to decrypt a row whose owner or name was edited behind its back", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const sql = yield* SqlClient.SqlClient;
        yield* secrets.set(CONNECTION, "pat", Redacted.make(TOKEN));
        yield* sql`UPDATE secrets SET name = 'renamed'`;
        return yield* secrets.get(CONNECTION, "renamed");
      }),
    );
    expect(failureOf(exit)?._tag).toBe("SecretDecryptError");
    expect(String(exit)).not.toContain(TOKEN);
  });

  it("fails to decrypt under a different master key", async () => {
    const database = TestDatabase;
    const written = secretsLayer.pipe(
      Layer.provide(masterKeyLayer("file").pipe(Layer.provide(keyIn()))),
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
            Layer.provide(masterKeyLayer("file").pipe(Layer.provide(keyIn()))),
            Layer.provideMerge(TestDatabase),
          ),
        ),
      ),
    );
    expect(failureOf(other)?._tag).toBe("SecretDecryptError");
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
    expect(printed(value)).toBe("<redacted>");
    expect(JSON.stringify(value)).not.toContain(TOKEN);
  });

  it("joins the caller's transaction and rolls back with it", async () => {
    const after = await run(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        yield* withTransaction(
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
