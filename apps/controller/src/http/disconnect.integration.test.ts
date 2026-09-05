/**
 * What a client hanging up mid-request does to the real controller.
 *
 * What these tests prove is the outcome, not the mechanism: a request the
 * client abandoned performs no durable write, and the controller goes on
 * serving. They deliberately do not claim that a particular fiber was
 * interrupted with a transaction open - an interrupt requested inside an
 * uninterruptible region is delivered later, so no test of this shape could
 * tell that apart from a request abandoned before its handler ran.
 *
 * Asserting the outcome against a hand-rolled router would only re-test
 * `@effect/platform-bun`, so this drives the whole stack the way anything else
 * does: the envelope, the pre-setup gate, both credential gates, the derived
 * route and the operation's own transaction behind it.
 *
 * Both cases matter and they are not the same request. An unauthenticated one
 * runs with no security middleware at all; an authenticated one has passed the
 * whole credential gate, so it is the one that shows a resolved bearer does not
 * make the abandoned write happen anyway.
 *
 * The request is parked deliberately rather than raced. SQLite has one writer
 * and `@effect/sql-sqlite-bun` puts every statement behind one connection
 * permit, so a transaction held open here stalls the request at its first
 * statement - which is where a disconnect under load lands in production too.
 */
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { withTransaction } from "../db";
import { completeSetup, get, PASSWORD, post, USERNAME, withServer } from "./testing";

/** Long enough for the parked request to reach the database and stop there. */
const PARKED_MS = 250;

/**
 * How long the test waits after tearing the socket down before it lets the
 * parked request go.
 *
 * The abort reaches the controller as an event, not as a return value: Bun
 * fires `request.signal` on a later turn of the loop than the one the FIN
 * arrives on. Releasing the database in the same turn as the teardown lets the
 * request finish before the interrupt is delivered, and the test then measures
 * that race rather than the behaviour.
 */
const DELIVERED_MS = 100;

/**
 * Sends a request over a socket of this test's own and closes it while the
 * controller is still working on it. `fetch` with an `AbortSignal` is not
 * enough for a test that has to be sure: it hands the response back to nobody,
 * and whether the connection is torn down is the client's business, not the
 * assertion's.
 */
const hangUp = (
  base: string,
  path: string,
  payload: unknown,
  token?: string,
): Promise<"closed"> => {
  const url = new URL(base);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\n` +
          `host: ${url.host}\r\n` +
          `content-type: application/json\r\n` +
          (token === undefined ? "" : `authorization: Bearer ${token}\r\n`) +
          `content-length: ${String(Buffer.byteLength(body))}\r\n` +
          `\r\n${body}`,
      );
      setTimeout(() => {
        socket.destroy();
        setTimeout(() => resolve("closed"), DELIVERED_MS);
      }, PARKED_MS);
    });
    socket.on("error", reject);
  });
};

/**
 * Holds the one write connection open and hands back the release. Anything the
 * controller does against the database in the meantime stalls where it stands.
 */
const parkTheDatabase = async (
  sql: SqlClient.SqlClient,
): Promise<{ readonly release: () => Promise<void> }> => {
  const parked = Promise.withResolvers<void>();
  const letGo = Promise.withResolvers<void>();
  const holder = Effect.runPromise(
    withTransaction(
      sql,
      Effect.gen(function* () {
        yield* sql`SELECT 1`;
        parked.resolve();
        yield* Effect.promise(() => letGo.promise);
      }),
    ),
  );
  await parked.promise;
  return {
    release: async () => {
      letGo.resolve();
      await holder;
    },
  };
};

/** Parks the write connection for the body, and always lets it go again. */
const withParkedDatabase = async (
  sql: SqlClient.SqlClient,
  body: () => Promise<void>,
): Promise<void> => {
  const held = await parkTheDatabase(sql);
  try {
    await body();
  } finally {
    await held.release();
  }
};

describe("a client that hangs up", () => {
  it("leaves no login token, no audit row and a controller that keeps serving", async () => {
    await withServer(async ({ base, audit, sql }) => {
      await completeSetup(base);
      const credential = { username: USERNAME, password: PASSWORD };

      // Hold the one write connection until this test lets go of it, so the
      // request below is still inside `auth.login` when the socket closes.
      await withParkedDatabase(sql, async () => {
        expect(await hangUp(base, "/api/v1/auth/login", credential)).toBe("closed");
      });

      // The login never happened: no token was issued and no audit row was
      // written. A disconnect is also not a failure, so the envelope answered
      // nothing and logged nothing.
      expect(await audit("auth.login.succeeded")).toEqual([]);
      expect(await audit("auth.login.failed")).toEqual([]);

      // The control. The same request, on a connection that stays up, does
      // everything the assertions above say did not happen - so they are about
      // the disconnect and not about a request that could never have worked.
      const kept = await post(base, "/api/v1/auth/login", credential);
      expect(kept.status).toBe(200);
      expect(await audit("auth.login.succeeded")).toHaveLength(1);
    });
  }, 15_000);

  it("leaves no api key and no audit row when the request was authenticated", async () => {
    await withServer(async ({ base, audit, sql }) => {
      const bearer = await completeSetup(base);
      // One request through first, so the pre-setup gate has its answer cached
      // and the parked request below stalls in the credential gate rather than
      // in front of it.
      expect((await get(base, "/api/v1/api-keys", bearer)).status).toBe(200);

      await withParkedDatabase(sql, async () => {
        expect(await hangUp(base, "/api/v1/api-keys", { name: "laptop" }, bearer)).toBe("closed");
      });

      // The bearer was good and the request had reached the database, and the
      // key was still never minted.
      expect(await audit("auth.apiKey.minted")).toEqual([]);
      expect(await (await get(base, "/api/v1/api-keys", bearer)).json()).toMatchObject({
        items: [],
      });

      // The same control: on a connection that stays up the key is minted and
      // logged, so the assertions above are about the disconnect.
      const kept = await post(base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      expect(kept.status).toBe(200);
      expect(await audit("auth.apiKey.minted")).toHaveLength(1);
      expect(await (await get(base, "/api/v1/api-keys", bearer)).json()).toMatchObject({
        items: [{ name: "laptop" }],
      });
    });
  }, 15_000);
});
