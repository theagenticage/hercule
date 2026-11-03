/**
 * Verifies how an archived workspace goes back to automatic cleanup
 * (spec 03 section 6.9), on rows written straight into the database. The
 * sessions domain calls `returnToAutomaticCleanup` from its archive
 * transaction; here the sessions are archived by a plain UPDATE, so the test
 * covers the workspace side alone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { buildHomePaths, HerculeHome } from "../config";
import { ConnectionTypesLayer } from "../connections";
import { mintUuid, uuidFromString } from "../db/id";
import { inTransaction, TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { SessionTokensLayer } from "../permissions";
import { PluginConfigsLayer } from "../plugins";
import { ServingPromotionStateLayer } from "../promotion/testing";
import { RunWorkspaceStepActivityLayer } from "../runs";
import { masterKeyLayer } from "../secrets/masterKey";
import { secretsLayer } from "../secrets/repository";
import { SettingsLayer } from "../settings";
import { workspaceRepository } from "./repository";
import { WorkspaceService, WorkspaceServiceLayer } from "./service";

const home = mkdtempSync(join(tmpdir(), "hercule-workspace-archived-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const RUNNER_ID = "0199e0e7-0000-7000-8000-0000000000a1";

const serviceLayer = WorkspaceServiceLayer.pipe(
  Layer.provideMerge(SessionTokensLayer),
  Layer.provideMerge(RunWorkspaceStepActivityLayer),
  Layer.provideMerge(ConnectionTypesLayer),
  Layer.provideMerge(PluginConfigsLayer),
  Layer.provideMerge(ServingPromotionStateLayer),
  Layer.provideMerge(SettingsLayer),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
  Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
  Layer.provideMerge(TestDatabase),
);

const RELEASED_AT = "2026-11-01T10:00:00.000Z";
const IDLE_UNTIL = "2026-12-01T10:00:00.000Z";
/** Seven days after `RELEASED_AT`: the default archived window. */
const ARCHIVED_UNTIL = "2026-11-08T10:00:00.000Z";

interface LeaseRow {
  readonly released_at: string | null;
  readonly retention: string | null;
  readonly kept_until: string | null;
}

/**
 * Arranges one workspace of the given kind with a lease of each sort and
 * calls `returnToAutomaticCleanup` on it. Returns the workspace's retention
 * policy and each lease's row, by name.
 */
const returnWorkspace = (kind: "ephemeral" | "primary") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* workspaceRepository;
    const service = yield* WorkspaceService;
    const arranged = yield* inTransaction(
      Effect.gen(function* () {
        yield* sql`
        INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                             credential_hash, created_at, updated_at)
        VALUES (${uuidFromString(RUNNER_ID)}, 'laptop', 'online', 'active', 0, '{}', 'hash', 'old', 'old')`;
        const workspace = yield* repository.insert({
          runnerId: RUNNER_ID,
          kind,
          designatedConnectionId: null,
          at: RELEASED_AT,
        });
        yield* sql`UPDATE workspaces SET retention_policy = 'manual' WHERE id = ${uuidFromString(workspace.id)}`;
        const holders = {
          archivedExited: { id: mintUuid(), archived: true },
          archivedRunning: { id: mintUuid(), archived: true },
          plainExited: { id: mintUuid(), archived: false },
        };
        for (const holder of Object.values(holders)) {
          const none = mintUuid();
          yield* sql`
          INSERT INTO sessions (id, permission_profile_id, provider_account_id, harness_id,
                                runner_id, workspace_id, requested_access_mode, access_mode, spec,
                                title, status, created_at, last_activity_at, archived_at, archived_by)
          VALUES (${holder.id}, ${none}, ${none}, 'harnesses/test', ${none},
                  ${uuidFromString(workspace.id)}, 'auto', 'auto', '{}', 'a session', 'exited',
                  ${RELEASED_AT}, ${RELEASED_AT},
                  ${holder.archived ? RELEASED_AT : null}, ${holder.archived ? "user" : null})`;
        }
        const runId = mintUuid();
        const lease = (
          holderKind: "session" | "run",
          holderId: Uint8Array,
          released: { readonly retention: string; readonly keptUntil: string } | null,
        ) =>
          sql`
          INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at,
                                        released_at, retention, kept_until)
          VALUES (${uuidFromString(workspace.id)}, ${holderKind}, ${holderId}, ${RELEASED_AT},
                  ${released === null ? null : RELEASED_AT}, ${released?.retention ?? null},
                  ${released?.keptUntil ?? null})`;
        yield* lease("session", holders.archivedExited.id, {
          retention: "idle",
          keptUntil: IDLE_UNTIL,
        });
        yield* lease("session", holders.archivedRunning.id, null);
        yield* lease("session", holders.plainExited.id, {
          retention: "idle",
          keptUntil: IDLE_UNTIL,
        });
        yield* lease("run", runId, { retention: "inspection", keptUntil: IDLE_UNTIL });

        return { workspace, holders, runId };
      }),
    );
    const { workspace, holders, runId } = arranged;
    yield* inTransaction(service.returnToAutomaticCleanup(workspace.id));

    const policy = (yield* sql<{ readonly retention_policy: string }>`
      SELECT retention_policy FROM workspaces WHERE id = ${uuidFromString(workspace.id)}`)[0]!
      .retention_policy;
    const read = (holderId: Uint8Array) =>
      sql<LeaseRow>`SELECT released_at, retention, kept_until FROM workspace_leases
                    WHERE workspace_id = ${uuidFromString(workspace.id)} AND holder_id = ${holderId}`.pipe(
        Effect.map((rows) => rows[0]),
      );
    return {
      policy,
      archivedExited: yield* read(holders.archivedExited.id),
      archivedRunning: yield* read(holders.archivedRunning.id),
      plainExited: yield* read(holders.plainExited.id),
      run: yield* read(runId),
    };
  }).pipe(Effect.provide(serviceLayer), Effect.orDie);

describe("giving an archived workspace back to automatic cleanup", () => {
  it("makes the workspace automatic and releases only the released leases of archived sessions again", async () => {
    const found = await Effect.runPromise(returnWorkspace("ephemeral"));
    expect(found.policy).toBe("automatic");
    // The release time stays the session's own; the window is the archived one.
    expect(found.archivedExited).toEqual({
      released_at: RELEASED_AT,
      retention: "archived",
      kept_until: ARCHIVED_UNTIL,
    });
    // An active lease keeps its workspace until its session exits.
    expect(found.archivedRunning).toEqual({ released_at: null, retention: null, kept_until: null });
    // A session that is not archived, and a run, keep what they were released with.
    expect(found.plainExited).toEqual({
      released_at: RELEASED_AT,
      retention: "idle",
      kept_until: IDLE_UNTIL,
    });
    expect(found.run).toEqual({
      released_at: RELEASED_AT,
      retention: "inspection",
      kept_until: IDLE_UNTIL,
    });
  });

  it("leaves a primary workspace as it was, because the sweep never deletes one", async () => {
    const found = await Effect.runPromise(returnWorkspace("primary"));
    expect(found.policy).toBe("manual");
    expect(found.archivedExited).toEqual({
      released_at: RELEASED_AT,
      retention: "idle",
      kept_until: IDLE_UNTIL,
    });
  });
});
