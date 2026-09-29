/**
 * Tests the two ways an event is written, over a real socket: `event.emit`,
 * which appends one manual event to the log, and `event.enrich`, which amends
 * an event that is already there.
 *
 * The tests load the shipped github plugin, because both operations need a
 * real kind catalog: an emit is validated against the payload schema the plugin
 * declared, and the event's `system` is the bare id of the plugin that owns the
 * kind. Nothing is arranged behind the API: every event these tests read back
 * is fetched through `event.read`, the way any client reads one.
 */
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import type { Event } from "@hercule/contract";
import type { ModelDescriptor, RunnerFacts } from "@hercule/protocol";
import type { Plugin } from "@hercule/plugin-host";
import { github } from "@hercule/plugin-github";
import {
  completeSetup,
  get,
  post,
  readErrorBody,
  send,
  USERNAME,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import { readEvent } from "./testing";
import {
  spawnAgentUnder,
  createProfile,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../sessions/testing";

/** Twice the wait deadline, because the fleet cases start a runner and then a session. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/** A kind the shipped github plugin declares, and a payload its schema accepts. */
const KIND = "github.issue.opened";

const SUBJECT = {
  repo: "octo/repo",
  number: 42,
  title: "The lid does not close",
  author: "octocat",
  state: "open",
  url: "https://github.com/octo/repo/issues/42",
} as const;

const PAYLOAD = { subject: SUBJECT } as const;

const REF = "github:issue:octo/repo#42";
const SECOND_REF = "github:repo:octo/repo";

/** A well-formed id that matches no record. */
const NOBODY = "0199e0e7-9999-7000-8000-000000000000";

const emit = (base: string, token: string, body: unknown): Promise<Response> =>
  post(base, "/api/v1/events/emit", body, token);

/** Emits an event, asserts that it succeeded, and returns its id. */
const emitEventOrFail = async (base: string, token: string, body: unknown): Promise<number> => {
  const response = await emit(base, token, body);
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as { readonly eventId: number }).eventId;
};

const enrich = (base: string, token: string, id: number, body: unknown): Promise<Response> =>
  post(base, `/api/v1/events/${String(id)}/enrich`, body, token);

const enrichEventOrFail = async (
  base: string,
  token: string,
  id: number,
  body: unknown,
): Promise<Response> => {
  const response = await enrich(base, token, id, body);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response;
};

/** Returns every entry of one kind in the log, to assert that no row was written. */
const listEventsOfKind = async (
  base: string,
  token: string,
  kind: string,
): Promise<ReadonlyArray<Event>> => {
  const response = await get(base, `/api/v1/events?kind=${kind}&limit=100`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly items: ReadonlyArray<Event> }).items;
};

/**
 * Returns how many manual events are in the log. The log holds audit entries
 * too, written by the boot and the setup, so the count covers only the rows an
 * emit writes, not the whole table.
 */
