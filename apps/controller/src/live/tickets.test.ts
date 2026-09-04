/**
 * How long a live-socket ticket stays good.
 *
 * The rest of the ticket's behaviour - who may fetch one, and that it is spent
 * on first use - is visible from the wire and tested there. Its lifetime is not:
 * the real controller runs on the real clock, and no integration test can wait
 * five minutes. So this one drives the store directly on a `TestClock` and moves
 * time rather than passing it.
 *
 * Both sides of the boundary matter. A ticket that dies early breaks a client on
 * a slow network; one that outlives its window is a bearer credential lying
 * around in memory.
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

const FIVE_MINUTES = 5 * 60_000;

const run = <A, E>(effect: Effect.Effect<A, E, WsTickets>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(WsTicketsLayer),
      Effect.provide(TestClock.layer()),
    ),
  );

describe("a ticket's lifetime", () => {
  it("still resolves a moment before five minutes are up", async () => {
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

  it("resolves nobody once five minutes have passed", async () => {
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
