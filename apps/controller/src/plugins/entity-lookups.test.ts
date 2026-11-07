/**
 * Tests how the host decides a lookup: what `recognize` hands out, which
 * Connections `search` and `resolve` ask, and the one answer they give. The
 * plugins are fakes whose lookups answer from a table, so nothing here
 * touches a network. The database, the host and the Connections are real.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Redacted, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import {
  AuthError,
  HOST_API,
  PluginError,
  registerConnectionType,
  registerEventSource,
  type EntityLookup,
  type EntityLookupContext,
  type EntityObservation,
  type EntityRecognition,
  type EntityResolution,
  type IngestConnection,
  type Plugin,
} from "@hercule/plugin-host";
import { connectionRepository, type StoredConnection } from "../connections";
import type { ConnectionStatus } from "@hercule/contract";
import { withTransaction } from "../db";
import { Secrets } from "../secrets";
import { PluginHost, Plugins } from "./index";
import { EntityLookups, EntityLookupsLayer } from "./entity-lookups";
import { asUser, buildPluginStack, IDLE_FEEDS, IDLE_INGEST_OPEN } from "./testing";

/** What a fake Connection does when asked, by the Connection's account id. */
type Behavior<A> = (accountId: string) => Effect.Effect<A, AuthError | PluginError>;

interface FakeLookup {
  readonly lookup: EntityLookup;
  /** The account id of every `search` and `resolve` call, in order. */
  readonly calls: Array<string>;
  /** The targets `resolve` received. */
  readonly targets: Array<EntityRecognition>;
  /** The context of every `resolve` call, in order. */
  readonly contexts: Array<EntityLookupContext>;
  recognitions: ReadonlyArray<EntityRecognition>;
  /** Makes `recognize` throw, as a broken plugin does. */
  recognizeThrows: boolean;
  search: Behavior<ReadonlyArray<EntityObservation>>;
  resolve: Behavior<EntityResolution>;
}

const buildObservation = (ref: string): EntityObservation => ({
  kind: "ticket",
  ref,
  title: `Title of ${ref}`,
  url: `https://tracker.example/${ref}`,
  lifecycle: "open",
  fields: {},
  concerns: [],
  sourceUpdatedAt: "2026-01-01T00:00:00Z",
});

const buildFakeLookup = (): FakeLookup => {
  const fake: FakeLookup = {
    calls: [],
    targets: [],
    contexts: [],
    recognitions: [],
    recognizeThrows: false,
    search: () => Effect.succeed([]),
    resolve: () => Effect.succeed({ missing: "unknown" }),
    lookup: {
      recognize: () => {
        if (fake.recognizeThrows) throw new Error("boom");
        return fake.recognitions;
      },
      search: (connection: IngestConnection) =>
        Effect.suspend(() => {
          fake.calls.push(connection.accountId);
          return fake.search(connection.accountId);
        }),
      resolve: (connection: IngestConnection, context, target) =>
        Effect.suspend(() => {
          fake.calls.push(connection.accountId);
          fake.contexts.push(context);
          fake.targets.push(target);
          return fake.resolve(connection.accountId);
        }),
    },
  };
  return fake;
};

/** Builds a plugin with one Connection type, and one event source with `lookup`. */
const buildLookupPlugin = (id: string, lookup: EntityLookup | undefined): Plugin => ({
  manifest: {
    id,
    displayName: id,
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events", "entities"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.andThen(
      registerConnectionType(host, {
        type: id,
        displayName: id,
        setup: [],
        validate: () => Effect.succeed({ displayName: id, accountId: id }),
      }),
      registerEventSource(host, {
        id,
        connectionType: `${id}/${id}`,
        feeds: IDLE_FEEDS,
        kinds: {
          [`${id}.thing.done`]: {
            description: "Something was done.",
            schema: Schema.Struct({ title: Schema.String }),
            availableToTriage: true,
          },
        },
        ...(lookup === undefined ? {} : { entityLookup: lookup }),
        open: IDLE_INGEST_OPEN,
      }),
    ),
  activate: () => Effect.succeed(Effect.void),
});

const layer = EntityLookupsLayer.pipe(Layer.provideMerge(buildPluginStack()));

