import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { withTransaction } from "../db/client";
import { AuditLog, AuditLogLayer } from "./audit-log";

const layer = AuditLogLayer.pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(effect: Effect.Effect<A, E, AuditLog | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

describe("AuditLog", () => {
  it("writes a platform row with the actor and the payload", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* audit.append({
          kind: "auth.login.succeeded",
          actor: "user",
          payload: { username: "rogier" },
        });
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          readonly source: string;
          readonly connection_id: Uint8Array | null;
          readonly system: string;
          readonly kind: string;
          readonly occurred_at: string;
          readonly received_at: string;
          readonly dedup_key: string;
          readonly refs: string;
          readonly url: string | null;
          readonly payload: string;
          readonly raw: string | null;
          readonly actor: string;
        }>`SELECT * FROM events`;
      }),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBe("platform");
    expect(row.connection_id).toBeNull();
    expect(row.system).toBe("platform");
    expect(row.kind).toBe("auth.login.succeeded");
    expect(row.occurred_at).toBe(row.received_at);
    expect(row.dedup_key).not.toBe("");
    expect(row.refs).toBe("[]");
    expect(row.url).toBeNull();
    expect(JSON.parse(row.payload)).toEqual({ username: "rogier" });
    expect(row.raw).toBeNull();
    expect(row.actor).toBe("user");
  });

  it("keeps repeated entries of the same kind and actor apart", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* audit.append({ kind: "auth.login.failed", actor: "user", payload: { attempt: 1 } });
        yield* audit.append({ kind: "auth.login.failed", actor: "user", payload: { attempt: 2 } });
        return yield* audit.listByKind("auth.login.failed");
      }),
    );
    expect(entries.map((entry) => entry.payload)).toEqual([{ attempt: 1 }, { attempt: 2 }]);
  });

  it("stamps a session actor", async () => {
    const actor = "session:0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" as const;
    const entries = await run(
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        yield* audit.append({ kind: "secret.created", actor, payload: { owner: "connection" } });
        return yield* audit.listByKind("secret.created");
      }),
    );
    expect(entries[0]?.actor).toBe(actor);
  });

  it("rolls back with the mutation it records", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* audit.append({
              kind: "profile.created",
              actor: "user",
              payload: { name: "reviewer" },
            });
            yield* sql`
              INSERT INTO permission_profiles (id, name, grants, shipped, created_at, updated_at)
              VALUES (x'00', 'reviewer', '[]', 0, '2026-09-04T00:00:00.000Z', '2026-09-04T00:00:00.000Z')
            `;
            return yield* Effect.fail(new Error("the operation failed after both writes"));
          }),
        ).pipe(Effect.ignore);
        const profiles = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM permission_profiles WHERE name = 'reviewer'`;
        return {
          audit: yield* audit.listByKind("profile.created"),
          profiles,
        };
      }),
    );
    expect(entries.audit).toEqual([]);
    expect(entries.profiles).toEqual([]);
  });

  it("keeps both writes when the transaction commits", async () => {
    const entries = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const audit = yield* AuditLog;
            yield* audit.append({
              kind: "profile.updated",
              actor: "user",
              payload: { id: "reviewer" },
            });
            return yield* audit.listByKind("profile.updated");
          }),
        );
      }),
    );
    expect(entries).toHaveLength(1);
  });
});
