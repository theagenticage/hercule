/**
 * Tests `readAssistantTexts`, which reads the assistant text of a turn, or of
 * one item of a turn, from a session's stored stream, and `readTurnStanding`
 * and `readOpenTurnId`, which tell where a turn stands and find the turn an
 * agent has open.
 *
 * It reads no further back than the start of what it was asked for: the
 * turn's `turn.started` row, or the item's `item.started` row. When that row
 * is missing, it reads nothing rather than the whole session.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type { SqlError } from "effect/sql/SqlError";
import type { HarnessEvent } from "@hercule/protocol";
import { mintUuid, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { sessionRepository } from "./repository";
import {
  readAssistantTexts,
  readOpenTurnId,
  readRecentAssistantText,
  readTurnStanding,
} from "./transcript-log";

const at = "2026-09-07T10:00:00.000Z";

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

/**
 * One stream row to store, without the fields every event shares, and the
 * subagent it belongs to, if any.
 */
type Row = { readonly subagentId?: string } & (
  | { readonly _tag: "turn.started"; readonly turnId: string }
  | { readonly _tag: "turn.completed"; readonly turnId: string }
  | { readonly _tag: "item.started"; readonly turnId: string; readonly itemId: string }
  | {
      readonly _tag: "content.delta";
      readonly turnId: string;
      readonly itemId: string;
      readonly delta: string;
    }
);

