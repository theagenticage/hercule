/**
 * Tests the Ignore Rule service against a migrated test database, with
 * a plugin host that declares two signal kinds of the plugin Acme:
 *
 * - who may list, create and delete a rule;
 * - which rules `create` refuses, and why;
 * - what `create` stores, which open signals and offers it resolves, which
 *   claimed signals it leaves open, and what it records in the audit log;
 * - what `delete` removes, and what it leaves.
 *
 * The round trip over HTTP is tested in `ignore-rules.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import type { Grant, IgnoreRuleCreateInput, SignalMatch } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { PluginHost, type RegisteredSignalKind } from "../plugins";
import { ignoreRuleRepository } from "./ignore-rule-repository";
import { SignalClaims, SignalClaimsLayer } from "./claims";
import { IgnoreRuleService, IgnoreRuleServiceLayer } from "./ignore-rules";
import { signalRepository } from "./repository";

type Deps = IgnoreRuleService | SignalClaims | SqlClient.SqlClient;

const KIND = "acme/asked";
const OTHER_KIND = "acme/mentioned";

/** The match fields both of the stub's kinds declare, repository first. */
const MATCH_FIELDS = [
  { name: "repo", label: "Repository", path: "event.payload.repo" },
  { name: "author", label: "Author", path: "event.author" },
];

/** A plugin host that declares `KIND` and `OTHER_KIND`, of the plugin Acme. */
const PluginHostStub = Layer.mock(PluginHost)({
  findSignalKind: (kind) =>
    Effect.succeed(
      kind === KIND || kind === OTHER_KIND
        ? Option.some({
            kind,
            pluginId: "acme",
            pluginDisplayName: "Acme",
            label: kind === KIND ? "Asked" : "Mentioned",
            matchFields: MATCH_FIELDS,
          } as unknown as RegisteredSignalKind)
        : Option.none(),
    ),
});

const layer = IgnoreRuleServiceLayer.pipe(
  Layer.provideMerge(SignalClaimsLayer),
  Layer.provide(PluginHostStub),
  Layer.provide(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** Builds the actor of a session, in no run, whose profile holds `grants`. */
const buildSessionActor = (grants: ReadonlyArray<Grant>): Actor => ({
  _tag: "session",
  sessionId: "0199e0e7-0000-7000-8000-00000000b501",
  profileId: "0199e0e7-0000-7000-8000-00000000d001",
  grants,
  profileGrants: grants,
  assistantId: null,
  agentId: null,
});

const SESSION = buildSessionActor(["signal.read", "signal.write"]);

const RUN: Actor = {
  _tag: "run",
  runId: "0199e0e7-0000-7000-8000-00000000e001",
  stepId: "ignore",
  workflowId: null,
};

const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";
const AT = "2026-10-12T10:00:00.000Z";

const BOT_IN_WEBSHOP: SignalMatch = { repo: "acme/webshop", author: "dependabot[bot]" };

const as =
  (actor: Actor) =>
  <A, E>(effect: Effect.Effect<A, E, Deps>): Effect.Effect<A, E, Deps> =>
    Effect.provideService(effect, CurrentActor, actor);

const run = <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer));

/** Runs `effect` and returns the error it fails with. Fails the test if it succeeds. */
const fail = <A, E>(effect: Effect.Effect<A, E, Deps>): Promise<E> => run(Effect.flip(effect));

/** Returns the message of an API error. Fails the test for an error with no message, such as a `SqlError`. */
const readMessage = (error: object): string => {
  expect(error).toHaveProperty("error.message");
  return (error as { readonly error: { readonly message: string } }).error.message;
};

const service = Effect.service(IgnoreRuleService);

/** Creates a rule as the user. */
const createAsUser = (input: IgnoreRuleCreateInput) =>
  Effect.flatMap(service, (rules) => as(USER)(rules.create(input)));

/** Writes a signal of `kind` with these match values, open unless `resolved`, and returns its id. */
const insertSignal = (kind: string, match: SignalMatch, resolved = false) =>
  inTransaction(
    Effect.gen(function* () {
      const signals = yield* signalRepository;
      const id = uuidToString(mintUuid());
      yield* signals.insert(
        {
          id,
          kind,
          origin: { type: "api", actor: "user", eventIds: [], reason: "A test signal." },
          title: "Review the bump",
          priority: "normal",
          blocks: [],
          actions: [],
          match,
          status: resolved ? "resolved" : "open",
          ...(resolved
            ? {
                resolution: {
                  kind: "decided",
                  actionId: "done",
                  outcome: "Done",
                  actor: "user",
                  origin: "web",
                  at: AT,
                },
              }
            : {}),
          createdAt: AT,
        },
        [],
      );
      return id;
    }),
  );

