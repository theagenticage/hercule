/**
 * The credential the live socket connects with.
 *
 * A browser cannot set a header on a WebSocket handshake, and the 30-day bearer
 * token must never ride in a URL, so a client trades its token over ordinary
 * authenticated HTTP for a short-lived string and presents that in the socket's
 * first frame. The string is good once and for five minutes.
 *
 * The tickets live in memory and nowhere else. A ticket is worthless a restart
 * later, so persisting one would only put a live credential in the database;
 * and hashing a value that already lives in this process guards nothing that
 * reaching this process does not already give away. Issuing one sweeps the
 * expired entries, so a map of tickets nobody ever spent cannot grow.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { unauthenticated, type Unauthenticated } from "@hydra/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintToken } from "../credentials";

/** How long a ticket stays good. Long enough to dial, short enough to lose. */
const WS_TICKET_LIFETIME_MS = 5 * 60 * 1000;

/** What a caller with no usable credential is told; never why. */
const NO_CREDENTIAL = "this operation needs a credential";

interface Held {
  readonly actor: Actor;
  readonly expiresAt: number;
}

const make = Effect.sync(() => {
  const held = new Map<string, Held>();

  return {
    /**
     * `auth.wsTicket`: a fresh ticket for whoever is calling. The actor is
     * captured here, so the socket the ticket opens is that caller's socket and
     * not merely somebody's.
     */
    issue: (): Effect.Effect<string, Unauthenticated> =>
      Effect.gen(function* () {
        // Any credential of any kind reaches this, so there is no grant to
        // check and `requireGrant` would only ever answer yes. What is left to
        // enforce is that somebody was resolved at all, and it is enforced here
        // rather than only in the transport gate, because that is what binds a
        // caller who reaches no transport.
        const actor = yield* CurrentActor;
        if (actor._tag === "none") {
          return yield* Effect.fail(unauthenticated(NO_CREDENTIAL));
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
     * Who this ticket was issued for, spending it in the process. A ticket that
     * was never issued, has already been spent, or has run out reads the same:
     * nobody.
     */
    consume: (ticket: string): Effect.Effect<Option.Option<Actor>> =>
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
  "hydra/controller/live/WsTickets",
) {}

export const WsTicketsLayer: Layer.Layer<WsTickets> = Layer.effect(WsTickets)(make);
