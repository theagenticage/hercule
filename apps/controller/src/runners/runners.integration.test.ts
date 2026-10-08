/**
 * Tests for the runner operations over a real HTTP server: the fields a list
 * and a single runner return, what an update, a join, a lifecycle change and
 * a join token do over HTTP, and what an anonymous caller gets.
 *
 * Runners that do not join in a test are created with the harness's
 * `insertRunner`, which uses the real repository.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { RunnerFacts, SessionStart, SessionStop as SessionStopFrame } from "@hercule/protocol";
import type { Runner, RunnerDetail, Session } from "@hercule/contract";
import { uuidFromString } from "../db";
import { hashToken } from "../credentials";
import type { ServerHarness } from "../http/testing";
import { SETUP_TOKEN, completeSetup, del, get, post, send, withServer } from "../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import {
  listFrames,
  waitForFrames,
  reportEvent,
  waitUntil,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../sessions/testing";

interface RunnerPage {
  readonly items: ReadonlyArray<Runner>;
  readonly nextCursor?: string;
}

/** A valid id that matches no runner. */
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const listRunners = async (base: string, token: string, query = ""): Promise<RunnerPage> => {
  const response = await get(base, `/api/v1/runners${query}`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as RunnerPage;
};

const readRunner = async (base: string, token: string, id: string): Promise<RunnerDetail> => {
  const response = await get(base, `/api/v1/runners/${id}`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as RunnerDetail;
};

const patchRunner = (base: string, token: string, id: string, body: unknown): Promise<Response> =>
  send("PATCH", base, `/api/v1/runners/${id}`, { body, token });

/** Sends a lifecycle change, the way the runner page's buttons do. */
const moveRunner = (
  base: string,
  token: string,
  id: string,
  verb: string,
  body: unknown = {},
): Promise<Response> => send("POST", base, `/api/v1/runners/${id}/${verb}`, { body, token });

const listRunnerNames = (page: RunnerPage): ReadonlyArray<string> =>
  page.items.map((runner) => runner.name).sort();

/** The response a runner gets when it joins. */
interface JoinAnswer {
  readonly runnerId: string;
  readonly credential: string;
  readonly controllerIdentityId: string;
  readonly controllerPublicKey: string;
  readonly name: string;
}

/** Reads every row of a table, whatever its columns are. */
const readAllRows = (
  sql: ServerHarness["sql"],
  table: string,
): Promise<ReadonlyArray<Record<string, unknown>>> =>
  Effect.runPromise(
    Effect.orDie(sql.unsafe<Record<string, unknown>>(`SELECT rowid, * FROM ${table}`)),
  );

/**
 * Reads the join token rows as the database stores them.
 *
 * The table is found through the schema rather than named here, so the test
 * checks what the database really stores, not what this file guessed the table
 * is called.
 */
const readJoinTokenRows = async (
  sql: ServerHarness["sql"],
): Promise<{ readonly table: string; readonly rows: ReadonlyArray<Record<string, unknown>> }> => {
  const tables = await Effect.runPromise(
    Effect.orDie(
      sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%join%token%'`,
    ),
  );
  expect(
    tables.map((one) => one.name),
    "exactly one table holds the join tokens",
  ).toHaveLength(1);
  const table = tables[0]!.name;
  return { table, rows: await readAllRows(sql, table) };
};

/**
 * Moves the token's timestamps two hours back, because a test cannot wait an
 * hour. Both timestamps move together, so the row describes a token created
 * two hours ago that expired one hour ago. A token that expired before it was
 * created would fail the table's CHECK constraint.
 */
const expireJoinToken = async (sql: ServerHarness["sql"], id: string): Promise<void> => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const shiftTwoHoursBack = (at: string): string =>
    new Date(Date.parse(at) - TWO_HOURS).toISOString();
  const key = uuidFromString(id);
  const [row] = await Effect.runPromise(
    Effect.orDie(
      sql<{ readonly created_at: string; readonly expires_at: string }>`
        SELECT created_at, expires_at FROM runner_join_tokens WHERE id = ${key}`,
    ),
  );
  expect(row, `no join token row has the id ${id}`).toBeDefined();
  await Effect.runPromise(
    Effect.orDie(
      sql`
        UPDATE runner_join_tokens
        SET created_at = ${shiftTwoHoursBack(row!.created_at)}, expires_at = ${shiftTwoHoursBack(row!.expires_at)}
        WHERE id = ${key}`,
    ),
  );
};

/** Creates a join token the way the fleet page's "Add machine" dialog does. */
const mintJoinToken = async (
  base: string,
  token: string,
): Promise<{ readonly token: string; readonly expiresAt: string }> => {
  const response = await post(base, "/api/v1/runners/join-tokens", {}, token);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { token: string; expiresAt: string };
};

interface ListedJoinToken {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * Lists the join tokens that can still be spent, as the "Add machine" dialog
 * reads them. The list is not paged: a token lasts an hour and runners join
 * one at a time, so the list is always short.
 */
const listJoinTokens = async (
  base: string,
  token: string,
): Promise<ReadonlyArray<ListedJoinToken>> => {
  const response = await get(base, "/api/v1/runners/join-tokens", token);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  expect(Array.isArray(body), JSON.stringify(body)).toBe(true);
  return body as ReadonlyArray<ListedJoinToken>;
};

/** Revokes a join token, the way the Revoke button next to it does. */
const revokeJoinToken = (base: string, token: string, id: string): Promise<Response> =>
  del(base, `/api/v1/runners/join-tokens/${id}`, token);

/**
 * Returns the ids of the join tokens created so far, oldest first. Creating a
 * token returns the token and its expiry but not its id, and revoking needs
 * the id; the audit entry for the creation is where a caller can find it.
 */
const readMintedIds = async (harness: ServerHarness): Promise<ReadonlyArray<string>> =>
  (await harness.audit("runner.joinToken.minted")).map(
    (entry) => entry.payload["joinTokenId"] as string,
  );

/** Sends a join request, as a runner holding a join token does. */
const joinWith = (base: string, bearer: string, body: unknown): Promise<Response> =>
  send("POST", base, "/api/v1/runners/join", { body, token: bearer });

const join = (base: string, bearer: string): Promise<Response> => joinWith(base, bearer, {});

const enlist = async (base: string, bearer: string, body: unknown = {}): Promise<JoinAnswer> => {
  const response = await joinWith(base, bearer, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as JoinAnswer;
};

const patchController = (base: string, token: string, body: unknown): Promise<Response> =>
  send("PATCH", base, "/api/v1/controller", { body, token });

const countRunners = async (base: string, token: string): Promise<number> =>
  (await listRunners(base, token)).items.length;

const insertThreeRunners = async (harness: ServerHarness) => ({
  online: await harness.insertRunner({ name: "iris", connectivity: "online", labels: ["gpu"] }),
  offline: await harness.insertRunner({ name: "atlas", connectivity: "offline" }),
  retired: await harness.insertRunner({
    name: "vega",
    connectivity: "offline",
    lifecycle: "retired",
  }),
});

describe("GET /runners", () => {
  it("returns every runner in a page, with the fields the fleet page reads", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const { online } = await insertThreeRunners(harness);

      const page = await listRunners(harness.base, token);
      expect(listRunnerNames(page)).toEqual(["atlas", "iris", "vega"]);

      const row = page.items.find((runner) => runner.id === online.id);
      expect(row).toBeDefined();
      for (const field of [
        "id",
        "name",
        "connectivity",
        "lifecycle",
        "reserved",
        "version",
        "labels",
        "facts",
        "watermark",
        "maxConcurrentSessions",
        "lastSeenAt",
      ]) {
        expect(Object.keys(row ?? {}), `a listed runner carries ${field}`).toContain(field);
      }
      expect(Object.keys(row ?? {}), "the five-valued state is gone").not.toContain("state");
      expect(row).toMatchObject({
        id: online.id,
        name: "iris",
        connectivity: "online",
        lifecycle: "active",
        reserved: false,
        labels: ["gpu"],
        maxConcurrentSessions: 1,
      });
    });
  });

  it("filters by connectivity, by lifecycle and by label", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await insertThreeRunners(harness);

      expect(
        listRunnerNames(await listRunners(harness.base, token, "?connectivity=online")),
      ).toEqual(["iris"]);
      expect(listRunnerNames(await listRunners(harness.base, token, "?lifecycle=retired"))).toEqual(
        ["vega"],
      );
      expect(listRunnerNames(await listRunners(harness.base, token, "?lifecycle=active"))).toEqual([
        "atlas",
        "iris",
      ]);
      expect(listRunnerNames(await listRunners(harness.base, token, "?label=gpu"))).toEqual([
        "iris",
      ]);
      expect(
        listRunnerNames(await listRunners(harness.base, token, "?connectivity=online&label=gpu")),
      ).toEqual(["iris"]);
      expect(
        listRunnerNames(await listRunners(harness.base, token, "?connectivity=offline&label=gpu")),
      ).toEqual([]);
    });
  });

  it("pages by name, in the requested sort direction", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await insertThreeRunners(harness);

      expect(listRunnerNames(await listRunners(harness.base, token, "?sort=name:desc"))).toEqual([
        "atlas",
        "iris",
        "vega",
      ]);
      expect((await listRunners(harness.base, token, "?sort=name:desc")).items[0]?.name).toBe(
        "vega",
      );

      const first = await listRunners(harness.base, token, "?limit=2");
      expect(first.items.map((runner) => runner.name)).toEqual(["atlas", "iris"]);
      expect(first.nextCursor).toBeDefined();

      const rest = await listRunners(
        harness.base,
        token,
        `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
      );
      expect(rest.items.map((runner) => runner.name)).toEqual(["vega"]);
      expect(rest.nextCursor).toBeUndefined();

      // A cursor from one sort direction is not valid for the other.
      const crossed = await get(
        harness.base,
        `/api/v1/runners?sort=name:desc&cursor=${encodeURIComponent(first.nextCursor!)}`,
        token,
      );
      expect(crossed.status).toBe(400);
      expect(await crossed.json()).toMatchObject({ error: { code: "validation" } });
    });
  });

  it("rejects a connectivity or lifecycle value that belongs to the other field", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await insertThreeRunners(harness);

      // Each field has its own three values: `draining` is not a connectivity,
      // and `unreachable` is not a lifecycle.
      for (const query of ["?connectivity=asleep", "?connectivity=draining", "?lifecycle=online"]) {
        const response = await get(harness.base, `/api/v1/runners${query}`, token);
        expect(response.status, query).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      }
    });
  });
});

describe("GET /runners/{id}", () => {
  it("returns the list's fields plus the negotiated capabilities and protocol version", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const { online } = await insertThreeRunners(harness);

      const row = await readRunner(harness.base, token, online.id);
      for (const field of [
        "id",
        "name",
        "connectivity",
        "lifecycle",
        "reserved",
        "version",
        "labels",
        "facts",
        "watermark",
        "maxConcurrentSessions",
        "lastSeenAt",
        "negotiatedCapabilities",
        "protocolVersion",
      ]) {
        expect(Object.keys(row), `a read runner carries ${field}`).toContain(field);
      }
      expect(Object.keys(row), "the five-valued state is gone").not.toContain("state");
      expect(row).toMatchObject({
        id: online.id,
        name: "iris",
        connectivity: "online",
        lifecycle: "active",
      });
    });
  });

  it("returns a reported value this build cannot decode as null", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const { online, offline } = await insertThreeRunners(harness);
      // A row written by a build that reported a different shape. The column
      // holds what a runner sent, so the fleet list has to survive such a row
      // rather than fail as a whole.
      await Effect.runPromise(
        Effect.orDie(
          harness.sql`UPDATE runners
                      SET facts = '{"os":42}',
                          watermark = 'not json at all',
                          negotiated_capabilities = '{"not":"a list"}'
                      WHERE id = ${uuidFromString(online.id)}`,
        ),
      );

      const row = await readRunner(harness.base, token, online.id);
      expect(row.facts).toBeNull();
      expect(row.watermark).toBeNull();
      expect(row.negotiatedCapabilities).toBeNull();

      const page = await listRunners(harness.base, token);
      expect(page.items.map((one) => one.id)).toContain(offline.id);
    });
  });

  it("returns not_found for an id that matches no runner, and validation for a string that is not an id", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      const unknown = await get(harness.base, `/api/v1/runners/${UNKNOWN_ID}`, token);
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });

      const malformed = await get(harness.base, "/api/v1/runners/not-a-runner-id", token);
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ error: { code: "validation" } });
    });
  });
});

describe("PATCH /runners/{id}", () => {
  it("changes only the field the patch names, and returns the updated runner", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({
        name: "iris",
        connectivity: "online",
        labels: ["gpu"],
        maxConcurrentSessions: 3,
      });

      const renamed = await patchRunner(harness.base, token, runner.id, { name: "iris-2" });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({
        id: runner.id,
        name: "iris-2",
        connectivity: "online",
        lifecycle: "active",
        labels: ["gpu"],
        maxConcurrentSessions: 3,
      });

      const relabelled = await patchRunner(harness.base, token, runner.id, {
        labels: ["cpu", "arm"],
      });
      expect(relabelled.status).toBe(200);
      expect(await relabelled.json()).toMatchObject({
        name: "iris-2",
        labels: ["cpu", "arm"],
        maxConcurrentSessions: 3,
      });

      const capped = await patchRunner(harness.base, token, runner.id, {
        maxConcurrentSessions: 8,
      });
      expect(capped.status).toBe(200);
      expect(await capped.json()).toMatchObject({
        name: "iris-2",
        labels: ["cpu", "arm"],
        maxConcurrentSessions: 8,
      });

      // The response matches the stored row.
      expect(await readRunner(harness.base, token, runner.id)).toMatchObject({
        name: "iris-2",
        labels: ["cpu", "arm"],
        maxConcurrentSessions: 8,
        connectivity: "online",
      });
    });
  });

  it("writes one audit entry per update, stamped with the user", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });

      expect((await patchRunner(harness.base, token, runner.id, { name: "iris-2" })).status).toBe(
        200,
      );

      const entries = await harness.audit("runner.updated");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
    });
  });

  it("writes nothing when the patch sends the values the runner already has", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({
        name: "iris",
        labels: ["gpu"],
        maxConcurrentSessions: 1,
      });

      const response = await patchRunner(harness.base, token, runner.id, {
        name: "iris",
        labels: ["gpu"],
        maxConcurrentSessions: 1,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ name: "iris", labels: ["gpu"] });
      expect(await harness.audit("runner.updated")).toHaveLength(0);
    });
  });

  it("rejects a patch with no fields", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });

      const response = await patchRunner(harness.base, token, runner.id, {});
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      expect(await harness.audit("runner.updated")).toHaveLength(0);
    });
  });

  it("rejects an empty name, a session cap below one, a disk watermark below one, and a label that is not a string", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris", labels: ["gpu"] });

      for (const body of [
        { name: "" },
        { maxConcurrentSessions: 0 },
        { diskWatermarkBytes: 0 },
        { labels: [7] },
      ]) {
        const response = await patchRunner(harness.base, token, runner.id, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      }

      expect(await readRunner(harness.base, token, runner.id)).toMatchObject({
        name: "iris",
        labels: ["gpu"],
      });
    });
  });

  it("rejects a patch that sets facts, state or the watermark", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris", connectivity: "online" });

      // Each one is sent next to a field the patch may set, so the error is for
      // the unknown key, not for an empty patch.
      for (const body of [
        { name: "iris-2", facts: { os: "linux" } },
        { name: "iris-2", connectivity: "unreachable" },
        { name: "iris-2", lifecycle: "retired" },
        { name: "iris-2", watermark: { diskFreeBytes: 1 } },
      ]) {
        const response = await patchRunner(harness.base, token, runner.id, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      }

      expect(await readRunner(harness.base, token, runner.id)).toMatchObject({
        name: "iris",
        connectivity: "online",
        lifecycle: "active",
      });
    });
  });
});

describe("the infra routes with no credential", () => {
  it("all return 401", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });

      const responses = [
        await send("GET", harness.base, "/api/v1/runners"),
        await send("GET", harness.base, `/api/v1/runners/${runner.id}`),
        await send("PATCH", harness.base, `/api/v1/runners/${runner.id}`, {
          body: { name: "iris-2" },
        }),
        await send("PATCH", harness.base, "/api/v1/controller", { body: {} }),
        await send("POST", harness.base, "/api/v1/runners/join-tokens", { body: {} }),
      ];

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: { code: "unauthenticated" } });
      }

      // No anonymous request changed anything.
      expect(await readRunner(harness.base, token, runner.id)).toMatchObject({ name: "iris" });
    });
  });
});

describe("POST /runners/join-tokens", () => {
  it("creates a new single-use token, valid for an hour, that the database never stores", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const before = Date.now();

      const first = await mintJoinToken(harness.base, token);
      const second = await mintJoinToken(harness.base, token);

      expect(first.token).not.toBe(second.token);
      for (const minted of [first, second]) {
        expect(typeof minted.token).toBe("string");
        expect(minted.token.length).toBeGreaterThan(0);
        const ahead = Date.parse(minted.expiresAt) - before;
        expect(ahead).toBeGreaterThan(59 * 60 * 1000);
        expect(ahead).toBeLessThanOrEqual(61 * 60 * 1000);
      }

      // The token is a bearer secret: whoever reads the database must not be
      // able to join with what they find there.
      const { rows } = await readJoinTokenRows(harness.sql);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          for (const minted of [first, second]) {
            expect(String(value), `${column} holds the token itself`).not.toContain(minted.token);
          }
        }
      }
    });
  });

  it("deletes the tokens that can no longer be spent", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const stale = await mintJoinToken(harness.base, token);
      await expireJoinToken(harness.sql, (await readMintedIds(harness))[0]!);

      // The "Add machine" dialog creates a token every time it opens, so
      // without this the table would grow every time somebody opened it.
      const fresh = await mintJoinToken(harness.base, token);
      const { rows } = await readJoinTokenRows(harness.sql);
      expect(rows).toHaveLength(1);

      expect((await join(harness.base, stale.token)).status).toBe(401);
      expect((await join(harness.base, fresh.token)).status).toBe(201);
    });
  });
});

describe("POST /runners/join", () => {
  it("joins a runner, returns a credential, and stores only the credential's hash", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const minted = await mintJoinToken(harness.base, token);

      const response = await send("POST", harness.base, "/api/v1/runners/join", {
        body: {},
        token: minted.token,
      });
      const body = await response.text();
      expect([200, 201], body).toContain(response.status);
      const answer = JSON.parse(body) as JoinAnswer;

      for (const field of [
        "runnerId",
        "credential",
        "controllerIdentityId",
        "controllerPublicKey",
        "name",
      ]) {
        expect(Object.keys(answer), `the join answer carries ${field}`).toContain(field);
      }
      expect(answer.credential.length).toBeGreaterThan(0);
      expect(answer.name.length).toBeGreaterThan(0);

      // The identity a runner pins is the one the controller publishes.
      const controller = (await (await get(harness.base, "/api/v1/controller", token)).json()) as {
        id: string;
        publicKey: string;
      };
      expect(answer.controllerIdentityId).toBe(controller.id);
      expect(answer.controllerPublicKey).toBe(controller.publicKey);

      // The runner has not connected yet, so it is `active` (its lifecycle)
      // and `offline` (its connectivity).
      const row = await readRunner(harness.base, token, answer.runnerId);
      expect(row).toMatchObject({
        id: answer.runnerId,
        name: answer.name,
        connectivity: "offline",
        lifecycle: "active",
        reserved: false,
      });
      expect(Object.keys(row), "the five-valued state is gone").not.toContain("state");

      const runnerRows = await readAllRows(harness.sql, "runners");
      expect(runnerRows).toHaveLength(1);
      for (const [column, value] of Object.entries(runnerRows[0]!)) {
        expect(String(value), `${column} holds the credential itself`).not.toContain(
          answer.credential,
        );
      }
    });
  });

  it("rejects a second use of the same token, and joins nothing", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const minted = await mintJoinToken(harness.base, token);

      expect((await join(harness.base, minted.token)).status).toBeLessThan(300);
      expect(await countRunners(harness.base, token)).toBe(1);

      const again = await join(harness.base, minted.token);
      expect(again.status).toBe(401);
      expect(await countRunners(harness.base, token)).toBe(1);
    });
  });

  it("rejects a token older than an hour, and joins nothing", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const minted = await mintJoinToken(harness.base, token);
      await expireJoinToken(harness.sql, (await readMintedIds(harness))[0]!);

      const response = await join(harness.base, minted.token);
      expect(response.status).toBe(401);
      expect(await countRunners(harness.base, token)).toBe(0);
    });
  });

  it("joins a second runner under a different name", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const first = JSON.parse(
        await (await join(harness.base, (await mintJoinToken(harness.base, token)).token)).text(),
      ) as JoinAnswer;
      const second = JSON.parse(
        await (await join(harness.base, (await mintJoinToken(harness.base, token)).token)).text(),
      ) as JoinAnswer;

      expect(second.runnerId).not.toBe(first.runnerId);
      expect(second.name).not.toBe(first.name);
      expect(second.credential).not.toBe(first.credential);
      expect(listRunnerNames(await listRunners(harness.base, token))).toEqual(
        [first.name, second.name].sort(),
      );
    });
  });

  it("makes the first runner the default runner, and does not change the default after that", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const readDefaultRunnerId = async (): Promise<string | null> =>
        (
          (await (await get(harness.base, "/api/v1/controller", token)).json()) as {
            defaultRunnerId: string | null;
          }
        ).defaultRunnerId;

      expect(await readDefaultRunnerId()).toBeNull();
      const first = JSON.parse(
        await (await join(harness.base, (await mintJoinToken(harness.base, token)).token)).text(),
      ) as JoinAnswer;
      expect(await readDefaultRunnerId()).toBe(first.runnerId);

      // A second runner does not replace an existing default, whether a person
      // chose it or the first join set it.
      const second = JSON.parse(
        await (await join(harness.base, (await mintJoinToken(harness.base, token)).token)).text(),
      ) as JoinAnswer;
      expect(second.runnerId).not.toBe(first.runnerId);
      expect(await readDefaultRunnerId()).toBe(first.runnerId);

      // Nor does it set one a person deliberately cleared: an empty default is
      // a choice, not a gap for the next runner to fill.
      await send("PATCH", harness.base, "/api/v1/controller", {
        body: { defaultRunnerId: null },
        token,
      });
      await join(harness.base, (await mintJoinToken(harness.base, token)).token);
      expect(await readDefaultRunnerId()).toBeNull();

      // The event log shows which join set the default and which did not. A
      // join is the only change to that setting no user asked for.
      const log = (await (await get(harness.base, "/api/v1/events", token)).json()) as {
        items: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>;
      };
      // The log is newest first; these are the three joins in the order they
      // happened.
      const joined = log.items.filter((entry) => entry.kind === "runner.joined").reverse();
      expect(joined.map((entry) => entry.payload["becameDefaultRunner"])).toEqual([
        true,
        false,
        false,
      ]);
    });
  });

  it("is reachable before Hercule has been set up, because the local runner joins then", async () => {
    await withServer(async (harness) => {
      const response = await join(harness.base, await harness.joinToken());
      expect(response.status, await response.clone().text()).toBe(201);

      // Every operation is still closed: setup has not happened.
      expect((await get(harness.base, "/api/v1/runners")).status).toBe(401);
    });
  });

  it("records the join with the system as the actor", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const minted = await mintJoinToken(harness.base, token);
      const answer = JSON.parse(
        await (await join(harness.base, minted.token)).text(),
      ) as JoinAnswer;

      // Read back over HTTP, because a `system` actor the event schema cannot
      // encode would fail the whole page, not just the row.
      const log = (await (await get(harness.base, "/api/v1/events", token)).json()) as {
        items: ReadonlyArray<{
          kind: string;
          actor: string | null;
          payload: Record<string, unknown>;
        }>;
      };
      const joined = log.items.find((entry) => entry.kind === "runner.joined");
      expect(joined).toBeDefined();
      expect(joined!.actor, "nobody holding a credential asked for this row").toBe("system");
      expect(joined!.payload).toMatchObject({ runnerId: answer.runnerId, name: answer.name });

      const mintedRow = log.items.find((entry) => entry.kind === "runner.joinToken.minted");
      expect(mintedRow).toBeDefined();
      expect(mintedRow!.actor).toBe("user");
      // Both entries name the same join token id, which lets the log show
      // which token let which runner join.
      expect(mintedRow!.payload["joinTokenId"]).toBe(joined!.payload["joinTokenId"]);
      for (const entry of log.items) {
        expect(JSON.stringify(entry.payload)).not.toContain(minted.token);
      }
    });
  });

  it("rejects an unknown token and a user credential, and joins nothing", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await mintJoinToken(harness.base, token);

      // A user's credential is not a join token: the two are separate, and a
      // credential that opens the API must not join a runner.
      for (const bearer of ["a-token-nobody-minted", token, SETUP_TOKEN]) {
        const response = await join(harness.base, bearer);
        expect(response.status, bearer).toBe(401);
      }
      expect(await countRunners(harness.base, token)).toBe(0);
    });
  });
});

describe("a runner that joins as a personal runner", () => {
  it("is reserved when its join says so, and is not when it does not", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      const reserved = await enlist(
        harness.base,
        (await mintJoinToken(harness.base, token)).token,
        {
          reserved: true,
        },
      );
      const plain = await enlist(
        harness.base,
        (await mintJoinToken(harness.base, token)).token,
        {},
      );
      const explicit = await enlist(
        harness.base,
        (await mintJoinToken(harness.base, token)).token,
        {
          reserved: false,
        },
      );

      expect((await readRunner(harness.base, token, reserved.runnerId)).reserved).toBe(true);
      expect((await readRunner(harness.base, token, plain.runnerId)).reserved).toBe(false);
      expect((await readRunner(harness.base, token, explicit.runnerId)).reserved).toBe(false);
    });
  });

  it("is never made the fleet default, even when it is the first runner to join", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      // The default runner gets work that names no runner, which a reserved
      // runner must never get. An empty fleet is no reason to create a
      // reserved default, which the other rules forbid.
      const first = await enlist(harness.base, (await mintJoinToken(harness.base, token)).token, {
        reserved: true,
      });

      const controller = (await (await get(harness.base, "/api/v1/controller", token)).json()) as {
        defaultRunnerId: string | null;
      };
      expect(controller.defaultRunnerId).toBeNull();
      expect((await readRunner(harness.base, token, first.runnerId)).reserved).toBe(true);
    });
  });

  it("rejects a join body with an unknown key", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      // Otherwise a misspelled key would join a shared runner while its owner
      // believes they asked for a personal one.
      for (const body of ["", "not json", { reserved: "yes" }, { reservd: true }]) {
        const minted = await mintJoinToken(harness.base, token);
        const response = await send("POST", harness.base, "/api/v1/runners/join", {
          body,
          token: minted.token,
        });
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      }
      expect(await countRunners(harness.base, token)).toBe(0);
    });
  });
});

describe("PATCH /runners/{id}: reserved", () => {
  it("toggles reserved and records the change", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });

      const flipped = await patchRunner(harness.base, token, runner.id, { reserved: true });
      expect(flipped.status, await flipped.clone().text()).toBe(200);
      expect(await flipped.json()).toMatchObject({ id: runner.id, reserved: true });
      expect((await readRunner(harness.base, token, runner.id)).reserved).toBe(true);

      const entries = await harness.audit("runner.updated");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
      expect(JSON.stringify(entries[0]?.payload)).toContain("reserved");
    });
  });
});

describe("how many sessions a runner will take", () => {
  it("computes one per 2 GiB with a minimum of 1, until the owner sets a cap", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });

      // The runner has not reported its memory, so the cap is the minimum, not
      // zero.
      expect((await readRunner(harness.base, token, runner.id)).maxConcurrentSessions).toBe(1);

      const capped = await patchRunner(harness.base, token, runner.id, {
        maxConcurrentSessions: 4,
      });
      expect(capped.status, await capped.clone().text()).toBe(200);
      expect(await capped.json()).toMatchObject({ maxConcurrentSessions: 4 });
      expect((await readRunner(harness.base, token, runner.id)).maxConcurrentSessions).toBe(4);
    });
  });
});

describe("POST /runners/{id}/drain and /runners/{id}/undrain", () => {
  it("takes a runner out of service and puts it back, recording each change", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris", connectivity: "online" });

      const drained = await moveRunner(harness.base, token, runner.id, "drain");
      expect(drained.status, await drained.clone().text()).toBe(200);
      // The lifecycle changed; the connectivity did not.
      expect(await drained.json()).toMatchObject({
        id: runner.id,
        lifecycle: "draining",
        connectivity: "online",
      });
      expect(await readRunner(harness.base, token, runner.id)).toMatchObject({
        lifecycle: "draining",
        connectivity: "online",
      });

      const drainedRows = await harness.audit("runner.drained");
      expect(drainedRows).toHaveLength(1);
      expect(drainedRows[0]?.actor).toBe("user");
      expect(drainedRows[0]?.payload).toMatchObject({ runnerId: runner.id });

      // A drain can be undone.
      const undrained = await moveRunner(harness.base, token, runner.id, "undrain");
      expect(undrained.status, await undrained.clone().text()).toBe(200);
      expect(await undrained.json()).toMatchObject({ id: runner.id, lifecycle: "active" });
      expect(await readRunner(harness.base, token, runner.id)).toMatchObject({
        lifecycle: "active",
      });

      const undrainedRows = await harness.audit("runner.undrained");
      expect(undrainedRows).toHaveLength(1);
      expect(undrainedRows[0]?.actor).toBe("user");
      expect(undrainedRows[0]?.payload).toMatchObject({ runnerId: runner.id });
    });
  });
});

describe("POST /runners/{id}/retire", () => {
  it("retires a runner whose sessions the controller can account for, drained or not", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      // A connected runner, and one that sent a goodbye: both have reported on
      // the sessions they were running.
      const online = await harness.insertRunner({ name: "iris", connectivity: "online" });
      const offline = await harness.insertRunner({
        name: "atlas",
        connectivity: "offline",
        lifecycle: "draining",
      });

      for (const runner of [online, offline]) {
        const response = await moveRunner(harness.base, token, runner.id, "retire");
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toMatchObject({ id: runner.id, lifecycle: "retired" });
        expect((await readRunner(harness.base, token, runner.id)).lifecycle).toBe("retired");
      }
    });
  });

  it("does not retire an unreachable runner unless forced", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const active = await harness.insertRunner({ name: "iris", connectivity: "unreachable" });
      const draining = await harness.insertRunner({
        name: "atlas",
        connectivity: "unreachable",
        lifecycle: "draining",
      });

      for (const runner of [active, draining]) {
        const refused = await moveRunner(harness.base, token, runner.id, "retire");
        expect(refused.status, runner.name).toBe(409);
        // An unreachable runner cannot report that its sessions have finished,
        // so the error mentions reachability rather than sessions.
        const body = (await refused.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("invalid_state");
        expect(body.error.message).toContain("unreachable");
      }

      expect(await readRunner(harness.base, token, active.id)).toMatchObject({
        lifecycle: "active",
        connectivity: "unreachable",
      });
      expect((await readRunner(harness.base, token, draining.id)).lifecycle).toBe("draining");
      expect(await harness.audit("runner.retired")).toHaveLength(0);

      for (const runner of [active, draining]) {
        const forced = await moveRunner(harness.base, token, runner.id, "retire", { force: true });
        expect(forced.status, await forced.clone().text()).toBe(200);
        expect(await forced.json()).toMatchObject({ id: runner.id, lifecycle: "retired" });
      }
      expect(await harness.audit("runner.retired")).toHaveLength(2);
    });
  });
});

describe("what retiring a runner leaves behind", () => {
  it("keeps the row, records the retirement, and clears the fleet default if it was the default", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const chosen = await harness.insertRunner({ name: "iris" });
      const other = await harness.insertRunner({ name: "atlas" });
      expect(
        (await patchController(harness.base, token, { defaultRunnerId: chosen.id })).status,
      ).toBe(200);
      const readDefaultRunnerId = async (): Promise<string | null> =>
        (
          (await (await get(harness.base, "/api/v1/controller", token)).json()) as {
            defaultRunnerId: string | null;
          }
        ).defaultRunnerId;

      // Retiring a runner that is not the default leaves the default alone.
      expect((await moveRunner(harness.base, token, other.id, "retire")).status).toBe(200);
      expect(await readDefaultRunnerId()).toBe(chosen.id);

      expect((await moveRunner(harness.base, token, chosen.id, "retire")).status).toBe(200);
      // The default is left empty: no other runner is promoted to it.
      expect(await readDefaultRunnerId()).toBeNull();

      // Nothing is deleted: the row and everything linked to it stay.
      expect(await readRunner(harness.base, token, chosen.id)).toMatchObject({
        id: chosen.id,
        name: "iris",
        lifecycle: "retired",
      });
      expect(listRunnerNames(await listRunners(harness.base, token))).toEqual(["atlas", "iris"]);

      // The audit entry records that the fleet lost its default, which nothing
      // else records.
      const entries = await harness.audit("runner.retired");
      expect(entries.map((entry) => entry.payload["lostDefaultRunner"])).toEqual([false, true]);
    });
  });
});

describe("GET /runners/join-tokens", () => {
  it("lists the tokens that can still be spent, without any token value", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      // All three are created before the first two are made unusable: creating
      // a token deletes expired rows, so expiring one first would make the
      // list correct for the wrong reason.
      const spent = await mintJoinToken(harness.base, token);
      const stale = await mintJoinToken(harness.base, token);
      const live = await mintJoinToken(harness.base, token);
      const [, staleId, liveId] = await readMintedIds(harness);

      expect((await join(harness.base, spent.token)).status).toBe(201);
      await expireJoinToken(harness.sql, staleId!);

      // A used token and an expired one are both useless to whoever holds them,
      // so neither is listed.
      const items = await listJoinTokens(harness.base, token);
      expect(items.map((item) => item.id)).toEqual([liveId]);
      const only = items[0]!;
      expect(Object.keys(only).sort()).toEqual(["createdAt", "expiresAt", "id"]);
      expect(Number.isNaN(Date.parse(only.createdAt)), only.createdAt).toBe(false);
      expect(Date.parse(only.expiresAt)).toBe(Date.parse(live.expiresAt));

      // Whoever reads this list can create a token of their own; they must not
      // get the token somebody is taking to another machine.
      const body = JSON.stringify(items);
      for (const minted of [spent, stale, live]) {
        expect(body).not.toContain(minted.token);
        expect(body).not.toContain(hashToken(minted.token));
      }
    });
  });
});

describe("DELETE /runners/join-tokens/{id}", () => {
  it("revokes an open token, and no runner can join with it afterwards", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const revoked = await mintJoinToken(harness.base, token);
      const other = await mintJoinToken(harness.base, token);
      const [revokedId, otherId] = await readMintedIds(harness);

      const response = await revokeJoinToken(harness.base, token, revokedId!);
      expect(response.status, await response.clone().text()).toBe(200);

      // The token was pasted into a chat window by mistake: revoking it means a
      // runner using it is rejected.
      expect((await join(harness.base, revoked.token)).status).toBe(401);
      expect(await countRunners(harness.base, token)).toBe(0);
      expect((await listJoinTokens(harness.base, token)).map((one) => one.id)).toEqual([otherId]);

      const entries = await harness.audit("runner.joinToken.revoked");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
      expect(JSON.stringify(entries[0]?.payload), "the trail names the token taken back").toContain(
        revokedId,
      );
      expect(JSON.stringify(entries[0]?.payload)).not.toContain(revoked.token);

      // Revoking one token leaves the other open tokens alone.
      expect((await join(harness.base, other.token)).status).toBe(201);
    });
  });

  it("returns not_found for an id that is unknown, spent or expired", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const spent = await mintJoinToken(harness.base, token);
      await mintJoinToken(harness.base, token);
      const live = await mintJoinToken(harness.base, token);
      const [spentId, staleId, liveId] = await readMintedIds(harness);

      // Created first and made unusable afterwards, for the same reason as
      // above: creating the third token would delete an already-expired row.
      expect((await join(harness.base, spent.token)).status).toBe(201);
      await expireJoinToken(harness.sql, staleId!);

      for (const id of [UNKNOWN_ID, spentId!, staleId!]) {
        const refused = await revokeJoinToken(harness.base, token, id);
        expect(refused.status, id).toBe(404);
        expect(await refused.json()).toMatchObject({ error: { code: "not_found" } });
      }
      expect(await harness.audit("runner.joinToken.revoked")).toHaveLength(0);

      // The one token that was still open was left alone, and can still be
      // revoked.
      expect((await listJoinTokens(harness.base, token)).map((one) => one.id)).toEqual([liveId]);
      expect((await revokeJoinToken(harness.base, token, liveId!)).status).toBe(200);
      expect((await join(harness.base, live.token)).status).toBe(401);
    });
  });
});

const GIB = 1024 * 1024 * 1024;

describe("the disk watermark placement checks a runner against", () => {
  it("is ten gibibytes until the owner sets one, and the API returns the value in effect", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris", connectivity: "online" });

      // Nobody has set one, so the runner returns the default rather than
      // nothing.
      expect((await readRunner(harness.base, token, runner.id)).diskWatermarkBytes).toBe(10 * GIB);

      const set = await patchRunner(harness.base, token, runner.id, {
        diskWatermarkBytes: 2 * GIB,
      });
      expect(set.status, await set.clone().text()).toBe(200);
      expect(await set.json()).toMatchObject({ diskWatermarkBytes: 2 * GIB });
      expect((await readRunner(harness.base, token, runner.id)).diskWatermarkBytes).toBe(2 * GIB);

      // A runner that has reported its disk: 4 GiB free, which is above the
      // 2 GiB watermark just set, so it is accepting placements.
      await Effect.runPromise(
        Effect.orDie(
          harness.sql`UPDATE runners SET watermark = ${JSON.stringify({
            diskFreeBytes: 4 * GIB,
            availableMemoryBytes: 16 * GIB,
          })} WHERE id = ${uuidFromString(runner.id)}`,
        ),
      );
      const before = await harness.audit("runner.placementsChanged");

      // Raising the watermark above the free disk it already reported is the
      // same change a report would cause, and it is recorded the same way.
      const raised = await patchRunner(harness.base, token, runner.id, {
        diskWatermarkBytes: 8 * GIB,
      });
      expect(raised.status, await raised.clone().text()).toBe(200);

      const after = await harness.audit("runner.placementsChanged");
      expect(after).toHaveLength(before.length + 1);
      const flip = after[after.length - 1];
      expect(flip?.actor).toBe("system");
      expect(flip?.payload).toMatchObject({ runnerId: runner.id, acceptingPlacements: false });
    });
  });
});

/**
 * Retiring a runner that still has sessions. This needs a real runner on the
 * real socket, so these tests use the shared fleet rather than an inserted
 * row: retiring has to handle sessions, and sessions exist only where a runner
 * can receive a start frame.
 */
const FLEET_FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["full-provider"],
  identityPort: 4939,
};

/**
 * The timeout for a test that sets up a fleet. It covers the fleet's shared
 * waits; a wait that outlasts the test timeout never gets to report what it
 * was waiting for.
 */
const FLEET_BUDGET_MS = WAIT_DEADLINE_MS * 3 + 10_000;

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, {
    plugins: [
      createPluginFixture({
        id: "providers",
        definitions: [buildProviderDefinition("full-provider", { token: "t" })],
      }).plugin,
    ],
    facts: FLEET_FACTS,
    models: [
      {
        slug: "clever",
        name: "Clever",
        imageInput: { maxBytes: null },
        isDefault: true,
        options: [],
      },
    ],
  });

const readSession = async (arranged: Arranged, id: string): Promise<Session> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

const spawnSession = async (arranged: Arranged, prompt: string): Promise<Session> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/sessions",
    { prompt },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

/**
 * Spawns a session and waits until the runner has reported it started and
 * answered that its prompt opened a turn, which makes the session `busy`.
 */
const spawnRunningSession = async (arranged: Arranged): Promise<Session> => {
  const session = await spawnSession(arranged, "hello");
  await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at: "2026-09-07T10:00:00.000Z",
    _tag: "session.started",
  });
  return await waitUntil("started the session", async () => {
    const one = await readSession(arranged, session.id);
    return one.status === "busy" ? one : undefined;
  });
};

const setSessionCap = async (arranged: Arranged, cap: number): Promise<void> => {
  const response = await patchRunner(arranged.harness.base, arranged.token, arranged.runnerId, {
    maxConcurrentSessions: cap,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

describe("retiring a runner that still has sessions", () => {
  it(
    "is rejected while one is running, and when forced ends both running and queued sessions",
    async () => {
      await withFleet(async (arranged) => {
        await setSessionCap(arranged, 1);
        const live = await spawnRunningSession(arranged);
        const waiting = await spawnSession(arranged, "after you");
        expect(waiting.status).toBe("queued");

        const refused = await moveRunner(
          arranged.harness.base,
          arranged.token,
          arranged.runnerId,
          "retire",
        );

        expect(refused.status, await refused.clone().text()).toBe(409);
        const body = (await refused.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("invalid_state");
        expect(body.error.message).toContain("session");
        expect(
          (await readRunner(arranged.harness.base, arranged.token, arranged.runnerId)).lifecycle,
        ).toBe("active");

        const forced = await moveRunner(
          arranged.harness.base,
          arranged.token,
          arranged.runnerId,
          "retire",
          { force: true },
        );

        expect(forced.status, await forced.clone().text()).toBe(200);
        for (const session of [live, waiting]) {
          const ended = await waitUntil(`ended ${session.id}`, async () => {
            const one = await readSession(arranged, session.id);
            return one.status === "exited" ? one : undefined;
          });
          expect(ended.status).toBe("exited");
        }
        // The running session had a harness to stop; the queued one never did.
        await waitUntil("sent a sessionStop", () =>
          listFrames<SessionStopFrame>(arranged.wire, "sessionStop").length > 0 ? true : undefined,
        );
        expect(
          listFrames<SessionStopFrame>(arranged.wire, "sessionStop").map(
            (frame) => frame.sessionId,
          ),
        ).toEqual([live.id]);

        // One audit entry per session the retirement ended, with the reason.
        const stopped = await arranged.harness.audit("session.stopped");
        expect(stopped.map((row) => row.payload["sessionId"]).sort()).toEqual(
          [live.id, waiting.id].sort(),
        );
        for (const row of stopped) {
          expect(row.payload["runnerId"]).toBe(arranged.runnerId);
          expect(row.payload["reason"]).toBe("runner_retired");
        }
      });
    },
    FLEET_BUDGET_MS,
  );

  it(
    "retires without force when all its sessions are only queued",
    async () => {
      await withFleet(async (arranged) => {
        // Below the default watermark, so the session is placed on the runner
        // and waits there instead of starting.
        arranged.wire.send({
          _tag: "watermarkReport",
          watermark: { diskFreeBytes: 4 * GIB, availableMemoryBytes: 16 * GIB },
        });
        await waitUntil("stored the low reading", async () => {
          const runner = await readRunner(arranged.harness.base, arranged.token, arranged.runnerId);
          return runner.watermark?.diskFreeBytes === 4 * GIB ? runner : undefined;
        });
        const waiting = await spawnSession(arranged, "no room");
        expect(waiting.status).toBe("queued");

        const retired = await moveRunner(
          arranged.harness.base,
          arranged.token,
          arranged.runnerId,
          "retire",
        );

        expect(retired.status, await retired.clone().text()).toBe(200);
        expect(await retired.json()).toMatchObject({ lifecycle: "retired" });
        const ended = await waitUntil("ended what was queued", async () => {
          const one = await readSession(arranged, waiting.id);
          return one.status === "exited" ? one : undefined;
        });
        expect(ended.status).toBe("exited");
      });
    },
    FLEET_BUDGET_MS,
  );
});
