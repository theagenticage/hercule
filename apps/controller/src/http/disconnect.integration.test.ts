/**
 * Tests what happens to the real controller when a client disconnects in the
 * middle of a request.
 *
 * These tests check the outcome, not the mechanism: a request the client
 * abandoned makes no durable write, and the controller keeps serving. They do
 * not claim that a particular fiber was interrupted with a transaction open.
 * An interrupt requested inside an uninterruptible region is delivered later,
 * so no test like this could tell that apart from a request abandoned before
 * its handler ran.
 *
 * Testing against a hand-written router would only test
 * `@effect/platform-bun` again, so these tests use the whole stack: the
 * envelope, the pre-setup gate, both credential middlewares, the derived
 * route and the operation's own transaction.
 *
 * There are two cases, and they differ. An unauthenticated request runs with
 * no security middleware at all. An authenticated one has passed the
 * credential middleware, so it shows that a resolved token does not make the
 * abandoned write happen anyway.
 *
 * The request is deliberately held at the database rather than raced. SQLite
 * has one writer, and `@effect/sql-sqlite-bun` puts every statement behind one
 * connection permit, so a transaction held open here stalls the request at
 * its first statement. That is also where a disconnect under load happens in
 * production.
 */
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { withTransaction } from "../db";
import { completeSetup, get, PASSWORD, post, USERNAME, withServer } from "./testing";

/** Long enough for the held request to reach the database and stall there. */
const PARKED_MS = 250;

/**
 * How long the test waits after closing the socket before it releases the
 * held request.
 *
 * The abort reaches the controller as an event: Bun fires `request.signal` on
 * a later turn of the event loop than the one the FIN arrives on. Releasing
 * the database in the same turn as the close would let the request finish
 * before the interrupt is delivered, and the test would then measure that
 * race rather than the behaviour.
 */
const DELIVERED_MS = 100;

/**
 * Sends a request over the test's own socket, and closes the socket while the
 * controller is still working on the request. `fetch` with an `AbortSignal` is
 * not reliable enough here: it drops the response, but whether it actually
 * closes the connection is up to the client, not the test.
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
 * Holds the single write connection and returns a function that releases it.
 * Any database work the controller does in the meantime stalls.
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

/** Holds the write connection while `body` runs, and always releases it afterwards. */
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

describe("a client that disconnects", () => {
  it("leaves no login token, no audit row and a controller that keeps serving", async () => {
    await withServer(async ({ base, audit, sql }) => {
      await completeSetup(base);
      const credential = { username: USERNAME, password: PASSWORD };

      // Hold the write connection until this test releases it, so the request
      // below is still inside `auth.login` when the socket closes.
      await withParkedDatabase(sql, async () => {
        expect(await hangUp(base, "/api/v1/auth/login", credential)).toBe("closed");
      });

      // The login never happened: no token was issued and no audit row was
      // written. A disconnect is not a failure either, so the envelope
      // returned nothing and logged nothing.
      expect(await audit("auth.login.succeeded")).toEqual([]);
      expect(await audit("auth.login.failed")).toEqual([]);

      // The control: the same request, on a connection that stays open, does
      // everything the assertions above say did not happen. So they are about
      // the disconnect, not about a request that could never have worked.
      const kept = await post(base, "/api/v1/auth/login", credential);
      expect(kept.status).toBe(200);
      expect(await audit("auth.login.succeeded")).toHaveLength(1);
    });
  }, 15_000);

  it("leaves no api key and no audit row when the request was authenticated", async () => {
    await withServer(async ({ base, audit, sql }) => {
      const bearer = await completeSetup(base);
      // Send one request first, so the pre-setup gate has cached its answer
      // and the held request below stalls in the credential middleware rather
      // than before it.
      expect((await get(base, "/api/v1/api-keys", bearer)).status).toBe(200);

      await withParkedDatabase(sql, async () => {
        expect(await hangUp(base, "/api/v1/api-keys", { name: "laptop" }, bearer)).toBe("closed");
      });

      // The token was valid and the request had reached the database, but the
      // key was still never minted.
      expect(await audit("auth.apiKey.minted")).toEqual([]);
      expect(await (await get(base, "/api/v1/api-keys", bearer)).json()).toMatchObject({
        items: [],
      });

      // The same control: on a connection that stays open, the key is minted
      // and logged, so the assertions above are about the disconnect.
      const kept = await post(base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      expect(kept.status).toBe(200);
      expect(await audit("auth.apiKey.minted")).toHaveLength(1);
      expect(await (await get(base, "/api/v1/api-keys", bearer)).json()).toMatchObject({
        items: [{ name: "laptop" }],
      });
    });
  }, 15_000);
});
