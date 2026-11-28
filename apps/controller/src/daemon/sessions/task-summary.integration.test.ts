/**
 * Tests when the end of a turn makes the summary of a Task out of date, over
 * HTTP against a real controller and one fake runner (the third observer of
 * `combineSessionObservers`):
 *
 * - a turn of the Thread's own agent counts, also when a queued input starts
 *   the next turn at once and the session never reads idle;
 * - a subagent's turn does not.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { SessionInput } from "@hercule/protocol";
import { post } from "../../http/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  listInputs,
  reportEvent,
  reportTurnCompleted,
  spawnThreadWithGrants,
  waitForSession,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../../sessions/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/** Removes the dashes of an id, the form `lower(hex(...))` reads rows in. */
const compact = (id: string): string => id.replaceAll("-", "");

/** Returns how many times the Task's summary was marked out of date, 0 when it never was. */
const readRevision = async (arranged: Arranged, taskId: string): Promise<number> => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ readonly dirty_revision: number }>`
        SELECT dirty_revision FROM task_summaries WHERE lower(hex(task_id)) = ${compact(taskId)}`,
    ),
  );
  return rows[0]?.dirty_revision ?? 0;
};

describe("the summary of a Task, when a turn of one of its sessions ends", () => {
  it("is out of date when the turn ends and a queued input starts the next turn at once", async () => {
    await withAgentFleet(async (arranged) => {
      const { session } = await spawnThreadWithGrants(arranged, "summary-queued", []);
      const taskId = session.taskId!;
      const queued = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "and rebase it", steer: false },
        arranged.token,
      );
      expect(queued.status, await queued.clone().text()).toBe(200);
      const { inputId } = (await queued.json()) as { readonly inputId: string };
      const before = await readRevision(arranged, taskId);

      reportTurnCompleted(arranged, session.id, 2);
      await waitUntil("delivered the queued input", async () =>
        (await listInputs(arranged, session.id)).find(
          (one) => one.id === inputId && one.status === "delivered",
        ),
      );

      // The input went out as the next turn, so the session never read idle.
      expect(listFrames<SessionInput>(arranged.wire, "sessionInput")).toHaveLength(1);
      expect(await readRevision(arranged, taskId)).toBe(before + 1);
    });
  });

  it("is not out of date when a subagent's turn ends, and is when the Thread's own turn does", async () => {
    await withAgentFleet(async (arranged) => {
      const { session } = await spawnThreadWithGrants(arranged, "summary-subagent", []);
      const taskId = session.taskId!;
      const before = await readRevision(arranged, taskId);
      const base = (subagentId?: string) => ({
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        ...(subagentId === undefined ? {} : { subagentId }),
      });

      reportEvent(arranged.wire, 2, { ...base(), _tag: "subagent.started", subagentId: "helper" });
      reportEvent(arranged.wire, 3, { ...base("helper"), _tag: "turn.started", turnId: "s1" });
      reportEvent(arranged.wire, 4, {
        ...base("helper"),
        _tag: "turn.completed",
        turnId: "s1",
        state: "completed",
      });
      // A report is applied only after the ones before it, so once the Thread
      // reads idle the subagent's turn end has been applied too.
      reportEvent(arranged.wire, 5, {
        ...base(),
        _tag: "turn.completed",
        turnId: "t1",
        state: "completed",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "idle");

      expect(await readRevision(arranged, taskId)).toBe(before + 1);
    });
  });
});
