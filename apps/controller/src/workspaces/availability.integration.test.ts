import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../db/client";
import { uuidFromString } from "../db/id";
import { runMigrations } from "../db/migrate";
import { workspaceRepository } from "./repository";

describe("repository availability reports", () => {
  it("records readiness loss for a derived existing repository without changing an ordinary managed terminal outcome", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const runnerId = "0199e0e7-0000-7000-8000-0000000000a1";
        yield* sql`
          INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                               credential_hash, created_at, updated_at)
          VALUES (${uuidFromString(runnerId)}, 'laptop', 'online', 'active', 0, '{}', 'hash', 'old', 'old')`;
        const repository = yield* workspaceRepository;
        const statuses = [];
        for (const bound of [false, true]) {
          const workspace = yield* repository.insert({
            runnerId,
            kind: "ephemeral",
            designatedConnectionId: null,
            at: "old",
          });
          yield* repository.freezeProvisionFrame(workspace.id, {
            _tag: "workspaceProvision",
            workspaceId: workspace.id,
            kind: "ephemeral",
            checkouts: [
              {
                checkoutId: "0199e0e7-0000-7000-8000-0000000000c1",
                resourceId: "0199e0e7-0000-7000-8000-0000000000d1",
                remote: "https://github.com/acme/repo",
                subdirectory: null,
                branch: "work",
                baseBranch: null,
                setupCommand: null,
                workspaceInclude: false,
                ...(bound ? { repositoryWorkspaceId: "0199e0e7-0000-7000-8000-0000000000b1" } : {}),
              },
            ],
          });
          yield* repository.markReady(workspace.id, [], "ready");
          const moved = yield* repository.markFailed(
            workspace.id,
            "The runner no longer supports this repository.",
            "later",
          );
          const row = yield* repository.one(workspace.id);
          const repeated = yield* repository.markFailed(workspace.id, "duplicate", "later");
          statuses.push({ bound, moved, row, repeated });
        }
        return statuses;
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );
    expect(result[0]).toMatchObject({
      bound: false,
      moved: false,
      row: { value: { status: "ready", message: null } },
      repeated: false,
    });
    expect(result[1]).toMatchObject({
      bound: true,
      moved: true,
      row: {
        value: { status: "failed", message: "The runner no longer supports this repository." },
      },
      repeated: false,
    });
  });
});
