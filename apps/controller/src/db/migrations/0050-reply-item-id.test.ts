/**
 * Tests what the reply item id migration does to a database at the previous
 * head: a message that exists already reads no item id, and a reply stored
 * after it keeps the id of the assistant text it holds.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { uuidFromString } from "../id";
import { runMigrations } from "../migrate";
import { messageRepository } from "../../conversations/message-repository";
import { migrations } from "./index";

const CONVERSATION = "0199e0e7-0000-7000-8000-0000000000c1";
const MESSAGE = "0199e0e7-0000-7000-8000-0000000000d1";
const AT = "2026-10-07T00:00:00.000Z";
const BEFORE = migrations.filter(([id]) => id < 50);

describe("the reply item id migration", () => {
  it("leaves existing messages without an item id and keeps a new reply's", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO conversation_messages
            (id, conversation_id, container_key, position, sender_role, sender_label, text,
             session_id, turn_id, actor, created_at)
          VALUES (${uuidFromString(MESSAGE)}, ${uuidFromString(CONVERSATION)}, NULL, 1,
                  'assistant', 'Ada', 'Done.', NULL, 't1', 'system', ${AT})`;
        yield* runMigrations();
        const messages = yield* messageRepository;
        yield* messages.insert({
          conversationId: CONVERSATION,
          containerKey: null,
          senderRole: "assistant",
          senderLabel: "Ada",
          text: "Again.",
          sessionId: null,
          turnId: "t2",
          itemId: "a1",
          actor: "system",
          at: AT,
        });
        const page = yield* messages.list({
          conversationId: CONVERSATION,
          limit: 10,
          cursor: undefined,
          direction: "asc",
        });
        return page.items.map((message) => [message.text, message.itemId]);
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );
    expect(result).toEqual([
      ["Done.", null],
      ["Again.", "a1"],
    ]);
  });
});
