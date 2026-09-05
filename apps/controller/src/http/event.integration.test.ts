/**
 * The event log over HTTP: `GET /events` and `GET /events/{id}`.
 *
 * Every row these tests read was written by a request in the same test - a
 * task created through `POST /tasks`, a login refused through
 * `POST /auth/login` - because the log is only worth reading if what the API
 * did is what it holds.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { Event, type Task } from "@hydra/contract";
import { uuidFromString } from "../db";
import { completeSetup, get, post, send, USERNAME, withServer } from "./testing";

/** One page of the log, as the wire hands it back. */
interface EventPage {
  readonly items: ReadonlyArray<Record<string, unknown>>;
  readonly nextCursor?: string;
}

const events = async (base: string, token: string, query = ""): Promise<EventPage> => {
  const response = await get(base, `/api/v1/events${query}`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as EventPage;
};

const createTask = async (base: string, token: string, title: string): Promise<Task> => {
  const response = await post(base, "/api/v1/tasks", { title, description: "" }, token);
  expect(response.status).toBe(200);
  return (await response.json()) as Task;
};

/** A login that cannot succeed, which is what writes an `auth.login.failed` row. */
const failLogin = async (base: string): Promise<void> => {
  const response = await send("POST", base, "/api/v1/auth/login", {
    body: { username: USERNAME, password: "not the password" },
  });
  expect(response.status).toBe(401);
};

/** An instant strictly between two batches of writes, for `since` and `until`. */
const between = async (): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const now = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return now;
};

const kinds = (page: EventPage): ReadonlyArray<unknown> => page.items.map((item) => item.kind);

/** The titles of the tasks a page of `task.created` rows describes. */
const titlesOf = (page: EventPage): ReadonlyArray<string | undefined> =>
  page.items.map((item) => (item.payload as { task?: { title?: string } }).task?.title);

const ids = (page: EventPage): ReadonlyArray<number> => page.items.map((item) => item.id as number);

describe("the event log over HTTP", () => {
  it("returns both populations from one unfiltered call, told apart only by kind", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await createTask(base, token, "a task the log should hold");
      await failLogin(base);

      const page = await events(base, token, "?limit=500");
      const created = page.items.find((item) => item.kind === "task.created");
      const failed = page.items.find((item) => item.kind === "auth.login.failed");
      expect(created).toBeDefined();
      expect(failed).toBeDefined();

      // Nothing but `kind` separates the two populations: same source, same
      // absent connection, same envelope.
      expect(created).toMatchObject({ source: "platform", connectionId: null });
      expect(failed).toMatchObject({ source: "platform", connectionId: null });

      // Every row decodes as the contract's Event, actor included.
      for (const item of page.items) {
        const decoded = Schema.decodeUnknownExit(Event)(item);
        expect(decoded._tag, JSON.stringify(item)).toBe("Success");
      }
    });
  });

  it("filters by kind", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await createTask(base, token, "one");
      await createTask(base, token, "two");
      await failLogin(base);

      const created = await events(base, token, "?kind=task.created");
      expect(created.items).toHaveLength(2);
      expect(new Set(kinds(created))).toEqual(new Set(["task.created"]));

      const failed = await events(base, token, "?kind=auth.login.failed");
      expect(failed.items).toHaveLength(1);

      const none = await events(base, token, "?kind=task.exploded");
      expect(none.items).toEqual([]);
    });
  });

  it("filters by since and until, and by the two together", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await createTask(base, token, "before the boundary");
      const boundary = await between();
      await createTask(base, token, "after the boundary");

      const after = await events(base, token, `?kind=task.created&since=${boundary}`);
      expect(titlesOf(after)).toEqual(["after the boundary"]);

      const before = await events(base, token, `?kind=task.created&until=${boundary}`);
      expect(titlesOf(before)).toEqual(["before the boundary"]);

      const both = await events(
        base,
        token,
        `?kind=task.created&since=1970-01-01T00:00:00.000Z&until=2999-01-01T00:00:00.000Z`,
      );
      expect(both.items).toHaveLength(2);

      const window = await events(
        base,
        token,
        `?since=2999-01-01T00:00:00.000Z&until=2999-01-02T00:00:00.000Z`,
      );
      expect(window.items).toEqual([]);
    });
  });

  it("filters by connectionId, which no platform row carries", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await createTask(base, token, "a task through no connection");

      const unfiltered = await events(base, token, "?kind=task.created");
      expect(unfiltered.items).toHaveLength(1);

      const byConnection = await events(
        base,
        token,
        "?kind=task.created&connectionId=0199e0e7-1111-7000-8000-000000000000",
      );
      expect(byConnection.items).toEqual([]);
    });
  });

  it("finds a row that did arrive through a connection, and hands its id back", async () => {
    await withServer(async ({ base, sql }) => {
      const token = await completeSetup(base);
      // No operation writes a connection yet, so the row is written straight
      // to the table: the filter and the id it hands back are the reader's
      // either way, and ingest lands on top of them.
      const connectionId = "0199e0e7-1111-7000-8000-0000000000ab";
      await Effect.runPromise(
        Effect.orDie(
          sql`INSERT INTO events
                (source, connection_id, system, kind, occurred_at, received_at,
                 dedup_key, refs, url, payload, raw, actor)
              VALUES
                ('github', ${uuidFromString(connectionId)}, 'github', 'github.issue.opened',
                 '2026-09-04T10:00:00.000Z', '2026-09-04T10:00:01.000Z',
                 'issue-42', '["github:issue:owner/repo#42"]',
                 'https://github.com/owner/repo/issues/42', '{"number":42}', '{"raw":true}', NULL)`,
        ),
      );

      const page = await events(base, token, `?connectionId=${connectionId}`);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        source: "github",
        connectionId,
        kind: "github.issue.opened",
        refs: ["github:issue:owner/repo#42"],
        url: "https://github.com/owner/repo/issues/42",
        payload: { number: 42 },
        raw: { raw: true },
        actor: null,
      });
      expect(Schema.decodeUnknownExit(Event)(page.items[0])._tag).toBe("Success");
    });
  });

  it("reads one row by its integer id, and answers not_found for one nobody has", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await createTask(base, token, "readable");

      const page = await events(base, token, "?kind=task.created");
      const id = ids(page)[0];
      expect(typeof id).toBe("number");
      expect(Number.isInteger(id)).toBe(true);

      const read = await get(base, `/api/v1/events/${String(id)}`, token);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(page.items[0]);

      const missing = await get(base, "/api/v1/events/999999", token);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});

