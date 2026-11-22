import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vitest";
import type { TokenSet } from "./client";
import { makeRefreshPermits, renewTokenSet, type RefreshEndpoint } from "./refresh";

const ENDPOINT: RefreshEndpoint = {
  tokenUrl: "https://auth.test/token",
  client: { clientId: "id" },
};

/** The failure a test's `writeIfHeld` raises when its stored set was replaced. */
class Replaced extends Schema.TaggedError<Replaced>()("Replaced", { message: Schema.String }) {}

/** A token endpoint that answers every request with `body` and status 200. */
const answering = (body: object) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body)))),
    ),
  );

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>, body: object) =>
  Effect.runPromise(effect.pipe(Effect.provide(answering(body))));

describe("renewTokenSet", () => {
  it("writes the new tokens once and returns them", async () => {
    const written: Array<TokenSet> = [];

    const next = await run(
      renewTokenSet({
        refreshToken: "old-refresh",
        endpoint: ENDPOINT,
        writeIfHeld: (tokens) => Effect.sync(() => void written.push(tokens)),
      }),
      { access_token: "new-access", refresh_token: "new-refresh" },
    );

    expect(next).toEqual({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(written).toEqual([next]);
  });

  it("keeps the old refresh token when the answer has none", async () => {
    const written: Array<TokenSet> = [];

    const next = await run(
      renewTokenSet({
        refreshToken: "old-refresh",
        endpoint: ENDPOINT,
        writeIfHeld: (tokens) => Effect.sync(() => void written.push(tokens)),
      }),
      { access_token: "new-access" },
    );

    expect(next.refreshToken).toBe("old-refresh");
    expect(written[0]?.refreshToken).toBe("old-refresh");
  });

  it("fails with the failure of the write when the stored set was replaced", async () => {
    const failure = await run(
      Effect.flip(
        renewTokenSet({
          refreshToken: "old-refresh",
          endpoint: ENDPOINT,
          writeIfHeld: () => Effect.fail(new Replaced({ message: "replaced meanwhile" })),
        }),
      ),
      { access_token: "new-access" },
    );

    expect(failure).toBeInstanceOf(Replaced);
  });

  it("writes nothing when the provider refuses", async () => {
    let writes = 0;
    const failure = await Effect.runPromise(
      Effect.flip(
        renewTokenSet({
          refreshToken: "old-refresh",
          endpoint: ENDPOINT,
          writeIfHeld: () => Effect.sync(() => void (writes += 1)),
        }),
      ).pipe(
        Effect.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    expect(failure._tag).toBe("ProviderRefused");
    expect(writes).toBe(0);
  });

  it("finishes the write when the caller is interrupted after the answer", async () => {
    const stored: Array<TokenSet> = [];
    const program = Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        renewTokenSet({
          refreshToken: "old-refresh",
          endpoint: ENDPOINT,
          writeIfHeld: (tokens) =>
            Deferred.succeed(writing, undefined).pipe(
              Effect.andThen(Effect.sleep(Duration.millis(20))),
              Effect.andThen(Effect.sync(() => void stored.push(tokens))),
            ),
        }),
      );
      // The answer is in and the write has begun: this is where a caller that
      // is cancelled would lose a rotated refresh token.
      yield* Deferred.await(writing);
      yield* Fiber.interrupt(fiber);
    });

    await run(program, { access_token: "new-access", refresh_token: "rotated-refresh" });

    expect(stored).toEqual([{ accessToken: "new-access", refreshToken: "rotated-refresh" }]);
  });
});

describe("makeRefreshPermits", () => {
  /** Runs one holder per key at once, and returns the most holders of one key that ran at the same time. */
  const measureOverlap = async (keys: ReadonlyArray<string>): Promise<number> => {
    const permits = makeRefreshPermits();
    const running = new Map<string, number>();
    let most = 0;
    const hold = (key: string) =>
      permits.withPermit(
        key,
        Effect.gen(function* () {
          running.set(key, (running.get(key) ?? 0) + 1);
          most = Math.max(most, running.get(key) ?? 0);
          yield* Effect.sleep(Duration.millis(10));
          running.set(key, (running.get(key) ?? 0) - 1);
        }),
      );
    await Effect.runPromise(Effect.all(keys.map(hold), { concurrency: "unbounded" }));
    return most;
  };

  it("lets one holder of a key run at a time", async () => {
    expect(await measureOverlap(["connection:1", "connection:1", "connection:1"])).toBe(1);
  });

  it("lets holders of different keys run together", async () => {
    const permits = makeRefreshPermits();
    let both = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const second = yield* Deferred.make<void>();
        yield* Effect.all(
          [
            permits.withPermit(
              "connection:1",
              Deferred.succeed(first, undefined).pipe(Effect.andThen(Deferred.await(second))),
            ),
            permits.withPermit(
              "mcp-server:1",
              Deferred.await(first).pipe(
                Effect.andThen(Deferred.succeed(second, undefined)),
                Effect.andThen(Effect.sync(() => void (both = true))),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );
    expect(both).toBe(true);
  });
});
