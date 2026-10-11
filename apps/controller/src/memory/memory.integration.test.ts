/**
 * Tests assistant memory over HTTP, against a real controller and one fake
 * runner on the socket:
 *
 * - every route reaches its operation, `search` included, which shares its
 *   path shape with `read`;
 * - a stale write is refused with 409 and control characters with 400;
 * - an assistant has a `core` from its creation and loses its memory with
 *   its delete;
 * - an assistant's conversation session starts with its memory in the spec
 *   and with compaction off, and a Thread starts with neither;
 * - a session token reaches only its own assistant's memory.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Assistant, MemoryDocument, MemoryEntry, MemoryMatch } from "@hercule/contract";
import { del, get, post, readErrorBody, send } from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  readProfileNamed,
  readSessionToken,
  spawnThreadUnder,
  waitForStartFrames,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import { readDefaultConversation, startConversationSession } from "../conversations/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Writes a memory document with `token` and returns the raw response. */
const writeMemory = (
  arranged: Arranged,
  assistant: string,
  name: string,
  body: unknown,
  token = arranged.token,
): Promise<Response> =>
  send("PUT", arranged.harness.base, `/api/v1/assistants/${assistant}/memory/${name}`, {
    body,
    token,
  });

/** Creates an assistant as the user and returns it. */
const createAssistant = async (arranged: Arranged, name: string): Promise<Assistant> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/assistants",
    { name },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Assistant;
};

