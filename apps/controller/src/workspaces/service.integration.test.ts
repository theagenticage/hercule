import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { join } from "node:path";
import { buildHomePaths, HerculeHome } from "../config";
import { uuidFromString } from "../db/id";
import { inTransaction, TestDatabase } from "../db/testing";
import { ConnectionTypesLayer } from "../connections";
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

const home = mkdtempSync(join(tmpdir(), "hercule-workspace-service-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const RUNNER_ID = "0199e0e7-0000-7000-8000-0000000000a1";

/** The workspace service on a database opened like the controller opens its own, with a throwaway home. */
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

/**
 * Creates a provisioning workspace the way an upgraded home has one: it has
 * no stored preparation instruction. Returns its id.
 */
const arrangeLegacyWorkspace = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* workspaceRepository;
  return yield* inTransaction(
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                             credential_hash, created_at, updated_at)
        VALUES (${uuidFromString(RUNNER_ID)}, 'laptop', 'online', 'active', 0, '{}', 'hash', 'old', 'old')`;
      const workspace = yield* repository.insert({
        runnerId: RUNNER_ID,
        kind: "primary",
        designatedConnectionId: null,
        at: "old",
      });
      return workspace.id;
    }),
  );
});

describe("resending the provision of a legacy workspace", () => {
  // Runner arrival and step delivery call these without a transaction of
  // their own, so the first resend must open one to store the rebuilt instruction.
  it("lists the owed provision of a runner and stores the rebuilt instruction", async () => {
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const workspaceId = yield* arrangeLegacyWorkspace;
        const service = yield* WorkspaceService;
        const repository = yield* workspaceRepository;
        const owed = yield* service.listOwedProvisioning(RUNNER_ID);
        const frozen = yield* repository.readPreparationInstruction(workspaceId);
        return { workspaceId, owed, frozen };
      }).pipe(Effect.provide(serviceLayer), Effect.orDie),
    );
    expect(stored.owed).toMatchObject([{ workspaceId: stored.workspaceId, checkouts: [] }]);
    expect(Option.getOrThrow(stored.frozen)).toEqual(stored.owed[0]);
  });

  it("rebuilds the owed provision of one workspace and stores the rebuilt instruction", async () => {
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const workspaceId = yield* arrangeLegacyWorkspace;
        const service = yield* WorkspaceService;
        const repository = yield* workspaceRepository;
        const rebuilt = yield* service.rebuildOwedProvision(workspaceId);
        const frozen = yield* repository.readPreparationInstruction(workspaceId);
        return { workspaceId, rebuilt, frozen };
      }).pipe(Effect.provide(serviceLayer), Effect.orDie),
    );
    expect(Option.getOrThrow(stored.rebuilt)).toMatchObject({ workspaceId: stored.workspaceId });
    expect(Option.getOrThrow(stored.frozen)).toEqual(Option.getOrThrow(stored.rebuilt));
  });
});
