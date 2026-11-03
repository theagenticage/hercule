/**
 * Tests how the latest release of each harness is read from the npm registry
 * and what `harness.query` then answers: a read that succeeds, one that fails
 * after a good one, one that fails first, and the live update that follows.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import type { Harness } from "@hercule/contract";
import { AfterCommit, type Change } from "../db";
import { PluginHost } from "../plugins";
import {
  asUser,
  buildHarnessDefinition,
  buildPluginStack,
  createPluginFixture,
} from "../plugins/testing";
import {
  buildFakeProviderApi,
  type FakeProviderAnswer,
  type FakeProviderRequest,
} from "../provider-accounts/testing";
import { HarnessReleases, HarnessReleasesLayer } from "./releases";
import { HarnessService, HarnessServiceLayer } from "./service";

const SCOPED_HARNESS = "scoped/scoped";
const PLAIN_HARNESS = "plain/plain";

/** Two harnesses: one published under a scoped package name, one under a plain one. */
const buildPlugins = () => [
  createPluginFixture({
    id: "scoped",
    definitions: [
      {
        ...buildHarnessDefinition("scoped"),
        releaseSource: { kind: "npm", package: "@acme/tool" },
      },
    ],
  }).plugin,
  createPluginFixture({
    id: "plain",
    definitions: [
      { ...buildHarnessDefinition("plain"), releaseSource: { kind: "npm", package: "plain-tool" } },
    ],
  }).plugin,
];

const SCOPED_URL = "https://registry.npmjs.org/%40acme%2Ftool/latest";
const PLAIN_URL = "https://registry.npmjs.org/plain-tool/latest";

/** The registry's answer for a release: a package document of which only `version` is used. */
const releaseOf = (version: string): Response =>
  new Response(JSON.stringify({ name: "tool", version, dist: { shasum: "abc" } }));

/** Everything the registry answers, by default the release 1.0.0 for both packages. */
const registry = (answer: (request: FakeProviderRequest) => FakeProviderAnswer) =>
  buildFakeProviderApi(answer);

const TIME_OF_FIRST_READ = Date.parse("2026-11-03T08:00:00.000Z");

/**
 * Runs `body` against the real services with a fake registry, a test clock set
 * to `TIME_OF_FIRST_READ`, and a recorder of what the controller announces to
 * its live clients.
 */
const run = <A, E>(
  client: HttpClient.HttpClient,
  body: (
    announced: Array<Change>,
  ) => Effect.Effect<A, E, HarnessService | HarnessReleases | SqlClient.SqlClient>,
) => {
  const announced: Array<Change> = [];
  const stack = Layer.mergeAll(
    HarnessServiceLayer,
    HarnessReleasesLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
  ).pipe(Layer.provideMerge(buildPluginStack()));
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(TIME_OF_FIRST_READ);
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildPlugins()));
      return yield* body(announced);
    }).pipe(
      Effect.provideService(AfterCommit, {
        publish: (changes) =>
          Effect.sync(() => {
            announced.push(...changes);
          }),
      }),
      Effect.provide(stack),
      Effect.provide(TestClock.layer()),
      asUser,
    ) as Effect.Effect<A, E, never>,
  );
};

const refresh = Effect.flatMap(HarnessReleases, (releases) => releases.refreshLatestReleases());

const queryLatest = (
  harnessId: string,
): Effect.Effect<Harness["latestRelease"], unknown, HarnessService> =>
  Effect.map(
    Effect.flatMap(HarnessService, (service) => service.query()),
    (harnesses) => {
      const harness = harnesses.find(({ id }) => id === harnessId);
      if (harness === undefined) throw new Error(`no harness ${harnessId}`);
      return harness.latestRelease;
    },
  );

