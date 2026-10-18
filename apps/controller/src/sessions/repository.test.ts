/**
 * Tests for the session repository, mainly paging through a transcript: one
 * session's stream rows, in position order, a page at a time.
 *
 * The transcript tests check the paging, not the rows:
 *
 * - the last page ends the paging;
 * - a cursor works only for the sort direction it was created for;
 * - one session's transcript never shows another session's rows.
 *
 * The other tests check the status and token rules of single writes, and
 * the profile filter of the session list, and its `activeSince` filter,
 * with the query plan that filter runs.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { LIVE_SESSION_STATUSES } from "@hercule/contract";
import type { ProviderEvent } from "@hercule/protocol";
import { CursorError, mintUuid, uuidFromString, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { inputRepository } from "./inputs";
import { sessionRepository } from "./repository";
import { fold, startTracking } from "./stream";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

const at = "2026-09-07T10:00:00.000Z";

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

/**
 * Inserts a session row on the given profile, with default values for the
 * rest. `step` makes it the session of a run's agent step.
 */
const insertSession = (
  permissionProfileId: string,
  step: { readonly runId: string; readonly stepId: string } | undefined = undefined,
) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    // The caller creates the id, not the repository. A spawn opens the
    // workspace in the same transaction, and the workspace's branch is named
    // after the session, so the id must exist before the row is written.
    const id = mintId();
    yield* sessions.insert({
      id,
      title: "a session",
      permissionProfileId,
      agentId: undefined,
      conversationId: undefined,
      step,
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
      createdBy: "user",
      at,
    });
    return id;
  });

/** Inserts a session row for stream tests, on a profile no other session uses. */
const aSession = Effect.suspend(() => insertSession(mintId()));

/** Appends `count` ordinary events to one session, numbered from one. */
const fillStream = (sessionId: string, count: number) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    for (let seq = 1; seq <= count; seq += 1) {
      const event: ProviderEvent = {
        _tag: "turn.started",
        eventId: mintId(),
        sessionId,
        at,
        turnId: `t${String(seq)}`,
      };
      yield* sessions.append(sessionId, { seq, at, event });
    }
  });

/** Reads a session's token hash directly from the row. */
const readTokenHash = (sessionId: string) =>
  Effect.map(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{
          readonly token_hash: string | null;
        }>`SELECT token_hash FROM sessions WHERE id = unhex(${sessionId.replaceAll("-", "")})`,
    ),
    (rows) => rows[0]!.token_hash,
  );

describe("paging through a transcript", () => {
  it("returns no cursor when the page holds the remaining rows", async () => {
    const page = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        yield* fillStream(sessionId, 3);
        return yield* sessions.transcript({
          sessionId,
          subagentId: undefined,
          limit: 3,
          cursor: undefined,
          direction: "asc",
        });
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeUndefined();
  });

  it("reads only the requested session", async () => {
    const items = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const mine = yield* aSession;
        const theirs = yield* aSession;
        yield* fillStream(mine, 2);
        yield* fillStream(theirs, 4);
        const page = yield* sessions.transcript({
          sessionId: mine,
          subagentId: undefined,
          limit: 50,
          cursor: undefined,
          direction: "asc",
        });
        return page.items;
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(items.map((row) => row.position)).toEqual([1, 2]);
  });

  it("rejects a cursor from the other direction rather than continuing in the wrong place", async () => {
    const error = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        yield* fillStream(sessionId, 4);
        const forwards = yield* sessions.transcript({
          sessionId,
          subagentId: undefined,
          limit: 2,
          cursor: undefined,
          direction: "asc",
        });
        return yield* sessions.transcript({
          sessionId,
          subagentId: undefined,
          limit: 2,
          cursor: forwards.nextCursor,
          direction: "desc",
        });
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.flip),
    );

    expect(error).toBeInstanceOf(CursorError);
  });

  it("rejects another session's cursor rather than skipping rows", async () => {
    const error = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const mine = yield* aSession;
        const theirs = yield* aSession;
        yield* fillStream(mine, 6);
        yield* fillStream(theirs, 6);
        const theirPage = yield* sessions.transcript({
          sessionId: theirs,
          subagentId: undefined,
          limit: 4,
          cursor: undefined,
          direction: "asc",
        });
        // Positions are per session, so the other session's position 4 means
        // nothing here. Used as is, it would skip this session's first four rows.
        return yield* sessions.transcript({
          sessionId: mine,
          subagentId: undefined,
          limit: 4,
          cursor: theirPage.nextCursor,
          direction: "asc",
        });
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.flip),
    );

    expect(error).toBeInstanceOf(CursorError);
  });
});