describe("memory over HTTP", () => {
  it("serves every operation to the user, search included", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const { assistant } = await readDefaultConversation(arranged);
      const path = `/api/v1/assistants/${assistant.id}/memory`;

      const written = await writeMemory(arranged, assistant.id, "travel", {
        body: "Flights to Amsterdam.",
        gist: "trips",
      });
      expect(written.status, await written.clone().text()).toBe(200);

      const appended = await post(
        base,
        `${path}/travel/append`,
        { body: "Hotel booked." },
        arranged.token,
      );
      expect(appended.status, await appended.clone().text()).toBe(200);
      expect(((await appended.json()) as MemoryDocument).body).toBe(
        "Flights to Amsterdam.\nHotel booked.",
      );

      const searched = await get(base, `${path}/search?text=amsterdam`, arranged.token);
      expect(searched.status, await searched.clone().text()).toBe(200);
      expect((await searched.json()) as ReadonlyArray<MemoryMatch>).toEqual([
        { name: "travel", snippets: ["Flights to Amsterdam.\nHotel booked."] },
      ]);

      const listed = await get(base, path, arranged.token);
      expect((await listed.json()) as ReadonlyArray<MemoryEntry>).toEqual([
        { name: "core", gist: "", size: 0 },
        { name: "travel", gist: "trips", size: 35 },
      ]);

      const deleted = await del(base, `${path}/travel`, arranged.token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect((await get(base, `${path}/travel`, arranged.token)).status).toBe(404);

      const auditEntries = await arranged.harness.audit("memory.written");
      expect(auditEntries).toHaveLength(1);
      expect(JSON.stringify(auditEntries)).not.toContain("Amsterdam");
    });
  });

  it("refuses a stale write with 409, and text with control characters with 400", async () => {
    await withAgentFleet(async (arranged) => {
      const { assistant } = await readDefaultConversation(arranged);

      const created = await writeMemory(arranged, assistant.id, "notes", {
        body: "first",
        expectedVersion: 0,
      });
      expect(created.status, await created.clone().text()).toBe(200);
      expect(((await created.json()) as MemoryDocument).version).toBe(1);

      const updated = await writeMemory(arranged, assistant.id, "notes", {
        body: "second",
        expectedVersion: 1,
      });
      expect(((await updated.json()) as MemoryDocument).version).toBe(2);

      const stale = await writeMemory(arranged, assistant.id, "notes", {
        body: "from a stale copy",
        expectedVersion: 1,
      });
      expect(stale.status).toBe(409);
      expect(await readErrorBody(stale)).toMatchObject({ code: "conflict" });

      const controlled = await writeMemory(arranged, assistant.id, "notes", {
        body: "a \u0002 b",
      });
      expect(controlled.status).toBe(400);
      expect((await readErrorBody(controlled)).issues).toEqual([["body"]]);
    });
  });

  it("seeds core when an assistant is created and removes its memory when it is deleted", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const created = await createAssistant(arranged, "Scout");
      const core = await get(base, `/api/v1/assistants/${created.id}/memory/core`, arranged.token);
      expect(core.status, await core.clone().text()).toBe(200);
      expect((await core.json()) as MemoryDocument).toMatchObject({
        name: "core",
        body: "",
        size: 0,
      });

      await writeMemory(arranged, created.id, "notes", { body: "kept until the delete" });
      expect((await del(base, `/api/v1/assistants/${created.id}`, arranged.token)).status).toBe(
        200,
      );

      const rows = await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql<{ readonly count: number }>`
            SELECT count(*) AS count FROM memory_documents
            WHERE assistant_id = unhex(${created.id.replaceAll("-", "")})`,
        ),
      );
      expect(rows[0]!.count).toBe(0);
      expect(
        (await get(base, `/api/v1/assistants/${created.id}/memory`, arranged.token)).status,
      ).toBe(404);
    });
  });

  it("starts a conversation session with the assistant's memory, scoped to that assistant", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const { assistant, conversation } = await readDefaultConversation(arranged);
      await writeMemory(arranged, assistant.id, "core", { body: "Rogier prefers short answers." });
      await writeMemory(arranged, assistant.id, "people", { body: "Ada", gist: "who is who" });
      const other = await createAssistant(arranged, "Scout");

      const session = await startConversationSession(arranged, conversation.id, "hi");
      const [frame] = await waitForStartFrames(arranged, session.id, 1);
      expect(frame!.spec.autoCompaction).toBe(false);
      expect(frame!.spec.memory).toContain("## Memory (core)\n\nRogier prefers short answers.");
      expect(frame!.spec.memory).toContain("- people (3 chars): who is who");
      const token = readSessionToken(frame!);

      const own = await get(base, "/api/v1/assistants/me/memory/core", token);
      expect(own.status, await own.clone().text()).toBe(200);
      const byId = await get(base, `/api/v1/assistants/${assistant.id}/memory`, token);
      expect(byId.status, await byId.clone().text()).toBe(200);

      const refused = await writeMemory(arranged, other.id, "core", { body: "x" }, token);
      expect(refused.status).toBe(403);
      expect(await readErrorBody(refused)).toMatchObject({
        code: "forbidden",
        grant: "memory.write",
      });

      const fromUser = await get(base, "/api/v1/assistants/me/memory", arranged.token);
      expect(fromUser.status).toBe(400);
      expect((await readErrorBody(fromUser)).issues).toEqual([["id"]]);
    });
  });

  it("starts a Thread with no memory, and refuses me from it", async () => {
    await withAgentFleet(async (arranged) => {
      const thread = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );
      const [frame] = await waitForStartFrames(arranged, thread.session.id, 1);
      expect(frame!.spec.memory).toBeUndefined();
      expect(frame!.spec.autoCompaction).toBeUndefined();

      const refused = await get(
        arranged.harness.base,
        "/api/v1/assistants/me/memory",
        thread.token,
      );
      expect(refused.status).toBe(400);
      expect((await readErrorBody(refused)).issues).toEqual([["id"]]);
    });
  });

  it("refuses a session under the worker profile before reading anything", async () => {
    await withAgentFleet(async (arranged) => {
      const thread = await spawnThreadUnder(arranged, await readProfileNamed(arranged, "worker"));
      const refused = await get(
        arranged.harness.base,
        "/api/v1/assistants/me/memory",
        thread.token,
      );
      expect(refused.status).toBe(403);
      expect(await readErrorBody(refused)).toMatchObject({
        code: "forbidden",
        grant: "memory.read",
      });
    });
  });
});
