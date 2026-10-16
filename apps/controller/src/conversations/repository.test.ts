/**
 * Tests the conversation repository's read of the conversation the owner wrote
 * in last.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { uuidFromString } from "../db";
import { TestDatabase } from "../db/testing";
import { conversationRepository } from "./repository";

const ASSISTANT = "0199e0e7-0000-7000-8000-0000000000a1";
const OTHER_ASSISTANT = "0199e0e7-0000-7000-8000-0000000000a2";
const FIRST = "0199e0e7-0000-7000-8000-0000000000c1";
const FOREIGN = "0199e0e7-0000-7000-8000-0000000000c3";
const CREATED = "2026-10-01T00:00:00.000Z";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [id, assistant] of [
    [FIRST, ASSISTANT],
    [FOREIGN, OTHER_ASSISTANT],
  ] as const) {
    yield* sql`INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
      VALUES (${uuidFromString(id)}, ${uuidFromString(assistant)}, 'web', NULL, ${CREATED})`;
  }
});

const addMessage = (conversationId: string, position: number, role: string, createdAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = `0199e0e7-0000-7000-8000-${String(position).padStart(4, "0")}${conversationId.slice(-8)}`;
    yield* sql`INSERT INTO conversation_messages (id, conversation_id, container_key, position,
                                                  sender_role, sender_label, text, actor, created_at)
      VALUES (${uuidFromString(id)}, ${uuidFromString(conversationId)}, NULL, ${position}, ${role},
              'x', 'hi', 'user', ${createdAt})`;
  });

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestDatabase)));

describe("readLatestOwnerConversationId", () => {
  it("returns the assistant's conversation the owner wrote in, not another assistant's", async () => {
    const found = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* addMessage(FIRST, 1, "owner", "2026-10-02T00:00:00.000Z");
        yield* addMessage(FIRST, 2, "assistant", "2026-10-04T00:00:00.000Z");
        // Another assistant's conversation does not answer, even with a newer owner message.
        yield* addMessage(FOREIGN, 1, "owner", "2026-10-05T00:00:00.000Z");
        const conversations = yield* conversationRepository;
        return yield* conversations.readLatestOwnerConversationId(ASSISTANT);
      }),
    );
    expect(found._tag === "Some" ? found.value : undefined).toBe(FIRST);
  });

  it("returns none when the owner wrote in none of the conversations", async () => {
    const found = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* addMessage(FIRST, 1, "assistant", "2026-10-02T00:00:00.000Z");
        const conversations = yield* conversationRepository;
        return yield* conversations.readLatestOwnerConversationId(ASSISTANT);
      }),
    );
    expect(found._tag).toBe("None");
  });
});
