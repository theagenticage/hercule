/**
 * The boot step over the sessions and the subscriptions: what a restart does
 * to an input that was on the wire, and what it says about the wake-up that
 * was on it.
 *
 * A wake-up cancelled here is lost for good - the pair of subscription and
 * event may be written only once - so the case reads the subscription back
 * through the operation a holder calls, which is where a holder would find out.
 */
import { describe, expect, it, vi } from "vitest";
import { del, type ServerHarness } from "../http/testing";
import { at, waitUntil, WAIT_DEADLINE_MS, type Agent, type Arranged } from "../sessions/testing";
import {
  buildRecordingNotifier,
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
  type Notified,
  type ReadSubscription,
} from "./testing";

/** A fleet, a session and a reboot fit inside this. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 20_000 });

/**
 * The ids of the rows the cases write by hand. Canonical v7, because that is
 * the only shape the store reads back.
 */
const WAKE_UP_INPUT_ID = "0199f0b7-0000-7000-8000-000000000001";
const TYPED_INPUT_ID = "0199f0b7-0000-7000-8000-000000000002";

/** The position of an event that is named by the row and by nothing else. */
const EVENT_ID = 4242;

/** One input row, read back the way only the table can answer it. */
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

/** A subscription whose one wake-up a restart cancelled, and its holder. */
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

  // A row that went out and was never answered: the machine may or may not
  // have taken it, and the controller stopped before it found out.
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

/** Waits until the router has walked past this entry, whatever it did with it. */
const waitForCursorPast = (arranged: Arranged, eventId: number): Promise<number> =>
  waitUntil("walked past the event", async () => {
    const seen = await readCursorAndHead(arranged.harness);
    return seen.position !== null && seen.position >= eventId ? seen.position : undefined;
  });

describe("an input a restart caught on the wire", () => {
  it("is cancelled, and the wake-up lost with it is shown on its subscription", async () => {
    await withPipeline(async (arranged) => {
      // A row a person typed was on the wire too. It names no subscription, so
      // it is cancelled like any other and says nothing about a wake-up.
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

      // The lost wake-up is its own fact: it names the event nothing will
      // deliver again, and the condition itself is still evaluable.
      expect(lost.subscription.lostWakeUp!.at).not.toBe("");
      expect(lost.subscription.health).toEqual({ state: "ok" });

      // An event this subscription does not wait for evaluates cleanly and
      // leaves the lost wake-up where it is. It is about one event that is
      // gone, which no later evaluation can say anything about.
      await waitForCursorPast(
        arranged,
        await emitManualEvent(arranged, [OTHER_REF], "for somebody else"),
      );
      expect(await readSubscription(arranged, lost.agent, lost.subscriptionId)).toEqual(
        lost.subscription,
      );

      // A wake-up that does arrive is what makes it out of date, and it takes
      // nothing else with it.
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

  it("keeps the lost wake-up beside an evaluation error: neither fact hides the other", async () => {
    const calls: Array<Notified> = [];
    await withPipeline(
      async (arranged) => {
        const lost = await withALostWakeUp(arranged, "wake-up-holder");

        // A condition that cannot be evaluated is the second fact, and it is
        // written where the first one is not.
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
        await waitUntil("reported the evaluation error", () =>
          calls.some((call) => call.subscriptionId === lost.subscriptionId) ? calls : undefined,
        );

        // The condition works again and matches, which ends both facts: the
        // clean evaluation ends the first and the wake-up written ends the
        // second.
        await storeCondition(arranged.harness, lost.subscriptionId, "true");
        await emitManualEvent(arranged, [REF], "the next one");
        const repaired = await waitForSubscription(
          arranged,
          lost.agent,
          lost.subscriptionId,
          (one) => one.health.state === "ok" && one.lostWakeUp === null,
        );
        expect(repaired.health).toEqual({ state: "ok" });
      },
      { evaluationErrorNotifier: buildRecordingNotifier(calls) },
    );
  });

  it("says nothing on a subscription that has ended: there is no holder left to tell", async () => {
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
