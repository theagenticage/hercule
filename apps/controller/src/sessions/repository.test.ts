/**
 * Tests for the session repository, mainly paging through a transcript: one
 * session's stream rows, in position order, a page at a time.
 *
 * The transcript tests check the paging, not the rows:
 *
 * - the pages are contiguous and in order;
 * - the last page ends the paging;
 * - a cursor works only for the sort direction it was created for;
 * - one session's transcript never shows another session's rows.
 *
 * The other tests check the status and token rules of single writes, and
 * the profile filter of the session list.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderEvent } from "@hercule/protocol";
import { CursorError, mintUuid, uuidFromString, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { inputRepository } from "./inputs";
import { LIVE_SESSION_STATUSES, sessionRepository, type StoredStreamRow } from "./repository";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

const at = "2026-09-07T10:00:00.000Z";

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

/** Inserts a session row on the given profile, with default values for the rest. */
const insertSession = (permissionProfileId: string) =>
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

/** Reads every row of a session's transcript, `limit` at a time, and counts the pages. */
const walkTranscript = (sessionId: string, limit: number) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const items: Array<StoredStreamRow> = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = yield* sessions.transcript({ sessionId, limit, cursor, direction: "asc" });
      items.push(...page.items);
      pages += 1;
      if (page.nextCursor === undefined) return { items, pages };
      cursor = page.nextCursor;
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

const readTurnId = (row: StoredStreamRow): string =>
  row.event._tag === "turn.started" ? row.event.turnId : row.event._tag;

describe("paging through a transcript", () => {
  it("pages through the whole stream in position order and stops at the end", async () => {
    const { items, pages } = await run(
      Effect.gen(function* () {
        const sessionId = yield* aSession;
        yield* fillStream(sessionId, 5);
        return yield* walkTranscript(sessionId, 2);
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(items.map((row) => row.position)).toEqual([1, 2, 3, 4, 5]);
    expect(items.map(readTurnId)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    // Three pages of two: the third is short and ends the paging, which proves
    // no cursor is returned one page too many.
    expect(pages).toBe(3);
  });

  it("returns no cursor when the page holds the remaining rows", async () => {
    const page = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        yield* fillStream(sessionId, 3);
        return yield* sessions.transcript({
          sessionId,
          limit: 3,
          cursor: undefined,
          direction: "asc",
        });
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
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
          limit: 50,
          cursor: undefined,
          direction: "asc",
        });
        return page.items;
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
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
          limit: 2,
          cursor: undefined,
          direction: "asc",
        });
        return yield* sessions.transcript({
          sessionId,
          limit: 2,
          cursor: forwards.nextCursor,
          direction: "desc",
        });
      }).pipe(Effect.provide(TestDatabase), Effect.flip),
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
          limit: 4,
          cursor: undefined,
          direction: "asc",
        });
        // Positions are per session, so the other session's position 4 means
        // nothing here. Used as is, it would skip this session's first four rows.
        return yield* sessions.transcript({
          sessionId: mine,
          limit: 4,
          cursor: theirPage.nextCursor,
          direction: "asc",
        });
      }).pipe(Effect.provide(TestDatabase), Effect.flip),
    );

    expect(error).toBeInstanceOf(CursorError);
  });

  it("returns the normalized event exactly as it was written", async () => {
    const items = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        const event: ProviderEvent = {
          _tag: "content.delta",
          eventId: mintId(),
          sessionId,
          at,
          turnId: "t1",
          itemId: "i1",
          streamKind: "assistant_text",
          delta: "Hello",
        };
        yield* sessions.append(sessionId, { seq: 1, at, event });
        const page = yield* sessions.transcript({
          sessionId,
          limit: 50,
          cursor: undefined,
          direction: "asc",
        });
        return page.items;
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(items).toHaveLength(1);
    expect(items[0]!.event).toMatchObject({
      _tag: "content.delta",
      streamKind: "assistant_text",
      delta: "Hello",
    });
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
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
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
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
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
          conversationId: undefined,
        });
        return { listed: page.items, profileId, live };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(listed.map((one) => one.id)).toEqual([live]);
    expect(listed[0]?.permissionProfileId).toBe(profileId);
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
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
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
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
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
    at,
  });
  yield* sessions.bind(sessionId, uuidToString(runner), instanceId, "native-1");
  yield* sessions.moved(sessionId, "exited", at);
  return sessionId;
});

describe("resuming an exited session", () => {
  it("puts the session back on the queue, and holds it back after an exit before any turn until new input", async () => {
    // The crash-loop guard reads the flag: an exit before the process started
    // a turn sets it, and a resume or a new input clears it.
    const rows = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* insertResumableSession;
        const exitedBeforeWork = yield* sessions.one(sessionId);
        yield* sessions.resume(sessionId, "{}", at);
        const resumed = yield* sessions.one(sessionId);
        yield* sessions.moved(sessionId, "busy", at);
        yield* sessions.moved(sessionId, "exited", at);
        const exitedAfterWork = yield* sessions.one(sessionId);
        yield* sessions.resume(sessionId, "{}", at);
        yield* sessions.moved(sessionId, "exited", at);
        const exitedAgain = yield* sessions.one(sessionId);
        yield* sessions.liftResumeHold(sessionId);
        const lifted = yield* sessions.one(sessionId);
        return [exitedBeforeWork, resumed, exitedAfterWork, exitedAgain, lifted].map((row) =>
          Option.map(row, (one) => [one.status, one.awaitingNewInput]),
        );
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(rows).toEqual([
      Option.some(["exited", true]),
      Option.some(["queued", false]),
      Option.some(["exited", false]),
      Option.some(["exited", true]),
      Option.some(["exited", false]),
    ]);
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
        yield* sessions.resume(sessionId, "{}", at);
        const empty = yield* sessions.one(sessionId);
        const sent = yield* inputs.insert({
          sessionId,
          source: "user",
          actor: "user",
          text: "a",
          at,
        });
        yield* inputs.claim(sent.id, at);
        const onTheWire = yield* sessions.one(sessionId);
        yield* inputs.cancelWithReason(sent.id, at, "the session exited");
        const cancelled = yield* sessions.one(sessionId);
        return [empty, onTheWire, cancelled].map((row) =>
          Option.map(row, (one) => one.inputWaiting),
        );
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(waiting).toEqual([Option.some(false), Option.some(true), Option.some(false)]);
  });
});
