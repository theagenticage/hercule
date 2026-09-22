/**
 * The two ways an event is written, over a real socket: `event.emit`, which
 * appends one manual event to the log, and `event.enrich`, which amends one
 * that is already there.
 *
 * The registry is the shipped github plugin, because both operations need a
 * real kind catalog: an emit is validated against the payload schema the plugin
 * declared, and the event's `system` is the bare id of the plugin that owns the
 * kind. Nothing is arranged behind the API - every event these tests read back
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
  readRefusal,
  send,
  USERNAME,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";
import {
  agentOn,
  createProfile,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../sessions/testing";

/** Two, because the cases on a fleet stand a machine up and then a session. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/** A kind the shipped roster holds, and a payload its schema accepts. */
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

/** An id shaped the way every Hercule id is, that nothing was created under. */
const NOBODY = "0199e0e7-9999-7000-8000-000000000000";

const emit = (base: string, token: string, body: unknown): Promise<Response> =>
  post(base, "/api/v1/events/emit", body, token);

/** Emits and asserts it was taken, for the cases whose subject is something else. */
const emitted = async (base: string, token: string, body: unknown): Promise<number> => {
  const response = await emit(base, token, body);
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as { readonly eventId: number }).eventId;
};

const enrich = (base: string, token: string, id: number, body: unknown): Promise<Response> =>
  post(base, `/api/v1/events/${String(id)}/enrich`, body, token);

const enriched = async (
  base: string,
  token: string,
  id: number,
  body: unknown,
): Promise<Response> => {
  const response = await enrich(base, token, id, body);
  expect(response.ok, await response.clone().text()).toBe(true);
  return response;
};

