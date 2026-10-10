/**
 * Integration tests for a runner's session traffic while a promotion moves
 * the controller's data, over the runner socket against a real controller and
 * one fake runner.
 *
 * The runner is capped at one session. One session holds the slot and a
 * second one waits in the queue. The test spends a promotion token, which
 * freezes the controller, and then the runner reports that the first session
 * exited. The new machine's copy of the data was taken with the second
 * session still queued, and it starts that session itself once the runner
 * connects to it. So the frozen controller must not record the exit, and must
 * not start the queued session: it would start twice.
 *
 * The cost is a known loss: an event the runner reports between the copy and
 * its reconnect to the new machine is on neither machine. A test asserts it.
 *
 * A test knows the exit has reached the controller when the exit waits at the
 * promotion gate. Work that waits there has not run, so the checks that
 * follow cannot pass only because the exit had not arrived yet.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SessionStart } from "@hercule/protocol";
import type { Session } from "@hercule/contract";
import { buildHomePaths, type HomePaths } from "@hercule/home";
import { openDatabase, uuidFromString } from "../../db";
import { send } from "../../http/testing";
import {
  awaitHeldWork,
  freezeController,
  pullTransfer,
  receiveTransferIntoHome,
  requestTransfer,
  sealController,
  QUIET_LOOP_TIMINGS,
} from "../../promotion/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  readSession,
  reportEvent,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  withAgentFleet,
  type Arranged,
} from "../../sessions/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/**
 * Caps the runner at one session, starts a session that takes the slot, and
 * queues a second one behind it. Returns both.
 */
const queueBehindOneSession = async (
  arranged: Arranged,
): Promise<{ running: Session; queued: Session }> => {
  const capped = await send(
    "PATCH",
    arranged.harness.base,
    `/api/v1/runners/${arranged.runnerId}`,
    {
      body: { maxConcurrentSessions: 1 },
      token: arranged.token,
    },
  );
  expect(capped.status, await capped.clone().text()).toBe(200);
  const running = await spawnSessionOrFail(arranged, { prompt: "take the slot" });
  await waitForStartFrames(arranged, running.id, 1);
  const queued = await spawnSessionOrFail(arranged, { prompt: "wait" });
  expect(queued.status).toBe("queued");
  return { running, queued };
};

/**
 * Reports that the session's process exited, as the session's first event,
 * and returns the event's id.
 */
const reportExited = (arranged: Arranged, sessionId: string): string => {
  const eventId = crypto.randomUUID();
  reportEvent(arranged.wire, 1, {
    eventId,
    sessionId,
    at,
    _tag: "session.exited",
    reason: "process_exit",
  });
  return eventId;
};

/** Returns a session's status as the database holds it. */
const readStatus = (sql: SqlClient.SqlClient, sessionId: string) =>
  Effect.map(
    sql<{ status: string }>`SELECT status FROM sessions WHERE id = ${uuidFromString(sessionId)}`,
    (rows) => rows[0]!.status,
  );

/** Checks whether the session's stream holds the event with id `eventId`. */
const isEventOnStream = (sql: SqlClient.SqlClient, sessionId: string, eventId: string) =>
  Effect.map(
    sql`
      SELECT 1 FROM session_stream
      WHERE session_id = ${uuidFromString(sessionId)}
        AND json_extract(event, '$.eventId') = ${eventId}
    `,
    (rows) => rows.length > 0,
  );

/** Returns a session's status as the database holds it, for a controller that answers no request. */
const readStatusFromDatabase = (arranged: Arranged, sessionId: string): Promise<string> =>
  Effect.runPromise(Effect.orDie(readStatus(arranged.harness.sql, sessionId)));

/**
 * Returns the session's status and whether its stream holds the event, read
 * from the database of the Home at `paths`.
 */
const readSessionFromHome = (
  paths: HomePaths,
  sessionId: string,
  eventId: string,
): Promise<{ status: string; hasEvent: boolean }> =>
  Effect.runPromise(
    Effect.orDie(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          status: yield* readStatus(sql, sessionId),
          hasEvent: yield* isEventOnStream(sql, sessionId, eventId),
        };
      }).pipe(Effect.provide(openDatabase(paths.databaseFile))),
    ),
  );

