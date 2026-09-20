/**
 * `POST /auth/ws-ticket` over a real socket: the one credential Hercule hands out
 * that is not a token.
 *
 * A browser cannot set a header on a WebSocket handshake, so the live socket is
 * authenticated by a short-lived string the caller fetches over HTTP first.
 * That makes three things worth holding the controller to here, and they are
 * the only things this file claims: any credential the API already accepts can
 * fetch one, no two calls hand out the same string, and the string is long
 * enough to be unguessable. Whether the ticket is then good exactly once, and
 * for five minutes, is the socket's business and lives beside the socket.
 *
 * The stack, the temporary home and the request helpers are `./testing.ts`,
 * the same ones every other transport test drives.
 */
import { describe, expect, it } from "vitest";
import { completeSetup, del, get, post, withServer } from "./testing";

/**
 * 32 random bytes rendered base64url. Anything shorter than this is fewer than
 * 32 bytes of randomness, whatever the alphabet.
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
  it("hands the login bearer a fresh, long ticket every time it asks", async () => {
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
      // Three asks, three different strings: nothing is reused or cached.
      expect(new Set(tickets).size).toBe(3);
    });
  });

  it("answers an API key too, because every credential reaches the same socket", async () => {
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

  it("refuses a caller with no credential, and one whose credential is dead", async () => {
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

      // The bearer that revoked the key still works, so the 401 above is the
      // dead credential and not the operation refusing everybody.
      expect((await get(base, "/api/v1/api-keys", bearer)).status).toBe(200);
    });
  });
});