/** Writes an open offer of the core that suggests the rule `kind` and `match`, and returns its id. */
const insertOffer = (kind: string, match: SignalMatch) =>
  inTransaction(
    Effect.gen(function* () {
      const signals = yield* signalRepository;
      const id = uuidToString(mintUuid());
      yield* signals.insert(
        {
          id,
          kind: "offer",
          origin: { type: "api", actor: "system", eventIds: [], reason: "A test offer." },
          title: "Ignore these?",
          priority: "normal",
          blocks: [],
          actions: [
            {
              id: "ignore",
              label: "Ignore",
              operation: { op: "ignoreRule.create", input: { kind, match } },
            },
          ],
          match: {},
          ignoreRule: { kind, match },
          status: "open",
          createdAt: AT,
        },
        [],
      );
      return id;
    }),
  );

/** Reads the signal with that id. */
const readSignal = (id: string) =>
  Effect.map(
    Effect.flatMap(signalRepository, (signals) => signals.read(id)),
    Option.getOrThrow,
  );

describe("ignoreRule.query", () => {
  it("lists the rules for the user and for a session that holds signal.read", async () => {
    const { forUser, forSession, rule } = await run(
      Effect.gen(function* () {
        const rules = yield* service;
        const rule = yield* createAsUser({ kind: KIND, match: BOT_IN_WEBSHOP });
        return {
          rule,
          forUser: yield* as(USER)(rules.query({})),
          forSession: yield* as(buildSessionActor(["signal.read"]))(rules.query({ kind: KIND })),
        };
      }),
    );

    expect(forUser).toEqual([{ ...rule, caughtCount: 0 }]);
    expect(forSession).toEqual(forUser);
  });

  it("refuses a session without signal.read", async () => {
    const error = await fail(
      Effect.flatMap(service, (rules) => as(buildSessionActor(["task.read"]))(rules.query({}))),
    );

    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "signal.read" } },
    });
  });
});