const readEvent = async (base: string, token: string, id: number): Promise<Event> => {
  const response = await get(base, `/api/v1/events/${String(id)}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Event;
};

/** Every entry the log holds of one kind, which is how "no row" is asserted. */
const eventsOfKind = async (
  base: string,
  token: string,
  kind: string,
): Promise<ReadonlyArray<Event>> => {
  const response = await get(base, `/api/v1/events?kind=${kind}&limit=100`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly items: ReadonlyArray<Event> }).items;
};

/**
 * How many events an emit has written. The log holds audit entries too - the
 * boot and the setup leave their own - so the count is of the population this
 * operation writes to, not of the table.
 */
const manualEvents = (sql: ServerHarness["sql"]): Promise<number> =>
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

/** A controller holding the kind catalog, and the user's own credential. */
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
 * The fleet the two refusal cases need: a session token is the only credential
 * whose grants are a chosen set, so it is the only way to hold a credential
 * that lacks `event.emit`. The github plugin rides along, because the call that
 * is refused must otherwise be a call that would have worked.
 */
const PROVIDER = providerDefinition("full-provider", { token: "t" });

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

const registry = (): ReadonlyArray<Plugin> => [
  fixture({ id: "providers", definitions: [PROVIDER] }).plugin,
  github,
];

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, { plugins: registry(), facts: FACTS, models: MODELS });

/** A session on a profile that reads the log and may not write to it. */
const reader = async (arranged: Arranged): Promise<string> => {
  const profile = await createProfile(arranged, "log-reader", ["event.read"]);
  return (await agentOn(arranged, profile)).token;
};

describe("POST /events/emit", () => {
  it("stamps the core's own fields on the event and keeps what the caller gave", async () => {
    await withEvents(async ({ base }, token) => {
      const before = Date.now();

      const eventId = await emitted(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF],
        dedupKey: "issue-42-opened",
      });

      expect(eventId).toEqual(expect.any(Number));
      const event = await readEvent(base, token, eventId);
      expect(event.id).toBe(eventId);
      // The core's own stamps: who, from where, and about what system.
      expect(event.source).toBe("manual");
      expect(event.actor).toBe("user");
      expect(event.system).toBe("github");
      expect(event.url).toBeNull();
      expect(event.connectionId).toBeNull();
      // Neither instant is an input, and one emit is one moment, so the two
      // agree to within the second the request took.
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

  it("refuses a kind nothing registered, naming it, and writes no event", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const response = await emit(base, token, {
        kind: "acme.nothing.happened",
        payload: PAYLOAD,
      });

      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.text).toContain("acme.nothing.happened");
      expect(await eventsOfKind(base, token, "acme.nothing.happened")).toEqual([]);
      expect(await manualEvents(sql)).toBe(0);
    });
  });

  it("refuses a payload the kind's schema turns down, listing the paths, and writes no event", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const response = await emit(base, token, {
        kind: KIND,
        payload: { subject: { repo: 42 } },
      });

      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues.length).toBeGreaterThan(0);
      expect(refusal.issues.flat()).toContain("subject");
      expect(await eventsOfKind(base, token, KIND)).toEqual([]);
      expect(await manualEvents(sql)).toBe(0);
    });
  });

  it("refuses a ref that is not an external ref, naming it, and writes no event", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const response = await emit(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF, "not-an-external-ref"],
      });

      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.text).toContain("not-an-external-ref");
      expect(await manualEvents(sql)).toBe(0);
    });
  });

  it("refuses a connection nothing holds, naming it, and writes no event", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const response = await emit(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        connectionId: NOBODY,
      });

      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      expect(refusal.text).toContain(NOBODY);
      expect(await manualEvents(sql)).toBe(0);
    });
  });

  it("answers the first event's id when the same dedup key comes again", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const body = { kind: KIND, payload: PAYLOAD, dedupKey: "issue-42-opened" };

      const first = await emitted(base, token, body);
      const again = await emitted(base, token, body);

      expect(again).toBe(first);
      expect(await manualEvents(sql)).toBe(1);
    });
  });

  it("mints a dedup key of its own when none is given, so two emits are two events", async () => {
    await withEvents(async ({ base, sql }, token) => {
      const body = { kind: KIND, payload: PAYLOAD, refs: [REF] };

      const first = await emitted(base, token, body);
      const second = await emitted(base, token, body);

      expect(second).not.toBe(first);
      expect(await manualEvents(sql)).toBe(2);
      const one = await readEvent(base, token, first);
      const other = await readEvent(base, token, second);
      expect(one.dedupKey.length).toBeGreaterThan(0);
      expect(other.dedupKey).not.toBe(one.dedupKey);
    });
  });

  it("refuses a credential that was never given event.emit, naming the grant", async () => {
    await withFleet(async (arranged) => {
      const base = arranged.harness.base;
      const token = await reader(arranged);

      const response = await emit(base, token, { kind: KIND, payload: PAYLOAD });

      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(403);
      expect(refusal.code).toBe("forbidden");
      expect(refusal.grant).toBe("event.emit");
      expect(await eventsOfKind(base, arranged.token, KIND)).toEqual([]);
    });
  });
});

describe("POST /events/:id/enrich", () => {
  it("overwrites the system and the url that were given, and leaves the rest as it was", async () => {
    await withEvents(async ({ base }, token) => {
      const eventId = await emitted(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF],
        dedupKey: "issue-42-opened",
      });
      const before = await readEvent(base, token, eventId);

      await enriched(base, token, eventId, {
        system: "sentry",
        url: "https://sentry.io/issues/123",
        refs: ["sentry:issue:123"],
      });

      const after = await readEvent(base, token, eventId);
      expect(after.system).toBe("sentry");
      expect(after.url).toBe("https://sentry.io/issues/123");
      // What enrichment never touches, field for field.
      expect(after.kind).toBe(before.kind);
      expect(after.source).toBe(before.source);
      expect(after.occurredAt).toBe(before.occurredAt);
      expect(after.payload).toEqual(before.payload);
      expect(after.raw).toEqual(before.raw);
      expect(JSON.stringify(after.payload)).toBe(JSON.stringify(before.payload));
    });
  });

  it("unions the refs, keeping the old ones and adding no duplicate", async () => {
    await withEvents(async ({ base }, token) => {
      const eventId = await emitted(base, token, {
        kind: KIND,
        payload: PAYLOAD,
        refs: [REF],
      });

      await enriched(base, token, eventId, { refs: [REF, SECOND_REF] });

      const after = await readEvent(base, token, eventId);
      expect([...after.refs].sort()).toEqual([REF, SECOND_REF].sort());
    });
  });

  it("leaves the system and the url alone when neither is given", async () => {
    await withEvents(async ({ base }, token) => {
      const eventId = await emitted(base, token, { kind: KIND, payload: PAYLOAD, refs: [REF] });
      const before = await readEvent(base, token, eventId);

      await enriched(base, token, eventId, { refs: [SECOND_REF] });

      const after = await readEvent(base, token, eventId);
      expect(after.system).toBe(before.system);
      expect(after.url).toBe(before.url);
      expect([...after.refs].sort()).toEqual([REF, SECOND_REF].sort());
    });
  });

  it("answers not_found for an id the log does not hold", async () => {
    await withEvents(async ({ base }, token) => {
      const eventId = await emitted(base, token, { kind: KIND, payload: PAYLOAD });

      const response = await enrich(base, token, eventId + 1000, { system: "sentry" });

      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
    });
  });

  /**
   * The log holds two populations. An audit entry is the record of a mutation,
   * and enrichment is a pipeline-event operation, so one is refused exactly as
   * an id naming nothing is: a caller holding only `event.emit` must not learn
   * through this route what the log holds or what a security entry says.
   */
  it("answers not_found for an audit entry, and leaves the entry as it was", async () => {
    await withEvents(async ({ base, audit }, token) => {
      const before = (await audit("setup.completed"))[0]!;

      const response = await enrich(base, token, before.id, {
        system: "sentry",
        refs: ["sentry:issue:123"],
      });

      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      const after = await readEvent(base, token, before.id);
      expect(after.system).toBe("platform");
      expect(after.refs).toEqual([]);
    });
  });

  /**
   * The security entries are the population a session without `event.audit`
   * cannot read at all, so the refusal has to hold for them by the same rule
   * and not by luck: amending one would both rewrite what happened to the
   * user's account and tell the caller it is there.
   */
  it("answers not_found for a security entry too, and leaves it as it was", async () => {
    await withEvents(async ({ base, audit }, token) => {
      // A login that cannot succeed is what writes one of these.
      const refusedLogin = await send("POST", base, "/api/v1/auth/login", {
        body: { username: USERNAME, password: "not the password" },
      });
      expect(refusedLogin.status).toBe(401);
      const before = (await audit("auth.login.failed"))[0]!;

      const response = await enrich(base, token, before.id, {
        url: "https://example.test/rewritten",
        refs: ["sentry:issue:123"],
      });

      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      const after = await readEvent(base, token, before.id);
      expect(after.url).toBeNull();
      expect(after.refs).toEqual([]);
    });
  });

  it("stamps the amendment with the caller, as an audit entry beside the event", async () => {
    await withEvents(async ({ base, sql, audit }, token) => {
      const eventId = await emitted(base, token, { kind: KIND, payload: PAYLOAD, refs: [REF] });

      await enriched(base, token, eventId, {
        url: "https://sentry.io/issues/123",
        refs: [SECOND_REF],
      });

      const entries = await audit("event.enriched");
      expect(entries).toHaveLength(1);
      // The event keeps the emitter as its actor, so who amended it is read
      // here and nowhere else.
      expect(entries[0]!.actor).toBe("user");
      expect(entries[0]!.payload).toEqual({
        eventId,
        url: "https://sentry.io/issues/123",
        refs: [SECOND_REF],
      });
      // The entry names only what was amended: `system` was not given.
      expect(entries[0]!.payload["system"]).toBeUndefined();

      // The entry is an audit kind, so it is not one of the events the matcher
      // evaluates: the manual population still holds the one emit above.
      expect(await manualEvents(sql)).toBe(1);
      const entry = await readEvent(base, token, entries[0]!.id);
      expect(entry.source).toBe("platform");
    });
  });

  it("refuses a credential that was never given event.emit, naming the grant", async () => {
    await withFleet(async (arranged) => {
      const base = arranged.harness.base;
      const eventId = await emitted(base, arranged.token, { kind: KIND, payload: PAYLOAD });
      const token = await reader(arranged);

      const response = await enrich(base, token, eventId, { system: "sentry" });

      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(403);
      expect(refusal.code).toBe("forbidden");
      expect(refusal.grant).toBe("event.emit");
      expect((await readEvent(base, arranged.token, eventId)).system).toBe("github");
    });
  });
});
