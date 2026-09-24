/**
 * Tests the event pipeline's tick: what a pass reads, how far the cursor
 * moves, and what it writes for the routes that matched.
 *
 * Tests never call the pipeline directly. Its interval is shortened to a few
 * milliseconds, in the same loop `hercule serve` starts, and each test waits
 * for the tick's result.
 */
import { describe, expect, it, vi } from "vitest";
import { createProfile, at, waitUntil, WAIT_DEADLINE_MS } from "../sessions/testing";
import {
  BURST,
  buildPayload,
  waitUntilCaughtUp,
  emitManualEvent,
  KIND,
  readMatchedInputRows,
  REF,
  waitForMatchedInputRows,
  runEffect,
  storeCondition,
  subscribeAgent,
  spawnSubscriber,
  readCursorAndHead,
  withPipeline,
} from "./testing";

/** Long enough for a fleet, three sessions and several ticks. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("the event pipeline's tick", () => {
  it("writes one matched input for a matched subscription, and moves its cursor past the event", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);

      const eventId = await emitManualEvent(arranged, [REF], "The lid does not close");

      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 1,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe("subscription");
      expect(rows[0]!.event_id).toBe(eventId);
      expect(rows[0]!.session).toBe(agent.session.id.replaceAll("-", ""));
      // `routing/render-event-input.test.ts` tests the exact text. This test
      // only checks that the row holds the rendered text, not the raw event.
      expect(rows[0]!.text).toContain(KIND);
      expect(rows[0]!.text).toContain("The lid does not close");
      expect(rows[0]!.text).toContain("```json");

      // The cursor ends at the end of the log. It is compared with the newest
      // event id rather than with this event's id, so an event appended by
      // something else in the meantime does not fail the test.
      const position = await waitUntilCaughtUp(arranged.harness);
      expect(position).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("reads a burst larger than one batch to the end of the log in one tick, not one batch per tick", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "burst-holder");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      await waitUntilCaughtUp(arranged.harness);

      // Two and a half batches, inserted in one statement so the router finds
      // them all at once, not a few per pass as they arrive. They are written
      // straight to the table because `event.emit` takes one call per event,
      // and the router would read the early ones while the later ones were
      // still being posted.
      await runEffect(
        arranged.harness.sql`
          INSERT INTO events
            (source, connection_id, system, kind, occurred_at, received_at,
             dedup_key, refs, url, payload, raw, actor)
          WITH RECURSIVE counted(value) AS (
            SELECT 1 UNION ALL SELECT value + 1 FROM counted WHERE value < ${BURST}
          )
          SELECT 'manual', NULL, 'github', ${KIND}, ${at}, ${at}, 'burst-' || value,
                 ${JSON.stringify([REF])}, NULL, ${JSON.stringify(buildPayload("a burst"))},
                 NULL, 'user'
          FROM counted`,
      );

      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= BURST,
      );
      expect(rows).toHaveLength(BURST);
      const seen = await readCursorAndHead(arranged.harness);
      expect(seen.position).toBe(seen.head);
    });
  });

  it("writes nothing twice, however often the cursor is moved back over the same events", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      const eventId = await emitManualEvent(arranged, [REF], "The lid does not close");
      await waitForMatchedInputRows(arranged.harness, subscriptionId, (found) => found.length >= 1);
      const settled = await waitUntilCaughtUp(arranged.harness);

      // Simulates a crash between writing the matched inputs and moving the
      // cursor, three times.
      for (let pass = 0; pass < 3; pass++) {
        await runEffect(
          arranged.harness.sql`UPDATE event_cursors SET position = ${eventId - 1}
                               WHERE consumer = 'router'`,
        );
        await waitUntil("walked the log again", async () => {
          const seen = await readCursorAndHead(arranged.harness);
          return seen.position !== null && seen.position >= settled ? seen.position : undefined;
        });
        const rows = await readMatchedInputRows(arranged.harness, subscriptionId);
        expect(rows, `pass ${String(pass)}`).toHaveLength(1);
        expect(rows[0]!.event_id).toBe(eventId);
      }

      expect(await waitUntilCaughtUp(arranged.harness)).toBeGreaterThanOrEqual(settled);
    });
  });

  it("writes no matched input for an audit entry, whatever the condition, and moves the cursor past it", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      // A condition that matches everything, so a missing row is caused by the
      // kind of event, not by the condition.
      await storeCondition(arranged.harness, subscriptionId, "true");

      // Creating a profile appends `profile.created`, which is an audit entry.
      await createProfile(arranged, "leaves-an-entry", ["event.read"]);
      const entries = await runEffect(
        arranged.harness.sql<{
          readonly id: number;
        }>`SELECT id FROM events WHERE kind = 'profile.created' ORDER BY id DESC LIMIT 1`,
      );
      const entryId = entries[0]!.id;

      await waitUntil("moved its cursor past the audit entry", async () => {
        const seen = await readCursorAndHead(arranged.harness);
        return seen.position !== null && seen.position >= entryId ? seen.position : undefined;
      });
      expect(await readMatchedInputRows(arranged.harness, subscriptionId)).toEqual([]);

      // The same subscription does get a row for a pipeline event, so the
      // missing row above is caused by the kind of event, not a stopped router.
      const eventId = await emitManualEvent(arranged, [REF], "The lid does not close");
      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 1,
      );
      expect(rows.map((row) => row.event_id)).toEqual([eventId]);
    });
  });
});
