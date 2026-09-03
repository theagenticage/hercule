import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { homePaths, HydraHome } from "../config";
import { TestDatabase } from "../db/testing";
import { ControllerIdentity, controllerIdentityLayer, SIGNING_KEY_SECRET } from "./repository";
import { CORE_OWNER, masterKeyLayer, Secrets, secretsLayer } from "../secrets";

let home: string;

const stack = () => {
  const key = masterKeyLayer("file").pipe(
    Layer.provide(Layer.succeed(HydraHome, HydraHome.of(homePaths(home, join(home, "data"))))),
  );
  return controllerIdentityLayer.pipe(
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(key))),
    Layer.provideMerge(TestDatabase),
  );
};

const run = <A, E>(
  effect: Effect.Effect<A, E, ControllerIdentity | Secrets | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(stack())));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-identity-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the controller identity", () => {
  it("creates one id and Ed25519 public key on first run", async () => {
    const record = await run(
      Effect.gen(function* () {
        const identity = yield* ControllerIdentity;
        return yield* identity.ensure;
      }),
    );
    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Raw SPKI for an Ed25519 public key: 12 header bytes plus the 32-byte key.
    expect(record.publicKey).toHaveLength(44);
    expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);
  });

  it("finds the same identity on every later boot", async () => {
    const { first, second, rows } = await run(
      Effect.gen(function* () {
        const identity = yield* ControllerIdentity;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* identity.ensure;
        const second = yield* identity.ensure;
        const rows = yield* sql<{ readonly n: number }>`SELECT count(*) AS n FROM secrets`;
        return { first, second, rows: rows[0]!.n };
      }),
    );
    expect(second).toEqual(first);
    expect(Buffer.from(second.publicKey).equals(Buffer.from(first.publicKey))).toBe(true);
    expect(rows).toBe(1);
  });

  it("keeps the private key as an encrypted core secret, usable for signing", async () => {
    const { names, verified } = await run(
      Effect.gen(function* () {
        const identity = yield* ControllerIdentity;
        const secrets = yield* Secrets;
        const record = yield* identity.ensure;
        const sql = yield* SqlClient.SqlClient;
        const names = (yield* sql<{ readonly name: string }>`
            SELECT name FROM secrets WHERE owner_kind = 'core' ORDER BY name
          `).map((row) => row.name);
        const stored = Option.getOrThrow(yield* secrets.get(CORE_OWNER, SIGNING_KEY_SECRET));

        // The stored key signs what the stored public key verifies: the two
        // halves in the database belong to each other.
        const verified = yield* Effect.promise(async () => {
          const pkcs8 = Buffer.from(Redacted.value(stored), "base64");
          const privateKey = await crypto.subtle.importKey(
            "pkcs8",
            pkcs8,
            { name: "Ed25519" },
            false,
            ["sign"],
          );
          const publicKey = await crypto.subtle.importKey(
            "spki",
            record.publicKey,
            { name: "Ed25519" },
            false,
            ["verify"],
          );
          const message = new TextEncoder().encode("controller moved to x");
          const signature = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message);
          return crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message);
        });
        return { names, verified };
      }),
    );
    expect(names).toEqual([SIGNING_KEY_SECRET]);
    expect(verified).toBe(true);
  });

  it("never writes the private key into the identity row", async () => {
    const row = await run(
      Effect.gen(function* () {
        const identity = yield* ControllerIdentity;
        const sql = yield* SqlClient.SqlClient;
        yield* identity.ensure;
        const rows = yield* sql<Record<string, unknown>>`SELECT * FROM controller_identity`;
        return rows[0]!;
      }),
    );
    expect(Object.keys(row).sort()).toEqual(["created_at", "id", "public_key", "singleton"]);
  });
});