/** Inserts a Connection of the plugin `pluginId`, named by `accountId`, created at the `order`th second. */
const insertConnection = (
  pluginId: string,
  accountId: string,
  order: number,
  status: ConnectionStatus = "connected",
): Effect.Effect<StoredConnection, never, SqlClient.SqlClient> =>
  Effect.orDie(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const connections = yield* connectionRepository;
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString();
      return yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const inserted = yield* connections.insert({
            pluginId,
            type: `${pluginId}/${pluginId}`,
            label: accountId,
            displayName: accountId,
            accountId,
            labels: [],
            config: {},
            at,
          });
          if (status !== "connected") yield* connections.update(inserted.id, { status }, at);
          return inserted;
        }),
      );
    }),
  );

/** Boots `plugin` with the fake lookup, inserts one Connection per account id, and runs the test body. */
const runWith = <A>(
  accounts: ReadonlyArray<string | readonly [string, ConnectionStatus]>,
  body: (
    fake: FakeLookup,
    lookups: EntityLookups["Service"],
  ) => Effect.Effect<A, never, SqlClient.SqlClient | Plugins | Secrets>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fake = buildFakeLookup();
      const host = yield* PluginHost;
      yield* host.boot([buildLookupPlugin("tracker", fake.lookup)]);
      for (const [index, account] of accounts.entries()) {
        const [accountId, status] = typeof account === "string" ? [account, undefined] : account;
        yield* insertConnection("tracker", accountId, index, status);
      }
      return yield* body(fake, yield* EntityLookups);
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())) as Effect.Effect<A>,
  );

const scoped: EntityRecognition = {
  recognized: "scoped",
  form: "identifier",
  identifier: "SHOP-1",
};

const byRef: EntityRecognition = {
  recognized: "ref",
  form: "url",
  ref: "tracker:ticket:1",
  kind: "tracker/ticket",
};

describe("recognize", () => {
  it("qualifies kinds, keeps an absent kind absent, and makes no call", async () => {
    await runWith(["a"], (fake, lookups) =>
      Effect.gen(function* () {
        fake.recognitions = [
          { recognized: "ref", form: "url", ref: "tracker:ticket:1", kind: "ticket" },
          { recognized: "scoped", form: "identifier", identifier: "SHOP-1" },
        ];
        const found = yield* lookups.recognize("see SHOP-1");
        expect(found).toEqual([
          {
            pluginId: "tracker",
            recognition: {
              recognized: "ref",
              form: "url",
              ref: "tracker:ticket:1",
              kind: "tracker/ticket",
            },
          },
          { pluginId: "tracker", recognition: scoped },
        ]);
        expect("kind" in (found[1]?.recognition ?? {})).toBe(false);
        // `recognize` takes only the text, so a lookup has no way to read credentials or call out.
        expect(fake.calls).toEqual([]);
      }),
    );
  });

  it("recognizes nothing for a lookup that throws, and logs a warning that names the plugin", async () => {
    const logged: Array<string> = [];
    await runWith(["a"], (fake, lookups) =>
      Effect.gen(function* () {
        fake.recognizeThrows = true;
        expect(yield* lookups.recognize("see SHOP-1")).toEqual([]);
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make<unknown, void>(({ message }) => {
              logged.push(String(message));
            }),
          ]),
        ),
      ),
    );
    expect(logged.join("\n")).toContain("tracker");
    expect(logged.join("\n")).toContain("boom");
  });

  it("lists the plugins that can read links, and skips one with no lookup", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot([
          buildLookupPlugin("tracker", buildFakeLookup().lookup),
          buildLookupPlugin("bare", undefined),
        ]);
        const lookups = yield* EntityLookups;
        expect(yield* lookups.listLinkSources()).toEqual(["tracker"]);
      }).pipe(Effect.provide(layer)),
    );
  });
});