describe("ignoreRule.create", () => {
  it.each([
    ["a session that holds signal.write", SESSION],
    ["a run", RUN],
  ])("refuses %s, because only the user creates a rule", async (_name, actor) => {
    const { error, stored } = await run(
      Effect.gen(function* () {
        const rules = yield* service;
        const error = yield* Effect.flip(
          as(actor)(rules.create({ kind: KIND, match: BOT_IN_WEBSHOP })),
        );
        return { error, stored: yield* as(USER)(rules.query({})) };
      }),
    );

    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "signal.write" } },
    });
    expect(readMessage(error)).toContain("only the user may create or delete an Ignore Rule");
    expect(stored).toEqual([]);
  });

  it.each([
    ["a core kind", { kind: "proposal", match: { repo: "acme/webshop" } }, ["kind"]],
    [
      "a kind no plugin declares",
      { kind: "acme/unknown", match: { repo: "acme/webshop" } },
      ["kind"],
    ],
    [
      "a field the kind does not declare",
      { kind: KIND, match: { repo: "acme/webshop", team: "core" } },
      ["match", "team"],
    ],
  ] as const)("refuses %s", async (_name, input, path) => {
    const error = await fail(createAsUser(input));

    expect(error).toMatchObject({
      error: { code: "validation", details: { issues: [{ path }] } },
    });
  });

  it("refuses a rule with the same values as an existing one, in any order, and names the existing rule", async () => {
    const { existing, error, narrower } = await run(
      Effect.gen(function* () {
        const existing = yield* createAsUser({ kind: KIND, match: BOT_IN_WEBSHOP });
        const error = yield* Effect.flip(
          createAsUser({ kind: KIND, match: { author: "dependabot[bot]", repo: "acme/webshop" } }),
        );
        // Fewer values are a different rule, as are the same values of another kind.
        const narrower = yield* createAsUser({ kind: KIND, match: { repo: "acme/webshop" } });
        yield* createAsUser({ kind: OTHER_KIND, match: BOT_IN_WEBSHOP });
        return { existing, error, narrower };
      }),
    );

    expect(error).toMatchObject({ error: { code: "conflict" } });
    expect(readMessage(error)).toContain(existing.id);
    expect(narrower.match).toEqual({ repo: "acme/webshop" });
  });

  it("stores the values sorted by name and writes the rule's text from the kind's labels, in the kind's order", async () => {
    const { rule, stored } = await run(
      Effect.gen(function* () {
        const rule = yield* createAsUser({
          kind: KIND,
          match: { repo: "acme/webshop", author: "dependabot[bot]" },
        });
        const [stored] = yield* Effect.flatMap(ignoreRuleRepository, (rules) => rules.list(KIND));
        return { rule, stored: stored! };
      }),
    );

    expect(rule).toMatchObject({
      kind: KIND,
      text: "Asked · Repository acme/webshop · Author dependabot[bot]",
      actor: "user",
    });
    expect(stored).toEqual(rule);
    expect(Object.keys(stored.match)).toEqual(["author", "repo"]);
  });

  it("resolves only the open signals of its kind that it matches, and records them in the audit log", async () => {
    const checked = await run(
      Effect.gen(function* () {
        const matching = yield* insertSignal(KIND, BOT_IN_WEBSHOP);
        const alsoMatching = yield* insertSignal(KIND, {
          repo: "acme/webshop",
          author: "renovate[bot]",
        });
        const otherRepo = yield* insertSignal(KIND, { repo: "acme/api", author: "octocat" });
        const otherKind = yield* insertSignal(OTHER_KIND, BOT_IN_WEBSHOP);
        const resolvedBefore = yield* insertSignal(KIND, BOT_IN_WEBSHOP, true);
        const rule = yield* createAsUser({ kind: KIND, match: { repo: "acme/webshop" } });
        return {
          rule,
          matching: yield* readSignal(matching),
          alsoMatching: yield* readSignal(alsoMatching),
          otherRepo: yield* readSignal(otherRepo),
          otherKind: yield* readSignal(otherKind),
          resolvedBefore: yield* readSignal(resolvedBefore),
          entries: yield* readEventsOfKind("ignoreRule.created"),
        };
      }),
    );

    const resolution = {
      kind: "decided",
      actionId: "ignore",
      outcome: "Ignored · rule Asked · Repository acme/webshop",
      actor: "user",
      origin: "web",
      at: checked.rule.createdAt,
    };
    expect(checked.matching).toMatchObject({ status: "resolved", resolution });
    expect(checked.alsoMatching).toMatchObject({ status: "resolved", resolution });
    expect(checked.otherRepo.status).toBe("open");
    expect(checked.otherKind.status).toBe("open");
    // A signal resolved before keeps its own resolution.
    expect(checked.resolvedBefore.resolution).toMatchObject({ actionId: "done", outcome: "Done" });

    expect(checked.entries).toHaveLength(1);
    const [entry] = checked.entries;
    expect(entry!.actor).toBe("user");
    expect(entry!.payload).toMatchObject({
      ruleId: checked.rule.id,
      kind: KIND,
      match: { repo: "acme/webshop" },
      text: "Asked · Repository acme/webshop",
    });
    expect([...(entry!.payload["signalIds"] as ReadonlyArray<string>)].sort()).toEqual(
      [checked.matching.id, checked.alsoMatching.id].sort(),
    );
  });

  it("resolves the open offer of the same rule, and leaves an offer of another rule open", async () => {
    const checked = await run(
      Effect.gen(function* () {
        const sameRule = yield* insertOffer(KIND, {
          author: "dependabot[bot]",
          repo: "acme/webshop",
        });
        const narrowerRule = yield* insertOffer(KIND, { repo: "acme/webshop" });
        const rule = yield* createAsUser({ kind: KIND, match: BOT_IN_WEBSHOP });
        return {
          rule,
          sameRule: yield* readSignal(sameRule),
          narrowerRule: yield* readSignal(narrowerRule),
          entries: yield* readEventsOfKind("ignoreRule.created"),
        };
      }),
    );

    expect(checked.sameRule).toMatchObject({
      status: "resolved",
      resolution: {
        kind: "decided",
        actionId: "ignore",
        outcome: `Ignored · rule ${checked.rule.text}`,
        actor: "user",
      },
    });
    expect(checked.narrowerRule.status).toBe("open");
    expect(checked.entries.map((entry) => entry.payload["signalIds"])).toEqual([
      [checked.sameRule.id],
    ]);
  });

  it("leaves open a signal an action is working on, so the action resolves it", async () => {
    const checked = await run(
      Effect.gen(function* () {
        const claims = yield* SignalClaims;
        const claimed = yield* insertSignal(KIND, BOT_IN_WEBSHOP);
        const free = yield* insertSignal(KIND, BOT_IN_WEBSHOP);
        yield* claims.withSignalsClaimed(
          [claimed],
          "An action on this signal is running.",
          createAsUser({ kind: KIND, match: BOT_IN_WEBSHOP }),
        );
        return {
          claimed: yield* readSignal(claimed),
          free: yield* readSignal(free),
          entries: yield* readEventsOfKind("ignoreRule.created"),
        };
      }),
    );

    expect(checked.claimed.status).toBe("open");
    expect(checked.free.status).toBe("resolved");
    expect(checked.entries.map((entry) => entry.payload["signalIds"])).toEqual([[checked.free.id]]);
  });

  it("records the audit entry with no signals when nothing open matches", async () => {
    const entries = await run(
      Effect.gen(function* () {
        yield* createAsUser({ kind: KIND, match: BOT_IN_WEBSHOP });
        return yield* readEventsOfKind("ignoreRule.created");
      }),
    );

    expect(entries.map((entry) => entry.payload["signalIds"])).toEqual([[]]);
  });
});