describe("a session's tool calls", () => {
  it("counts each stored tool call start from every agent, and a replayed one once", async () => {
    const toolCalls = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        const counts: Array<number> = [];
        const appendItem = (seq: number, event: Partial<ProviderEvent>) =>
          Effect.gen(function* () {
            yield* sessions.append(sessionId, {
              seq,
              at,
              event: {
                eventId: mintId(),
                sessionId,
                at,
                turnId: "t1",
                itemId: `i${String(seq)}`,
                detail: {},
                ...event,
              } as ProviderEvent,
            });
            const session = yield* sessions.one(sessionId);
            counts.push(Option.getOrThrow(session).toolCalls);
          });
        yield* appendItem(1, { _tag: "item.started", kind: "user_message" });
        yield* appendItem(2, { _tag: "item.started", kind: "command_execution" });
        yield* appendItem(3, {
          _tag: "item.completed",
          kind: "command_execution",
          status: "completed",
        });
        yield* appendItem(4, { _tag: "item.started", kind: "subagent" });
        yield* appendItem(5, { _tag: "item.started", kind: "file_read", subagentId: "sub-1" });
        yield* appendItem(6, {
          _tag: "item.started",
          kind: "assistant_message",
          subagentId: "sub-1",
        });
        // A replayed frame: its sequence number is already stored.
        yield* appendItem(5, { _tag: "item.started", kind: "file_read", subagentId: "sub-1" });
        return counts;
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    // A message, a completed item and a replayed frame add nothing.
    expect(toolCalls).toEqual([0, 1, 1, 2, 3, 3, 3]);
  });
});

/** Inserts a session and moves it to `starting` with a token hash, as dispatch does. */
const insertStartedSession = (tokenHash: string) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const sessionId = yield* aSession;
    yield* sessions.started(sessionId, tokenHash, at);
    const row = yield* sessions.one(sessionId);
    if (Option.isNone(row)) return yield* Effect.die("the session was just written");
    return { sessionId, runnerId: row.value.runnerId };
  });

const minutesAfterAt = (minutes: number): string =>
  new Date(Date.parse(at) + minutes * 60_000).toISOString();

describe("a session's last activity", () => {
  it("follows the session's work, and an exit and anything after it do not move it", async () => {
    const times = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const { sessionId } = yield* insertStartedSession("hash");
        const read = Effect.map(sessions.one(sessionId), (row) =>
          Option.match(row, {
            onNone: () => "missing",
            onSome: (one) => one.lastActivityAt,
          }),
        );
        yield* sessions.moved(sessionId, "busy", minutesAfterAt(1));
        const busy = yield* read;
        yield* sessions.touched(sessionId, minutesAfterAt(2));
        const touched = yield* read;
        yield* sessions.moved(sessionId, "exited", minutesAfterAt(3));
        const exited = yield* read;
        yield* sessions.touched(sessionId, minutesAfterAt(4));
        const touchedAfterExit = yield* read;
        return { busy, touched, exited, touchedAfterExit };
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(times).toEqual({
      busy: minutesAfterAt(1),
      touched: minutesAfterAt(2),
      exited: minutesAfterAt(2),
      touchedAfterExit: minutesAfterAt(2),
    });
  });

  it("is not moved by an exit the controller itself causes, such as a runner restart", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const retired = yield* insertStartedSession("hash-retired");
        yield* sessions.endOnRunner(retired.runnerId, minutesAfterAt(5));
        const reported = yield* insertStartedSession("hash-reported");
        yield* sessions.reportedGone(reported.runnerId, [], minutesAfterAt(5));
        const queued = yield* aSession;
        yield* sessions.endQueued(queued, minutesAfterAt(5));
        return yield* Effect.all(
          [retired.sessionId, reported.sessionId, queued].map((id) =>
            Effect.map(sessions.one(id), (row) =>
              Option.map(row, (one) => [one.exitedAt, one.lastActivityAt]),
            ),
          ),
        );
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    // Each session was last active when dispatch started it (or when it was
    // written), and only `exitedAt` records the exit.
    expect(rows).toEqual([
      Option.some([minutesAfterAt(5), at]),
      Option.some([minutesAfterAt(5), at]),
      Option.some([minutesAfterAt(5), at]),
    ]);
  });

  it("is not moved by queueing a resume, nor by undoing it", async () => {
    const times = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* insertResumableSession;
        const read = Effect.map(sessions.one(sessionId), (row) =>
          Option.map(row, (one) => one.lastActivityAt),
        );
        yield* sessions.resume(sessionId, "{}");
        const resumed = yield* read;
        yield* sessions.undoResume(sessionId);
        const undone = yield* read;
        return { resumed, undone };
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(times).toEqual({ resumed: Option.some(at), undone: Option.some(at) });
  });
});

