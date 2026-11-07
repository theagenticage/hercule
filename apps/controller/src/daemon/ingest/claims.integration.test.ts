/**
 * Tests relation claims through the real path: a plugin's ingest context
 * recognizes the addresses and texts it reports with the other active
 * plugins' lookups, the External Entities ingest stores the claims, and the
 * resolver pass gives pending claims their refs.
 *
 * Two invented plugins stand in for a code forge and a tracker. The forge
 * names a thing from its address alone. The tracker knows an address or an
 * identifier only inside a workspace, so it needs a read. The lookups answer
 * from a table, so nothing touches a network. The database, the host and the
 * Connections are real.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  HOST_API,
  PluginError,
  registerConnectionType,
  registerEventSource,
  type EntityKindDeclaration,
  type EntityLookup,
  type EntityObservation,
  type EntityRecognition,
  type EntityResolution,
  type IngestContext,
  type Plugin,
} from "@hercule/plugin-host";
import { connectionRepository, type StoredConnection } from "../../connections";
import { withTransaction } from "../../db";
import {
  ClaimResolutionLayer,
  ClaimResolution,
  decodePendingTarget,
} from "../../external-entities";
import { relationClaimRepository } from "../../external-entities/relation-claims";
import { EntityLookups, EntityLookupsLayer, PluginHost, Plugins } from "../../plugins";
import { ingestContexts } from "../../plugins/ingest-context";
import { asUser, buildPluginStack, IDLE_FEEDS, IDLE_INGEST_OPEN } from "../../plugins/testing";
import { resolvePendingClaims } from "./claim-resolver";

const FORGE_URL = /^https:\/\/forge\.example\/items\/(\d+)$/;
const TRACKER_URL = /^https:\/\/tracker\.example\/([a-z]+)\/issue\/([A-Z]+-\d+)$/;
const BARE_IDENTIFIER = /\b[A-Z]{2,5}-\d+\b/g;

/** What a tracker Connection answers to `resolve`, by its account id. */
type TrackerAnswers = Record<string, (identifier: string) => EntityResolution | "fail">;

const buildFound = (ref: string): EntityResolution => ({
  found: { kind: "item", ref, title: `Title of ${ref}`, partial: true } as EntityObservation,
});

const kindOf = (id: string): EntityKindDeclaration => ({
  word: "item",
  noun: "Item",
  refPrefix: `${id}:item:`,
  pace: "fast",
  patience: 24,
  identifier: "{key}",
  person: null,
  owner: null,
  status: null,
  facts: [],
  reasons: {},
});

/** Builds a plugin with one Connection type, one event source that declares the `item` kind, and a lookup. */
const buildPlugin = (id: string, lookup: EntityLookup): Plugin => ({
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
        entityKinds: [kindOf(id)],
        kinds: {
          [`${id}.item.done`]: {
            description: "Something was done.",
            schema: Schema.Struct({ title: Schema.String }),
            availableToTriage: true,
          },
        },
        entityLookup: lookup,
        open: IDLE_INGEST_OPEN,
      }),
    ),
  activate: () => Effect.succeed(Effect.void),
});

const forgeLookup: EntityLookup = {
  recognize: (text) => {
    const match = FORGE_URL.exec(text);
    return match === null
      ? []
      : [{ recognized: "ref", form: "url", ref: `forge:item:${match[1]}`, kind: "item" }];
  },
  search: () => Effect.succeed([]),
  resolve: () => Effect.succeed({ missing: "unknown" }),
};

const buildTrackerLookup = (answers: { current: TrackerAnswers }): EntityLookup => ({
  recognize: (text) => {
    const url = TRACKER_URL.exec(text);
    const recognitions: Array<EntityRecognition> =
      url === null
        ? []
        : [
            {
              recognized: "scoped",
              form: "url",
              kind: "item",
              identifier: url[2]!,
              scopeHint: url[1]!,
            },
          ];
    if (url === null) {
      for (const match of text.matchAll(BARE_IDENTIFIER)) {
        recognitions.push({
          recognized: "scoped",
          form: "identifier",
          kind: "item",
          identifier: match[0],
        });
      }
    }
    return recognitions;
  },
  search: () => Effect.succeed([]),
  resolve: (connection, _context, target) =>
    Effect.suspend(() => {
      const answer = answers.current[connection.accountId];
      const decided =
        answer === undefined || target.recognized !== "scoped"
          ? ({ missing: "unknown" } as const)
          : answer(target.identifier);
      return decided === "fail"
        ? Effect.fail(new PluginError({ message: "the tracker is down" }))
        : Effect.succeed(decided);
    }),
});