/**
 * Waits until the work held while the controller was frozen is held again
 * after the seal, and never runs. Frozen work that sees the seal stops being
 * held for a moment and then waits at the gate for good, so the held count
 * drops to zero and comes back to one. Waiting for the count to read one is
 * not enough: a read before the held work saw the seal also reads one.
 *
 * Call it before the seal: it subscribes to the gate at once, and the seal
 * must not happen before that.
 */
const awaitHeldAgainAfterSeal = (arranged: Arranged): Promise<unknown> =>
  Effect.runPromise(
    arranged.harness.promotion.gateChanges.pipe(
      Stream.filter((state) => state.phase._tag === "Sealed"),
      Stream.dropWhile((state) => state.held !== 0),
      Stream.filter((state) => state.held === 1),
      Stream.runHead,
    ),
  );

/** Returns the start frames the runner received for the session. */
const listStartFrames = (arranged: Arranged, sessionId: string): ReadonlyArray<SessionStart> =>
  listFrames<SessionStart>(arranged.wire, "sessionStart").filter(
    (frame) => frame.sessionId === sessionId,
  );

describe("session traffic during a promotion", () => {
  it("holds a session's exit while frozen, and starts the queued session once the transfer is cancelled", async () => {
    await withAgentFleet(async (arranged) => {
      const { running, queued } = await queueBehindOneSession(arranged);
      const promotionToken = await freezeController(arranged.harness.base, arranged.token);

      reportExited(arranged, running.id);
      await Effect.runPromise(awaitHeldWork(arranged.harness.promotion, 1));
      // Reading still works while frozen.
      expect((await readSession(arranged, running.id)).status).not.toBe("exited");
      expect((await readSession(arranged, queued.id)).status).toBe("queued");
      expect(listStartFrames(arranged, queued.id)).toEqual([]);

      const cancelled = await requestTransfer(arranged.harness.base, promotionToken, "DELETE");
      expect(cancelled.status).toBe(204);
      await waitForSession(arranged, running.id, (one) => one.status === "exited");
      await waitForStartFrames(arranged, queued.id, 1);
    }, QUIET_LOOP_TIMINGS);
  });

  it("never records the exit or starts the queued session on a sealed controller", async () => {
    await withAgentFleet(async (arranged) => {
      const { running, queued } = await queueBehindOneSession(arranged);
      const promotionToken = await freezeController(arranged.harness.base, arranged.token);
      await sealController(arranged.harness.base, promotionToken);

      reportExited(arranged, running.id);
      await Effect.runPromise(awaitHeldWork(arranged.harness.promotion, 1));
      // A sealed controller answers no request, so the sessions are read from its database.
      expect(await readStatusFromDatabase(arranged, running.id)).not.toBe("exited");
      expect(await readStatusFromDatabase(arranged, queued.id)).toBe("queued");
      expect(listStartFrames(arranged, queued.id)).toEqual([]);
    }, QUIET_LOOP_TIMINGS);
  });

  it("loses a session event the runner reports between the copy and the switch: it is on neither machine", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "hercule-promote-loss-"));
    try {
      await withAgentFleet(async (arranged) => {
        const session = await spawnSessionOrFail(arranged, { prompt: "run" });
        await waitForStartFrames(arranged, session.id, 1);
        const transferFile = join(scratch, "transfer");
        const { promotionToken, controllerId } = await pullTransfer(
          arranged.harness.base,
          arranged.token,
          transferFile,
        );

        const eventId = reportExited(arranged, session.id);
        await Effect.runPromise(awaitHeldWork(arranged.harness.promotion, 1));
        const heldAgain = awaitHeldAgainAfterSeal(arranged);
        await sealController(arranged.harness.base, promotionToken);
        // The seal does not write the held event: the event goes on waiting
        // at the gate, now for good.
        await heldAgain;
        const onA = await Effect.runPromise(
          Effect.orDie(isEventOnStream(arranged.harness.sql, session.id, eventId)),
        );
        expect(onA).toBe(false);
        expect(await readStatusFromDatabase(arranged, session.id)).not.toBe("exited");

        const homeB = join(scratch, "b");
        mkdirSync(homeB);
        const pathsB = buildHomePaths(homeB, join(homeB, "data"));
        await receiveTransferIntoHome(pathsB, promotionToken, controllerId, transferFile);
        const onB = await readSessionFromHome(pathsB, session.id, eventId);
        expect(onB.hasEvent).toBe(false);
        expect(onB.status).not.toBe("exited");
      }, QUIET_LOOP_TIMINGS);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
