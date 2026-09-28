/**
 * Tests the boot step that cancels inputs a restart interrupted mid-delivery,
 * and records the lost wake-up on the subscription.
 *
 * A wake-up cancelled at boot is lost for good, because each pair of
 * subscription and event can be written only once. So the tests read the
 * subscription through the API a holder calls, which is where a holder would
 * find out.
 */
import { describe, expect, it, vi } from "vitest";
import { del, type ServerHarness } from "../http/testing";
import { at, waitUntil, WAIT_DEADLINE_MS, type Agent, type Arranged } from "../sessions/testing";
import {
  emitManualEvent,
  OTHER_REF,
  readCursorAndHead,
  readSubscription,
  REF,
  runEffect,
  spawnSubscriber,
  storeCondition,
  subscribeAgent,
  readSubscriptionRow,
  waitForSubscription,
  UNRESOLVABLE,
  withPipeline,
  type ReadSubscription,
} from "./testing";
import { readNotificationBodiesAbout } from "../notifications/testing";

/** Long enough for a fleet, a session and a reboot. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 20_000 });

/**
 * The ids of the input rows the tests insert directly. They must be UUID v7,
 * because the store reads back only v7 ids.
 */
const WAKE_UP_INPUT_ID = "0199f0b7-0000-7000-8000-000000000001";
const TYPED_INPUT_ID = "0199f0b7-0000-7000-8000-000000000002";

/** An event id that only the inserted row refers to. */
const EVENT_ID = 4242;

/** One input row, read straight from the table because no operation returns these fields. */
interface InputRow {
  readonly status: string;
  readonly sent_at: string | null;
  readonly reason: string | null;
}

const readInputRow = async (harness: ServerHarness, id: string): Promise<InputRow> => {
  const rows = await runEffect(
    harness.sql<InputRow>`
      SELECT status, sent_at, reason FROM session_inputs
      WHERE id = unhex(replace(${id}, '-', ''))`,
  );
  expect(rows[0], `no input ${id}`).toBeDefined();
  return rows[0]!;
};

/**
 * Creates a subscription, inserts one of its inputs as sent but unanswered,
 * and reboots the controller. Returns the holder and the subscription once
 * the subscription shows the lost wake-up.
 */
const withALostWakeUp = async (
  arranged: Arranged,
  name: string,
): Promise<{
  readonly agent: Agent;
  readonly subscriptionId: string;
  readonly subscription: ReadSubscription;
}> => {
  const agent = await spawnSubscriber(arranged, name);
  const subscriptionId = await subscribeAgent(arranged, agent, REF);
  expect((await readSubscription(arranged, agent, subscriptionId)).lostWakeUp).toBeNull();

  // A row that was sent and never answered: the runner may or may not have
  // taken it, and the controller stopped before it found out.
  await runEffect(
    arranged.harness.sql`
      INSERT INTO session_inputs
        (id, session_id, source, actor, text, status, created_at, sent_at,
         subscription_id, event_id)
      VALUES
        (unhex(replace(${WAKE_UP_INPUT_ID}, '-', '')),
         unhex(replace(${agent.session.id}, '-', '')),
         'subscription', 'system', 'on the wire', 'queued', ${at}, ${at},
         unhex(replace(${subscriptionId}, '-', '')), ${EVENT_ID})`,
  );

  await arranged.harness.reboot();

  const subscription = await waitForSubscription(
    arranged,
    agent,
    subscriptionId,
    (one) => one.lostWakeUp !== null,
  );
  expect(subscription.lostWakeUp!.eventId).toBe(EVENT_ID);
  return { agent, subscriptionId, subscription };
};

/** Waits until the router's cursor has passed this event, whether or not it matched. */
const waitForCursorPast = (arranged: Arranged, eventId: number): Promise<number> =>
  waitUntil("moved its cursor past the event", async () => {
    const seen = await readCursorAndHead(arranged.harness);
    return seen.position !== null && seen.position >= eventId ? seen.position : undefined;
  });

