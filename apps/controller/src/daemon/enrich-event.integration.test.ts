/**
 * Enrichment's second look: a ref added after the router walked past an event
 * makes that one event reach the route that was waiting for it.
 *
 * The second look writes rows and sends nothing, so each case waits for the
 * tick that delivers them, as it would for any other match.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration } from "effect";
import { post } from "../http/testing";
import { readSession, WAIT_DEADLINE_MS } from "../sessions/testing";
import {
  caughtUp,
  emitted,
  exit,
  frameWhen,
  matchedInputRows,
  OTHER_REF,
  readCursorAndHead,
  REF,
  rowsWhen,
  stranded,
  subscribed,
  subscriber,
  subscriptionRow,
  withPipeline,
} from "./testing";

/**
 * Longer than any case here runs, so the pipeline never ticks: what the case
 * then sees is the enrichment's own second look and nothing else.
 */
const NO_TICK = Duration.hours(1);

/** A fleet, three sessions and several ticks fit inside this. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("enrichment's second look", () => {
  it("writes a row for the subscription the added ref now matches, and for nothing else", async () => {
    await withPipeline(async (arranged) => {
      const first = await subscriber(arranged, "first-holder");
      const second = await subscriber(arranged, "second-holder");
      const early = await subscribed(arranged, first, REF);
      const eventId = await emitted(arranged, [REF], "the first match");
      await rowsWhen(arranged.harness, early, (rows) => rows.length >= 1);
      const before = await caughtUp(arranged.harness);

      // The second subscription is created after the event was matched, so
      // nothing it could match on has happened yet.
      const late = await subscribed(arranged, second, OTHER_REF);
      expect(await matchedInputRows(arranged.harness, late)).toEqual([]);

      const response = await post(
        arranged.harness.base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { url: "https://github.com/o/r/pull/88", refs: [OTHER_REF] },
        arranged.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);

      const rows = await rowsWhen(arranged.harness, late, (found) => found.length >= 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_id).toBe(eventId);
      // The row reads the amended envelope, not the one that was stored when
      // the event first arrived.
      expect(rows[0]!.text).toContain("https://github.com/o/r/pull/88");
      // The subscription that already matched gets nothing a second time.
      expect(await matchedInputRows(arranged.harness, early)).toHaveLength(1);
      // The second look is not a step through the log, so the cursor is never
      // put back to read the event again. It does move on: the audit entry the
      // enrichment stamped is one more entry for the next pass to walk past.
      expect((await readCursorAndHead(arranged.harness)).position).toBeGreaterThanOrEqual(before);

      // An enrichment that adds nothing writes nothing.
      const again = await post(
        arranged.harness.base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { refs: [OTHER_REF] },
        arranged.token,
      );
      expect(again.status, await again.clone().text()).toBe(200);
      expect(await matchedInputRows(arranged.harness, late)).toHaveLength(1);
      expect(await matchedInputRows(arranged.harness, early)).toHaveLength(1);
      expect((await readCursorAndHead(arranged.harness)).position).toBeGreaterThanOrEqual(before);
    });
  });

  it("gets the row it wrote to an idle session, on the pass after the enrichment", async () => {
    await withPipeline(async (arranged) => {
      const agent = await subscriber(arranged, "late-holder");
      const eventId = await emitted(arranged, [REF], "enriched into a match");
      await caughtUp(arranged.harness);

      // The subscription waits for a ref the event does not carry yet, so the
      // pass that walked past the event matched nothing.
      const subscriptionId = await subscribed(arranged, agent, OTHER_REF);
      expect((await readSession(arranged, agent.session.id)).status).toBe("idle");

      const response = await post(
        arranged.harness.base,
        `/api/v1/events/${String(eventId)}/enrich`,
        { refs: [OTHER_REF] },
        arranged.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);

      // Nothing was sent on the request's own fiber: the frame crosses the
      // socket because a later tick of the pipeline sent it.
      const frame = await frameWhen(arranged, "enriched into a match");
      expect(frame.sessionId).toBe(agent.session.id);
      const rows = await rowsWhen(
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
        const holder = await stranded(arranged, "gone-holder");
        const subscriptionId = await subscribed(arranged, holder, OTHER_REF);
        const eventId = await emitted(arranged, [REF], "for a holder that is gone");
        await exit(arranged, holder, 1);
        expect((await readSession(arranged, holder.session.id)).resumable).toBe(false);

        // The ref this subscription waits for is added to the event. The
        // second look prepares the table as a pass does, sweep and all, so the
        // claim nobody is left to answer is ended rather than answered.
        const response = await post(
          arranged.harness.base,
          `/api/v1/events/${String(eventId)}/enrich`,
          { refs: [OTHER_REF] },
          arranged.token,
        );
        expect(response.status, await response.clone().text()).toBe(200);

        expect(await matchedInputRows(arranged.harness, subscriptionId)).toEqual([]);
        const row = await subscriptionRow(arranged.harness, subscriptionId);
        expect(row?.ended_at).not.toBeNull();
        expect(row?.ended_reason ?? "").toContain(holder.session.id);
        expect(row?.ended_actor).toBe("system");
      },
      { eventRoutingInterval: NO_TICK },
    );
  });
});
