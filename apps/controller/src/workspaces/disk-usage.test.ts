/**
 * Tests how the controller stores the disk usage a runner reports for its
 * workspaces (spec 03, section 6.9): only the entries whose values changed are
 * written and announced, entries for workspaces the runner does not own are
 * dropped, and a workspace the report leaves out keeps what it has.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { WorkspaceDiskUsageEntry } from "@hercule/protocol";
import { buildAnnouncementRecorder, inTransaction, TestDatabase } from "../db/testing";
import { uuidFromString } from "../db/id";
import { workspaceRepository } from "./repository";

const RUNNER = "0199e0e7-0000-7000-8000-0000000000a1";
const OTHER_RUNNER = "0199e0e7-0000-7000-8000-0000000000a2";
const UNKNOWN = "0199e0e7-0000-7000-8000-0000000000ff";
const MEASURED_AT = "2026-11-03T10:00:00.000Z";
const LATER = "2026-11-03T11:00:00.000Z";

const measured = (
  workspaceId: string,
  sizeBytes: number,
  freesBytes: number,
  measuredAt = MEASURED_AT,
): WorkspaceDiskUsageEntry => ({
  workspaceId,
  diskUsage: { sizeBytes, freesBytes, measuredAt },
  error: null,
});

/** Runs `body` on a database holding two runners, three workspaces on the first and one on the second. */
const withWorkspaces = (
  body: (ids: {
    readonly a: string;
    readonly b: string;
    readonly c: string;
    readonly elsewhere: string;
  }) => Effect.Effect<void, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* workspaceRepository;
      const ids = yield* inTransaction(
        Effect.gen(function* () {
          for (const [runner, name] of [
            [RUNNER, "laptop"],
            [OTHER_RUNNER, "desktop"],
          ] as const) {
            yield* sql`
              INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                                   credential_hash, created_at, updated_at)
              VALUES (${uuidFromString(runner)}, ${name}, 'online', 'active', 0, '{}',
                      ${name}, 'old', 'old')`;
          }
          const insert = (runnerId: string) =>
            Effect.map(
              repository.insert({
                runnerId,
                kind: "ephemeral",
                designatedConnectionId: null,
                at: "old",
              }),
              (workspace) => workspace.id,
            );
          return {
            a: yield* insert(RUNNER),
            b: yield* insert(RUNNER),
            c: yield* insert(RUNNER),
            elsewhere: yield* insert(OTHER_RUNNER),
          };
        }),
      );
      yield* body(ids);
    }).pipe(Effect.provide(TestDatabase), Effect.orDie),
  );

/** Stores a report and returns the ids it changed, with the changes announced after the commit. */
const record = (entries: ReadonlyArray<WorkspaceDiskUsageEntry>, runnerId = RUNNER) =>
  Effect.gen(function* () {
    const repository = yield* workspaceRepository;
    const { listener, announced } = buildAnnouncementRecorder();
    const changed = yield* inTransaction(repository.recordDiskUsage(runnerId, entries)).pipe(
      Effect.provide(listener),
    );
    return {
      changed,
      announced: announced.flatMap((change) =>
        change._tag === "record" && change.topic === "workspace"
          ? [{ id: change.id, kind: change.kind }]
          : [],
      ),
    };
  });

const read = (id: string) =>
  Effect.gen(function* () {
    const repository = yield* workspaceRepository;
    const found = yield* repository.one(id);
    if (found._tag === "None") throw new Error("Expected the workspace to exist");
    return { diskUsage: found.value.diskUsage, diskUsageError: found.value.diskUsageError };
  });