describe("an input that was being delivered when the controller restarted", () => {
  it("is cancelled, and the lost wake-up is shown on its subscription", async () => {
    await withPipeline(async (arranged) => {
      // A row a person typed was also being delivered. It has no subscription,
      // so it is cancelled like any other and records no lost wake-up.
      const agent = await spawnSubscriber(arranged, "typist");
      await runEffect(
        arranged.harness.sql`
          INSERT INTO session_inputs
            (id, session_id, source, actor, text, status, created_at, sent_at)
          VALUES
            (unhex(replace(${TYPED_INPUT_ID}, '-', '')),
             unhex(replace(${agent.session.id}, '-', '')),
             'user', 'user', 'typed by hand', 'queued', ${at}, ${at})`,
      );

      const lost = await withALostWakeUp(arranged, "wake-up-holder");

      for (const id of [WAKE_UP_INPUT_ID, TYPED_INPUT_ID]) {
        const row = await readInputRow(arranged.harness, id);
        expect(row.status, id).toBe("cancelled");
        expect(row.sent_at, id).toBeNull();
        expect(row.reason ?? "", id).toContain("restarted");
      }

      // The lost wake-up is recorded on its own: it holds the event that will
      // never be delivered, and the condition's health stays ok.
      expect(lost.subscription.lostWakeUp!.at).not.toBe("");
      expect(lost.subscription.health).toEqual({ state: "ok" });

      // An event this subscription does not wait for evaluates cleanly and
      // leaves the lost wake-up in place. The record is about one lost event,
      // and evaluating other events does not change that.
      await waitForCursorPast(
        arranged,
        await emitManualEvent(arranged, [OTHER_REF], "for somebody else"),
      );
      expect(await readSubscription(arranged, lost.agent, lost.subscriptionId)).toEqual(
        lost.subscription,
      );

      // A wake-up that does arrive clears the record, and changes nothing
      // else.
      await emitManualEvent(arranged, [REF], "the next one");
      const woken = await waitForSubscription(
        arranged,
        lost.agent,
        lost.subscriptionId,
        (one) => one.lostWakeUp === null,
      );
      expect(woken.health).toEqual({ state: "ok" });
    });
  });

  it("keeps the lost wake-up next to an evaluation error, and clears each one on its own", async () => {
    await withPipeline(async (arranged) => {
      const lost = await withALostWakeUp(arranged, "wake-up-holder");

      // A condition that fails to evaluate is recorded in the health, a
      // separate field from the lost wake-up.
      await storeCondition(arranged.harness, lost.subscriptionId, UNRESOLVABLE);
      await emitManualEvent(arranged, [REF], "cannot be evaluated");
      const failed = await waitForSubscription(
        arranged,
        lost.agent,
        lost.subscriptionId,
        (one) => one.health.state === "error",
      );
      expect(failed.lostWakeUp).toEqual(lost.subscription.lostWakeUp);
      expect(failed.health.message ?? "").not.toBe("");
      expect(
        await runEffect(
          readNotificationBodiesAbout(arranged.harness.sql, "core.subscription-condition-error", {
            kind: "subscription",
            id: lost.subscriptionId,
          }),
        ),
      ).toHaveLength(1);

      // The condition works again and matches, which clears both: the clean
      // evaluation clears the health error, and the new wake-up clears the
      // lost wake-up.
      await storeCondition(arranged.harness, lost.subscriptionId, "true");
      await emitManualEvent(arranged, [REF], "the next one");
      const repaired = await waitForSubscription(
        arranged,
        lost.agent,
        lost.subscriptionId,
        (one) => one.health.state === "ok" && one.lostWakeUp === null,
      );
      expect(repaired.health).toEqual({ state: "ok" });
    });
  });

  it("records no lost wake-up on an ended subscription, because it has no holder left", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "gone-holder");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      const cancelled = await del(
        arranged.harness.base,
        `/api/v1/subscriptions/${subscriptionId}`,
        agent.token,
      );
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);

      await runEffect(
        arranged.harness.sql`
          INSERT INTO session_inputs
            (id, session_id, source, actor, text, status, created_at, sent_at,
             subscription_id, event_id)
          VALUES
            (unhex(replace(${WAKE_UP_INPUT_ID}, '-', '')),
             unhex(replace(${agent.session.id}, '-', '')),
             'subscription', 'system', 'on the wire', 'queued', ${at}, ${at},
             unhex(replace(${subscriptionId}, '-', '')), ${EVENT_ID})`,
      );

      await arranged.harness.reboot();

      expect((await readInputRow(arranged.harness, WAKE_UP_INPUT_ID)).status).toBe("cancelled");
      const row = await readSubscriptionRow(arranged.harness, subscriptionId);
      expect(row?.ended_at).not.toBeNull();
      expect(row?.lost_wake_up_event_id).toBeNull();
      expect(row?.health_error_message).toBeNull();
    });
  });
});
