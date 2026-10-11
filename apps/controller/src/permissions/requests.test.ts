/**
 * Tests the Permission Request repository against a migrated in-memory
 * database: finding a session's open request for a grant, withdrawing the open
 * requests of several sessions at once, and reading a request stored without
 * an operation.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { mintUuid, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { sessionRepository } from "../sessions";
import { permissionRequestRepository } from "./requests";

const AT = "2026-09-07T10:00:00.000Z";

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof TestDatabase>>) =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

const PROFILE_ID = mintId();

/** Inserts a session, which a request's `session_id` must point at, and returns its id. */
const insertSession = Effect.gen(function* () {
  const sessions = yield* sessionRepository;
  const id = mintId();
  yield* sessions.insert({
    id,
    title: "a session",
    permissionProfileId: PROFILE_ID,
    agentId: undefined,
    conversationId: undefined,
    step: undefined,
    instanceId: mintId(),
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
    at: AT,
  });
  return id;
});

/** Stores an open request for `grant` with no operation, and returns its id. */
const insertRequest = (sessionId: string, grant: "task.delete" | "task.create") =>
  Effect.flatMap(permissionRequestRepository, (requests) =>
    requests.insert({
      sessionId,
      profileId: PROFILE_ID,
      grant,
      reason: "a reason",
      operation: undefined,
      at: AT,
    }),
  );

describe("the Permission Request repository", () => {
  it("finds the open request for a grant, and none once it is decided", async () => {
    const result = await run(
      Effect.gen(function* () {
        const requests = yield* permissionRequestRepository;
        const sessionId = yield* insertSession;
        const id = yield* insertRequest(sessionId, "task.delete");
        const open = yield* requests.findOpen(sessionId, "task.delete");
        const otherGrant = yield* requests.findOpen(sessionId, "task.create");
        yield* requests.decide(id, "deny", AT);
        return {
          id,
          open,
          otherGrant,
          decided: yield* requests.findOpen(sessionId, "task.delete"),
        };
      }),
    );

    expect(result.open).toEqual(Option.some(result.id));
    expect(Option.isNone(result.otherGrant)).toBe(true);
    expect(Option.isNone(result.decided)).toBe(true);
  });

  it("withdraws the open requests of every listed session, and leaves the rest", async () => {
    const result = await run(
      Effect.gen(function* () {
        const requests = yield* permissionRequestRepository;
        const first = yield* insertSession;
        const second = yield* insertSession;
        const untouched = yield* insertSession;
        const firstDelete = yield* insertRequest(first, "task.delete");
        const firstCreate = yield* insertRequest(first, "task.create");
        const secondDelete = yield* insertRequest(second, "task.delete");
        const decided = yield* insertRequest(second, "task.create");
        yield* requests.decide(decided, "session", AT);
        const kept = yield* insertRequest(untouched, "task.delete");

        const withdrawn = yield* requests.withdrawOpen([first, second]);
        const readStatus = (id: string) =>
          Effect.map(requests.read(id), (found) => Option.getOrThrow(found).status);
        return {
          withdrawn,
          expected: [firstDelete, firstCreate, secondDelete],
          decided: yield* readStatus(decided),
          kept: yield* readStatus(kept),
          none: yield* requests.withdrawOpen([]),
        };
      }),
    );

    expect([...result.withdrawn].sort()).toEqual([...result.expected].sort());
    expect(result.decided).toBe("decided");
    expect(result.kept).toBe("open");
    expect(result.none).toEqual([]);
  });

  it("reads a request stored without an operation as having none", async () => {
    const request = await run(
      Effect.gen(function* () {
        const requests = yield* permissionRequestRepository;
        const id = yield* insertRequest(yield* insertSession, "task.delete");
        return Option.getOrThrow(yield* requests.read(id));
      }),
    );

    expect(request.operation).toBeUndefined();
    expect(request).toMatchObject({
      profileId: PROFILE_ID,
      grant: "task.delete",
      status: "open",
      outcome: null,
      decidedAt: null,
    });
  });
});