const layer = Layer.mergeAll(EntityLookupsLayer, ClaimResolutionLayer).pipe(
  Layer.provideMerge(buildPluginStack()),
);

const insertConnection = (pluginId: string, accountId: string, order: number) =>
  Effect.orDie(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const connections = yield* connectionRepository;
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString();
      return yield* withTransaction(
        sql,
        connections.insert({
          pluginId,
          type: `${pluginId}/${pluginId}`,
          label: accountId,
          displayName: accountId,
          accountId,
          labels: [],
          config: {},
          at,
        }),
      );
    }),
  );

interface World {
  readonly answers: { current: TrackerAnswers };
  readonly forge: IngestContext;
  readonly forgeConnection: StoredConnection;
  readonly trackerConnection: StoredConnection;
  readonly tracker: IngestContext;
  readonly sql: SqlClient.SqlClient;
}

/** Boots both plugins, connects one account of each, and runs `body` with their ingest contexts. */
const runInWorld = <A>(
  body: (
    world: World,
  ) => Effect.Effect<
    A,
    unknown,
    ClaimResolution | EntityLookups | PluginHost | Plugins | SqlClient.SqlClient
  >,
  options: { readonly trackerAccounts?: ReadonlyArray<string> } = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const answers: { current: TrackerAnswers } = { current: {} };
      const host = yield* PluginHost;
      yield* host.boot([
        buildPlugin("forge", forgeLookup),
        buildPlugin("tracker", buildTrackerLookup(answers)),
      ]);
      const forgeConnection = yield* insertConnection("forge", "forge-a", 0);
      const accounts = options.trackerAccounts ?? ["tracker-a"];
      const trackerConnections: Array<StoredConnection> = [];
      for (const [index, account] of accounts.entries()) {
        trackerConnections.push(yield* insertConnection("tracker", account, index + 1));
      }
      const contexts = yield* ingestContexts;
      const sources = yield* host.listActiveEventSources();
      const contextOf = (pluginId: string, connection: StoredConnection) =>
        contexts.buildIngestContext(
          sources.find((source) => source.pluginId === pluginId)!,
          {
            id: connection.id,
            config: {},
            accountId: connection.accountId,
            displayName: connection.displayName,
          },
        );
      return yield* body({
        answers,
        forge: contextOf("forge", forgeConnection),
        forgeConnection,
        tracker: contextOf("tracker", trackerConnections[0]!),
        trackerConnection: trackerConnections[0]!,
        sql: yield* SqlClient.SqlClient,
      });
    }).pipe(Effect.provide(layer), asUser),
  );

interface ReportedItem {
  readonly plugin: "forge" | "tracker";
  readonly n: number;
  readonly urls?: ReadonlyArray<string>;
  readonly complete?: boolean;
  readonly texts?: ReadonlyArray<{ evidenceKey: string; text: string; revision?: string }>;
}

/** Reports one `item` the way a poll does, with an inventory read that is complete unless said otherwise. */
const reportItem = (context: IngestContext, item: ReportedItem) =>
  context.entities!.reconcile({
    kind: "item",
    complete: item.complete ?? true,
    observations: [
      {
        kind: "item",
        ref: `${item.plugin}:item:${item.n}`,
        title: `Item ${item.n}`,
        url: `https://${item.plugin}.example/items/${item.n}`,
        lifecycle: "open",
        fields: { key: `I-${item.n}` },
        concerns: ["assigned"],
        sourceUpdatedAt: "2026-09-01T10:00:00Z",
        relations: {
          complete: item.complete ?? true,
          partOf: [],
          linked: [],
          ...(item.urls === undefined ? {} : { linkedUrls: item.urls }),
        },
        ...(item.texts === undefined ? {} : { texts: item.texts }),
      },
    ],
  });

interface StoredClaim {
  readonly id: number;
  readonly from_ref: string;
  readonly to_ref: string;
  readonly claim_type: string;
  readonly evidence_key: string;
  readonly observed_at: string;
  readonly connection_id: Uint8Array | null;
  readonly resolve_attempts: number;
  readonly next_resolve_at: string;
}

const readClaims = (sql: SqlClient.SqlClient) =>
  sql<StoredClaim>`
    SELECT id, from_ref, to_ref, claim_type, evidence_key, observed_at, connection_id,
           resolve_attempts, next_resolve_at
    FROM external_entity_relation_claims ORDER BY id`;

