/**
 * Tests how Ignore Rules stop a raise from becoming a signal (spec 10 §9.2
 * step 2.2, §9.9), on a migrated test database. `SignalRaises.raise`
 * runs on raises written straight into the outbox, with a stub plugin host
 * that knows two signal kinds of the plugin Acme. Both kinds come from the
 * same event kind and take their match values from the event's payload.
 *
 * The rest of the raise path, through the whole event pipeline, is tested in
 * `daemon/events/routing/intake.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Fiber, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { IgnoreRule, SignalMatch } from "@hercule/contract";
import type { SignalDraft } from "@hercule/plugin-host";
import { FakeBoundOperationsLayer } from "../bound-actions/testing";
import { ConnectionTypes } from "../connections";
import { uuidFromString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { PluginHost, type RegisteredSignalKind } from "../plugins";
import { ignoreRuleRepository } from "./ignore-rule-repository";
import { SignalRaises, SignalRaisesLayer } from "./raises";
import { signalRepository } from "./repository";

const ASKED_KIND = "acme/asked";
const PINGED_KIND = "acme/pinged";
/** A kind whose one match field is named like the property every object inherits its prototype from. */
const PROTO_KIND = "acme/proto";
const CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c001";
const AT = "2026-10-12T10:00:00.000Z";

/** What a test learns about, and holds, the plugin's `build` calls. */
interface BuildProbe {
  calls: number;
  /** When set, `build` waits for the promise it returns before it returns its draft. */
  beforeBuild?: (() => Promise<void>) | undefined;
}

const DRAFT: SignalDraft = { title: "Asked", blocks: [], actions: [] };

/** Builds one of Acme's signal kinds, whose `build` reports to `probe`. */
const buildKind = (kind: string, probe: BuildProbe): RegisteredSignalKind => ({
  kind,
  pluginId: "acme",
  pluginDisplayName: "Acme",
  word: kind.slice("acme/".length),
  label: "Asked",
  description: "Someone asked.",
  from: ["acme.asked"],
  rule: '"yes"',
  guidance: "Raise it.",
  threadRef: "event.payload.thread",
  namesYou: true,
  priority: "high",
  matchFields: [
    { name: "author", label: "Author", path: "event.payload.author" },
    { name: "repo", label: "Repository", path: "event.payload.repo" },
  ],
  ends: [],
  build: () =>
    Effect.gen(function* () {
      probe.calls += 1;
      const before = probe.beforeBuild;
      if (before !== undefined) yield* Effect.promise(before);
      return DRAFT;
    }),
});

/**
 * Connection types that know no type, so `build` gets the Connection's
 * config as it is stored. The raise path never hands a plugin its runtime.
 */
const ConnectionTypesStub = Layer.mock(ConnectionTypes)({
  named: () => Effect.succeed(Option.none()),
  runtimeFor: () => {
    throw new Error("the raise path never asks for a plugin's Connections runtime");
  },
});

type Deps = SignalRaises | SqlClient.SqlClient;

