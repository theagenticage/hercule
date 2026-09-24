/**
 * Tickets: the credential a client uses to open the live socket.
 *
 * A browser cannot set a header on a WebSocket handshake, and the 30-day
 * bearer token must never appear in a URL. So a client exchanges its token,
 * over normal authenticated HTTP, for a short-lived ticket, and sends the
 * ticket in the socket's first frame. A ticket works once, for five minutes.
 *
 * Tickets are kept in memory only. A ticket is useless after a restart, so
 * storing it would only put a live credential in the database. Hashing it
 * would not help either: anyone who can read this process's memory already
 * has everything the hash would protect. Issuing a ticket deletes the expired
 * ones, so unused tickets cannot pile up.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createUnauthenticatedError, type Unauthenticated } from "@hercule/contract";
import { CurrentActor, NO_CREDENTIAL, type UserActor } from "../actor";
import { mintToken } from "../credentials";

/** How long a ticket stays valid: long enough to connect, short enough to be low risk if leaked. */
const WS_TICKET_LIFETIME_MS = 5 * 60 * 1000;

interface Held {
  readonly actor: UserActor;
  readonly expiresAt: number;
}

/**
 * The error message when a session actor asks for a ticket.
 *
 * This is a 401, although other user-only operations reject a session actor
 * with a 403. `auth.wsTicket` requires only that a credential resolved, so
 * there is no grant for a 403 to name, and the contract's `forbidden` error
 * needs one. The message tells this case apart from a caller that sent no
 * credential.
 */
const SESSION_HAS_NO_SOCKET =
  "only the user can open a live connection; a session reads what it needs through the API";

const make = Effect.sync(() => {
  const held = new Map<string, Held>();

  return {
    /**
     * Implements `auth.wsTicket`: returns a new ticket for the calling user.
     * Fails with unauthenticated when there is no credential, or the caller
     * is not the user, such as a session. The actor is stored with the ticket, so the socket it
     * opens belongs to that caller.
     */
    issue: (): Effect.Effect<string, Unauthenticated> =>
      Effect.gen(function* () {
        // Any credential may call this, so there is no grant to check, and
        // `requireGrant` would always pass. What remains is to check that a
        // credential resolved at all. That is checked here, not only in the
        // transport gate, so it also holds for a caller that does not come
        // through a transport.
        const actor = yield* CurrentActor;
        if (actor._tag === "none") {
          return yield* Effect.fail(createUnauthenticatedError(NO_CREDENTIAL));
        }
        // The socket serves the user's screens. Any other actor, such as a
        // session, reads what it needs through the API and has no live topics
        // yet. Also, the connection sweep can re-check only a user credential,
        // so a socket opened by another actor could never be closed by it.
        if (actor._tag !== "user") {
          return yield* Effect.fail(createUnauthenticatedError(SESSION_HAS_NO_SOCKET));
        }
        const now = yield* Clock.currentTimeMillis;
        for (const [value, entry] of held) {
          if (entry.expiresAt <= now) held.delete(value);
        }
        const ticket = mintToken();
        held.set(ticket, { actor, expiresAt: now + WS_TICKET_LIFETIME_MS });
        return ticket;
      }),

    /**
     * Uses up a ticket and returns the user it was issued for. Returns `none`
     * for a ticket that was never issued, was already used, or has expired.
     */
    consume: (ticket: string): Effect.Effect<Option.Option<UserActor>> =>
      Effect.gen(function* () {
        const entry = held.get(ticket);
        if (entry === undefined) return Option.none();
        held.delete(ticket);
        const now = yield* Clock.currentTimeMillis;
        return entry.expiresAt <= now ? Option.none() : Option.some(entry.actor);
      }),
  };
});

/** The live socket's tickets. */
export class WsTickets extends Context.Service<WsTickets, Effect.Success<typeof make>>()(
  "hercule/controller/live/WsTickets",
) {}

export const WsTicketsLayer: Layer.Layer<WsTickets> = Layer.effect(WsTickets)(make);