describe("the event log's order and paging", () => {
  it("defaults to id desc and accepts id as its only sort field", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await createTask(base, token, "one");
      await createTask(base, token, "two");
      await createTask(base, token, "three");

      const byDefault = await events(base, token, "?kind=task.created");
      const descending = ids(byDefault);
      expect(descending).toEqual([...descending].sort((a, b) => b - a));
      expect(descending).toHaveLength(3);

      const explicit = await events(base, token, "?kind=task.created&sort=id:desc");
      expect(ids(explicit)).toEqual(descending);

      const ascending = await events(base, token, "?kind=task.created&sort=id:asc");
      expect(ids(ascending)).toEqual([...descending].reverse());

      const unknown = await get(base, "/api/v1/events?sort=receivedAt", token);
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toMatchObject({ error: { code: "validation" } });
    });
  });

  it("walks seven rows at limit 2, returning each exactly once", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      for (let index = 0; index < 7; index++) {
        await createTask(base, token, `task ${String(index)}`);
      }

      const seen: Array<number> = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const query = `?kind=task.created&limit=2${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
        const result = await events(base, token, query);
        expect(result.items.length).toBeLessThanOrEqual(2);
        seen.push(...ids(result));
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }

      expect(cursor).toBeUndefined();
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      expect(seen).toEqual([...seen].sort((a, b) => b - a));
    });
  });
});

describe("a failed login in the log", () => {
  it("stamps auth.login.failed with a null actor, and no row claims the user", async () => {
    await withServer(async ({ base, audit }) => {
      const token = await completeSetup(base);
      await failLogin(base);

      const page = await events(base, token, "?kind=auth.login.failed");
      expect(page.items).toHaveLength(1);
      const row = page.items[0]!;
      expect(row.actor).toBeNull();

      // The contract's Event decodes the null; nothing about the row is
      // special-cased on the way out.
      const decoded = Schema.decodeUnknownExit(Event)(row);
      expect(decoded._tag).toBe("Success");

      // Read through the writer as well, so a row that never reached the log
      // cannot pass by the reader answering an empty page.
      const written = await audit("auth.login.failed");
      expect(written).toHaveLength(1);
      expect(written[0]?.actor).toBeNull();
      expect(written.map((entry) => entry.actor)).not.toContain("user");
    });
  });
});