/** Runs `effect` against a fresh database, with Acme's kinds reporting to `probe`. */
const run = <A, E>(effect: Effect.Effect<A, E, Deps>, probe: BuildProbe = { calls: 0 }) => {
  const kinds = [
    buildKind(ASKED_KIND, probe),
    buildKind(PINGED_KIND, probe),
    {
      ...buildKind(PROTO_KIND, probe),
      matchFields: [{ name: "__proto__", label: "Proto", path: "event.payload.author" }],
    },
  ];
  const host = Layer.mock(PluginHost)({
    findSignalKind: (kind) =>
      Effect.succeed(Option.fromNullishOr(kinds.find((known) => known.kind === kind))),
    status: () => Effect.succeed(Option.some({ _tag: "active" as const })),
  });
  const layer = SignalRaisesLayer.pipe(
    Layer.provide(host),
    Layer.provide(ConnectionTypesStub),
    Layer.provide(FakeBoundOperationsLayer),
    Layer.provide(NotifierLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
  );
  return Effect.runPromise(Effect.provide(effect, layer));
};

let dedupCounter = 0;

/**
 * Writes the Acme Connection, and one event through it from `author` in
 * `repo`, and returns the event's id.
 */
const insertEvent = (author: string, repo = "acme/webshop") =>
  inTransaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
      INSERT OR IGNORE INTO connections (id, plugin_id, type, label, display_name, account_id,
                                         status, labels, config, intake, created_at, updated_at)
      VALUES (${uuidFromString(CONNECTION_ID)}, 'acme', 'acme/acme', 'L', 'D', 'a-1', 'connected',
              '[]', '{}', '{"eventKinds":{},"signalKinds":{}}', ${AT}, ${AT})`;
      dedupCounter += 1;
      const rows = yield* sql<{ readonly id: number }>`
      INSERT INTO events (source, connection_id, system, kind, occurred_at, received_at,
                          dedup_key, payload)
      VALUES ('acme', ${uuidFromString(CONNECTION_ID)}, 'acme', 'acme.asked', ${AT}, ${AT},
              ${`key-${String(dedupCounter)}`},
              ${JSON.stringify({ thread: `t-${String(dedupCounter)}`, author, repo })})
      RETURNING id`;
      return rows[0]!.id;
    }),
  );

/** Writes a pending raise of `kind` for the event. */
const insertRaise = (eventId: number, kind = ASKED_KIND) =>
  inTransaction(
    Effect.gen(function* () {
      const signals = yield* signalRepository;
      yield* signals.insertRaise({
        eventId,
        kind,
        decision: "yes",
        connectionId: CONNECTION_ID,
        threadRef: `t-${String(eventId)}`,
      });
    }),
  );

let ruleCounter = 0;

/** Writes an Ignore Rule of `kind` with these values, created at `createdAt`, and returns it. */
const insertRule = (match: SignalMatch, createdAt = AT, kind = ASKED_KIND) =>
  inTransaction(
    Effect.gen(function* () {
      const rules = yield* ignoreRuleRepository;
      ruleCounter += 1;
      const rule: IgnoreRule = {
        id: `0199e0e7-0000-7000-8000-${ruleCounter.toString(16).padStart(12, "0")}`,
        kind,
        match,
        text: `Asked · ${Object.values(match).join(" · ")}`,
        createdAt,
        actor: "user",
      };
      yield* rules.insert(rule);
      return rule;
    }),
  );

/** Raises every pending raise, oldest event first, as the signal raise delivery does. */
const raiseAll = Effect.gen(function* () {
  const raises = yield* SignalRaises;
  for (const raise of yield* raises.listPending()) yield* raises.raise(raise, []);
});

/** Returns what the raises left behind: the signals, the catches and the raises still pending. */
const readOutcome = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const raises = yield* SignalRaises;
  return {
    signals: yield* sql<{ readonly kind: string }>`SELECT kind FROM signals ORDER BY kind`,
    catches: yield* sql<{
      readonly event_id: number;
      readonly rule_id: Uint8Array;
      readonly kind: string;
      readonly rule_text: string;
    }>`SELECT event_id, rule_id, kind, rule_text FROM ignore_rule_catches ORDER BY event_id, kind`,
    pending: yield* raises.listPending(),
  };
});

describe("raising a signal an Ignore Rule matches", () => {
  it("records the catch in place of the signal, deletes the raise, and never runs build", async () => {
    const probe: BuildProbe = { calls: 0 };
    const [outcome, eventId, rule] = await run(
      Effect.gen(function* () {
        const rule = yield* insertRule({ author: "dependabot[bot]" });
        const eventId = yield* insertEvent("dependabot[bot]");
        yield* insertRaise(eventId);
        yield* raiseAll;
        return [yield* readOutcome, eventId, rule] as const;
      }),
      probe,
    );
    expect(outcome.signals).toEqual([]);
    expect(outcome.pending).toEqual([]);
    expect(outcome.catches).toEqual([
      {
        event_id: eventId,
        rule_id: uuidFromString(rule.id),
        kind: ASKED_KIND,
        rule_text: rule.text,
      },
    ]);
    expect(probe.calls).toBe(0);
  });

  it("records the catch with the oldest of two matching rules", async () => {
    const [outcome, older] = await run(
      Effect.gen(function* () {
        yield* insertRule({ author: "dependabot[bot]" }, "2026-10-12T11:00:00.000Z");
        const older = yield* insertRule({ repo: "acme/webshop" }, "2026-10-12T09:00:00.000Z");
        yield* insertRaise(yield* insertEvent("dependabot[bot]"));
        yield* raiseAll;
        return [yield* readOutcome, older] as const;
      }),
    );
    expect(outcome.catches.map((caught) => caught.rule_id)).toEqual([uuidFromString(older.id)]);
  });

  it("catches the signal with a rule the user created while build ran, and stamps the catch after the rule", async () => {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const probe: BuildProbe = {
      calls: 0,
      beforeBuild: () => {
        markStarted();
        return released;
      },
    };
    const [outcome, rule, stamps] = await run(
      Effect.gen(function* () {
        yield* insertRaise(yield* insertEvent("dependabot[bot]"));
        const raising = yield* Effect.forkChild(raiseAll);
        yield* Effect.promise(() => started);
        // The rule is created a little after the build started, at the
        // real time, so a catch stamped before the build would be older.
        yield* Effect.sleep("5 millis");
        const rule = yield* insertRule({ author: "dependabot[bot]" }, new Date().toISOString());
        release();
        yield* Fiber.join(raising);
        const sql = yield* SqlClient.SqlClient;
        const stamps = yield* sql<{ readonly at: string }>`SELECT at FROM ignore_rule_catches`;
        return [yield* readOutcome, rule, stamps.map((row) => row.at)] as const;
      }),
      probe,
    );
    expect(probe.calls).toBe(1);
    expect(outcome.signals).toEqual([]);
    expect(outcome.pending).toEqual([]);
    expect(outcome.catches.map((caught) => caught.rule_id)).toEqual([uuidFromString(rule.id)]);
    // ISO times in UTC sort as text in the order of the times.
    expect(stamps[0]! >= rule.createdAt).toBe(true);
  });

  it("raises nothing for a caught event when the event raises again after its rule was deleted", async () => {
    const probe: BuildProbe = { calls: 0 };
    const outcome = await run(
      Effect.gen(function* () {
        const rules = yield* ignoreRuleRepository;
        const rule = yield* insertRule({ author: "dependabot[bot]" });
        const eventId = yield* insertEvent("dependabot[bot]");
        yield* insertRaise(eventId);
        yield* raiseAll;
        yield* inTransaction(rules.delete(rule.id));
        // Enriching the event writes its raise again.
        yield* insertRaise(eventId);
        yield* raiseAll;
        return yield* readOutcome;
      }),
      probe,
    );
    expect(outcome.signals).toEqual([]);
    expect(outcome.pending).toEqual([]);
    expect(outcome.catches).toHaveLength(1);
    expect(probe.calls).toBe(0);
  });

  it("raises the signal when no rule matches every one of the rule's values, or the rule is of another kind", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* insertRule({ author: "dependabot[bot]", repo: "acme/other" });
        yield* insertRule({ author: "dependabot[bot]" }, AT, PINGED_KIND);
        yield* insertRaise(yield* insertEvent("dependabot[bot]"));
        yield* raiseAll;
        return yield* readOutcome;
      }),
    );
    expect(outcome.signals).toEqual([{ kind: ASKED_KIND }]);
    expect(outcome.catches).toEqual([]);
    expect(outcome.pending).toEqual([]);
  });

  it("keeps a match field named __proto__ as a value, so a rule on it catches the event", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertRaise(yield* insertEvent("octocat"), PROTO_KIND);
        yield* raiseAll;
        const stored = yield* sql<{ readonly match: string }>`SELECT match FROM signals`;
        yield* insertRule(
          JSON.parse('{"__proto__":"dependabot[bot]"}') as SignalMatch,
          AT,
          PROTO_KIND,
        );
        yield* insertRaise(yield* insertEvent("dependabot[bot]"), PROTO_KIND);
        yield* raiseAll;
        return { stored, catches: (yield* readOutcome).catches.length };
      }),
    );
    expect(outcome).toEqual({ stored: [{ match: '{"__proto__":"octocat"}' }], catches: 1 });
  });

  it("records a catch per kind for an event two kinds' rules stop, and raises neither again once both rules are deleted", async () => {
    const [outcome, eventId, asked, pinged] = await run(
      Effect.gen(function* () {
        const rules = yield* ignoreRuleRepository;
        const asked = yield* insertRule({ author: "dependabot[bot]" });
        const pinged = yield* insertRule({ author: "dependabot[bot]" }, AT, PINGED_KIND);
        const eventId = yield* insertEvent("dependabot[bot]");
        yield* insertRaise(eventId, ASKED_KIND);
        yield* insertRaise(eventId, PINGED_KIND);
        yield* raiseAll;
        yield* inTransaction(rules.delete(asked.id));
        yield* inTransaction(rules.delete(pinged.id));
        // Enriching the event writes both raises again.
        yield* insertRaise(eventId, ASKED_KIND);
        yield* insertRaise(eventId, PINGED_KIND);
        yield* raiseAll;
        return [yield* readOutcome, eventId, asked, pinged] as const;
      }),
    );
    expect(outcome.signals).toEqual([]);
    expect(outcome.pending).toEqual([]);
    expect(outcome.catches).toEqual([
      {
        event_id: eventId,
        rule_id: uuidFromString(asked.id),
        kind: ASKED_KIND,
        rule_text: asked.text,
      },
      {
        event_id: eventId,
        rule_id: uuidFromString(pinged.id),
        kind: PINGED_KIND,
        rule_text: pinged.text,
      },
    ]);
  });
});

describe("raising a signal from a raise with nothing to raise", () => {
  it("deletes a raise whose event is gone, in a transaction of its own, and writes no signal", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        // The event id names no event, as when the event was deleted after
        // the raise was written.
        yield* insertRaise(404);
        yield* raiseAll;
        return yield* readOutcome;
      }),
    );
    expect(outcome.signals).toEqual([]);
    expect(outcome.pending).toEqual([]);
  });
});
