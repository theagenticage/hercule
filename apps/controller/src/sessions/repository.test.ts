/**
 * The transcript walk: one session's stream rows, in position order, a page at
 * a time.
 *
 * What is asserted is the walk, not the rows: that the pages are contiguous and
 * in order, that the last one ends the walk, that a cursor is only good for the
 * order it was issued under, and that one session's stream never shows another
 * session's rows.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderEvent } from "@hydra/protocol";
import { CursorError, mintUuid, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { sessionRepository, type StoredStreamRow } from "./repository";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

const at = "2026-09-07T10:00:00.000Z";

/** A canonical v7 id, which is the only shape the store takes. */
const anId = () => uuidToString(mintUuid());

/** A session row to hang a stream on, with the shipped defaults filled in. */
const aSession = Effect.gen(function* () {
  const sessions = yield* sessionRepository;
  // D-21: the caller mints the id, because a spawn opens the working area in
  // the same transaction and its branch is named after the session.
  const id = anId();
  yield* sessions.insert({
    id,
    title: "a session",
    permissionProfileId: anId(),
    agentId: undefined,
    instanceId: anId(),
    runnerId: anId(),
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

/** `count` ordinary events on one session, numbered from one. */
const fill = (sessionId: string, count: number) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    for (let seq = 1; seq <= count; seq += 1) {
      const event: ProviderEvent = {
        _tag: "turn.started",
        eventId: anId(),
        sessionId,
        at,
        turnId: `t${String(seq)}`,
      };
      yield* sessions.append(sessionId, { seq, at, event });
    }
  });

/** Every row of a session's transcript, read `limit` at a time. */
const walk = (sessionId: string, limit: number) =>
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

/** The token hash a session row holds, read straight off the row. */
const hashOf = (sessionId: string) =>
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

const turnIdOf = (row: StoredStreamRow): string =>
  row.event._tag === "turn.started" ? row.event.turnId : row.event._tag;

describe("the transcript walk", () => {
  it("pages through the whole stream in position order and stops at the end", async () => {
    const { items, pages } = await run(
      Effect.gen(function* () {
        const sessionId = yield* aSession;
        yield* fill(sessionId, 5);
        return yield* walk(sessionId, 2);
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(items.map((row) => row.position)).toEqual([1, 2, 3, 4, 5]);
    expect(items.map(turnIdOf)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    // Three pages of two: the third comes back short and ends the walk, which
    // is the page that proves the cursor is not handed out one page too long.
    expect(pages).toBe(3);
  });

  it("ends the walk with no cursor when the page holds the rest", async () => {
    const page = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        yield* fill(sessionId, 3);
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

  it("reads only the session it was asked for", async () => {
    const items = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const mine = yield* aSession;
        const theirs = yield* aSession;
        yield* fill(mine, 2);
        yield* fill(theirs, 4);
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

  it("refuses a cursor from the other direction rather than resuming in the wrong place", async () => {
    const error = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        yield* fill(sessionId, 4);
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

  it("refuses another session's cursor rather than skipping the rows below it", async () => {
    const error = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const mine = yield* aSession;
        const theirs = yield* aSession;
        yield* fill(mine, 6);
        yield* fill(theirs, 6);
        const theirPage = yield* sessions.transcript({
          sessionId: theirs,
          limit: 4,
          cursor: undefined,
          direction: "asc",
        });
        // Position is per session, so their position 4 is a boundary that means
        // nothing here: taken at face value it would hide my first four rows.
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

  it("hands back the normalized event as it was written, not a summary of it", async () => {
    const items = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        const event: ProviderEvent = {
          _tag: "content.delta",
          eventId: anId(),
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

describe("the session's own credential across a resume", () => {
  it("is gone the moment the session goes back on the queue", async () => {
    // A resumed session is queued again, with no process to be the identity of,
    // and it is put back there by the same call that would otherwise leave the
    // dead process's token live until dispatch happened to overwrite it.
    const held = await run(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const sessionId = yield* aSession;
        yield* sessions.moved(sessionId, "starting", at);
        yield* sessions.setTokenHash(sessionId, "hash-one");
        yield* sessions.moved(sessionId, "exited", at);
        const before = yield* hashOf(sessionId);
        yield* sessions.resume(sessionId, "{}", at);
        return { before, after: yield* hashOf(sessionId) };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(held.before).toBe("hash-one");
    expect(held.after).toBeNull();
  });
});
