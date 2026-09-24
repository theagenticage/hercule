/**
 * Tests that enrichment routes an event again: a ref added after the router
 * read an event makes that event reach the route that was waiting for it.
 *
 * Routing again writes rows but sends nothing, so each test waits for the
 * tick that delivers them, as it would for any other match.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration } from "effect";
import { post } from "../http/testing";
import { readSession, WAIT_DEADLINE_MS } from "../sessions/testing";
import {
  waitUntilCaughtUp,
  emitManualEvent,
  exitSession,
  waitForFrameCarrying,
  readMatchedInputRows,
  OTHER_REF,
  readCursorAndHead,
  REF,
  waitForMatchedInputRows,
  spawnStrandedAgent,
  subscribeAgent,
  spawnSubscriber,
  readSubscriptionRow,
  withPipeline,
} from "./testing";

/**
 * Longer than any test here runs, so the pipeline never ticks, and the test
 * sees only what the enrichment itself did.
 */
const NO_TICK = Duration.hours(1);

/** Long enough for a fleet, three sessions and several ticks. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("routing an event again after enrichment", () => {
  it("writes a row for the subscription the added ref now matches, and for nothing else", async () => {
    await withPipeline(async (arranged) => {
      const first = await spawnSubscriber(arranged, "first-holder");
      const second = await spawnSubscriber(arranged, "second-holder");
      const early = await subscribeAgent(arranged, first, REF);
      const eventId = await emitManualEvent(arranged, [REF], "the first match");
      await waitForMatchedInputRows(arranged.harness, early, (rows) => rows.length >= 1);
      const before = await waitUntilCaughtUp(arranged.harness);

      // The second subscription is created after the event was matched, so
      // nothing it could match on has happened yet.
      const late = await subscribeAgent(arranged, second, OTHER_REF);
      expect(await readMatchedInputRows(arranged.harness, late)).toEqual([]);

      const response = await post(
        arranged.harness.base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { url: "https://github.com/o/r/pull/88", refs: [OTHER_REF] },
        arranged.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);

      const rows = await waitForMatchedInputRows(
        arranged.harness,
        late,
        (found) => found.length >= 1,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_id).toBe(eventId);
      // The row's text comes from the amended event, not from the event as it
      // was first stored.
      expect(rows[0]!.text).toContain("https://github.com/o/r/pull/88");
      // The subscription that already matched gets nothing a second time.
      expect(await readMatchedInputRows(arranged.harness, early)).toHaveLength(1);
      // Routing again is not a step through the log, so the cursor is never
      // moved back. It can move forward: the enrichment's audit entry is one
      // more event for the next pass to read.
      expect((await readCursorAndHead(arranged.harness)).position).toBeGreaterThanOrEqual(before);

      // An enrichment that adds nothing writes nothing.
      const again = await post(
        arranged.harness.base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { refs: [OTHER_REF] },
        arranged.token,
      );
      expect(again.status, await again.clone().text()).toBe(200);
      expect(await readMatchedInputRows(arranged.harness, late)).toHaveLength(1);
      expect(await readMatchedInputRows(arranged.harness, early)).toHaveLength(1);
      expect((await readCursorAndHead(arranged.harness)).position).toBeGreaterThanOrEqual(before);
    });
  });

  it("delivers the new row to an idle session on the tick after the enrichment", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "late-holder");
      const eventId = await emitManualEvent(arranged, [REF], "enriched into a match");
      await waitUntilCaughtUp(arranged.harness);

      // The subscription waits for a ref the event does not have yet, so the
      // pass that read the event matched nothing.
      const subscriptionId = await subscribeAgent(arranged, agent, OTHER_REF);
      expect((await readSession(arranged, agent.session.id)).status).toBe("idle");

      const response = await post(
        arranged.harness.base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { refs: [OTHER_REF] },
        arranged.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);

      // Nothing was sent on the request's fiber: a later tick of the pipeline
      // sends the frame.
      const frame = await waitForFrameCarrying(arranged, "enriched into a match");
      expect(frame.sessionId).toBe(agent.session.id);
      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found[0]?.status === "delivered",
      );
      expect(rows).toHaveLength(1);
    });
  });
  it("wakes no holder that has ended for good, and ends the subscription instead", async () => {
    await withPipeline(
      async (arranged) => {
        const holder = await spawnStrandedAgent(arranged, "gone-holder");
        const subscriptionId = await subscribeAgent(arranged, holder, OTHER_REF);
        const eventId = await emitManualEvent(arranged, [REF], "for a holder that is gone");
        await exitSession(arranged, holder, 1);
        expect((await readSession(arranged, holder.session.id)).resumable).toBe(false);

        // The ref this subscription waits for is added to the event. Routing
        // again prepares the table as a pass does, including the sweep, so the
        // subscription without a holder is ended instead of matched.
        const response = await post(
          arranged.harness.base,
          `/api/v1/events/${String(eventId)}/enrich`,
          { refs: [OTHER_REF] },
          arranged.token,
        );
        expect(response.status, await response.clone().text()).toBe(200);

        expect(await readMatchedInputRows(arranged.harness, subscriptionId)).toEqual([]);
        const row = await readSubscriptionRow(arranged.harness, subscriptionId);
        expect(row?.ended_at).not.toBeNull();
        expect(row?.ended_reason ?? "").toContain(holder.session.id);
        expect(row?.ended_actor).toBe("system");
      },
      { eventRoutingInterval: NO_TICK },
    );
  });
});