const FORGE_ITEM_7 = "https://forge.example/items/7";
const TRACKER_OPS_47 = "https://tracker.example/acme/issue/OPS-47";

describe("an address a source reports", () => {
  it("is a source claim of the reporting Connection when another plugin recognizes it as a ref", async () => {
    const claims = await runInWorld(({ tracker, sql, trackerConnection }) =>
      Effect.gen(function* () {
        yield* reportItem(tracker, { plugin: "tracker", n: 1, urls: [FORGE_ITEM_7] });
        return { rows: yield* readClaims(sql), connection: trackerConnection.id };
      }),
    );

    expect(claims.rows).toHaveLength(1);
    expect(claims.rows[0]).toMatchObject({
      from_ref: "tracker:item:1",
      to_ref: "forge:item:7",
      claim_type: "source",
      evidence_key: FORGE_ITEM_7,
    });
  });

  it("stays a pending claim when the plugin that knows it needs a read, and resolves with the same id", async () => {
    const result = await runInWorld(({ forge, sql, answers }) =>
      Effect.gen(function* () {
        const resolution = yield* ClaimResolution;
        yield* reportItem(forge, { plugin: "forge", n: 1, urls: [TRACKER_OPS_47] });
        const pending = yield* readClaims(sql);
        const due = yield* resolution.listDue({ now: new Date().toISOString(), perConnection: 20 });
        answers.current = { "tracker-a": () => buildFound("tracker:item:47") };
        yield* resolvePendingClaims;
        const resolved = yield* readClaims(sql);
        const dueAfter = yield* resolution.listDue({
          now: new Date(Date.now() + 1000).toISOString(),
          perConnection: 20,
        });
        return { pending, due, resolved, dueAfter };
      }),
    );

    expect(decodePendingTarget(result.pending[0]!.to_ref)).toEqual({
      form: "scoped",
      pluginId: "tracker",
      kind: "tracker/item",
      scopeHint: "acme",
      identifier: "OPS-47",
    });
    expect(result.due.map((claim) => claim.target)).toEqual([result.pending[0]!.to_ref]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]).toMatchObject({
      id: result.pending[0]!.id,
      to_ref: "tracker:item:47",
      claim_type: "source",
      evidence_key: TRACKER_OPS_47,
      observed_at: result.pending[0]!.observed_at,
      resolve_attempts: 0,
    });
    // A resolved claim is no longer listed.
    expect(result.dueAfter).toEqual([]);
  });

  it("writes a linked row on each end of the pair when it resolves, and none while it is pending", async () => {
    const rows = await runInWorld(({ forge, sql, answers }) =>
      Effect.gen(function* () {
        const readLinked = sql<{ readonly ref: string; readonly target_ref: string | null }>`
          SELECT ref, target_ref FROM external_entity_timeline WHERE reason = 'linked' ORDER BY id`;
        // The thing is known first, so the address it reports later is news.
        yield* reportItem(forge, { plugin: "forge", n: 1 });
        yield* Effect.sleep("5 millis");
        yield* reportItem(forge, { plugin: "forge", n: 1, urls: [TRACKER_OPS_47] });
        const pending = yield* readLinked;
        answers.current = { "tracker-a": () => buildFound("tracker:item:47") };
        yield* resolvePendingClaims;
        const resolved = yield* readLinked;
        // The same address again is not a new link.
        yield* reportItem(forge, { plugin: "forge", n: 1, urls: [TRACKER_OPS_47] });
        yield* resolvePendingClaims;
        return { pending, resolved, again: yield* readLinked };
      }),
    );

    expect(rows.pending).toEqual([]);
    expect(rows.resolved).toEqual([
      { ref: "forge:item:1", target_ref: "tracker:item:47" },
      { ref: "tracker:item:47", target_ref: "forge:item:1" },
    ]);
    expect(rows.again).toEqual(rows.resolved);
  });

  it("writes no linked row when a claim the thing arrived with resolves later", async () => {
    const outcome = await runInWorld(({ forge, sql, answers }) =>
      Effect.gen(function* () {
        // The address is part of the thing's first sight, and no read can place it yet.
        yield* reportItem(forge, { plugin: "forge", n: 1, urls: [TRACKER_OPS_47] });
        answers.current = { "tracker-a": () => buildFound("tracker:item:47") };
        yield* resolvePendingClaims;
        return {
          claims: yield* readClaims(sql),
          linked: yield* sql`SELECT id FROM external_entity_timeline WHERE reason = 'linked'`,
        };
      }),
    );

    expect(outcome.claims.map((claim) => claim.to_ref)).toEqual(["tracker:item:47"]);
    expect(outcome.linked).toEqual([]);
  });

  it("keeps its canonical edge, id and time through another complete read and a disabled recognizer", async () => {
    const rows = await runInWorld(({ forge, sql, answers }) =>
      Effect.gen(function* () {
        const plugins = yield* Plugins;
        answers.current = { "tracker-a": () => buildFound("tracker:item:47") };
        yield* reportItem(forge, { plugin: "forge", n: 1, urls: [TRACKER_OPS_47] });
        yield* resolvePendingClaims;
        const resolved = yield* readClaims(sql);
        yield* reportItem(forge, { plugin: "forge", n: 1, urls: [TRACKER_OPS_47] });
        const repeated = yield* readClaims(sql);
        yield* plugins.disable("tracker");
        yield* reportItem(forge, { plugin: "forge", n: 1, urls: [TRACKER_OPS_47] });
        const withoutRecognizer = yield* readClaims(sql);
        return { resolved, repeated, withoutRecognizer };
      }),
    );

    expect(rows.resolved[0]!.to_ref).toBe("tracker:item:47");
    expect(rows.repeated).toEqual(rows.resolved);
    expect(rows.withoutRecognizer).toEqual(rows.resolved);
  });

  it("is kept when nothing recognizes it, tried again later, and recognized when a plugin returns", async () => {
    const rows = await runInWorld(({ forge, sql, answers }) =>
      Effect.gen(function* () {
        const plugins = yield* Plugins;
        const resolution = yield* ClaimResolution;
        yield* plugins.disable("tracker");
        yield* reportItem(forge, { plugin: "forge", n: 1, urls: [TRACKER_OPS_47] });
        const first = yield* readClaims(sql);
        yield* resolvePendingClaims;
        const failed = yield* readClaims(sql);
        yield* plugins.enable("tracker");
        answers.current = { "tracker-a": () => buildFound("tracker:item:47") };
        // The claim waits for its backoff until the set of recognizers changes.
        yield* resolvePendingClaims;
        const waiting = yield* readClaims(sql);
        yield* resolution.makeUrlClaimsDue();
        yield* resolvePendingClaims;
        return { first, failed, waiting, resolved: yield* readClaims(sql) };
      }),
    );

    expect(rows.first[0]!.to_ref).toBe(`unresolved:url:${TRACKER_OPS_47}`);
    expect(rows.failed[0]).toMatchObject({
      to_ref: `unresolved:url:${TRACKER_OPS_47}`,
      resolve_attempts: 1,
    });
    expect(rows.failed[0]!.next_resolve_at > new Date().toISOString()).toBe(true);
    expect(rows.waiting).toEqual(rows.failed);
    expect(rows.resolved[0]).toMatchObject({ id: rows.first[0]!.id, to_ref: "tracker:item:47" });
  });

  it("is removed by a complete read that leaves it out, and by no partial read", async () => {
    const rows = await runInWorld(({ tracker, sql }) =>
      Effect.gen(function* () {
        yield* reportItem(tracker, { plugin: "tracker", n: 1, urls: [FORGE_ITEM_7] });
        yield* reportItem(tracker, { plugin: "tracker", n: 1, urls: [], complete: false });
        const afterPartial = yield* readClaims(sql);
        yield* reportItem(tracker, { plugin: "tracker", n: 1, urls: [] });
        return { afterPartial, afterComplete: yield* readClaims(sql) };
      }),
    );

    expect(rows.afterPartial).toHaveLength(1);
    expect(rows.afterComplete).toEqual([]);
  });

  it("is not a ref in the refs a Connection is asked to read", async () => {
    const wanted = await runInWorld(({ forge, tracker, answers }) =>
      Effect.gen(function* () {
        yield* reportItem(forge, { plugin: "forge", n: 1, urls: [TRACKER_OPS_47] });
        const whilePending = yield* forge.entities!.listWanted("item", 50);
        answers.current = { "tracker-a": () => buildFound("tracker:item:47") };
        yield* resolvePendingClaims;
        const afterwards = yield* tracker.entities!.listWanted("item", 50);
        return { whilePending, afterwards };
      }),
    );

    expect(wanted.whilePending).toEqual([]);
    // The thing is read for its title now that it has a ref.
    expect(wanted.afterwards).toEqual(["tracker:item:47"]);
  });
});

