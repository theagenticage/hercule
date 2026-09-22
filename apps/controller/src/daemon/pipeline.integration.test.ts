/**
 * The event pipeline's tick, running: what one pass reads, how far it walks,
 * and what it writes for the routes that matched.
 *
 * The pipeline is never called by hand. Its interval is shrunk to a few
 * milliseconds and each case waits for what a tick did, which is the same loop
 * `hercule serve` forks.
 */
import { describe, expect, it, vi } from "vitest";
import { createProfile, at, until, WAIT_DEADLINE_MS } from "../sessions/testing";
import {
  BURST,
  buildPayload,
  caughtUp,
  emitted,
  KIND,
  matchedInputRows,
  REF,
  rowsWhen,
  runEffect,
  storeCondition,
  subscribed,
  spawnSubscriber,
  readCursorAndHead,
  withPipeline,
} from "./testing";

/** A fleet, three sessions and several ticks fit inside this. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("the event pipeline's tick", () => {
  it("writes one matched input for a matched subscription, and walks its cursor past the event", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);

      const eventId = await emitted(arranged, [REF], "The lid does not close");

      const rows = await rowsWhen(arranged.harness, subscriptionId, (found) => found.length >= 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe("subscription");
      expect(rows[0]!.event_id).toBe(eventId);
      expect(rows[0]!.session).toBe(agent.session.id.replaceAll("-", ""));
      // The text is pinned in `routing/render-event-input.test.ts`; what
      // matters here is that the row carries the rendering, not the envelope.
      expect(rows[0]!.text).toContain(KIND);
      expect(rows[0]!.text).toContain("The lid does not close");
      expect(rows[0]!.text).toContain("```json");

      // The cursor ends at the event, which is the end of the log: it is read
      // against the head rather than against the id alone, so an entry
      // appended by anything else in the meantime is not read as a defect.
      const position = await caughtUp(arranged.harness);
      expect(position).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("walks a burst wider than one batch to the end of the log, rather than one batch a tick", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "burst-holder");
      const subscriptionId = await subscribed(arranged, agent, REF);
      await caughtUp(arranged.harness);

      // Two and a half batches, appended in one statement so the router finds
      // them all waiting rather than a few per pass as they arrive. They are
      // written to the table because `event.emit` is one call per event, and
      // the router would walk the early ones while the later ones were still
      // being posted.
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

      const rows = await rowsWhen(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= BURST,
      );
      expect(rows).toHaveLength(BURST);
      const seen = await readCursorAndHead(arranged.harness);
      expect(seen.position).toBe(seen.head);
    });
  });

  it("writes nothing a second time, however often the cursor is rewound over the same events", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      const eventId = await emitted(arranged, [REF], "The lid does not close");
      await rowsWhen(arranged.harness, subscriptionId, (found) => found.length >= 1);
      const settled = await caughtUp(arranged.harness);

      // The crash between the commit of the matched inputs and the advance of
      // the cursor, three times over.
      for (let pass = 0; pass < 3; pass++) {
        await runEffect(
          arranged.harness.sql`UPDATE event_cursors SET position = ${eventId - 1}
                               WHERE consumer = 'router'`,
        );
        await until("walked the log again", async () => {
          const seen = await readCursorAndHead(arranged.harness);
          return seen.position !== null && seen.position >= settled ? seen.position : undefined;
        });
        const rows = await matchedInputRows(arranged.harness, subscriptionId);
        expect(rows, `pass ${String(pass)}`).toHaveLength(1);
        expect(rows[0]!.event_id).toBe(eventId);
      }

      expect(await caughtUp(arranged.harness)).toBeGreaterThanOrEqual(settled);
    });
  });

  it("writes no matched input for an audit entry, whatever a subscription's condition says, and passes it", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      // A condition that admits everything, so a row that is not written is
      // the population's doing and not the condition's.
      await storeCondition(arranged.harness, subscriptionId, "true");

      // Creating a profile appends `profile.created`, which is an audit entry.
      await createProfile(arranged, "leaves-an-entry", ["event.read"]);
      const entries = await runEffect(
        arranged.harness.sql<{
          readonly id: number;
        }>`SELECT id FROM events WHERE kind = 'profile.created' ORDER BY id DESC LIMIT 1`,
      );
      const entryId = entries[0]!.id;

      await until("walked past the audit entry", async () => {
        const seen = await readCursorAndHead(arranged.harness);
        return seen.position !== null && seen.position >= entryId ? seen.position : undefined;
      });
      expect(await matchedInputRows(arranged.harness, subscriptionId)).toEqual([]);

      // The same subscription does get a row for a pipeline event, so the
      // silence above is about the population and not about a dead router.
      const eventId = await emitted(arranged, [REF], "The lid does not close");
      const rows = await rowsWhen(arranged.harness, subscriptionId, (found) => found.length >= 1);
      expect(rows.map((row) => row.event_id)).toEqual([eventId]);
    });
  });
});