describe("resolve", () => {
  it("gives one answer when two accounts see one thing in a scope", async () => {
    const answer = await runWith(["a", "b"], (fake, lookups) => {
      fake.resolve = () => Effect.succeed({ found: buildObservation("tracker:ticket:1") });
      return lookups.resolve("tracker", scoped);
    });
    expect(answer).toMatchObject({ found: { observation: { ref: "tracker:ticket:1" } } });
  });

  it("is ambiguous, not the first match, when two scopes hold different things", async () => {
    const answer = await runWith(["a", "b"], (fake, lookups) => {
      fake.resolve = (account) =>
        Effect.succeed({
          found: buildObservation(account === "a" ? "tracker:ticket:1" : "tracker:ticket:2"),
        });
      return lookups.resolve("tracker", scoped);
    });
    expect(answer).toEqual({ ambiguous: ["tracker:ticket:1", "tracker:ticket:2"] });
  });

  it("is incomplete when one Connection found it and another failed", async () => {
    const answer = await runWith(["a", "b"], (fake, lookups) => {
      fake.resolve = (account) =>
        account === "a"
          ? Effect.succeed({ found: buildObservation("tracker:ticket:1") })
          : Effect.fail(new PluginError({ message: "boom" }));
      return lookups.resolve("tracker", scoped);
    });
    expect(answer).toEqual({ incomplete: true });
  });

  it("counts a rejected credential as a failed Connection", async () => {
    const answer = await runWith(["a", "b"], (fake, lookups) => {
      fake.resolve = (account) =>
        account === "a"
          ? Effect.succeed({ found: buildObservation("tracker:ticket:1") })
          : Effect.fail(new AuthError({ message: "rejected" }));
      return lookups.resolve("tracker", scoped);
    });
    expect(answer).toEqual({ incomplete: true });
  });

  it("rules a Connection out when the scope is not its own", async () => {
    const answer = await runWith(["a", "b"], (fake, lookups) => {
      fake.resolve = (account) =>
        account === "a"
          ? Effect.succeed({ found: buildObservation("tracker:ticket:1") })
          : Effect.succeed({ outOfScope: true });
      return lookups.resolve("tracker", scoped);
    });
    expect(answer).toMatchObject({ found: { observation: { ref: "tracker:ticket:1" } } });
  });

  it("asks a ref recognition in turn, oldest first, and stops at the first that finds it", async () => {
    const { answer, calls, targets } = await runWith(["a", "b", "c"], (fake, lookups) =>
      Effect.gen(function* () {
        fake.resolve = (account) =>
          account === "a"
            ? Effect.fail(new PluginError({ message: "boom" }))
            : Effect.succeed({ found: buildObservation("tracker:ticket:1") });
        const answer = yield* lookups.resolve("tracker", byRef);
        return { answer, calls: fake.calls, targets: fake.targets };
      }),
    );
    expect(answer).toMatchObject({ found: { observation: { ref: "tracker:ticket:1" } } });
    expect(calls).toEqual(["a", "b"]);
    // The plugin gets the kind as it wrote it, without the plugin id.
    expect(targets[0]).toMatchObject({ kind: "ticket" });
  });

  it("answers the firmest missing, and no title, for a link nobody can read", async () => {
    const table: ReadonlyArray<
      readonly [Record<string, "inaccessible" | "unknown" | "not-found">, string]
    > = [
      [{ a: "not-found", b: "unknown", c: "inaccessible" }, "inaccessible"],
      [{ a: "not-found", b: "unknown", c: "not-found" }, "unknown"],
      [{ a: "not-found", b: "not-found", c: "not-found" }, "not-found"],
    ];
    for (const [says, expected] of table) {
      const answer = await runWith(["a", "b", "c"], (fake, lookups) => {
        fake.resolve = (account) => Effect.succeed({ missing: says[account] ?? "unknown" });
        return lookups.resolve("tracker", byRef);
      });
      expect(answer).toEqual({ missing: expected });
    }
  });

  it("is incomplete, not missing, when a Connection failed and none found it", async () => {
    const answer = await runWith(["a", "b"], (fake, lookups) => {
      fake.resolve = (account) =>
        account === "a"
          ? Effect.fail(new PluginError({ message: "boom" }))
          : Effect.succeed({ missing: "not-found" });
      return lookups.resolve("tracker", byRef);
    });
    expect(answer).toEqual({ incomplete: true });
  });

  it("is incomplete when eligible Connections were left out by the limit of 8", async () => {
    const accounts = Array.from({ length: 9 }, (_, index) => `c${String(index)}`);
    const { answer, calls } = await runWith(accounts, (fake, lookups) =>
      Effect.gen(function* () {
        fake.resolve = () => Effect.succeed({ missing: "not-found" });
        const answer = yield* lookups.resolve("tracker", byRef);
        return { answer, calls: fake.calls };
      }),
    );
    expect(answer).toEqual({ incomplete: true });
    expect(calls).toHaveLength(8);
    expect(calls).not.toContain("c8");
  });

  it("asks no further Connection once 8 seconds have passed, and answers incomplete", async () => {
    const { answer, calls } = await runWith(["a", "b", "c"], (fake, lookups) =>
      Effect.gen(function* () {
        fake.resolve = (account) =>
          account === "a"
            ? Effect.sleep("7 seconds").pipe(Effect.as({ missing: "not-found" } as const))
            : Effect.sleep("2 seconds").pipe(Effect.as({ missing: "not-found" } as const));
        const fiber = yield* Effect.forkChild(lookups.resolve("tracker", byRef));
        yield* TestClock.adjust("20 seconds");
        return { answer: yield* Fiber.join(fiber), calls: [...fake.calls] };
      }),
    );
    // a takes 7 s, b starts at 7 s and ends at 9 s, and c would start after the 8 s are gone.
    expect(calls).toEqual(["a", "b"]);
    expect(answer).toEqual({ incomplete: true });
  });

  it("is incomplete, not unavailable, when the first Connection times out and the deadline leaves the others out", async () => {
    const { answer, calls } = await runWith(["a", "b"], (fake, lookups) =>
      Effect.gen(function* () {
        // a hangs until its own 8 second timeout; b could read the ref but is never asked.
        fake.resolve = (account) =>
          account === "a"
            ? Effect.never
            : Effect.succeed({ found: buildObservation("tracker:ticket:1") });
        const fiber = yield* Effect.forkChild(lookups.resolve("tracker", byRef));
        yield* TestClock.adjust("20 seconds");
        return { answer: yield* Fiber.join(fiber), calls: [...fake.calls] };
      }),
    );
    expect(calls).toEqual(["a"]);
    expect(answer).toEqual({ incomplete: true });
  });

  it("is incomplete, not unavailable, when every asked Connection times out but the limit of 8 left others out", async () => {
    const accounts = Array.from({ length: 9 }, (_, index) => `c${String(index)}`);
    const answer = await runWith(accounts, (fake, lookups) =>
      Effect.gen(function* () {
        fake.resolve = () => Effect.never;
        const fiber = yield* Effect.forkChild(lookups.resolve("tracker", scoped));
        yield* TestClock.adjust("8 seconds");
        return yield* Fiber.join(fiber);
      }),
    );
    expect(answer).toEqual({ incomplete: true });
  });

  it("asks only eligible Connections of the target plugin", async () => {
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const target = buildFakeLookup();
        const mentioner = buildFakeLookup();
        target.resolve = () => Effect.succeed({ found: buildObservation("tracker:ticket:1") });
        mentioner.resolve = () => Effect.succeed({ found: buildObservation("other:ticket:1") });
        const host = yield* PluginHost;
        yield* host.boot([
          buildLookupPlugin("tracker", target.lookup),
          buildLookupPlugin("other", mentioner.lookup),
        ]);
        const connection = yield* insertConnection("tracker", "t-ok", 1);
        yield* insertConnection("tracker", "t-reauth", 0, "needs-reauth");
        yield* insertConnection("tracker", "t-disabled", 0, "disabled");
        yield* insertConnection("other", "o-1", 0);
        const lookups = yield* EntityLookups;
        const answer = yield* lookups.resolve("tracker", byRef);
        return { answer, connection, asked: target.calls, askedOther: mentioner.calls };
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
    );
    expect(answer.answer).toEqual({
      found: {
        connectionId: answer.connection.id,
        observation: buildObservation("tracker:ticket:1"),
      },
    });
    expect(answer.asked).toEqual(["t-ok"]);
    expect(answer.askedOther).toEqual([]);
  });

  it("asks a Connection in the error status", async () => {
    const answer = await runWith([["a", "error"]], (fake, lookups) => {
      fake.resolve = () => Effect.succeed({ missing: "not-found" });
      return lookups.resolve("tracker", byRef);
    });
    expect(answer).toEqual({ missing: "not-found" });
  });

  it("is unavailable with no eligible Connection, and for a plugin with no lookup", async () => {
    expect(
      await runWith([["a", "disabled"]], (_fake, lookups) => lookups.resolve("tracker", byRef)),
    ).toEqual({
      unavailable: true,
    });
    expect(await runWith(["a"], (_fake, lookups) => lookups.resolve("unknown", byRef))).toEqual({
      unavailable: true,
    });
  });

  it("is unavailable when every Connection times out after 8 seconds", async () => {
    const answer = await runWith(["a", "b"], (fake, lookups) =>
      Effect.gen(function* () {
        fake.resolve = () => Effect.never;
        const fiber = yield* Effect.forkChild(lookups.resolve("tracker", scoped));
        yield* TestClock.adjust("8 seconds");
        return yield* Fiber.join(fiber);
      }),
    );
    expect(answer).toEqual({ unavailable: true });
  });
});