describe("ignoreRule.delete", () => {
  it.each([
    ["a session that holds signal.write", SESSION],
    ["a run", RUN],
  ])("refuses %s, and leaves the rule", async (_name, actor) => {
    const { error, stored } = await run(
      Effect.gen(function* () {
        const rules = yield* service;
        const rule = yield* createAsUser({ kind: KIND, match: BOT_IN_WEBSHOP });
        const error = yield* Effect.flip(as(actor)(rules.delete(rule.id)));
        return { error, stored: yield* as(USER)(rules.query({})) };
      }),
    );

    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "signal.write" } },
    });
    expect(stored).toHaveLength(1);
  });

  it("fails with not found for an id no rule has", async () => {
    const error = await fail(
      Effect.flatMap(service, (rules) => as(USER)(rules.delete(UNKNOWN_ID))),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
    expect(readMessage(error)).toContain(UNKNOWN_ID);
  });

  it("deletes the rule, records it in the audit log, and keeps its catches and the signals it resolved", async () => {
    const checked = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rules = yield* service;
        const signalId = yield* insertSignal(KIND, BOT_IN_WEBSHOP);
        const rule = yield* createAsUser({ kind: KIND, match: BOT_IN_WEBSHOP });
        yield* inTransaction(
          Effect.gen(function* () {
            const [event] = yield* sql<{ readonly id: number }>`
              INSERT INTO events (source, system, kind, occurred_at, received_at, dedup_key, payload)
              VALUES ('acme', 'acme', 'acme.thing.done', ${AT}, ${AT}, 'k1', '{}')
              RETURNING id`;
            yield* Effect.flatMap(ignoreRuleRepository, (repository) =>
              repository.insertCatch({
                eventId: event!.id,
                ruleId: rule.id,
                kind: KIND,
                ruleText: rule.text,
                at: AT,
              }),
            );
          }),
        );
        const deleted = yield* as(USER)(rules.delete(rule.id));
        return {
          rule,
          deleted,
          listed: yield* as(USER)(rules.query({})),
          catches: yield* sql<{ readonly rule_text: string }>`
            SELECT rule_text FROM ignore_rule_catches`,
          signal: yield* readSignal(signalId),
          entries: yield* readEventsOfKind("ignoreRule.deleted"),
        };
      }),
    );

    expect(checked.deleted).toEqual({});
    expect(checked.listed).toEqual([]);
    expect(checked.catches).toEqual([{ rule_text: checked.rule.text }]);
    expect(checked.signal.status).toBe("resolved");
    expect(checked.entries.map(({ actor, payload }) => ({ actor, payload }))).toEqual([
      {
        actor: "user",
        payload: {
          ruleId: checked.rule.id,
          kind: KIND,
          match: BOT_IN_WEBSHOP,
          text: checked.rule.text,
        },
      },
    ]);
  });
});