describe("storing the disk usage a runner reports", () => {
  it("stores a measurement and announces the workspace as updated", async () => {
    await withWorkspaces(({ a, b }) =>
      Effect.gen(function* () {
        const { changed, announced } = yield* record([measured(a, 100, 40)]);
        expect(changed).toEqual([a]);
        expect(announced).toEqual([{ id: a, kind: "updated" }]);
        expect(yield* read(a)).toEqual({
          diskUsage: { sizeBytes: 100, freesBytes: 40, measuredAt: MEASURED_AT },
          diskUsageError: null,
        });
        expect(yield* read(b)).toEqual({ diskUsage: null, diskUsageError: null });
      }),
    );
  });

  it("writes and announces only the entries whose values changed", async () => {
    await withWorkspaces(({ a, b, c }) =>
      Effect.gen(function* () {
        yield* record([measured(a, 100, 40), measured(b, 200, 50), measured(c, 300, 60)]);
        const second = yield* record([
          measured(a, 100, 40),
          measured(b, 200, 50, LATER),
          measured(c, 301, 60),
        ]);
        expect(second.changed).toEqual([b, c]);
        expect(second.announced).toEqual([
          { id: b, kind: "updated" },
          { id: c, kind: "updated" },
        ]);
        const repeated = yield* record([measured(a, 100, 40), measured(b, 200, 50, LATER)]);
        expect(repeated).toEqual({ changed: [], announced: [] });
      }),
    );
  });

  it("drops entries for unknown workspaces and for another runner's workspaces", async () => {
    await withWorkspaces(({ a, elsewhere }) =>
      Effect.gen(function* () {
        const { changed, announced } = yield* record([
          measured(UNKNOWN, 1, 1),
          measured(elsewhere, 2, 2),
          measured(a, 3, 3),
        ]);
        expect(changed).toEqual([a]);
        expect(announced).toEqual([{ id: a, kind: "updated" }]);
        expect(yield* read(elsewhere)).toEqual({ diskUsage: null, diskUsageError: null });
      }),
    );
  });

  it("drops an id that is not a canonical id instead of failing the whole report", async () => {
    await withWorkspaces(({ a }) =>
      Effect.gen(function* () {
        const { changed } = yield* record([
          measured("not-a-uuid", 1, 1),
          measured("A".repeat(64), 2, 2),
          measured(a, 3, 3),
        ]);
        expect(changed).toEqual([a]);
        expect(yield* record([measured("not-a-uuid", 1, 1)])).toEqual({
          changed: [],
          announced: [],
        });
      }),
    );
  });

  it("keeps the workspaces a shortened report leaves out", async () => {
    await withWorkspaces(({ a, b }) =>
      Effect.gen(function* () {
        yield* record([measured(a, 100, 40), measured(b, 200, 50)]);
        const { changed } = yield* record([measured(a, 101, 41)]);
        expect(changed).toEqual([a]);
        expect((yield* read(b)).diskUsage).toEqual({
          sizeBytes: 200,
          freesBytes: 50,
          measuredAt: MEASURED_AT,
        });
        const empty = yield* record([]);
        expect(empty).toEqual({ changed: [], announced: [] });
        expect((yield* read(b)).diskUsage?.sizeBytes).toBe(200);
      }),
    );
  });

  it("stores a first failure as an error with no numbers, and a later success clears it", async () => {
    await withWorkspaces(({ a }) =>
      Effect.gen(function* () {
        const failure = "Measuring took longer than 10 minutes";
        yield* record([{ workspaceId: a, diskUsage: null, error: failure }]);
        expect(yield* read(a)).toEqual({ diskUsage: null, diskUsageError: failure });
        yield* record([measured(a, 100, 40)]);
        expect(yield* read(a)).toEqual({
          diskUsage: { sizeBytes: 100, freesBytes: 40, measuredAt: MEASURED_AT },
          diskUsageError: null,
        });
      }),
    );
  });

  it("keeps the stored numbers when a failure arrives with no measurement, and writes a repeated failure once", async () => {
    await withWorkspaces(({ a }) =>
      Effect.gen(function* () {
        yield* record([measured(a, 100, 40)]);
        const failure = { workspaceId: a, diskUsage: null, error: "Measuring failed" };
        const first = yield* record([failure]);
        expect(first.changed).toEqual([a]);
        expect(yield* read(a)).toEqual({
          diskUsage: { sizeBytes: 100, freesBytes: 40, measuredAt: MEASURED_AT },
          diskUsageError: "Measuring failed",
        });
        const repeated = yield* record([failure]);
        expect(repeated).toEqual({ changed: [], announced: [] });
      }),
    );
  });

  it("keeps earlier numbers beside the error of a failed later attempt", async () => {
    await withWorkspaces(({ a }) =>
      Effect.gen(function* () {
        yield* record([measured(a, 100, 40)]);
        yield* record([{ ...measured(a, 100, 40), error: "Measuring failed" }]);
        expect(yield* read(a)).toEqual({
          diskUsage: { sizeBytes: 100, freesBytes: 40, measuredAt: MEASURED_AT },
          diskUsageError: "Measuring failed",
        });
      }),
    );
  });
});
