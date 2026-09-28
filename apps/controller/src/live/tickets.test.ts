/**
 * Tests how long a live socket ticket stays valid.
 *
 * The rest of the ticket's behaviour, such as who may get one and that it
 * works only once, is tested through the API. Its lifetime cannot be: the
 * real controller uses the real clock, and no integration test can wait five
 * minutes. So this test calls the service directly with a `TestClock` and
 * moves time forward.
 *
 * Both sides of the limit matter. A ticket that expires early breaks a client
 * on a slow network; one that lasts too long is a bearer credential left in
 * memory.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { CurrentActor, type Actor } from "../actor";
import { WsTickets, WsTicketsLayer } from "./tickets";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** An agent inside a session, the only kind of caller that cannot get a ticket. */
const AGENT: Actor = {
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants: ["session.read"],
  assistantId: null,
};

const FIVE_MINUTES = 5 * 60_000;

const runAs =
  (actor: Actor) =>
  <A, E>(effect: Effect.Effect<A, E, WsTickets>): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(CurrentActor, actor),
        Effect.provide(WsTicketsLayer),
        Effect.provide(TestClock.layer()),
      ),
    );

const run = runAs(USER);

describe("a ticket's lifetime", () => {
  it("is still valid just before five minutes have passed", async () => {
    const actor = await run(
      Effect.gen(function* () {
        const tickets = yield* WsTickets;
        const ticket = yield* tickets.issue();
        yield* TestClock.adjust(FIVE_MINUTES - 1);
        return yield* tickets.consume(ticket);
      }),
    );

    expect(Option.getOrNull(actor)).toEqual(USER);
  });

  it("is no longer valid once five minutes have passed", async () => {
    const actor = await run(
      Effect.gen(function* () {
        const tickets = yield* WsTickets;
        const ticket = yield* tickets.issue();
        yield* TestClock.adjust(FIVE_MINUTES);
        return yield* tickets.consume(ticket);
      }),
    );

    expect(Option.isNone(actor)).toBe(true);
  });

  it("expires each ticket on its own issue time, not on the newest one", async () => {
    const [old, fresh] = await run(
      Effect.gen(function* () {
        const tickets = yield* WsTickets;
        const first = yield* tickets.issue();
        yield* TestClock.adjust(4 * 60_000);
        const second = yield* tickets.issue();
        yield* TestClock.adjust(2 * 60_000);
        return [yield* tickets.consume(first), yield* tickets.consume(second)] as const;
      }),
    );

    expect(Option.isNone(old)).toBe(true);
    expect(Option.getOrNull(fresh)).toEqual(USER);
  });
});

describe("who a ticket is issued to", () => {
  it("rejects an agent inside a session, because the socket serves the user's screens", async () => {
    // A 401 rather than the 403 a session actor gets elsewhere: this operation
    // has no grant for a 403 to name. So the message is what tells the caller
    // what went wrong.
    const refusal = await runAs(AGENT)(
      Effect.flip(Effect.flatMap(WsTickets, (tickets) => tickets.issue())),
    );

    expect(refusal.error.code).toBe("unauthenticated");
    expect(refusal.error.message.toLowerCase()).toContain("user");
  });
});
