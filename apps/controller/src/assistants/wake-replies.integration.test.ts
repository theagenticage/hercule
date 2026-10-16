/**
 * Tests the replies an assistant's session writes for a turn that a
 * Scheduled Wake opened, from what the fake runner reports on the runner
 * socket, against a real controller.
 *
 * A wake turn stores exactly one reply whatever the reply mode, marked with
 * the wake; a quiet heartbeat reply is stored with `quiet`. A rotation's
 * flush turn stores nothing, which `rotation.integration.test.ts` tests,
 * because that turn is told apart by its retired session and not by its
 * input. The tests start the session with an owner's
 * message, then change the source of the input that opened the turn, because
 * the Scheduler that queues wakes is not part of this suite.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { InputSource } from "@hercule/contract";
import { send } from "../http/testing";
import { WAIT_DEADLINE_MS, withAgentFleet, type Arranged } from "../sessions/testing";
import {
  listMessages,
  readDefaultConversation,
  runTurn,
  startConversationSession,
} from "../conversations/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/**
 * Starts a session whose first turn was opened by an input of `source`, runs
 * a turn that answers with `texts`, and returns the conversation's messages
 * after the owner's.
 */
const runWakeTurn = async (
  arranged: Arranged,
  source: InputSource,
  texts: ReadonlyArray<string>,
  reply: "turn-end" | "segments" = "turn-end",
  options: { readonly steeredInput?: boolean } = {},
) => {
  const { assistant, conversation } = await readDefaultConversation(arranged);
  if (reply !== "turn-end") {
    const response = await send(
      "PATCH",
      arranged.harness.base,
      `/api/v1/assistants/${assistant.id}`,
      {
        body: { reply },
        token: arranged.token,
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const session = await startConversationSession(arranged, conversation.id, "wake up");
  await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql`UPDATE session_inputs SET source = ${source} WHERE status = 'delivered'`,
    ),
  );
  if (options.steeredInput === true) {
    // The owner wrote while the turn ran, and the runner joined it to the turn.
    await Effect.runPromise(
      Effect.orDie(
        arranged.harness.sql`
          INSERT INTO session_inputs
            (id, session_id, source, actor, text, status, delivery, created_at, delivered_at)
          SELECT randomblob(16), session_id, 'user', 'user', 'one more thing', 'delivered',
                 'steered', created_at, '2099-01-01T00:00:00.000Z'
          FROM session_inputs WHERE status = 'delivered' LIMIT 1`,
      ),
    );
  }
  await runTurn(arranged, session.id, 2, "t1", texts);
  return (await listMessages(arranged, conversation.id, "sort=position:asc")).items.slice(1);
};

describe("the replies of a turn a Scheduled Wake opened", () => {
  it("stores a heartbeat's NO_REPLY as a quiet reply with no text", async () => {
    await withAgentFleet(async (arranged) => {
      const replies = await runWakeTurn(arranged, "heartbeat", ["NO_REPLY"]);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        senderRole: "assistant",
        text: "",
        wake: "heartbeat",
        quiet: true,
      });
    });
  });

  it("stores a heartbeat that speaks as a reply that is not quiet", async () => {
    await withAgentFleet(async (arranged) => {
      const replies = await runWakeTurn(arranged, "heartbeat", ["The build failed."]);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ text: "The build failed.", wake: "heartbeat" });
      expect(replies[0]).not.toHaveProperty("quiet");
    });
  });

  it("stores one reply at the turn's end for a reminder, even in segments mode", async () => {
    await withAgentFleet(async (arranged) => {
      const replies = await runWakeTurn(
        arranged,
        "reminder",
        ["Checking.", "Call Ada."],
        "segments",
      );
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ text: "Call Ada.", wake: "reminder" });
      expect(replies[0]).not.toHaveProperty("quiet");
    });
  });

  it("keeps the wake of a turn when an owner message was steered into it", async () => {
    await withAgentFleet(async (arranged) => {
      const replies = await runWakeTurn(arranged, "heartbeat", ["NO_REPLY"], "segments", {
        steeredInput: true,
      });
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ text: "", wake: "heartbeat", quiet: true });
    });
  });
});