describe("the session token hash", () => {
  it("is cleared by every move to a status with no process behind it", async () => {
    const hashes = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const exited = yield* insertStartedSession("hash-exited");
        yield* sessions.moved(exited.sessionId, "exited", at);
        const queued = yield* insertStartedSession("hash-queued");
        yield* sessions.moved(queued.sessionId, "queued", at);
        const retired = yield* insertStartedSession("hash-retired");
        yield* sessions.endOnRunner(retired.runnerId, at);
        const reported = yield* insertStartedSession("hash-reported");
        yield* sessions.reportedGone(reported.runnerId, [], at);
        const running = yield* insertStartedSession("hash-running");
        yield* sessions.moved(running.sessionId, "busy", at);
        return {
          exited: yield* readTokenHash(exited.sessionId),
          queued: yield* readTokenHash(queued.sessionId),
          retired: yield* readTokenHash(retired.sessionId),
          reported: yield* readTokenHash(reported.sessionId),
          running: yield* readTokenHash(running.sessionId),
        };
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(hashes).toEqual({
      exited: null,
      queued: null,
      retired: null,
      reported: null,
      // A process still holds this one.
      running: "hash-running",
    });
  });

  it("is rejected by the table on a row with no process behind it", async () => {
    // The constraint makes the rule hold for future writers too: a write that
    // leaves a hash on such a row fails.
    const refused = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessionId = yield* aSession;
        return yield* Effect.flip(sql`
          UPDATE sessions SET token_hash = 'a hash' WHERE id = ${uuidFromString(sessionId)}
        `);
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(refused.cause._tag).toBe("ConstraintError");
    expect(String(refused.cause.cause)).toContain("CHECK constraint failed: token_hash IS NULL");
  });
});

describe("listing the sessions on one profile", () => {
  it("returns that profile's live sessions and no other rows", async () => {
    const { listed, profileId, live } = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const profileId = mintId();
        const live = yield* insertSession(profileId);
        const exited = yield* insertSession(profileId);
        yield* sessions.moved(exited, "exited", at);
        // Another profile's session, which the filter must leave out.
        yield* insertSession(mintId());
        const page = yield* sessions.list({
          limit: 10,
          cursor: undefined,
          direction: "asc",
          status: LIVE_SESSION_STATUSES,
          runnerId: undefined,
          agentId: undefined,
          permissionProfileId: profileId,
          thread: undefined,
          done: undefined,
          runId: undefined,
          conversationId: undefined,
          activeSince: undefined,
        });
        return { listed: page.items, profileId, live };
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(listed.map((one) => one.id)).toEqual([live]);
    expect(listed[0]?.permissionProfileId).toBe(profileId);
  });
});

