/**
 * Tests what the session tool calls migration does to the sessions stored
 * before it: each one's `tool_calls` is the number of its stored
 * `item.started` rows of a tool-call kind, from any of its agents.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TOOL_CALL_KINDS } from "../../sessions/stream";
import { MEMORY, openDatabase } from "../client";
import { uuidFromString } from "../id";
import { runMigrations } from "../migrate";
import { MIGRATED_TOOL_CALL_KINDS } from "./0067-session-tool-calls";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 67);

const BUSY = "0190a000-0000-7000-8000-000000000001";
const QUIET = "0190a000-0000-7000-8000-000000000002";
const at = "2026-10-11T10:00:00.000Z";

/** Builds an `item.started` event of `kind`, from the subagent `subagentId` when one is given. */
const buildItemStarted = (itemId: string, kind: string, subagentId?: string) => ({
  _tag: "item.started",
  turnId: "t1",
  itemId,
  kind,
  detail: {},
  ...(subagentId === undefined ? {} : { subagentId }),
});

/**
 * Writes two sessions, gives the first a stream with tool calls from its own
 * agent and from a subagent beside rows that are not tool calls, runs every
 * migration, and returns each session's `tool_calls` by id.
 */
const seedAndMigrate = (): Promise<Readonly<Record<string, number>>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      for (const id of [BUSY, QUIET]) {
        yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at)
          VALUES (${uuidFromString(id)}, 'profile', 'instance', 'runner', 'auto', 'auto', '{}',
                  'a', 'idle', ${at}, ${at})`;
      }
      const busyStream = [
        buildItemStarted("i1", "user_message"),
        buildItemStarted("i2", "command_execution"),
        { ...buildItemStarted("i2", "command_execution"), _tag: "item.completed" },
        buildItemStarted("i3", "subagent"),
        buildItemStarted("i4", "file_read", "sub-1"),
        buildItemStarted("i5", "assistant_message", "sub-1"),
        {
          _tag: "content.delta",
          turnId: "t1",
          itemId: "i6",
          streamKind: "command_output",
          delta: '"kind":"tool_call"',
        },
      ];
      for (const [index, event] of busyStream.entries()) {
        yield* sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event,
                                               subagent_id)
          VALUES (${uuidFromString(BUSY)}, ${index + 1}, ${index + 1}, ${at},
                  ${JSON.stringify(event)}, ${"subagentId" in event ? event.subagentId : null})`;
      }
      yield* sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
        VALUES (${uuidFromString(QUIET)}, 1, 1, ${at},
                ${JSON.stringify(buildItemStarted("i1", "reasoning"))})`;
      yield* runMigrations();
      const rows = yield* sql<{ readonly id: Uint8Array; readonly tool_calls: number }>`
        SELECT id, tool_calls FROM sessions`;
      return Object.fromEntries(
        rows.map((row) => [Buffer.from(row.id).toString("hex"), row.tool_calls]),
      );
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

/** Returns a session id as the hex its stored bytes print as. */
const toHex = (id: string): string => id.replaceAll("-", "");

describe("the session tool calls migration", () => {
  it("counts each session's stored tool calls from every agent, and nothing else", async () => {
    const toolCalls = await seedAndMigrate();

    // The command, the call that started the subagent, and the subagent's
    // file read. The messages, the completed item and the delta do not count.
    expect(toolCalls).toEqual({ [toHex(BUSY)]: 3, [toHex(QUIET)]: 0 });
  });

  it("counts the kinds the sessions domain counts today", () => {
    // A kind added to `TOOL_CALL_KINDS` later fails this test. The migration
    // must not change, so the sessions stored before the new kind need a new
    // migration that counts it, and this test then compares against that one.
    expect(new Set(MIGRATED_TOOL_CALL_KINDS)).toEqual(TOOL_CALL_KINDS);
  });
});
