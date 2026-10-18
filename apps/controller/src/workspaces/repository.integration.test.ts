import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { WorkspaceProvision } from "@hercule/protocol";
import { inTransaction, TestDatabase } from "../db/testing";
import { uuidFromString } from "../db/id";
import { workspaceRepository } from "./repository";

describe("freezing legacy preparation instructions", () => {
  it("returns the same stored instruction to concurrent first resend callers", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* workspaceRepository;
        const runnerId = "0199e0e7-0000-7000-8000-0000000000a1";
        const workspace = yield* inTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                                   credential_hash, created_at, updated_at)
              VALUES (${uuidFromString(runnerId)}, 'laptop', 'online', 'active', 0, '{}',
                      'hash', 'old', 'old')`;
            return yield* repository.insert({
              runnerId,
              kind: "primary",
              designatedConnectionId: null,
              at: "old",
            });
          }),
        );
        const frame: WorkspaceProvision = {
          _tag: "workspaceProvision",
          workspaceId: workspace.id,
          kind: "primary",
          checkouts: [
            {
              checkoutId: "0199e0e7-0000-7000-8000-0000000000c1",
              resourceId: "0199e0e7-0000-7000-8000-0000000000d1",
              remote: "https://github.com/acme/repo",
              subdirectory: null,
              branch: null,
              baseBranch: null,
              setupCommand: "echo original",
              workspaceInclude: false,
            },
          ],
        };
        const edited: WorkspaceProvision = {
          ...frame,
          checkouts: frame.checkouts.map((checkout) => ({
            ...checkout,
            setupCommand: "echo edited",
          })),
        };
        const delivered = yield* Effect.all(
          [
            inTransaction(repository.freezePreparationInstruction(workspace.id, frame)),
            inTransaction(repository.freezePreparationInstruction(workspace.id, edited)),
          ],
          { concurrency: "unbounded" },
        );
        const stored = yield* repository.readPreparationInstruction(workspace.id);
        return { delivered, stored };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );
    expect(result.delivered[0]).toEqual(result.delivered[1]);
    expect(result.stored).toMatchObject({ _tag: "Some", value: result.delivered[0] });
  });
});
