/**
 * What a client hanging up mid-request does to the real controller.
 *
 * `server.ts` claims each request is one fiber and that a disconnect interrupts
 * it, rolling an open transaction back. Asserting that against a hand-rolled
 * router would only re-test `@effect/platform-bun`, so this drives the whole
 * stack the way anything else does: the envelope, the body cap, the pre-setup
 * gate, the derived route, and `auth.login`'s own transaction behind it.
 *
 * The request is parked deliberately rather than raced. SQLite has one writer
 * and `@effect/sql-sqlite-bun` puts every statement behind one connection
 * permit, so a transaction held open here stalls the request at its first
 * statement - which is where a disconnect under load lands in production too.
 */
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { completeSetup, PASSWORD, post, USERNAME, withServer } from "./testing";

/** Long enough for the parked request to reach the database and stop there. */
const PARKED_MS = 250;

/**
 * Sends a request over a socket of this test's own and closes it while the
 * controller is still working on it. `fetch` with an `AbortSignal` is not
 * enough for a test that has to be sure: it hands the response back to nobody,
 * and whether the connection is torn down is the client's business, not the
 * assertion's.
 */
const hangUp = (base: string, path: string, payload: unknown): Promise<"closed"> => {
  const url = new URL(base);
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\n` +
          `host: ${url.host}\r\n` +
          `content-type: application/json\r\n` +
          `content-length: ${String(Buffer.byteLength(body))}\r\n` +
          `\r\n${body}`,
      );
      setTimeout(() => {
        socket.destroy();
        resolve("closed");
      }, PARKED_MS);
    });
    socket.on("error", reject);
  });
};

describe("a client that hangs up", () => {
  it("leaves no login token, no audit row and a controller that keeps serving", async () => {
    await withServer(async (base, audit, sql) => {
      await completeSetup(base);
      const credential = { username: USERNAME, password: PASSWORD };

      // Hold the one write connection until this test lets go of it, so the
      // request below is still inside `auth.login` when the socket closes.
      const parked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holder = Effect.runPromise(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT 1`;
            parked.resolve();
            yield* Effect.promise(() => release.promise);
          }),
        ),
      );
      await parked.promise;

      expect(await hangUp(base, "/api/v1/auth/login", credential)).toBe("closed");

      release.resolve();
      await holder;

      // The login never happened: no token was issued and the operation's
      // audit row went back with its transaction. A disconnect is also not a
      // failure, so the envelope answered nothing and logged nothing.
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
});
