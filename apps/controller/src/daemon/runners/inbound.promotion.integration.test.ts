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
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SessionStart } from "@hercule/protocol";
import type { Session } from "@hercule/contract";
import { buildHomePaths } from "@hercule/home";
import { openDatabase, uuidFromString } from "../../db";
import { send } from "../../http/testing";
import { decodePromotionToken } from "../../promotion/crypto";
import { SWITCH_PATH } from "../../promotion/exchange";
import { receiveTransfer } from "../../promotion/receive";
import { createPromotionToken, requestTransfer } from "../../promotion/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  readSession,
  reportEvent,
  spawnSessionOrFail,
  waitForSession,
  waitForStartFrames,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../../sessions/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.length = 0;
});

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

/** Spends a new promotion token with a transfer, which freezes the controller, and returns the token. */
const freeze = async (arranged: Arranged): Promise<string> => {
  const promotionToken = await createPromotionToken(arranged.harness.base, arranged.token);
  const response = await requestTransfer(arranged.harness.base, promotionToken);
  expect(response.status).toBe(200);
  // Read to the end: a transfer stream that breaks off ends the freeze.
  await response.arrayBuffer();
  return promotionToken;
};

/** Reports that the session's process exited, as the session's first event. */
const reportExited = (arranged: Arranged, sessionId: string): void =>
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId,
    at,
    _tag: "session.exited",
    reason: "process_exit",
  });

/** Returns a session's status as the database holds it, for a controller that answers no request. */
const readStatusFromDatabase = async (arranged: Arranged, sessionId: string): Promise<string> => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<{ status: string }>`
        SELECT status FROM sessions WHERE id = ${uuidFromString(sessionId)}
      `,
    ),
  );
  return rows[0]!.status;
};

/** Returns the start frames the runner received for the session. */
const listStartFrames = (arranged: Arranged, sessionId: string): ReadonlyArray<SessionStart> =>
  listFrames<SessionStart>(arranged.wire, "sessionStart").filter(
    (frame) => frame.sessionId === sessionId,
  );

describe("session traffic during a promotion", () => {
  it("holds a session's exit while frozen, and starts the queued session once the transfer is cancelled", async () => {
    await withAgentFleet(async (arranged) => {
      const { running, queued } = await queueBehindOneSession(arranged);
      const promotionToken = await freeze(arranged);

      reportExited(arranged, running.id);
      await delay(200);
      // Reading still works while frozen.
      expect((await readSession(arranged, running.id)).status).not.toBe("exited");
      expect((await readSession(arranged, queued.id)).status).toBe("queued");
      expect(listStartFrames(arranged, queued.id)).toEqual([]);

      const cancelled = await requestTransfer(arranged.harness.base, promotionToken, "DELETE");
      expect(cancelled.status).toBe(204);
      await waitForSession(arranged, running.id, (one) => one.status === "exited");
      await waitForStartFrames(arranged, queued.id, 1);
    });
  });

  it("never records the exit or starts the queued session on a sealed controller", async () => {
    await withAgentFleet(async (arranged) => {
      const { running, queued } = await queueBehindOneSession(arranged);
      const promotionToken = await freeze(arranged);
      const switched = await fetch(`${arranged.harness.base}${SWITCH_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${promotionToken}`,
          "content-type": "application/json",
          connection: "close",
        },
        body: JSON.stringify({ newAddress: "http://hercule.example:9" }),
      });
      expect(switched.status).toBe(200);

      reportExited(arranged, running.id);
      await delay(200);
      // A sealed controller answers no request, so the sessions are read from its database.
      expect(await readStatusFromDatabase(arranged, running.id)).not.toBe("exited");
      expect(await readStatusFromDatabase(arranged, queued.id)).toBe("queued");
      expect(listStartFrames(arranged, queued.id)).toEqual([]);
    });
  });

  it("leaves a session event reported after the copy off B's transcript", async () => {
    await withAgentFleet(async (arranged) => {
      const session = await spawnSessionOrFail(arranged, { prompt: "keep" });
      await waitForStartFrames(arranged, session.id, 1);

      const keptEventId = crypto.randomUUID();
      reportEvent(arranged.wire, 1, {
        eventId: keptEventId,
        sessionId: session.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "native-1" },
      });
      await waitUntil("recorded the pre-copy event", async () => {
        const rows = await Effect.runPromise(
          Effect.orDie(
            arranged.harness.sql<{ readonly event: string }>`
              SELECT event FROM session_stream WHERE session_id = ${uuidFromString(session.id)}
            `,
          ),
        );
        return rows.some((row) => row.event.includes(keptEventId)) ? true : undefined;
      });

      const promotionToken = await createPromotionToken(arranged.harness.base, arranged.token);
      const preview = (await (
        await requestTransfer(arranged.harness.base, promotionToken, "GET")
      ).json()) as { controllerId: string };
      const response = await requestTransfer(arranged.harness.base, promotionToken);
      expect(response.status).toBe(200);
      const dir = mkdtempSync(join(tmpdir(), "hercule-promote-download-"));
      homes.push(dir);
      const transferFile = join(dir, "transfer");
      await Bun.write(transferFile, response);

      const lostEventId = crypto.randomUUID();
      reportEvent(arranged.wire, 2, {
        eventId: lostEventId,
        sessionId: session.id,
        at,
        _tag: "turn.started",
        turnId: "t2",
      });
      await delay(200);

      const home = mkdtempSync(join(tmpdir(), "hercule-promote-recv-"));
      homes.push(home);
      const paths = buildHomePaths(home, join(home, "data"));
      const tokenBytes = decodePromotionToken(promotionToken);
      if (tokenBytes === undefined) throw new Error("not a promotion token");
      await Effect.runPromise(
        receiveTransfer(paths, tokenBytes, preview.controllerId, transferFile, "file"),
      );

      const found = await Effect.runPromise(
        Effect.orDie(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{ readonly event: string }>`
              SELECT event FROM session_stream WHERE session_id = ${uuidFromString(session.id)}
            `;
          }),
        ).pipe(Effect.provide(openDatabase(paths.databaseFile))),
      );
      const ids = found.map((row) => (JSON.parse(row.event) as { eventId: string }).eventId);
      expect(ids).toContain(keptEventId);
      expect(ids).not.toContain(lostEventId);
    });
  });
});
