/**
 * Tests for the one rule for when a session is unfinished: the SQL condition
 * (read through `isUnfinished`).
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { sessionRepository } from "./repository";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

const AT = "2026-10-14T00:00:00.000Z";

const mintId = () => uuidToString(mintUuid());

type RunStatus = "pending" | "running" | "completed";

/** Inserts a Run in the status, and returns its id. */
const insertRun = (status: RunStatus) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintId();
    yield* sql`
      INSERT INTO runs (id, plan, inputs, origin, status, created_at, finished_at)
      VALUES (${uuidFromString(id)}, '{}', '{}', '{}', ${status}, ${AT},
              ${status === "completed" ? AT : null})
    `;
    return id;
  });

/** Describes how a session was started, which decides its unfinished rule. */
interface Kind {
  readonly agent: boolean;
  readonly runStatus?: RunStatus;
}

/** Inserts a session of the kind and returns its id. */
const insertSession = (kind: Kind) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const runId = kind.runStatus === undefined ? undefined : yield* insertRun(kind.runStatus);
    const id = mintId();
    yield* sessions.insert({
      id,
      title: "a session",
      role: undefined,
      permissionProfileId: mintId(),
      agentId: kind.agent ? mintId() : undefined,
      conversationId: undefined,
      step: runId === undefined ? undefined : { runId, stepId: "step" },
      providerAccountId: mintId(),
      harnessId: "harnesses/full",
      runnerId: mintId(),
      requestedAccessMode: "approval-required",
      accessMode: "approval-required",
      workspaceId: null,
      projectId: undefined,
      checkoutBranch: undefined,
      githubConnectionId: undefined,
      spec: "{}",
      modelSelection: { model: "clever", options: {} },
      parentSessionId: undefined,
      createdBy: "user",
      at: AT,
    });
    return id;
  });

/** Sets the columns the rule reads. */
const update = (sessionId: string, status: "exited" | "idle", done: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE sessions
      SET status = ${status}, done_at = ${done ? AT : null}, done_by = ${done ? "user" : null}
      WHERE id = ${uuidFromString(sessionId)}
    `;
  });

const isUnfinishedAfter = (kind: Kind, status: "exited" | "idle", done: boolean) =>
  run(
    Effect.gen(function* () {
      const sessions = yield* sessionRepository;
      const sql = yield* SqlClient.SqlClient;
      // The rows are committed before the rule reads them, as they are in use.
      const id = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const id = yield* insertSession(kind);
          yield* update(id, status, done);
          return id;
        }),
      );
      return yield* sessions.isUnfinished(id);
    }).pipe(Effect.provide(TestDatabase)),
  );

describe("isUnfinished", () => {
  it("holds a Thread unfinished until it is Done or exits", async () => {
    expect(await isUnfinishedAfter({ agent: false }, "idle", false)).toBe(true);
    expect(await isUnfinishedAfter({ agent: false }, "idle", true)).toBe(false);
    expect(await isUnfinishedAfter({ agent: false }, "exited", false)).toBe(false);
  });

  it("holds an agent step's session unfinished while its Run is pending or running", async () => {
    expect(await isUnfinishedAfter({ agent: true, runStatus: "pending" }, "exited", false)).toBe(
      true,
    );
    expect(await isUnfinishedAfter({ agent: true, runStatus: "running" }, "exited", false)).toBe(
      true,
    );
    expect(await isUnfinishedAfter({ agent: true, runStatus: "completed" }, "idle", false)).toBe(
      false,
    );
  });

  it("holds any other Agent session unfinished until it exits", async () => {
    expect(await isUnfinishedAfter({ agent: true }, "idle", false)).toBe(true);
    expect(await isUnfinishedAfter({ agent: true }, "exited", false)).toBe(false);
  });

  it("does not hold a session that does not exist", async () => {
    const found = await run(
      Effect.flatMap(sessionRepository, (sessions) => sessions.isUnfinished(mintId())).pipe(
        Effect.provide(TestDatabase),
      ),
    );
    expect(found).toBe(false);
  });
});