describe("reading the latest releases", () => {
  it("answers null for a harness the controller has not tried to read", async () => {
    const { client } = registry(() => releaseOf("1.0.0"));

    const latest = await run(client, () => queryLatest(SCOPED_HARNESS));

    expect(latest).toBeNull();
  });

  it("stores the version and when it was read, for each harness", async () => {
    const { client } = registry((request) =>
      releaseOf(request.url === SCOPED_URL ? "2.4.1" : "0.9.0"),
    );

    const { scoped, plain } = await run(client, () =>
      Effect.gen(function* () {
        yield* refresh;
        return {
          scoped: yield* queryLatest(SCOPED_HARNESS),
          plain: yield* queryLatest(PLAIN_HARNESS),
        };
      }),
    );

    const checkedAt = new Date(TIME_OF_FIRST_READ).toISOString();
    expect(scoped).toEqual({ version: "2.4.1", checkedAt, error: null });
    expect(plain).toEqual({ version: "0.9.0", checkedAt, error: null });
  });

  it("asks the registry once for each harness, with a scoped package's name encoded", async () => {
    const { client, requests } = registry(() => releaseOf("1.0.0"));

    await run(client, () => refresh);

    expect(requests.map((request) => request.url).sort()).toEqual([PLAIN_URL, SCOPED_URL].sort());
  });

  it("keeps the last good version and when it was read when a later read fails, and clears the error at the next success", async () => {
    // A function, because a response body can be read only once.
    let answer = (): FakeProviderAnswer => releaseOf("1.0.0");
    const { client } = registry(() => answer());

    const outcome = await run(client, () =>
      Effect.gen(function* () {
        yield* refresh;
        yield* TestClock.adjust(Duration.hours(1));
        answer = () => new Response("overloaded", { status: 503 });
        yield* refresh;
        const failed = yield* queryLatest(SCOPED_HARNESS);
        yield* TestClock.adjust(Duration.hours(1));
        answer = () => releaseOf("1.1.0");
        yield* refresh;
        const recovered = yield* queryLatest(SCOPED_HARNESS);
        return { failed, recovered };
      }),
    );

    expect(outcome.failed).toEqual({
      version: "1.0.0",
      checkedAt: new Date(TIME_OF_FIRST_READ).toISOString(),
      error: "The npm registry answered 503.",
    });
    expect(outcome.recovered).toEqual({
      version: "1.1.0",
      checkedAt: new Date(TIME_OF_FIRST_READ + 2 * 60 * 60_000).toISOString(),
      error: null,
    });
  });

  it.each<[string, () => FakeProviderAnswer, string]>([
    [
      "answers a status other than 200",
      () => new Response("", { status: 404 }),
      "The npm registry answered 404.",
    ],
    [
      "answers a document with no version",
      () => new Response(JSON.stringify({ name: "tool" })),
      "The npm registry's answer had no version.",
    ],
    [
      "answers an empty version",
      () => new Response(JSON.stringify({ version: "" })),
      "The npm registry's answer had no version.",
    ],
    [
      "answers something that is not JSON",
      () => new Response("<html>"),
      "The npm registry's answer had no version.",
    ],
    ["cannot be reached", () => "unreachable", "Could not reach the npm registry."],
  ])(
    "records the reason, with no version, when the first read finds a registry that %s",
    async (_name, answer, error) => {
      const { client } = registry(answer);

      const latest = await run(client, () =>
        Effect.gen(function* () {
          yield* refresh;
          return yield* queryLatest(PLAIN_HARNESS);
        }),
      );

      expect(latest).toEqual({ version: null, checkedAt: null, error });
    },
  );

  it("fails the read of a registry that does not answer once the deadline has passed, and still reads the other harness", async () => {
    const { client } = registry((request) =>
      request.url === SCOPED_URL ? "silent" : releaseOf("3.0.0"),
    );

    const { scoped, plain } = await run(client, () =>
      Effect.gen(function* () {
        const reading = yield* Effect.forkChild(refresh);
        yield* TestClock.adjust(Duration.seconds(9));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Fiber.join(reading);
        return {
          scoped: yield* queryLatest(SCOPED_HARNESS),
          plain: yield* queryLatest(PLAIN_HARNESS),
        };
      }),
    );

    expect(scoped?.error).toBe("The npm registry did not answer in time.");
    expect(scoped?.version).toBeNull();
    expect(plain?.version).toBe("3.0.0");
  });

  it("announces one update to the clients' harness list after a read, whether it succeeded or failed", async () => {
    // A function, because a response body can be read only once.
    let answer = (): FakeProviderAnswer => releaseOf("1.0.0");
    const { client } = registry(() => answer());

    const announced = await run(client, (changes) =>
      Effect.gen(function* () {
        yield* refresh;
        const afterSuccess = changes.splice(0);
        answer = () => new Response("", { status: 500 });
        yield* refresh;
        return { afterSuccess, afterFailure: changes.splice(0) };
      }),
    );

    for (const changes of [announced.afterSuccess, announced.afterFailure]) {
      expect(changes).toHaveLength(2);
      expect(
        changes.every((change) => change._tag === "record" && change.topic === "provider"),
      ).toBe(true);
    }
  });
});