const countManualEvents = (sql: ServerHarness["sql"]): Promise<number> =>
  Effect.runPromise(
    Effect.orDie(
      Effect.map(
        sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM events WHERE source = 'manual'`,
        (rows) => rows[0]?.count ?? 0,
      ),
    ),
  );

/** Runs `body` against a controller with the github plugin, using the user's credential. */
const withEvents = (
  body: (harness: ServerHarness, token: string) => Promise<void>,
): Promise<void> =>
  withServer(
    async (harness) => {
      const token = await completeSetup(harness.base);
      await body(harness, token);
    },
    { plugins: [github] },
  );

/**
 * The fleet that the two missing-grant cases need. A session token is the only
 * credential whose grants can be chosen, so it is the only way to get a
 * credential without `event.emit`. The github plugin is loaded too, because the
 * rejected call must be one that would otherwise have worked.
 */
const PROVIDER = buildProviderDefinition("full-provider", { token: "t" });

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["full-provider"],
  identityPort: 4939,
};

const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "fast", name: "Fast", isDefault: true, options: [] },
];

const buildPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({ id: "providers", definitions: [PROVIDER] }).plugin,
  github,
];

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, { plugins: buildPlugins(), facts: FACTS, models: MODELS });

/** A session on a profile that reads the log and may not write to it. */
const spawnLogReader = async (arranged: Arranged): Promise<string> => {
  const profile = await createProfile(arranged, "log-reader", ["event.read"]);
  return (await spawnAgentUnder(arranged, profile)).token;
};

describe("POST /events/emit", () => {
  it("sets the controller's own fields on the event and keeps what the caller gave", async () => {
    await withEvents(async ({ base }, token) => {
      const before = Date.now();

      const eventId = await emitEventOrFail(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF],
        dedupKey: "issue-42-opened",
      });

      expect(eventId).toEqual(expect.any(Number));
      const event = await readEvent(base, token, eventId);
      expect(event.id).toBe(eventId);
      // The fields the controller sets: who, from where, and about what system.
      expect(event.source).toBe("manual");
      expect(event.actor).toBe("user");
      expect(event.system).toBe("github");
      expect(event.url).toBeNull();
      expect(event.connectionId).toBeNull();
      // Neither time is an input: the controller sets both when the post
      // arrives, so both fall within the time the request took.
      const occurred = Date.parse(event.occurredAt);
      const received = Date.parse(event.receivedAt);
      expect(Number.isNaN(occurred)).toBe(false);
      expect(Number.isNaN(received)).toBe(false);
      expect(occurred).toBeGreaterThanOrEqual(before - 1000);
      expect(Math.abs(received - occurred)).toBeLessThan(1000);
      // And what the caller handed over, unchanged.
      expect(event.kind).toBe(KIND);
      expect(event.payload).toEqual(PAYLOAD);
      expect(event.refs).toEqual([REF]);
      expect(event.dedupKey).toBe("issue-42-opened");
    });
  });

  it("rejects a kind that no plugin declares, names it, and writes no event", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const response = await emit(base, token, {
        kind: "acme.nothing.happened",
        payload: PAYLOAD,
      });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.text).toContain("acme.nothing.happened");
      expect(await listEventsOfKind(base, token, "acme.nothing.happened")).toEqual([]);
      expect(await countManualEvents(sql)).toBe(0);
    });
  });

  it("rejects a payload that fails the kind's schema, lists the paths, and writes no event", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const response = await emit(base, token, {
        kind: KIND,
        payload: { subject: { repo: 42 } },
      });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues.length).toBeGreaterThan(0);
      expect(refusal.issues.flat()).toContain("subject");
      expect(await listEventsOfKind(base, token, KIND)).toEqual([]);
      expect(await countManualEvents(sql)).toBe(0);
    });
  });

  it("rejects a ref that is not an external ref, names it, and writes no event", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const response = await emit(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF, "not-an-external-ref"],
      });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.text).toContain("not-an-external-ref");
      expect(await countManualEvents(sql)).toBe(0);
    });
  });

  it("rejects a connection id that does not exist, names it, and writes no event", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const response = await emit(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        connectionId: NOBODY,
      });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      expect(refusal.text).toContain(NOBODY);
      expect(await countManualEvents(sql)).toBe(0);
    });
  });

  it("returns the first event's id when the same dedup key is sent again", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const body = { kind: KIND, payload: PAYLOAD, dedupKey: "issue-42-opened" };

      const first = await emitEventOrFail(base, token, body);
      const again = await emitEventOrFail(base, token, body);

      expect(again).toBe(first);
      expect(await countManualEvents(sql)).toBe(1);
    });
  });

  it("generates a dedup key when none is given, so two emits are two events", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const body = { kind: KIND, payload: PAYLOAD, refs: [REF] };

      const first = await emitEventOrFail(base, token, body);
      const second = await emitEventOrFail(base, token, body);

      expect(second).not.toBe(first);
      expect(await countManualEvents(sql)).toBe(2);
      const one = await readEvent(base, token, first);
      const other = await readEvent(base, token, second);
      expect(one.dedupKey.length).toBeGreaterThan(0);
      expect(other.dedupKey).not.toBe(one.dedupKey);
    });
  });

  it("rejects a credential without the event.emit grant, and names the grant", async () => {
    await withFleet(async (arranged) => {
      const base = arranged.harness.base;
      const token = await spawnLogReader(arranged);

      const response = await emit(base, token, { kind: KIND, payload: PAYLOAD });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(403);
      expect(refusal.code).toBe("forbidden");
      expect(refusal.grant).toBe("event.emit");
      expect(await listEventsOfKind(base, arranged.token, KIND)).toEqual([]);
    });
  });
});

describe("POST /events/:id/enrich", () => {
  it("overwrites the given system and url, and leaves the rest unchanged", async () => {
    await withEvents(async ({ base }, token) => {
      const eventId = await emitEventOrFail(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF],
        dedupKey: "issue-42-opened",
      });
      const before = await readEvent(base, token, eventId);

      await enrichEventOrFail(base, token, eventId, {
        system: "sentry",
        url: "https://sentry.io/issues/123",
        refs: ["sentry:issue:123"],
      });

      const after = await readEvent(base, token, eventId);
      expect(after.system).toBe("sentry");
      expect(after.url).toBe("https://sentry.io/issues/123");
      // The fields enrichment never changes.
      expect(after.kind).toBe(before.kind);
      expect(after.source).toBe(before.source);
      expect(after.occurredAt).toBe(before.occurredAt);
      expect(after.payload).toEqual(before.payload);
      expect(after.raw).toEqual(before.raw);
      expect(JSON.stringify(after.payload)).toBe(JSON.stringify(before.payload));
    });
  });

  it("adds the new refs to the old ones, without duplicates", async () => {
    await withEvents(async ({ base }, token) => {
      const eventId = await emitEventOrFail(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF],
      });

      await enrichEventOrFail(base, token, eventId, { refs: [REF, SECOND_REF] });

      const after = await readEvent(base, token, eventId);
      expect([...after.refs].sort()).toEqual([REF, SECOND_REF].sort());
    });
  });

  it("leaves the system and the url alone when neither is given", async () => {
    await withEvents(async ({ base }, token) => {
      const eventId = await emitEventOrFail(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF],
      });
      const before = await readEvent(base, token, eventId);

      await enrichEventOrFail(base, token, eventId, { refs: [SECOND_REF] });

      const after = await readEvent(base, token, eventId);
      expect(after.system).toBe(before.system);
      expect(after.url).toBe(before.url);
      expect([...after.refs].sort()).toEqual([REF, SECOND_REF].sort());
    });
  });

  it("returns not_found for an id that is not in the log", async () => {
    await withEvents(async ({ base }, token) => {
      const eventId = await emitEventOrFail(base, token, { kind: KIND, payload: PAYLOAD });

      const response = await enrich(base, token, eventId + 1000, { system: "sentry" });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
    });
  });

  /**
   * The log holds pipeline events and audit entries. An audit entry records a
   * mutation, and enrichment works only on pipeline events, so an audit entry
   * fails exactly like an id that matches nothing. A caller holding only
   * `event.emit` must not learn through this route what the log holds or what
   * a security entry contains.
   */
  it("returns not_found for an audit entry, and leaves the entry unchanged", async () => {
    await withEvents(async ({ base, audit }, token) => {
      const before = (await audit("setup.completed"))[0]!;

      const response = await enrich(base, token, before.id, {
        system: "sentry",
        refs: ["sentry:issue:123"],
      });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      const after = await readEvent(base, token, before.id);
      expect(after.system).toBe("platform");
      expect(after.refs).toEqual([]);
    });
  });

  /**
   * A session without `event.audit` cannot read the security entries at all,
   * so the same rule must reject them too, and not by luck. Amending one would
   * rewrite what happened to the user's account and also tell the caller that
   * the entry exists.
   */
  it("returns not_found for a security entry too, and leaves it unchanged", async () => {
    await withEvents(async ({ base, audit }, token) => {
      // A failed login writes one of these entries.
      const refusedLogin = await send("POST", base, "/api/v1/auth/login", {
        body: { username: USERNAME, password: "not the password" },
      });
      expect(refusedLogin.status).toBe(401);
      const before = (await audit("auth.login.failed"))[0]!;

      const response = await enrich(base, token, before.id, {
        url: "https://example.test/rewritten",
        refs: ["sentry:issue:123"],
      });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      const after = await readEvent(base, token, before.id);
      expect(after.url).toBeNull();
      expect(after.refs).toEqual([]);
    });
  });

  /**
   * A platform event is routed, unlike an audit entry, so an added ref would
   * make it match subscriptions it was never about: a task's creation could
   * wake a session waiting on a pull request. It records what the controller
   * itself did, so it is refused exactly like an audit entry.
   */
  it("returns not_found for a platform event, and leaves it unchanged", async () => {
    await withEvents(async ({ base, platformEvents }, token) => {
      const created = await post(
        base,
        "/api/v1/tasks",
        { title: "Fix the lid", description: "" },
        token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const before = (await platformEvents("task.created"))[0]!;

      const response = await enrich(base, token, before.id, {
        url: "https://github.com/octo/repo/issues/42",
        refs: [REF],
      });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      const after = await readEvent(base, token, before.id);
      expect(after.kind).toBe("task.created");
      expect(after.url).toBeNull();
      expect(after.refs).toEqual([]);
    });
  });

  it("records the caller of the amendment in an audit entry beside the event", async () => {
    await withEvents(async ({ base, sql, audit }, token) => {
      const eventId = await emitEventOrFail(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF],
      });

      await enrichEventOrFail(base, token, eventId, {
        url: "https://sentry.io/issues/123",
        refs: [SECOND_REF],
      });

      const entries = await audit("event.enriched");
      expect(entries).toHaveLength(1);
      // The event keeps the emitter as its actor, so the audit entry is the
      // only place that records who amended it.
      expect(entries[0]!.actor).toBe("user");
      expect(entries[0]!.payload).toEqual({
        eventId,
        url: "https://sentry.io/issues/123",
        refs: [SECOND_REF],
      });
      // The entry names only what was amended: `system` was not given.
      expect(entries[0]!.payload["system"]).toBeUndefined();

      // The entry is an audit kind, so the router does not evaluate it: there
      // is still only the one manual event emitted above.
      expect(await countManualEvents(sql)).toBe(1);
      const entry = await readEvent(base, token, entries[0]!.id);
      expect(entry.source).toBe("platform");
    });
  });

  it("rejects a credential without the event.emit grant, and names the grant", async () => {
    await withFleet(async (arranged) => {
      const base = arranged.harness.base;
      const eventId = await emitEventOrFail(base, arranged.token, { kind: KIND, payload: PAYLOAD });
      const token = await spawnLogReader(arranged);

      const response = await enrich(base, token, eventId, { system: "sentry" });

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(403);
      expect(refusal.code).toBe("forbidden");
      expect(refusal.grant).toBe("event.emit");
      expect((await readEvent(base, arranged.token, eventId)).system).toBe("github");
    });
  });
});
