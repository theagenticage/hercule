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
import { at, until, WAIT_DEADLINE_MS, type Agent, type Arranged } from "../sessions/testing";
import {
  buildRecordingNotifier,
  emitted,
  healthWhen,
  OTHER_REF,
  readCursorAndHead,
  readHealth,
  REF,
  run,
  storeCondition,
  subscribed,
  subscriber,
  subscriptionRow,
  UNRESOLVABLE,
  withPipeline,
  type Health,
  type Notified,
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

const inputRow = async (harness: ServerHarness, id: string): Promise<InputRow> => {
  const rows = await run(
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
): Promise<{ readonly agent: Agent; readonly subscriptionId: string; readonly health: Health }> => {
  const agent = await subscriber(arranged, name);
  const subscriptionId = await subscribed(arranged, agent, REF);
  expect((await readHealth(arranged, agent, subscriptionId)).state).toBe("ok");

  // A row that went out and was never answered: the machine may or may not
  // have taken it, and the controller stopped before it found out.
  await run(
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

  const health = await healthWhen(arranged, agent, subscriptionId, (one) => one.state === "error");
  expect(health.kind).toBe("lost-wake-up");
  return { agent, subscriptionId, health };
};

/** Waits until the router has walked past this entry, whatever it did with it. */
const walkedPast = (arranged: Arranged, eventId: number): Promise<number> =>
  until("walked past the event", async () => {
    const seen = await readCursorAndHead(arranged.harness);
    return seen.position !== null && seen.position >= eventId ? seen.position : undefined;
  });

describe("an input a restart caught on the wire", () => {
  it("is cancelled, and the wake-up lost with it is shown on its subscription", async () => {
    await withPipeline(async (arranged) => {
      // A row a person typed was on the wire too. It names no subscription, so
      // it is cancelled like any other and says nothing about a wake-up.
      const agent = await subscriber(arranged, "typist");
      await run(
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
        const row = await inputRow(arranged.harness, id);
        expect(row.status, id).toBe("cancelled");
        expect(row.sent_at, id).toBeNull();
        expect(row.reason ?? "", id).toContain("restarted");
      }

      expect(lost.health.message ?? "").toContain(String(EVENT_ID));
      expect(lost.health.message ?? "").toContain("will not be delivered again");
      expect(lost.health.at ?? "").not.toBe("");

      // An event this subscription does not wait for evaluates cleanly and
      // leaves the error where it is. A lost wake-up is about one event that
      // is gone, which no later evaluation can say anything about.
      await walkedPast(arranged, await emitted(arranged, [OTHER_REF], "for somebody else"));
      expect(await readHealth(arranged, lost.agent, lost.subscriptionId)).toEqual(lost.health);

      // A wake-up that does arrive is what makes the message out of date.
      await emitted(arranged, [REF], "the next one");
      await healthWhen(arranged, lost.agent, lost.subscriptionId, (one) => one.state === "ok");
    });
  });

  it("hands the health to an evaluation error, which is the error the holder must act on", async () => {
    const calls: Array<Notified> = [];
    await withPipeline(
      async (arranged) => {
        const lost = await withALostWakeUp(arranged, "wake-up-holder");
        const health = (): Promise<Health> => readHealth(arranged, lost.agent, lost.subscriptionId);

        // A condition that evaluates cleanly and matches nothing says nothing
        // about the event that was lost, and leaves the message alone.
        await storeCondition(arranged.harness, lost.subscriptionId, "false");
        await walkedPast(arranged, await emitted(arranged, [REF], "a clean no-match"));
        expect(await health()).toEqual(lost.health);

        // A condition that cannot be evaluated takes the health over: a
        // subscription that can wake nobody at all is what the holder must
        // repair first, and the report of it has to go out.
        await storeCondition(arranged.harness, lost.subscriptionId, UNRESOLVABLE);
        await emitted(arranged, [REF], "cannot be evaluated");
        const failed = await healthWhen(
          arranged,
          lost.agent,
          lost.subscriptionId,
          (one) => one.kind === "evaluation",
        );
        expect(failed.message).not.toBe(lost.health.message);
        await until("reported the evaluation error", () =>
          calls.some((call) => call.subscriptionId === lost.subscriptionId) ? calls : undefined,
        );

        // The condition works again and matches, which ends both errors: the
        // clean evaluation ends the first and the wake-up written ends what is
        // left of the second.
        await storeCondition(arranged.harness, lost.subscriptionId, "true");
        await emitted(arranged, [REF], "the next one");
        await healthWhen(arranged, lost.agent, lost.subscriptionId, (one) => one.state === "ok");
      },
      { evaluationErrorNotifier: buildRecordingNotifier(calls) },
    );
  });

  it("says nothing on a subscription that has ended: there is no holder left to tell", async () => {
    await withPipeline(async (arranged) => {
      const agent = await subscriber(arranged, "gone-holder");
      const subscriptionId = await subscribed(arranged, agent, REF);
      const cancelled = await del(
        arranged.harness.base,
        `/api/v1/subscriptions/${subscriptionId}`,
        agent.token,
      );
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);

      await run(
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

      expect((await inputRow(arranged.harness, WAKE_UP_INPUT_ID)).status).toBe("cancelled");
      const row = await subscriptionRow(arranged.harness, subscriptionId);
      expect(row?.ended_at).not.toBeNull();
      expect(row?.health_error_kind).toBeNull();
      expect(row?.health_error_message).toBeNull();
    });
  });
});
