/**
 * Tests `conversation.queryMessages` over HTTP, against a real controller and
 * one fake runner: the messages of one conversation, newest first by default,
 * one page at a time.
 *
 * The messages are sent with `conversation.send`. The first one places the
 * assistant's session, and the fake runner never reports it started, so every
 * later message waits in the session's queue and nothing else is written to the
 * conversation.
 */
import { describe, expect, it, vi } from "vitest";
import { get, post, readErrorBody } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  readProfileNamed,
  spawnThreadUnder,
  withAgentFleet,
} from "../sessions/testing";
import { listMessages, readDefaultConversation, sendMessage } from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** A well-formed id that matches no record. */
const NOBODY = "0199e0e7-9999-7000-8000-000000000000";

/** Returns the numbers 1 to `count`, in order. */
const countTo = (count: number): Array<number> =>
  Array.from({ length: count }, (_, index) => index + 1);

describe("conversation.queryMessages", () => {
  it("returns the newest 50 first with a cursor, the rest after it, and the oldest 50 with sort=position:asc", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      for (const number of countTo(60)) {
        await sendMessage(arranged, conversation.id, `message ${String(number)}`);
      }

      const first = await listMessages(arranged, conversation.id);
      expect(first.items.map((one) => one.position)).toEqual(countTo(60).slice(10).reverse());
      expect(first.nextCursor).toBeDefined();

      const second = await listMessages(
        arranged,
        conversation.id,
        `cursor=${encodeURIComponent(first.nextCursor!)}`,
      );
      expect(second.items.map((one) => one.position)).toEqual(countTo(10).reverse());
      expect(second.nextCursor).toBeUndefined();

      const oldest = await listMessages(arranged, conversation.id, "sort=position:asc");
      expect(oldest.items.map((one) => one.position)).toEqual(countTo(50));
      expect(oldest.items[0]!.text).toBe("message 1");
    });
  });

  it("rejects a cursor from another conversation's messages, rather than paging from its position", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      await sendMessage(arranged, conversation.id, "message 1");
      await sendMessage(arranged, conversation.id, "message 2");
      const created = await post(
        arranged.harness.base,
        "/api/v1/assistants",
        { name: "Ada" },
        arranged.token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const ada = (await created.json()) as { readonly id: string };
      const listed = await get(
        arranged.harness.base,
        `/api/v1/conversations?assistantId=${ada.id}`,
        arranged.token,
      );
      const [other] = ((await listed.json()) as { items: ReadonlyArray<{ id: string }> }).items;
      await sendMessage(arranged, other!.id, "hello Ada");
      await sendMessage(arranged, other!.id, "are you there?");

      const first = await listMessages(arranged, conversation.id, "limit=1");
      expect(first.nextCursor).toBeDefined();
      const response = await get(
        arranged.harness.base,
        `/api/v1/conversations/${other!.id}/messages?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
        arranged.token,
      );

      expect(response.status).toBe(400);
      expect(await readErrorBody(response)).toMatchObject({ code: "validation" });
    });
  });

  it("fails with not_found for an id that names no conversation", async () => {
    await withAgentFleet(async (arranged) => {
      const response = await get(
        arranged.harness.base,
        `/api/v1/conversations/${NOBODY}/messages`,
        arranged.token,
      );

      expect(response.status).toBe(404);
      // The same refusal `conversation.read` gives for the id, not the
      // router's refusal of a path it does not know.
      const read = await get(
        arranged.harness.base,
        `/api/v1/conversations/${NOBODY}`,
        arranged.token,
      );
      expect(await readErrorBody(response)).toMatchObject({
        code: "not_found",
        message: (await readErrorBody(read)).message,
      });
    });
  });

  it("may be read with a session token under the assistant profile", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      await sendMessage(arranged, conversation.id, "hi");
      const { token } = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );

      const response = await get(
        arranged.harness.base,
        `/api/v1/conversations/${conversation.id}/messages`,
        token,
      );

      expect(response.status, await response.clone().text()).toBe(200);
      const page = (await response.json()) as { items: ReadonlyArray<{ text: string }> };
      expect(page.items.map((one) => one.text)).toEqual(["hi"]);
    });
  });
});