describe("a reference in a text", () => {
  const description = (text: string, revision?: string) => [
    { evidenceKey: "description", text, ...(revision === undefined ? {} : { revision }) },
  ];

  it("stores a claim and no text, and a new revision replaces the claims", async () => {
    const rows = await runInWorld(({ tracker, sql }) =>
      Effect.gen(function* () {
        const sentence = "Waiting for SHOP-123 before this can go out";
        yield* reportItem(tracker, {
          plugin: "tracker",
          n: 1,
          texts: description(sentence, "r1"),
        });
        const first = yield* readClaims(sql);
        const dump = JSON.stringify(yield* sql`SELECT * FROM external_entity_relation_claims`);
        yield* reportItem(tracker, {
          plugin: "tracker",
          n: 1,
          texts: description("Waiting for SHOP-456 now", "r2"),
        });
        return { first, dump, second: yield* readClaims(sql) };
      }),
    );

    expect(rows.dump).not.toContain("Waiting for");
    expect(rows.first.map((claim) => claim.claim_type)).toEqual(["text"]);
    expect(decodePendingTarget(rows.first[0]!.to_ref)).toMatchObject({ identifier: "SHOP-123" });
    expect(rows.second).toHaveLength(1);
    expect(decodePendingTarget(rows.second[0]!.to_ref)).toMatchObject({ identifier: "SHOP-456" });
  });

  it("resolves when exactly one eligible scope holds the identifier", async () => {
    const rows = await runInWorld(
      ({ tracker, sql, answers }) =>
        Effect.gen(function* () {
          answers.current = {
            "tracker-a": () => buildFound("tracker:item:123"),
            "tracker-b": () => ({ outOfScope: true }),
          };
          yield* reportItem(tracker, { plugin: "tracker", n: 1, texts: description("SHOP-123") });
          yield* resolvePendingClaims;
          return yield* readClaims(sql);
        }),
      { trackerAccounts: ["tracker-a", "tracker-b"] },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to_ref: "tracker:item:123", claim_type: "text" });
  });

  it("stays pending, and takes no first match, when two scopes hold different things", async () => {
    const rows = await runInWorld(
      ({ tracker, sql, answers }) =>
        Effect.gen(function* () {
          answers.current = {
            "tracker-a": () => buildFound("tracker:item:1"),
            "tracker-b": () => buildFound("tracker:item:2"),
          };
          yield* reportItem(tracker, { plugin: "tracker", n: 9, texts: description("SHOP-123") });
          yield* resolvePendingClaims;
          return yield* readClaims(sql);
        }),
      { trackerAccounts: ["tracker-a", "tracker-b"] },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_ref.startsWith("unresolved:")).toBe(true);
    expect(rows[0]!.resolve_attempts).toBe(1);
  });

  it("stays pending when one Connection failed, even if the other found it", async () => {
    const rows = await runInWorld(
      ({ tracker, sql, answers }) =>
        Effect.gen(function* () {
          answers.current = {
            "tracker-a": () => buildFound("tracker:item:123"),
            "tracker-b": () => "fail",
          };
          yield* reportItem(tracker, { plugin: "tracker", n: 9, texts: description("SHOP-123") });
          yield* resolvePendingClaims;
          return yield* readClaims(sql);
        }),
      { trackerAccounts: ["tracker-a", "tracker-b"] },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.to_ref.startsWith("unresolved:")).toBe(true);
    expect(rows[0]!.resolve_attempts).toBe(1);
  });

  it("joins nothing: a resolved reference is a hint", async () => {
    const joined = await runInWorld(({ tracker, answers }) =>
      Effect.gen(function* () {
        const claims = yield* relationClaimRepository;
        answers.current = { "tracker-a": () => buildFound("tracker:item:123") };
        yield* reportItem(tracker, { plugin: "tracker", n: 1, texts: description("SHOP-123") });
        yield* resolvePendingClaims;
        return yield* claims.hasEffectiveLink("tracker:item:1", "tracker:item:123");
      }),
    );

    expect(joined).toBe(false);
  });
});

describe("what a plugin may report", () => {
  it("is refused whole, with a message, when it carries more texts than the limit", async () => {
    const outcome = await runInWorld(({ tracker, sql }) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          reportItem(tracker, {
            plugin: "tracker",
            n: 1,
            texts: [1, 2, 3, 4].map((n) => ({ evidenceKey: `k${n}`, text: "SHOP-1" })),
          }),
        );
        return { message: failure.message, claims: yield* readClaims(sql) };
      }),
    );

    expect(outcome.message).toContain("texts");
    expect(outcome.claims).toEqual([]);
  });
});