describe("a Connection that stops being eligible while a lookup runs", () => {
  /** Finds the Connection of the account and sets its status, as the user disabling it does. */
  const setStatus = (accountId: string, status: ConnectionStatus) =>
    Effect.orDie(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const connections = yield* connectionRepository;
        const all = yield* connections.ofPlugin("tracker");
        const found = all.find((connection) => connection.accountId === accountId);
        if (found === undefined) return yield* Effect.die(`no Connection ${accountId}`);
        yield* withTransaction(
          sql,
          connections.update(found.id, { status }, "2026-02-01T00:00:00Z"),
        );
        return found;
      }),
    );

  it("is not asked when it was disabled during the call before it, and the answer is incomplete", async () => {
    const { answer, calls } = await runWith(["a", "b"], (fake, lookups) =>
      Effect.gen(function* () {
        const aIsAsked = yield* Deferred.make<void>();
        const aMayAnswer = yield* Deferred.make<void>();
        fake.resolve = (account) =>
          Effect.gen(function* () {
            if (account === "a") {
              yield* Deferred.succeed(aIsAsked, undefined);
              yield* Deferred.await(aMayAnswer);
            }
            return { missing: "not-found" } as const;
          });
        const fiber = yield* Effect.forkChild(lookups.resolve("tracker", byRef));
        yield* Deferred.await(aIsAsked);
        yield* setStatus("b", "disabled");
        yield* Deferred.succeed(aMayAnswer, undefined);
        const answer = yield* Fiber.join(fiber);
        return { answer, calls: [...fake.calls] };
      }),
    );
    expect(calls).toEqual(["a"]);
    expect(answer).toEqual({ incomplete: true });
  });

  it("is not asked when its plugin was disabled during the call before it", async () => {
    const { answer, calls } = await runWith(["a", "b"], (fake, lookups) =>
      Effect.gen(function* () {
        const aIsAsked = yield* Deferred.make<void>();
        const aMayAnswer = yield* Deferred.make<void>();
        fake.resolve = (account) =>
          Effect.gen(function* () {
            if (account === "a") {
              yield* Deferred.succeed(aIsAsked, undefined);
              yield* Deferred.await(aMayAnswer);
            }
            return { missing: "not-found" } as const;
          });
        const fiber = yield* Effect.forkChild(lookups.resolve("tracker", byRef));
        yield* Deferred.await(aIsAsked);
        const plugins = yield* Plugins;
        yield* Effect.orDie(asUser(plugins.disable("tracker")));
        yield* Deferred.succeed(aMayAnswer, undefined);
        const answer = yield* Fiber.join(fiber);
        return { answer, calls: [...fake.calls] };
      }),
    );
    expect(calls).toEqual(["a"]);
    expect(answer).toEqual({ incomplete: true });
  });

  it("refuses the credentials of a Connection disabled after its call began", async () => {
    const { before, after } = await runWith(["a"], (fake, lookups) =>
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        const sql = yield* SqlClient.SqlClient;
        const [stored] = yield* Effect.orDie(
          Effect.flatMap(connectionRepository, (connections) => connections.ofPlugin("tracker")),
        );
        yield* Effect.orDie(
          withTransaction(
            sql,
            secrets.set({ kind: "connection", id: stored?.id ?? "" }, "token", Redacted.make("t")),
          ),
        );
        fake.resolve = () => Effect.succeed({ missing: "not-found" });
        yield* lookups.resolve("tracker", byRef);
        const context = fake.contexts[0];
        if (context === undefined) return yield* Effect.die("the lookup was not asked");
        const before = yield* Effect.exit(context.credentials());
        yield* setStatus("a", "disabled");
        const after = yield* Effect.exit(context.credentials());
        return { before, after };
      }),
    );
    expect(Exit.isSuccess(before)).toBe(true);
    expect(Exit.isFailure(after)).toBe(true);
  });
});