describe("listing the sessions of runs", () => {
  /** Lists every session whose run is `runId`, oldest first. */
  const listByRun = (runId: string | ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const sessions = yield* sessionRepository;
      const page = yield* sessions.list({
        limit: 10,
        cursor: undefined,
        direction: "asc",
        status: undefined,
        runnerId: undefined,
        agentId: undefined,
        permissionProfileId: undefined,
        thread: undefined,
        done: undefined,
        runId,
        conversationId: undefined,
        activeSince: undefined,
      });
      return page.items.map((one) => one.id);
    });

  it("returns the sessions of one run, or of each run in a list, and no other rows", async () => {
    const { first, second, one, several } = await run(
      Effect.gen(function* () {
        const [runA, runB, runC] = [mintId(), mintId(), mintId()];
        const first = yield* insertSession(mintId(), { runId: runA, stepId: "plan" });
        const second = yield* insertSession(mintId(), { runId: runB, stepId: "build" });
        // A third run's session and a session of no run, which no list holds.
        yield* insertSession(mintId(), { runId: runC, stepId: "ship" });
        yield* insertSession(mintId());
        return {
          first,
          second,
          one: yield* listByRun(runA),
          several: yield* listByRun([runA, runB]),
        };
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(one).toEqual([first]);
    expect(several).toEqual([first, second]);
  });
});

describe("listing the sessions active since an instant", () => {
  const instant = "2026-09-07T12:00:00.000Z";

  /**
   * Inserts a session spawned from an Agent, so `thread: false` keeps it,
   * and returns its id. `exits` lists the instants it exits at, in order;
   * `resumed` puts it back on the queue after the last exit.
   */
  const insertAgentSession = (exits: ReadonlyArray<string>, resumed: boolean) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* sessionRepository;
      const id = yield* insertSession(mintId());
      yield* sql`UPDATE sessions SET agent_id = ${mintUuid()} WHERE id = ${uuidFromString(id)}`;
      for (const exitAt of exits) yield* sessions.moved(id, "exited", exitAt);
      if (resumed) yield* sessions.resume(id, "{}");
      return id;
    });

  /**
   * Lists the sessions active since `instant` that `thread` keeps, oldest
   * first, reading one session per page so the cursor is followed too.
   */
  const listAll = (thread: boolean | undefined) =>
    Effect.gen(function* () {
      const sessions = yield* sessionRepository;
      const ids: Array<string> = [];
      let cursor: string | undefined;
      do {
        const page = yield* sessions.list({
          limit: 1,
          cursor,
          direction: "asc",
          status: undefined,
          runnerId: undefined,
          agentId: undefined,
          permissionProfileId: undefined,
          thread,
          done: undefined,
          runId: undefined,
          conversationId: undefined,
          activeSince: instant,
        });
        ids.push(...page.items.map((one) => one.id));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return ids;
    });

  it("keeps live sessions and sessions that exited at or after the instant, across pages", async () => {
    const { expected, threadId, all, agentsOnly } = await run(
      Effect.gen(function* () {
        const live = yield* insertAgentSession([], false);
        // A resumed session keeps the exitedAt of its last exit while it is
        // live again, so the filter must keep it although that exit is old.
        const resumed = yield* insertAgentSession(["2026-09-07T11:00:00.000Z"], true);
        yield* insertAgentSession(["2026-09-07T11:59:59.999Z"], false);
        const exitedAtInstant = yield* insertAgentSession([instant], false);
        const exitedAfter = yield* insertAgentSession(["2026-09-07T13:00:00.000Z"], false);
        // A Thread, which `thread: false` leaves out.
        const threadId = yield* insertSession(mintId());
        return {
          expected: [live, resumed, exitedAtInstant, exitedAfter],
          threadId,
          all: yield* listAll(undefined),
          agentsOnly: yield* listAll(false),
        };
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(agentsOnly).toEqual(expected);
    expect(all).toEqual([...expected, threadId]);
  });

  it("finds the sessions through the index on status and exit, and scans no session", async () => {
    const plan = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* sessionRepository;
        // The statements the repository runs, as SQLite receives them.
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* sessions
          .list({
            limit: 10,
            cursor: undefined,
            direction: "desc",
            status: undefined,
            runnerId: undefined,
            agentId: undefined,
            permissionProfileId: undefined,
            thread: false,
            done: undefined,
            runId: undefined,
            conversationId: undefined,
            activeSince: instant,
          })
          .pipe(
            Effect.provideService(Statement.CurrentTransformer, (statement) => {
              statements.push(statement.compile());
              return Effect.succeed(statement);
            }),
          );
        const [text, params] = statements.find(([text]) => text.includes("active_id"))!;
        return yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params);
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    const details = plan.map((step) => step.detail);
    expect(details).toContain("SEARCH sessions USING INDEX sessions_status_exited (status=?)");
    expect(details).toContain(
      "SEARCH sessions USING INDEX sessions_status_exited (status=? AND exited_at>?)",
    );
    expect(details.some((detail) => detail.startsWith("SCAN sessions"))).toBe(false);
  });
});

describe("ending a queued session", () => {
  it("ends a session that is still queued", async () => {
    const { ended, status } = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        const ended = yield* sessions.endQueued(sessionId, at);
        const row = yield* sessions.one(sessionId);
        return { ended, status: Option.map(row, (one) => one.status) };
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    // The returned row is the session as it was just before it ended.
    expect(Option.map(ended, (one) => one.status)).toEqual(Option.some("queued"));
    expect(status).toEqual(Option.some("exited"));
  });

  it("leaves a session that dispatch has started since it was read, and returns nothing", async () => {
    // A stop reads the session as queued, then dispatch starts it before the
    // stop's write. The runner now holds the session, so only the runner can
    // end it, and the stop must go to the runner instead.
    const { ended, status, tokenHash } = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const { sessionId } = yield* insertStartedSession("hash-starting");
        const ended = yield* sessions.endQueued(sessionId, at);
        const row = yield* sessions.one(sessionId);
        return {
          ended,
          status: Option.map(row, (one) => one.status),
          tokenHash: yield* readTokenHash(sessionId),
        };
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(ended).toEqual(Option.none());
    expect(status).toEqual(Option.some("starting"));
    expect(tokenHash).toBe("hash-starting");
  });
});

/**
 * Inserts a runner and an exited session on it that can be resumed: its
 * native transcript is known and it has no workspace. Returns the session's id.
 */
const insertResumableSession = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sessionRepository;
  const runner = mintUuid();
  yield* sql`
    INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                         credential_hash, created_at, updated_at)
    VALUES (${runner}, ${uuidToString(runner)}, 'online', 'active', 0, '[]', 'a hash', ${at}, ${at})
  `;
  const sessionId = mintId();
  const instanceId = mintId();
  yield* sessions.insert({
    id: sessionId,
    title: "a session",
    permissionProfileId: mintId(),
    agentId: undefined,
    conversationId: undefined,
    step: undefined,
    instanceId,
    runnerId: uuidToString(runner),
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
    at,
  });
  yield* sessions.bind(sessionId, uuidToString(runner), instanceId, "native-1");
  yield* sessions.moved(sessionId, "exited", at);
  return sessionId;
});

describe("resuming an exited session", () => {
  it("puts the session back on the queue, and stores the crash-loop guard as the service sets it", async () => {
    // The repository decides nothing about the guard: a resume or an exit
    // leaves the flag as it is, and only `setCrashGuardArmed` changes it.
    const rows = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* insertResumableSession;
        const exited = yield* sessions.one(sessionId);
        yield* sessions.resume(sessionId, "{}");
        const resumed = yield* sessions.one(sessionId);
        yield* sessions.setCrashGuardArmed(sessionId, true);
        yield* sessions.moved(sessionId, "exited", at);
        const armed = yield* sessions.one(sessionId);
        yield* sessions.setCrashGuardArmed(sessionId, false);
        const disarmed = yield* sessions.one(sessionId);
        return [exited, resumed, armed, disarmed].map((row) =>
          Option.map(row, (stored) => [stored.status, stored.crashGuardArmed]),
        );
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(rows).toEqual([
      Option.some(["exited", false]),
      Option.some(["queued", false]),
      Option.some(["exited", true]),
      Option.some(["exited", false]),
    ]);
  });
});

describe("whether a session's conversation was deleted", () => {
  it("is true only for a session whose conversation no longer exists, and such a session has ended for good", async () => {
    const deleted = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* sessionRepository;
        const sessionId = yield* insertResumableSession;
        const answersNone = yield* sessions.one(sessionId);
        const conversation = mintUuid();
        yield* sql`
          INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
          VALUES (${conversation}, ${mintUuid()}, 'web', NULL, ${at})
        `;
        yield* sql`UPDATE sessions SET conversation_id = ${conversation}
                   WHERE id = ${uuidFromString(sessionId)}`;
        const answersOne = yield* sessions.one(sessionId);
        const endedWhileAnswering = yield* sessions.listEndedForGood([sessionId]);
        yield* sql`DELETE FROM conversations WHERE id = ${conversation}`;
        const answeredDeleted = yield* sessions.one(sessionId);
        const endedOnceDeleted = yield* sessions.listEndedForGood([sessionId]);
        return {
          rows: [answersNone, answersOne, answeredDeleted].map((row) =>
            Option.map(row, (stored) => [stored.conversationDeleted, stored.resumable]),
          ),
          endedWhileAnswering,
          endedOnceDeleted,
          sessionId,
        };
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    // The transcript is still there, but a session whose conversation is gone
    // takes no input, so it must not read as resumable.
    expect(deleted.rows).toEqual([
      Option.some([false, true]),
      Option.some([false, true]),
      Option.some([true, false]),
    ]);
    // So it has ended for good, and whatever it holds, such as subscriptions,
    // is ended with it.
    expect(deleted.endedWhileAnswering).toEqual([]);
    expect(deleted.endedOnceDeleted).toEqual([deleted.sessionId]);
  });
});

describe("whether an input waits on a session", () => {
  it("is true while an input is queued, sent or not, and false once none is", async () => {
    const waiting = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const inputs = yield* inputRepository;
        const sessionId = yield* insertResumableSession;
        // An exited session's input is never claimed, so the session is put
        // back on the queue first.
        yield* sessions.resume(sessionId, "{}");
        const empty = yield* sessions.one(sessionId);
        const sent = yield* inputs.insert({
          sessionId,
          source: "user",
          actor: "user",
          text: "a",
          at,
        });
        const queued = yield* sessions.one(sessionId);
        yield* inputs.claim(sent.id, at);
        const onTheWire = yield* sessions.one(sessionId);
        yield* inputs.cancelWithReason(sent.id, at, "the session exited");
        const cancelled = yield* sessions.one(sessionId);
        return [empty, queued, onTheWire, cancelled].map((row) =>
          Option.map(row, (one) => one.inputWaiting),
        );
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(waiting).toEqual([
      Option.some(false),
      Option.some(true),
      Option.some(true),
      Option.some(false),
    ]);
  });
});

describe("an event the controller writes itself", () => {
  /**
   * Folds the runner's first event of a new process, numbered 1, against the
   * ingest state stored now, and writes the row it produces. Returns whether
   * a row was written.
   */
  const ingestFirstRunnerEvent = (sessionId: string) =>
    Effect.gen(function* () {
      const sessions = yield* sessionRepository;
      const event: ProviderEvent = { _tag: "session.started", eventId: mintId(), sessionId, at };
      const folded = fold(startTracking(yield* sessions.ingestState(sessionId)), 1, event);
      if (folded === undefined) return false;
      for (const row of folded.rows) yield* sessions.append(sessionId, row);
      return true;
    });

  /** Returns the tags of the session's stream rows, in position order, with their sequence numbers. */
  const readStream = (sessionId: string) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ readonly runner_seq: number; readonly tag: string }>`
        SELECT runner_seq, json_extract(event, '$._tag') AS tag FROM session_stream
        WHERE session_id = unhex(${sessionId.replaceAll("-", "")}) ORDER BY position`,
    );

  it("goes before the first event of a session that never ran, and keeps that event", async () => {
    const stream = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        yield* sessions.appendRuntimeWarning(sessionId, "a notice", at);
        expect(yield* ingestFirstRunnerEvent(sessionId)).toBe(true);
        return yield* readStream(sessionId);
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(stream).toEqual([
      { runner_seq: 1, tag: "runtime.warning" },
      { runner_seq: 2, tag: "session.started" },
    ]);
  });

  it("goes past every event of a resumed session, and keeps the resumed process's first event", async () => {
    const stream = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        yield* fillStream(sessionId, 3);
        // A resume moves the offset to the highest sequence stored, 3.
        yield* sessions.resume(sessionId, "{}");
        yield* sessions.appendRuntimeWarning(sessionId, "a notice", at);
        expect(yield* ingestFirstRunnerEvent(sessionId)).toBe(true);
        return yield* readStream(sessionId);
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(stream).toEqual([
      { runner_seq: 1, tag: "turn.started" },
      { runner_seq: 2, tag: "turn.started" },
      { runner_seq: 3, tag: "turn.started" },
      { runner_seq: 4, tag: "runtime.warning" },
      { runner_seq: 5, tag: "session.started" },
    ]);
  });
});
