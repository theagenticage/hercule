/**
 * Tests how the latest release of each harness is read from the npm registry
 * and what `harness.query` then answers: a read that succeeds, one that fails
 * after a good one, one that fails first, the limits on what is accepted from
 * the registry, which reads a wake makes, and the live update that follows
 * only when something changed.
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
const buildReleaseResponse = (version: string): Response =>
  new Response(JSON.stringify({ name: "tool", version, dist: { shasum: "abc" } }));

/** Everything the registry answers, by default the release 1.0.0 for both packages. */
const buildRegistry = (answer: (request: FakeProviderRequest) => FakeProviderAnswer) =>
  buildFakeProviderApi(answer);

const UNREADABLE = "The npm registry's answer could not be read.";

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
    ),
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
  it("answers no good read and no error for a harness the controller has not tried to read", async () => {
    const { client } = buildRegistry(() => buildReleaseResponse("1.0.0"));

    const latest = await run(client, () => queryLatest(SCOPED_HARNESS));

    expect(latest).toEqual({ lastGoodRead: null, error: null });
  });

  it("stores the version and when it was read, for each harness", async () => {
    const { client } = buildRegistry((request) =>
      buildReleaseResponse(request.url === SCOPED_URL ? "2.4.1" : "0.9.0"),
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
    expect(scoped).toEqual({ lastGoodRead: { version: "2.4.1", checkedAt }, error: null });
    expect(plain).toEqual({ lastGoodRead: { version: "0.9.0", checkedAt }, error: null });
  });

  it("asks the registry once for each harness, with a scoped package's name encoded", async () => {
    const { client, requests } = buildRegistry(() => buildReleaseResponse("1.0.0"));

    await run(client, () => refresh);

    expect(requests.map((request) => request.url).sort()).toEqual([PLAIN_URL, SCOPED_URL].sort());
  });

  it("keeps the last good version and when it was read when a later read fails, and clears the error at the next success", async () => {
    // A function, because a response body can be read only once.
    let answer = (): FakeProviderAnswer => buildReleaseResponse("1.0.0");
    const { client } = buildRegistry(() => answer());

    const outcome = await run(client, () =>
      Effect.gen(function* () {
        yield* refresh;
        yield* TestClock.adjust(Duration.hours(1));
        answer = () => new Response("overloaded", { status: 503 });
        yield* refresh;
        const failed = yield* queryLatest(SCOPED_HARNESS);
        yield* TestClock.adjust(Duration.hours(1));
        answer = () => buildReleaseResponse("1.1.0");
        yield* refresh;
        const recovered = yield* queryLatest(SCOPED_HARNESS);
        return { failed, recovered };
      }),
    );

    expect(outcome.failed).toEqual({
      lastGoodRead: {
        version: "1.0.0",
        checkedAt: new Date(TIME_OF_FIRST_READ).toISOString(),
      },
      error: "The npm registry answered 503.",
    });
    expect(outcome.recovered).toEqual({
      lastGoodRead: {
        version: "1.1.0",
        checkedAt: new Date(TIME_OF_FIRST_READ + 2 * 60 * 60_000).toISOString(),
      },
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
    ["answers an empty version", () => new Response(JSON.stringify({ version: "" })), UNREADABLE],
    ["answers something that is not JSON", () => new Response("<html>"), UNREADABLE],
    [
      "answers a version that is not a semantic version",
      () => new Response(JSON.stringify({ version: "latest" })),
      UNREADABLE,
    ],
    [
      "answers a version of more than 100 characters",
      () => new Response(JSON.stringify({ version: `1.0.0-${"a".repeat(95)}` })),
      UNREADABLE,
    ],
    [
      "answers a body of more than 256 kB",
      () => new Response(JSON.stringify({ version: "1.0.0", padding: "x".repeat(256 * 1024) })),
      UNREADABLE,
    ],
    ["cannot be reached", () => "unreachable", "Could not reach the npm registry."],
  ])(
    "records the reason, with no version, when the first read finds a registry that %s",
    async (_name, answer, error) => {
      const { client } = buildRegistry(answer);

      const latest = await run(client, () =>
        Effect.gen(function* () {
          yield* refresh;
          return yield* queryLatest(PLAIN_HARNESS);
        }),
      );

      expect(latest).toEqual({ lastGoodRead: null, error });
    },
  );

  it("fails the read of a registry that does not answer once the deadline has passed, and still reads the other harness", async () => {
    const { client } = buildRegistry((request) =>
      request.url === SCOPED_URL ? "silent" : buildReleaseResponse("3.0.0"),
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

    expect(scoped.error).toBe("The npm registry did not answer in time.");
    expect(scoped.lastGoodRead).toBeNull();
    expect(plain.lastGoodRead?.version).toBe("3.0.0");
  });

  it("announces one update to the clients' harness list after a read, whether it succeeded or failed", async () => {
    // A function, because a response body can be read only once.
    let answer = (): FakeProviderAnswer => buildReleaseResponse("1.0.0");
    const { client } = buildRegistry(() => answer());

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

  it("accepts a version with a prerelease and a build part", async () => {
    const { client } = buildRegistry(() => buildReleaseResponse("2.0.0-beta.1+build.5"));

    const latest = await run(client, () =>
      Effect.gen(function* () {
        yield* refresh;
        return yield* queryLatest(PLAIN_HARNESS);
      }),
    );

    expect(latest.lastGoodRead?.version).toBe("2.0.0-beta.1+build.5");
  });

  it("sends the registry no trace headers, even from inside a span", async () => {
    const { client, requests } = buildRegistry(() => buildReleaseResponse("1.0.0"));

    await run(client, () => Effect.withSpan(refresh, "release-read"));

    expect(requests).toHaveLength(2);
    for (const { headers } of requests) {
      expect(Object.keys(headers).filter((name) => /^(traceparent|b3|x-b3-)/i.test(name))).toEqual(
        [],
      );
    }
  });

  it("announces nothing when a read finds what is already stored, but stores when it was read", async () => {
    // A function, because a response body can be read only once.
    let answer = (): FakeProviderAnswer => buildReleaseResponse("1.0.0");
    const { client } = buildRegistry(() => answer());

    const outcome = await run(client, (changes) =>
      Effect.gen(function* () {
        yield* refresh;
        changes.splice(0);
        yield* TestClock.adjust(Duration.hours(1));
        yield* refresh;
        const successRepeated = {
          announced: changes.splice(0),
          latest: yield* queryLatest(SCOPED_HARNESS),
        };
        answer = () => new Response("", { status: 500 });
        yield* refresh;
        changes.splice(0);
        yield* TestClock.adjust(Duration.hours(1));
        yield* refresh;
        const failureRepeated = {
          announced: changes.splice(0),
          latest: yield* queryLatest(SCOPED_HARNESS),
        };
        return { successRepeated, failureRepeated };
      }),
    );

    expect(outcome.successRepeated.announced).toEqual([]);
    expect(outcome.successRepeated.latest.lastGoodRead?.checkedAt).toBe(
      new Date(TIME_OF_FIRST_READ + 60 * 60_000).toISOString(),
    );
    expect(outcome.failureRepeated.announced).toEqual([]);
    expect(outcome.failureRepeated.latest).toEqual({
      lastGoodRead: {
        version: "1.0.0",
        checkedAt: new Date(TIME_OF_FIRST_READ + 60 * 60_000).toISOString(),
      },
      error: "The npm registry answered 500.",
    });
  });

  it("announces only the harness whose version changed", async () => {
    let newest = "1.0.0";
    const { client } = buildRegistry((request) =>
      buildReleaseResponse(request.url === SCOPED_URL ? newest : "0.9.0"),
    );

    const announced = await run(client, (changes) =>
      Effect.gen(function* () {
        yield* refresh;
        changes.splice(0);
        newest = "1.1.0";
        yield* refresh;
        return changes.splice(0);
      }),
    );

    expect(announced).toEqual([
      { _tag: "record", topic: "provider", id: SCOPED_HARNESS, kind: "updated" },
    ]);
  });
});
