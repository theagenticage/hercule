/**
 * Tests the device-setups repository on a migrated in-memory database: when a
 * poll may ask the provider, how a slow-down moves the next poll, and that a
 * flow can be ended only once.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { deviceSetupRepository, type NewDeviceSetup } from "./device-setups";

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

/** The moment the flow started. Every other time in these tests is relative to it. */
const START = "2026-09-01T00:00:00.000Z";

/** Returns the timestamp `seconds` after the start. */
const afterStart = (seconds: number): string =>
  new Date(Date.parse(START) + seconds * 1000).toISOString();

/** A flow with a five-second interval that may first poll at 5s and expires at 900s. */
const buildSetup = (setupId: string): NewDeviceSetup => ({
  setupId,
  type: "github/github",
  connectionId: undefined,
  label: "work",
  labels: ["Code"],
  config: { org: "acme" },
  deviceCode: "a-device-code",
  interval: 5,
  nextPollAt: afterStart(5),
  expiresAt: afterStart(900),
  createdAt: START,
});

describe("claimPoll", () => {
  it("answers early before the interval has passed, and claims the poll after it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const setups = yield* deviceSetupRepository;
        yield* setups.insert(buildSetup("a"));
        return {
          early: yield* setups.claimPoll("a", afterStart(4)),
          claimed: yield* setups.claimPoll("a", afterStart(5)),
          // The claim at 5s pushed the next poll to 10s.
          again: yield* setups.claimPoll("a", afterStart(9)),
          later: yield* setups.claimPoll("a", afterStart(10)),
        };
      }),
    );

    expect(result.early).toEqual({ _tag: "early", interval: 5 });
    expect(result.claimed).toEqual({
      _tag: "claimed",
      setup: {
        setupId: "a",
        type: "github/github",
        connectionId: undefined,
        label: "work",
        labels: ["Code"],
        config: { org: "acme" },
        deviceCode: "a-device-code",
        interval: 5,
      },
    });
    expect(result.again).toEqual({ _tag: "early", interval: 5 });
    expect(result.later._tag).toBe("claimed");
  });

  it("answers expired for a flow that does not exist or whose code has expired", async () => {
    const result = await run(
      Effect.gen(function* () {
        const setups = yield* deviceSetupRepository;
        yield* setups.insert(buildSetup("a"));
        return [
          yield* setups.claimPoll("missing", afterStart(5)),
          yield* setups.claimPoll("a", afterStart(900)),
        ];
      }),
    );

    expect(result).toEqual([{ _tag: "expired" }, { _tag: "expired" }]);
  });

  it("keeps the connection a reconnect names", async () => {
    const connectionId = "0199e0e7-0000-7000-8000-00000000c001";
    const claim = await run(
      Effect.gen(function* () {
        const setups = yield* deviceSetupRepository;
        yield* setups.insert({ ...buildSetup("a"), connectionId });
        return yield* setups.claimPoll("a", afterStart(5));
      }),
    );

    expect(claim).toMatchObject({ _tag: "claimed", setup: { connectionId } });
  });
});

describe("setInterval", () => {
  it("stores the new interval and moves the next poll one new interval past now", async () => {
    const result = await run(
      Effect.gen(function* () {
        const setups = yield* deviceSetupRepository;
        yield* setups.insert(buildSetup("a"));
        yield* setups.claimPoll("a", afterStart(5));
        yield* setups.setInterval("a", 12, afterStart(6));
        return {
          early: yield* setups.claimPoll("a", afterStart(17)),
          claimed: yield* setups.claimPoll("a", afterStart(18)),
        };
      }),
    );

    expect(result.early).toEqual({ _tag: "early", interval: 12 });
    expect(result.claimed).toMatchObject({ _tag: "claimed", setup: { interval: 12 } });
  });
});

describe("delete", () => {
  it("ends a flow once: the second delete finds nothing, and a poll answers expired", async () => {
    const result = await run(
      Effect.gen(function* () {
        const setups = yield* deviceSetupRepository;
        yield* setups.insert(buildSetup("a"));
        return {
          first: yield* setups.delete("a"),
          second: yield* setups.delete("a"),
          claim: yield* setups.claimPoll("a", afterStart(5)),
        };
      }),
    );

    expect(result).toEqual({ first: true, second: false, claim: { _tag: "expired" } });
  });
});

describe("deleteExpired", () => {
  it("deletes the flows that have expired and keeps the others", async () => {
    const result = await run(
      Effect.gen(function* () {
        const setups = yield* deviceSetupRepository;
        yield* setups.insert(buildSetup("old"));
        yield* setups.insert({ ...buildSetup("new"), expiresAt: afterStart(2000) });
        yield* setups.deleteExpired(afterStart(900));
        return { old: yield* setups.delete("old"), new: yield* setups.delete("new") };
      }),
    );

    expect(result).toEqual({ old: false, new: true });
  });
});
