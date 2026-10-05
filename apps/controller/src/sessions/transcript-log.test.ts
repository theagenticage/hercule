/**
 * Tests `readAssistantTexts`, which reads the assistant text of a turn, or of
 * one item of a turn, from a session's stored stream.
 *
 * It reads no further back than the start of what it was asked for: the
 * turn's `turn.started` row, or the item's `item.started` row. When that row
 * is missing, it reads nothing rather than the whole session.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderEvent } from "@hercule/protocol";
import { mintUuid, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import { sessionRepository } from "./repository";
import { readAssistantTexts } from "./transcript-log";

const at = "2026-09-07T10:00:00.000Z";

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

/** One stream row to store, without the fields every event shares. */
type Row =
  | { readonly _tag: "turn.started"; readonly turnId: string }
  | { readonly _tag: "turn.completed"; readonly turnId: string }
  | { readonly _tag: "item.started"; readonly turnId: string; readonly itemId: string }
  | {
      readonly _tag: "content.delta";
      readonly turnId: string;
      readonly itemId: string;
      readonly delta: string;
    };

/** Builds the full provider event for one stored row. */
const buildEvent = (sessionId: string, row: Row): ProviderEvent => {
  const base = { eventId: mintId(), sessionId, at };
  switch (row._tag) {
    case "turn.started":
      return { ...base, ...row };
    case "turn.completed":
      return { ...base, ...row, state: "completed" };
    case "item.started":
      return { ...base, ...row, kind: "assistant_message" };
    case "content.delta":
      return { ...base, ...row, streamKind: "assistant_text" };
  }
};

/**
 * Writes a session with `rows` as its stream, in order, then reads the
 * assistant text of `turnId`, or of one item of it when `itemId` is given.
 */
const readTexts = (rows: ReadonlyArray<Row>, turnId: string, itemId?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* sessionRepository;
      const sessionId = mintId();
      yield* sessions.insert({
        id: sessionId,
        title: "a session",
        permissionProfileId: mintId(),
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
        at,
      });
      for (const [index, row] of rows.entries()) {
        yield* sessions.append(sessionId, {
          seq: index + 1,
          at,
          event: buildEvent(sessionId, row),
        });
      }
      return yield* readAssistantTexts(sql, sessionId, turnId, itemId);
    }).pipe(Effect.provide(TestDatabase), Effect.orDie),
  );

/** A finished first turn, whose text a read of a later turn must not include. */
const FIRST_TURN: ReadonlyArray<Row> = [
  { _tag: "turn.started", turnId: "t1" },
  { _tag: "item.started", turnId: "t1", itemId: "i1" },
  { _tag: "content.delta", turnId: "t1", itemId: "i1", delta: "old" },
  { _tag: "turn.completed", turnId: "t1" },
];

describe("reading a turn's assistant text", () => {
  it("reads each item of the turn, in order, joining an item stored as several rows", async () => {
    const texts = await readTexts(
      [
        ...FIRST_TURN,
        { _tag: "turn.started", turnId: "t2" },
        { _tag: "item.started", turnId: "t2", itemId: "a" },
        { _tag: "content.delta", turnId: "t2", itemId: "a", delta: "hel" },
        { _tag: "content.delta", turnId: "t2", itemId: "a", delta: "lo" },
        { _tag: "item.started", turnId: "t2", itemId: "b" },
        { _tag: "content.delta", turnId: "t2", itemId: "b", delta: "again" },
      ],
      "t2",
    );

    expect(texts).toEqual([
      { itemId: "a", text: "hello" },
      { itemId: "b", text: "again" },
    ]);
  });

  it("reads nothing for a turn whose turn.started row is missing, not the rows before it", async () => {
    const texts = await readTexts(
      [...FIRST_TURN, { _tag: "content.delta", turnId: "t2", itemId: "a", delta: "orphan" }],
      "t2",
    );

    expect(texts).toEqual([]);
  });

  it("reads nothing from a session with no rows", async () => {
    expect(await readTexts([], "t1")).toEqual([]);
  });
});

describe("reading one item's assistant text", () => {
  it("reads only that item, from its item.started row", async () => {
    const texts = await readTexts(
      [
        ...FIRST_TURN,
        { _tag: "turn.started", turnId: "t2" },
        { _tag: "item.started", turnId: "t2", itemId: "a" },
        { _tag: "content.delta", turnId: "t2", itemId: "a", delta: "first" },
        { _tag: "item.started", turnId: "t2", itemId: "b" },
        { _tag: "content.delta", turnId: "t2", itemId: "b", delta: "sec" },
        { _tag: "content.delta", turnId: "t2", itemId: "b", delta: "ond" },
      ],
      "t2",
      "b",
    );

    expect(texts).toEqual([{ itemId: "b", text: "second" }]);
  });

  it("reads nothing for an item whose item.started row is missing, not the whole turn", async () => {
    const texts = await readTexts(
      [
        { _tag: "turn.started", turnId: "t1" },
        { _tag: "item.started", turnId: "t1", itemId: "a" },
        { _tag: "content.delta", turnId: "t1", itemId: "a", delta: "first" },
        { _tag: "content.delta", turnId: "t1", itemId: "b", delta: "orphan" },
      ],
      "t1",
      "b",
    );

    expect(texts).toEqual([]);
  });
});
