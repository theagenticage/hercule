/**
 * Tests `POST /auth/ws-ticket` over a real socket: the only credential Hercule
 * issues that is not a token.
 *
 * A browser cannot set a header on a WebSocket handshake, so the live socket
 * is authenticated with a short-lived ticket the caller fetches over HTTP
 * first. This file checks three things, and only these:
 *
 * - any credential the API accepts can fetch a ticket;
 * - no two calls return the same ticket;
 * - the ticket is long enough to be unguessable.
 *
 * That a ticket works exactly once, and for five minutes, is tested with the
 * socket.
 *
 * The test server, temporary home and request helpers come from
 * `./testing.ts`, like every other transport test.
 */
import { describe, expect, it } from "vitest";
import { completeSetup, del, get, post, withServer } from "./testing";

/**
 * The length of 32 random bytes in base64url. Anything shorter holds fewer
 * than 32 bytes of randomness, whatever the alphabet.
 */
const MINIMUM_TICKET_LENGTH = 43;

const fetchTicket = async (base: string, token: string): Promise<string> => {
  const response = await post(base, "/api/v1/auth/ws-ticket", {}, token);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ticket: string };
  expect(typeof body.ticket).toBe("string");
  return body.ticket;
};

describe("fetching a ticket for the live socket", () => {
  it("returns a new, long ticket to a login token on every call", async () => {
    await withServer(async ({ base }) => {
      const bearer = await completeSetup(base);

      const tickets = [
        await fetchTicket(base, bearer),
        await fetchTicket(base, bearer),
        await fetchTicket(base, bearer),
      ];

      for (const ticket of tickets) {
        expect(ticket.length).toBeGreaterThanOrEqual(MINIMUM_TICKET_LENGTH);
      }
      // Three calls, three different tickets: nothing is reused or cached.
      expect(new Set(tickets).size).toBe(3);
    });
  });

  it("returns a ticket to an API key too, because every credential can use the socket", async () => {
    await withServer(async ({ base }) => {
      const bearer = await completeSetup(base);
      const minted = await post(base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      expect(minted.status).toBe(200);
      const key = (await minted.json()) as { token: string };

      const ticket = await fetchTicket(base, key.token);
      expect(ticket.length).toBeGreaterThanOrEqual(MINIMUM_TICKET_LENGTH);
      expect(ticket).not.toBe(await fetchTicket(base, bearer));
    });
  });

  it("rejects a caller with no credential, and one whose credential was revoked", async () => {
    await withServer(async ({ base }) => {
      const bearer = await completeSetup(base);

      const anonymous = await post(base, "/api/v1/auth/ws-ticket", {});
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ error: { code: "unauthenticated" } });

      const minted = await post(base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      const key = (await minted.json()) as { id: string; token: string };
      expect((await post(base, "/api/v1/auth/ws-ticket", {}, key.token)).status).toBe(200);

      expect((await del(base, `/api/v1/api-keys/${key.id}`, bearer)).status).toBe(200);

      const after = await post(base, "/api/v1/auth/ws-ticket", {}, key.token);
      expect(after.status).toBe(401);
      expect(await after.json()).toMatchObject({ error: { code: "unauthenticated" } });

      // The token that revoked the key still works, so the 401 above is caused
      // by the revoked key, not by the operation rejecting everyone.
      expect((await get(base, "/api/v1/api-keys", bearer)).status).toBe(200);
    });
  });
});