describe("search", () => {
  it("merges the results of Connections by ref, oldest first", async () => {
    const outcome = await runWith(["a", "b"], (fake, lookups) => {
      fake.search = (account) =>
        Effect.succeed(
          account === "a"
            ? [buildObservation("tracker:ticket:1"), buildObservation("tracker:ticket:2")]
            : [buildObservation("tracker:ticket:2"), buildObservation("tracker:ticket:3")],
        );
      return lookups.search("tracker", { text: "words", limit: 20 });
    });
    expect(outcome.outcome).toBe("results");
    expect(outcome.incomplete).toBe(false);
    expect(outcome.observations.map(({ observation }) => observation.ref)).toEqual([
      "tracker:ticket:1",
      "tracker:ticket:2",
      "tracker:ticket:3",
    ]);
  });

  it("asks four Connections and sets incomplete when a fifth is eligible", async () => {
    const { outcome, calls } = await runWith(["a", "b", "c", "d", "e"], (fake, lookups) =>
      Effect.gen(function* () {
        const outcome = yield* lookups.search("tracker", { text: "words", limit: 20 });
        return { outcome, calls: [...fake.calls] };
      }),
    );
    expect(outcome.incomplete).toBe(true);
    expect(outcome.outcome).toBe("results");
    expect([...calls].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the results of the other Connections when one fails, and says incomplete", async () => {
    const outcome = await runWith(["a", "b"], (fake, lookups) => {
      fake.search = (account) =>
        account === "a"
          ? Effect.fail(new AuthError({ message: "rejected" }))
          : Effect.succeed([buildObservation("tracker:ticket:1")]);
      return lookups.search("tracker", { text: "words", limit: 20 });
    });
    expect(outcome.incomplete).toBe(true);
    expect(outcome.observations).toHaveLength(1);
  });

  it("returns no results, incomplete, when the four asked Connections time out and a fifth was left out", async () => {
    const outcome = await runWith(["a", "b", "c", "d", "e"], (fake, lookups) =>
      Effect.gen(function* () {
        fake.search = () => Effect.never;
        const fiber = yield* Effect.forkChild(lookups.search("tracker", { text: "x", limit: 20 }));
        yield* TestClock.adjust("8 seconds");
        return yield* Fiber.join(fiber);
      }),
    );
    expect(outcome).toEqual({ observations: [], incomplete: true, outcome: "results" });
  });

  it("is source-unavailable when every Connection times out, and with no Connection", async () => {
    const timedOut = await runWith(["a"], (fake, lookups) =>
      Effect.gen(function* () {
        fake.search = () => Effect.never;
        const fiber = yield* Effect.forkChild(lookups.search("tracker", { text: "x", limit: 20 }));
        yield* TestClock.adjust("8 seconds");
        return yield* Fiber.join(fiber);
      }),
    );
    expect(timedOut).toEqual({
      observations: [],
      incomplete: false,
      outcome: "source-unavailable",
    });
    const none = await runWith([], (_fake, lookups) =>
      lookups.search("tracker", { text: "x", limit: 20 }),
    );
    expect(none.outcome).toBe("source-unavailable");
  });
});