/** Builds the full harness event for one stored row. */
const buildEvent = (sessionId: string, row: Row): HarnessEvent => {
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
 * Writes a session with `rows` as its stream, in order, then runs `read` on
 * the new session and returns what it returns. With `resumedAfter`, the
 * session is resumed after that many rows, so those rows belong to an earlier
 * process and the rest to the current one.
 */
const readStoredRows = <A>(
  rows: ReadonlyArray<Row>,
  read: (sql: SqlClient.SqlClient, sessionId: string) => Effect.Effect<A, SqlError>,
  resumedAfter?: number,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* sessionRepository;
      const sessionId = mintId();
      yield* sessions.insert({
        id: sessionId,
        title: "a session",
        role: undefined,
        permissionProfileId: mintId(),
        agentId: undefined,
        conversationId: undefined,
        step: undefined,
        providerAccountId: mintId(),
        harnessId: "harnesses/full",
        runnerId: mintId(),
        requestedAccessMode: "approval-required",
        accessMode: "approval-required",
        workspaceId: null,
        projectId: undefined,
        taskId: undefined,
        checkoutBranch: undefined,
        githubConnectionId: undefined,
        spec: "{}",
        modelSelection: { model: "clever", options: {} },
        parentSessionId: undefined,
        createdBy: "user",
        at,
      });
      for (const [index, row] of rows.entries()) {
        yield* sessions.append(sessionId, {
          seq: index + 1,
          at,
          event: buildEvent(sessionId, row),
        });
        if (index + 1 === resumedAfter) yield* sessions.resume(sessionId, "{}");
      }
      return yield* read(sql, sessionId);
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

/**
 * Writes a session with `rows` as its stream, then reads the assistant text
 * of `turnId`, or of one item of it when `itemId` is given, from the
 * transcript of the session's own agent or of `subagentId`.
 */
const readTexts = (
  rows: ReadonlyArray<Row>,
  turnId: string,
  itemId?: string,
  subagentId?: string,
) =>
  readStoredRows(rows, (sql, sessionId) =>
    readAssistantTexts(sql, { sessionId, subagentId, turnId, itemId }),
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

  it("reads the turn's text past a late turn.completed of an earlier turn", async () => {
    const texts = await readTexts(
      [
        { _tag: "turn.started", turnId: "t1" },
        { _tag: "turn.started", turnId: "t2" },
        { _tag: "item.started", turnId: "t2", itemId: "a" },
        { _tag: "content.delta", turnId: "t2", itemId: "a", delta: "before " },
        { _tag: "turn.completed", turnId: "t1" },
        { _tag: "content.delta", turnId: "t2", itemId: "a", delta: "after" },
      ],
      "t2",
    );

    expect(texts).toEqual([{ itemId: "a", text: "before after" }]);
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

describe("reading one agent's assistant text", () => {
  /** A main turn with a subagent's whole turn written in the middle of it. */
  const INTERLEAVED: ReadonlyArray<Row> = [
    { _tag: "turn.started", turnId: "t1" },
    { _tag: "item.started", turnId: "t1", itemId: "a" },
    { _tag: "content.delta", turnId: "t1", itemId: "a", delta: "main " },
    { _tag: "turn.started", turnId: "s1", subagentId: "sub" },
    { _tag: "item.started", turnId: "s1", itemId: "x", subagentId: "sub" },
    {
      _tag: "content.delta",
      turnId: "s1",
      itemId: "x",
      delta: "from the subagent",
      subagentId: "sub",
    },
    { _tag: "turn.completed", turnId: "s1", subagentId: "sub" },
    { _tag: "content.delta", turnId: "t1", itemId: "a", delta: "reply" },
  ];

  it("reads the session's own agent past a subagent's turn, without its text", async () => {
    expect(await readTexts(INTERLEAVED, "t1")).toEqual([{ itemId: "a", text: "main reply" }]);
  });

  it("reads a subagent's turn from its own rows only", async () => {
    expect(await readTexts(INTERLEAVED, "s1", undefined, "sub")).toEqual([
      { itemId: "x", text: "from the subagent" },
    ]);
  });
});

describe("reading where a turn stands, and an agent's open turn", () => {
  /** Writes `rows`, then reads where the turn `turnId` of the subagent `sub` stands. */
  const readStanding = (rows: ReadonlyArray<Row>, turnId: string, resumedAfter?: number) =>
    readStoredRows(
      rows,
      (sql, sessionId) => readTurnStanding(sql, sessionId, "sub", turnId),
      resumedAfter,
    );

  /** Writes `rows`, then reads the open turn of the subagent `sub`. */
  const readOpenTurn = (rows: ReadonlyArray<Row>, resumedAfter?: number) =>
    readStoredRows(rows, (sql, sessionId) => readOpenTurnId(sql, sessionId, "sub"), resumedAfter);

  const started = (turnId: string): Row => ({ _tag: "turn.started", turnId, subagentId: "sub" });
  const completed = (turnId: string): Row => ({
    _tag: "turn.completed",
    turnId,
    subagentId: "sub",
  });

  it("reads the turn the subagent started last while it is open", async () => {
    expect(
      await readOpenTurn([
        started("s1"),
        completed("s1"),
        started("s2"),
        // Another agent's turn ending does not close the subagent's.
        { _tag: "turn.started", turnId: "t1" },
        { _tag: "turn.completed", turnId: "t1" },
      ]),
    ).toBe("s2");
  });

  it("reads no open turn when the subagent has none, or its turn ended", async () => {
    expect(await readOpenTurn([])).toBeUndefined();
    expect(await readOpenTurn([started("s1"), completed("s1")])).toBeUndefined();
    expect(await readOpenTurn([{ _tag: "turn.started", turnId: "t1" }])).toBeUndefined();
  });

  it("keeps the newest turn open when the end of an earlier turn is stored after its start", async () => {
    const lateCompletion = [started("s1"), started("s2"), completed("s1")];

    expect(await readOpenTurn(lateCompletion)).toBe("s2");
    expect(await readOpenTurn([...lateCompletion, completed("s2")])).toBeUndefined();
  });

  it("reads no open turn when the end of a turn the agent never started follows its newest start", async () => {
    // The connection dropped: the end of s1 and the start of s2 were lost, and
    // after the reconnect the end of s2 arrived. It ends the agent's turn.
    expect(await readOpenTurn([started("s1"), completed("s2")])).toBeUndefined();
  });

  it("reads the newest turn as current while it has not ended", async () => {
    expect(await readStanding([started("s1")], "s1")).toBe("current");
    expect(await readStanding([started("s1"), completed("s1"), started("s2")], "s2")).toBe(
      "current",
    );
  });

  it("reads a turn as past once it ended", async () => {
    expect(await readStanding([started("s1"), completed("s1")], "s1")).toBe("past");
  });

  it("reads a turn as past once a newer turn of the agent started", async () => {
    expect(await readStanding([started("s1"), started("s2")], "s1")).toBe("past");
  });

  it("reads a turn as unknown when the agent never started it", async () => {
    expect(await readStanding([started("s1"), completed("s1")], "s2")).toBe("unknown");
    expect(await readStanding([], "s1")).toBe("unknown");
  });

  it("ignores the turns of an earlier process of the session", async () => {
    const rows = [started("s1"), started("s2"), started("s3")];

    expect(await readStanding(rows, "s3", 3)).toBe("unknown");
    expect(await readOpenTurn(rows, 3)).toBeUndefined();
    expect(await readStanding(rows, "s3", 2)).toBe("current");
    expect(await readStanding(rows, "s2", 2)).toBe("unknown");
    expect(await readStanding(rows, "s2", 1)).toBe("past");
  });

  it("reads only the rows of the agent asked about", async () => {
    // The session's own agent started a turn after the subagent's turn, and
    // ended a turn with the same id: neither moves the subagent's turn.
    const rows: ReadonlyArray<Row> = [
      started("s1"),
      { _tag: "turn.started", turnId: "t2" },
      { _tag: "turn.completed", turnId: "s1" },
    ];

    expect(await readStanding(rows, "s1")).toBe("current");
    expect(await readOpenTurn(rows)).toBe("s1");
  });
});

describe("reading the recent assistant text", () => {
  /** A text delta of the session's own agent, or of `subagentId`. */
  const delta = (itemId: string, text: string, subagentId?: string): Row => ({
    _tag: "content.delta",
    turnId: "t",
    itemId,
    delta: text,
    ...(subagentId === undefined ? {} : { subagentId }),
  });

  /** A row that is not a text delta, such as the start of a tool call. */
  const toolRow = (index: number): Row => ({
    _tag: "item.started",
    turnId: "t",
    itemId: `tool-${String(index)}`,
  });

  const readRecent = (rows: ReadonlyArray<Row>, maxRows: number, maxChars: number) =>
    readStoredRows(rows, (sql, sessionId) =>
      readRecentAssistantText(sql, { sessionId, maxRows, maxChars }),
    );

  it("reads only the newest rows of a turn with thousands of deltas, in reading order", async () => {
    const rows = Array.from({ length: 3000 }, (_, index) => delta("a", `${String(index)} `));

    const text = await readRecent(rows, 8, 10_000);

    expect(text).toBe("2992 2993 2994 2995 2996 2997 2998 2999 ");
  });

  it("looks at a fixed window of the newest rows: text buried under later rows is not read", async () => {
    const rows = [
      delta("a", "buried"),
      ...Array.from({ length: 300 }, (_, index) => toolRow(index)),
      delta("b", "recent"),
    ];

    expect(await readRecent(rows, 8, 10_000)).toBe("recent");
    expect(await readRecent(rows.slice(0, -1), 8, 10_000)).toBe("");
  });

  it("keeps the newest characters when the text is longer than maxChars", async () => {
    const text = await readRecent([delta("a", "0123456789"), delta("a", "abcdefghij")], 8, 14);

    expect(text).toBe("6789abcdefghij");
  });

  it("never reads a subagent's text, and separates items with a blank line", async () => {
    const text = await readRecent(
      [
        delta("a", "first"),
        delta("sub", "from a subagent", "sub-1"),
        delta("b", "second"),
        delta("b", " half"),
      ],
      8,
      1000,
    );

    expect(text).toBe("first\n\nsecond half");
  });

  it("does not split a surrogate pair when it cuts", async () => {
    const text = await readRecent([delta("a", "a😀b")], 8, 2);

    expect(text).toBe("b");
  });

  it("walks the agent index back from the newest row instead of scanning the session", async () => {
    const compiled: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const plan = await readStoredRows([delta("a", "x")], (sql, sessionId) =>
      Effect.gen(function* () {
        yield* Effect.provideService(
          readRecentAssistantText(sql, { sessionId, maxRows: 8, maxChars: 100 }),
          Statement.CurrentTransformer,
          (statement) =>
            Effect.sync(() => {
              compiled.push(statement.compile());
              return statement;
            }),
        );
        const [text, params] = compiled[0]!;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        return rows.map((row) => row.detail);
      }),
    );

    expect(plan.some((detail) => detail.includes("USING INDEX session_stream_agent"))).toBe(true);
    expect(plan.some((detail) => /^SCAN session_stream\b(?! USING)/.test(detail))).toBe(false);
  });
});
