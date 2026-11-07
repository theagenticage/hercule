/**
 * Tests the Task of a Done Thread that an event wakes (ticket #1029, "Other
 * paths"). The event pipeline writes the Thread's new input with no request
 * and no actor behind it, so the Task the rule makes for the Thread must be
 * stamped with the system, and the wake-up must still be stored.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Session, Task } from "@hercule/contract";
import { withTransaction } from "../../db";
import { get, post } from "../../http/testing";
import { WAIT_DEADLINE_MS } from "../../sessions/testing";
import {
  emitManualEvent,
  REF,
  spawnSubscriber,
  subscribeThread,
  waitForMatchedInputRows,
  withPipeline,
} from "../testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("a Done Thread that an event wakes", () => {
  it("gets a new Task stamped with the system, and the wake-up is stored", async () => {
    await withPipeline(async (arranged) => {
      const thread = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeThread(arranged, thread, REF);
      const marked = await post(
        arranged.harness.base,
        "/api/v1/sessions/mark-done",
        { sessionIds: [thread.session.id] },
        arranged.token,
      );
      expect(marked.status, await marked.clone().text()).toBe(200);
      // The Thread has no Task, as the Threads that were Done at the upgrade.
      const id = thread.session.id.replaceAll("-", "");
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            arranged.harness.sql,
            arranged.harness.sql`UPDATE sessions SET task_id = NULL WHERE id = unhex(${id})`,
          ),
        ),
      );
      const createdBefore = (await arranged.harness.platformEvents("task.created")).length;

      await emitManualEvent(arranged, [REF], "The lid does not close");
      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 1,
      );

      expect(rows).toHaveLength(1);
      const read = await get(
        arranged.harness.base,
        `/api/v1/sessions/${thread.session.id}`,
        arranged.token,
      );
      const woken = (await read.json()) as Session;
      expect("done" in woken).toBe(false);
      expect(woken.taskId).toBeDefined();
      const created = (await arranged.harness.platformEvents("task.created")).slice(createdBefore);
      expect(created).toHaveLength(1);
      expect(created[0]!.actor).toBe("system");
      expect((created[0]!.payload as { task: Task }).task.id).toBe(woken.taskId);
      expect(created[0]!.payload).toMatchObject({
        task: { title: thread.session.title, stage: "exploring", status: "open" },
      });
    });
  });
});
