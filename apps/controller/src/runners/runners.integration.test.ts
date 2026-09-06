/**
 * The runner read side over a real socket: what a listing carries, what one
 * row carries, what a patch may change, and what an anonymous caller gets.
 *
 * Rows are arranged through the harness's `insertRunner`, which goes through
 * the real repository: no operation creates a runner in this slice, join lands
 * later.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { Runner, RunnerDetail } from "@hydra/contract";
import { uuidFromString, uuidToString } from "../db";
import { hashToken } from "../credentials";
import type { ServerHarness } from "../http/testing";
import { SETUP_TOKEN, completeSetup, del, get, post, send, withServer } from "../http/testing";

interface RunnerPage {
  readonly items: ReadonlyArray<Runner>;
  readonly nextCursor?: string;
}

/** An id that is well-formed and belongs to nobody. */
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const list = async (base: string, token: string, query = ""): Promise<RunnerPage> => {
  const response = await get(base, `/api/v1/runners${query}`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as RunnerPage;
};

const read = async (base: string, token: string, id: string): Promise<RunnerDetail> => {
  const response = await get(base, `/api/v1/runners/${id}`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as RunnerDetail;
};

const patch = (base: string, token: string, id: string, body: unknown): Promise<Response> =>
  send("PATCH", base, `/api/v1/runners/${id}`, { body, token });

/** A lifecycle move, the way the runner page's buttons make one. */
const move = (
  base: string,
  token: string,
  id: string,
  verb: string,
  body: unknown = {},
): Promise<Response> => send("POST", base, `/api/v1/runners/${id}/${verb}`, { body, token });

const names = (page: RunnerPage): ReadonlyArray<string> =>
  page.items.map((runner) => runner.name).sort();

/** What a machine is handed when it joins. */
interface JoinAnswer {
  readonly runnerId: string;
  readonly credential: string;
  readonly controllerIdentityId: string;
  readonly controllerPublicKey: string;
  readonly name: string;
}

/** Every row of a table, whatever columns it turns out to have. */
const allRows = (
  sql: ServerHarness["sql"],
  table: string,
): Promise<ReadonlyArray<Record<string, unknown>>> =>
  Effect.runPromise(
    Effect.orDie(sql.unsafe<Record<string, unknown>>(`SELECT rowid, * FROM ${table}`)),
  );

/**
 * The join tokens as the database holds them.
 *
 * The table is found through the schema rather than named here, so what is
 * asserted is what the database really stores and not what this file guessed
 * it would be called.
 */
const joinTokens = async (
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
  return { table, rows: await allRows(sql, table) };
};

/** A value that reads as an instant, as milliseconds; anything else, `undefined`. */
const instantOf = (value: unknown): number | undefined =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : undefined;

/**
 * Ages the token with this id by two hours, because nothing over the wire can
 * wait an hour. Every instant on the row moves together, so what the row
 * describes is a token minted two hours ago and expired one hour ago rather
 * than one that expired before it was minted; the columns are found by their
 * values, so no column name is written here. The row is found by its id,
 * because two tokens minted in the same millisecond share every timestamp
 * there is, and the write is keyed on `rowid`, which every SQLite table has.
 */
const expireById = async (sql: ServerHarness["sql"], id: string): Promise<void> => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const { table, rows } = await joinTokens(sql);
  const row = rows.find((one) =>
    Object.values(one).some(
      (value) => value instanceof Uint8Array && value.length === 16 && uuidToString(value) === id,
    ),
  );
  expect(row, `no join token row has the id ${id}`).toBeDefined();
  const moved = Object.entries(row!).flatMap(([column, value]) => {
    const at = instantOf(value);
    return at === undefined ? [] : [[column, new Date(at - TWO_HOURS).toISOString()] as const];
  });
  const sets = moved.map(([column]) => `${column} = ?`).join(", ");
  await Effect.runPromise(
    Effect.orDie(
      sql.unsafe(`UPDATE ${table} SET ${sets} WHERE rowid = ?`, [
        ...moved.map(([, value]) => value),
        row!["rowid"] as number,
      ]),
    ),
  );
};

/** Mints a join token the way the fleet's "Add machine" spot does. */
const mint = async (
  base: string,
  token: string,
): Promise<{ readonly token: string; readonly expiresAt: string }> => {
  const response = await post(base, "/api/v1/runners/join-tokens", {}, token);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { token: string; expiresAt: string };
};

/** What the fleet is shown about a token that is still outstanding. */
interface ListedJoinToken {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * The outstanding tokens, as the fleet's "Add machine" spot reads them. A whole
 * outstanding set is one answer: a token lives an hour and a fleet is enlisted
 * one machine at a time, so there is no page to turn.
 */
const outstanding = async (
  base: string,
  token: string,
): Promise<ReadonlyArray<ListedJoinToken>> => {
  const response = await get(base, "/api/v1/runners/join-tokens", token);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json();
  expect(Array.isArray(body), JSON.stringify(body)).toBe(true);
  return body as ReadonlyArray<ListedJoinToken>;
};

/** Takes a minted token back, the way the Revoke beside it does. */
const revoke = (base: string, token: string, id: string): Promise<Response> =>
  del(base, `/api/v1/runners/join-tokens/${id}`, token);

/**
 * The ids of the tokens minted so far, oldest first. A mint answers with the
 * token and its expiry but not its id, and the id is what a revoke names; the
 * trail the mint writes is where a caller with a credential can find it.
 */
const mintedIds = async (harness: ServerHarness): Promise<ReadonlyArray<string>> =>
  (await harness.audit("runner.joinToken.minted")).map(
    (entry) => entry.payload["joinTokenId"] as string,
  );

/** The join exchange, as a machine holding a join token makes it. */
const joinWith = (base: string, bearer: string, body: unknown): Promise<Response> =>
  send("POST", base, "/api/v1/runners/join", { body, token: bearer });

const join = (base: string, bearer: string): Promise<Response> => joinWith(base, bearer, {});

/** Enlists a machine and answers with what the controller handed it. */
const enlist = async (base: string, bearer: string, body: unknown = {}): Promise<JoinAnswer> => {
  const response = await joinWith(base, bearer, body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as JoinAnswer;
};

/** The one thing a caller may write about the controller. */
const patchController = (base: string, token: string, body: unknown): Promise<Response> =>
  send("PATCH", base, "/api/v1/controller", { body, token });

/** How many runners the controller has enlisted. */
const runnerCount = async (base: string, token: string): Promise<number> =>
  (await list(base, token)).items.length;

/** Three rows: three connectivities, one of them labelled `gpu`, one retired. */
const three = async (harness: ServerHarness) => ({
  online: await harness.insertRunner({ name: "iris", connectivity: "online", labels: ["gpu"] }),
  offline: await harness.insertRunner({ name: "atlas", connectivity: "offline" }),
  retired: await harness.insertRunner({
    name: "vega",
    connectivity: "offline",
    lifecycle: "retired",
  }),
});

describe("GET /runners", () => {
  it("hands back every runner in a page envelope, carrying the fields the fleet reads", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const { online } = await three(harness);

      const page = await list(harness.base, token);
      expect(names(page)).toEqual(["atlas", "iris", "vega"]);

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

  it("filters by either axis and by label", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await three(harness);

      expect(names(await list(harness.base, token, "?connectivity=online"))).toEqual(["iris"]);
      expect(names(await list(harness.base, token, "?lifecycle=retired"))).toEqual(["vega"]);
      expect(names(await list(harness.base, token, "?lifecycle=active"))).toEqual([
        "atlas",
        "iris",
      ]);
      expect(names(await list(harness.base, token, "?label=gpu"))).toEqual(["iris"]);
      expect(names(await list(harness.base, token, "?connectivity=online&label=gpu"))).toEqual([
        "iris",
      ]);
      expect(names(await list(harness.base, token, "?connectivity=offline&label=gpu"))).toEqual([]);
    });
  });

  it("pages by name, in the direction the sort asks for", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await three(harness);

      expect(names(await list(harness.base, token, "?sort=name:desc"))).toEqual([
        "atlas",
        "iris",
        "vega",
      ]);
      expect((await list(harness.base, token, "?sort=name:desc")).items[0]?.name).toBe("vega");

      const first = await list(harness.base, token, "?limit=2");
      expect(first.items.map((runner) => runner.name)).toEqual(["atlas", "iris"]);
      expect(first.nextCursor).toBeDefined();

      const rest = await list(
        harness.base,
        token,
        `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
      );
      expect(rest.items.map((runner) => runner.name)).toEqual(["vega"]);
      expect(rest.nextCursor).toBeUndefined();

      // A cursor issued walking one way says nothing about the other.
      const crossed = await get(
        harness.base,
        `/api/v1/runners?sort=name:desc&cursor=${encodeURIComponent(first.nextCursor!)}`,
        token,
      );
      expect(crossed.status).toBe(400);
      expect(await crossed.json()).toMatchObject({ error: { code: "validation" } });
    });
  });

  it("refuses a connectivity or a lifecycle that is not one of its own", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await three(harness);

      // Each axis takes its own three values: `draining` is not a connectivity
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
  it("carries the listing's fields plus the negotiated capabilities and protocol version", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const { online } = await three(harness);

      const row = await read(harness.base, token, online.id);
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

  it("reads a reported document this build cannot make sense of as absent", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const { online, offline } = await three(harness);
      // A row written by a build that reported something else. The column holds
      // what a runner sent, so a fleet listing has to survive one of them
      // rather than answering with nothing at all.
      await Effect.runPromise(
        Effect.orDie(
          harness.sql`UPDATE runners
                      SET facts = '{"os":42}',
                          watermark = 'not json at all',
                          negotiated_capabilities = '{"not":"a list"}'
                      WHERE id = ${uuidFromString(online.id)}`,
        ),
      );

      const row = await read(harness.base, token, online.id);
      expect(row.facts).toBeNull();
      expect(row.watermark).toBeNull();
      expect(row.negotiatedCapabilities).toBeNull();

      const page = await list(harness.base, token);
      expect(page.items.map((one) => one.id)).toContain(offline.id);
    });
  });

  it("answers not_found for an id nobody has, and validation for one that is not an id", async () => {
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
  it("changes only the field the patch names, and answers with the updated row", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({
        name: "iris",
        connectivity: "online",
        labels: ["gpu"],
        maxConcurrentSessions: 3,
      });

      const renamed = await patch(harness.base, token, runner.id, { name: "iris-2" });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({
        id: runner.id,
        name: "iris-2",
        connectivity: "online",
        lifecycle: "active",
        labels: ["gpu"],
        maxConcurrentSessions: 3,
      });

      const relabelled = await patch(harness.base, token, runner.id, { labels: ["cpu", "arm"] });
      expect(relabelled.status).toBe(200);
      expect(await relabelled.json()).toMatchObject({
        name: "iris-2",
        labels: ["cpu", "arm"],
        maxConcurrentSessions: 3,
      });

      const capped = await patch(harness.base, token, runner.id, { maxConcurrentSessions: 8 });
      expect(capped.status).toBe(200);
      expect(await capped.json()).toMatchObject({
        name: "iris-2",
        labels: ["cpu", "arm"],
        maxConcurrentSessions: 8,
      });

      // What the wire says is what the row is.
      expect(await read(harness.base, token, runner.id)).toMatchObject({
        name: "iris-2",
        labels: ["cpu", "arm"],
        maxConcurrentSessions: 8,
        connectivity: "online",
      });
    });
  });

  it("writes one audit row per update, stamped with the user", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });

      expect((await patch(harness.base, token, runner.id, { name: "iris-2" })).status).toBe(200);

      const entries = await harness.audit("runner.updated");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
    });
  });

  it("writes nothing when the patch asks for the values the runner already holds", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({
        name: "iris",
        labels: ["gpu"],
        maxConcurrentSessions: 1,
      });

      const response = await patch(harness.base, token, runner.id, {
        name: "iris",
        labels: ["gpu"],
        maxConcurrentSessions: 1,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ name: "iris", labels: ["gpu"] });
      expect(await harness.audit("runner.updated")).toHaveLength(0);
    });
  });

  it("refuses a patch that names no field", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });

      const response = await patch(harness.base, token, runner.id, {});
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      expect(await harness.audit("runner.updated")).toHaveLength(0);
    });
  });

  it("refuses an empty name, a session cap below one, and a label that is not a string", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris", labels: ["gpu"] });

      for (const body of [{ name: "" }, { maxConcurrentSessions: 0 }, { labels: [7] }]) {
        const response = await patch(harness.base, token, runner.id, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      }

      expect(await read(harness.base, token, runner.id)).toMatchObject({
        name: "iris",
        labels: ["gpu"],
      });
    });
  });

  it("refuses a patch that names facts, state or the watermark", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris", connectivity: "online" });

      // Each one rides beside a field the patch may set, so the refusal is the
      // unknown key and not the empty patch.
      for (const body of [
        { name: "iris-2", facts: { os: "linux" } },
        { name: "iris-2", connectivity: "unreachable" },
        { name: "iris-2", lifecycle: "retired" },
        { name: "iris-2", watermark: { diskFreeBytes: 1 } },
      ]) {
        const response = await patch(harness.base, token, runner.id, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      }

      expect(await read(harness.base, token, runner.id)).toMatchObject({
        name: "iris",
        connectivity: "online",
        lifecycle: "active",
      });
    });
  });
});

describe("the infra routes with no credential", () => {
  it("answers 401 to every one of them", async () => {
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

      // Nothing an anonymous request sent changed anything.
      expect(await read(harness.base, token, runner.id)).toMatchObject({ name: "iris" });
    });
  });
});

describe("POST /runners/join-tokens", () => {
  it("mints a fresh single-use token, good for an hour, that the database never holds", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const before = Date.now();

      const first = await mint(harness.base, token);
      const second = await mint(harness.base, token);

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
      const { rows } = await joinTokens(harness.sql);
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

  it("clears out the tokens that can no longer be spent", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const stale = await mint(harness.base, token);
      await expireById(harness.sql, (await mintedIds(harness))[0]!);

      // The "Add machine" spot mints one every time it is opened, so without
      // this the table would grow with the number of times somebody looked.
      const fresh = await mint(harness.base, token);
      const { rows } = await joinTokens(harness.sql);
      expect(rows).toHaveLength(1);

      expect((await join(harness.base, stale.token)).status).toBe(401);
      expect((await join(harness.base, fresh.token)).status).toBe(201);
    });
  });
});

describe("POST /runners/join", () => {
  it("enlists a machine, hands it a credential, and stores only the credential's hash", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const minted = await mint(harness.base, token);

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

      // Nothing has dialled, so the fleet knows both where the machine stands
      // with the user (`active`) and that it is not reachable (`offline`).
      const row = await read(harness.base, token, answer.runnerId);
      expect(row).toMatchObject({
        id: answer.runnerId,
        name: answer.name,
        connectivity: "offline",
        lifecycle: "active",
        reserved: false,
      });
      expect(Object.keys(row), "the five-valued state is gone").not.toContain("state");

      const runnerRows = await allRows(harness.sql, "runners");
      expect(runnerRows).toHaveLength(1);
      for (const [column, value] of Object.entries(runnerRows[0]!)) {
        expect(String(value), `${column} holds the credential itself`).not.toContain(
          answer.credential,
        );
      }
    });
  });

  it("refuses a second use of the same token, and enlists nothing", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const minted = await mint(harness.base, token);

      expect((await join(harness.base, minted.token)).status).toBeLessThan(300);
      expect(await runnerCount(harness.base, token)).toBe(1);

      const again = await join(harness.base, minted.token);
      expect(again.status).toBe(401);
      expect(await runnerCount(harness.base, token)).toBe(1);
    });
  });

  it("refuses a token older than an hour, and enlists nothing", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const minted = await mint(harness.base, token);
      await expireById(harness.sql, (await mintedIds(harness))[0]!);

      const response = await join(harness.base, minted.token);
      expect(response.status).toBe(401);
      expect(await runnerCount(harness.base, token)).toBe(0);
    });
  });

  it("enlists a second machine under a name of its own", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const first = JSON.parse(
        await (await join(harness.base, (await mint(harness.base, token)).token)).text(),
      ) as JoinAnswer;
      const second = JSON.parse(
        await (await join(harness.base, (await mint(harness.base, token)).token)).text(),
      ) as JoinAnswer;

      expect(second.runnerId).not.toBe(first.runnerId);
      expect(second.name).not.toBe(first.name);
      expect(second.credential).not.toBe(first.credential);
      expect(names(await list(harness.base, token))).toEqual([first.name, second.name].sort());
    });
  });

  it("makes the first machine the default runner and leaves the choice alone after that", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const controller = async (): Promise<string | null> =>
        (
          (await (await get(harness.base, "/api/v1/controller", token)).json()) as {
            defaultRunnerId: string | null;
          }
        ).defaultRunnerId;

      expect(await controller()).toBeNull();
      const first = JSON.parse(
        await (await join(harness.base, (await mint(harness.base, token)).token)).text(),
      ) as JoinAnswer;
      expect(await controller()).toBe(first.runnerId);

      // A second machine does not take a default the fleet already has, which
      // is the same rule whether the first was chosen or fell into it.
      const second = JSON.parse(
        await (await join(harness.base, (await mint(harness.base, token)).token)).text(),
      ) as JoinAnswer;
      expect(second.runnerId).not.toBe(first.runnerId);
      expect(await controller()).toBe(first.runnerId);

      // Nor one a person deliberately took off: an empty default is an answer,
      // not an absence waiting to be filled in by whoever turns up next.
      await send("PATCH", harness.base, "/api/v1/controller", {
        body: { defaultRunnerId: null },
        token,
      });
      await join(harness.base, (await mint(harness.base, token)).token);
      expect(await controller()).toBeNull();

      // The log says which enlistment took the default and which did not; it is
      // the only writer of that setting with nobody behind it.
      const log = (await (await get(harness.base, "/api/v1/events", token)).json()) as {
        items: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>;
      };
      // The log reads newest first; these are the three enlistments in the
      // order they happened.
      const joined = log.items.filter((entry) => entry.kind === "runner.joined").reverse();
      expect(joined.map((entry) => entry.payload["becameDefaultRunner"])).toEqual([
        true,
        false,
        false,
      ]);
    });
  });

  it("is reachable before Hydra has been set up, because the local runner joins then", async () => {
    await withServer(async (harness) => {
      const response = await join(harness.base, await harness.joinToken());
      expect(response.status, await response.clone().text()).toBe(201);

      // Every operation is still closed: setup has not happened.
      expect((await get(harness.base, "/api/v1/runners")).status).toBe(401);
    });
  });

  it("records the enlistment as the system's own doing", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const minted = await mint(harness.base, token);
      const answer = JSON.parse(
        await (await join(harness.base, minted.token)).text(),
      ) as JoinAnswer;

      // Read back over the wire, because a `system` stamp the event schema
      // cannot encode would fail the whole page rather than the row.
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
      // The two entries name the same invitation, which is what makes the log
      // able to say which mint let which machine in.
      expect(mintedRow!.payload["joinTokenId"]).toBe(joined!.payload["joinTokenId"]);
      for (const entry of log.items) {
        expect(JSON.stringify(entry.payload)).not.toContain(minted.token);
      }
    });
  });

  it("refuses an unknown token and a user credential, and enlists nothing", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await mint(harness.base, token);

      // A user's own credential is not a join token: the two populations are
      // separate, and a bearer that opens the API must not enlist a machine.
      for (const bearer of ["a-token-nobody-minted", token, SETUP_TOKEN]) {
        const response = await join(harness.base, bearer);
        expect(response.status, bearer).toBe(401);
      }
      expect(await runnerCount(harness.base, token)).toBe(0);
    });
  });
});

describe("a machine that joins as a personal one", () => {
  it("is reserved when its join says so, and is not when it does not", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      const reserved = await enlist(harness.base, (await mint(harness.base, token)).token, {
        reserved: true,
      });
      const plain = await enlist(harness.base, (await mint(harness.base, token)).token, {});
      const explicit = await enlist(harness.base, (await mint(harness.base, token)).token, {
        reserved: false,
      });

      expect((await read(harness.base, token, reserved.runnerId)).reserved).toBe(true);
      expect((await read(harness.base, token, plain.runnerId)).reserved).toBe(false);
      expect((await read(harness.base, token, explicit.runnerId)).reserved).toBe(false);
    });
  });

  it("is never made the fleet default, even when it is the first machine to join", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      // The default is where work with nothing to say about placement lands,
      // which is the one thing a reserved runner never takes: an empty fleet is
      // no reason to write the pair the rules elsewhere refuse to reach.
      const first = await enlist(harness.base, (await mint(harness.base, token)).token, {
        reserved: true,
      });

      const controller = (await (await get(harness.base, "/api/v1/controller", token)).json()) as {
        defaultRunnerId: string | null;
      };
      expect(controller.defaultRunnerId).toBeNull();
      expect((await read(harness.base, token, first.runnerId)).reserved).toBe(true);
    });
  });

  it("refuses a join body that is not one this build understands", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      // A misspelled key would otherwise enlist a shared machine while its
      // owner believes they asked for a personal one.
      for (const body of ["", "not json", { reserved: "yes" }, { reservd: true }]) {
        const minted = await mint(harness.base, token);
        const response = await send("POST", harness.base, "/api/v1/runners/join", {
          body,
          token: minted.token,
        });
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      }
      expect(await runnerCount(harness.base, token)).toBe(0);
    });
  });
});

describe("PATCH /runners/{id}: reserved", () => {
  it("flips reserved on any runner but the fleet default, and records the change", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const chosen = await harness.insertRunner({ name: "iris" });
      const other = await harness.insertRunner({ name: "atlas" });
      expect(
        (await patchController(harness.base, token, { defaultRunnerId: chosen.id })).status,
      ).toBe(200);

      // Work with nothing to say about where it runs lands on the default, and
      // a reserved runner is the one place such work never goes.
      const refused = await patch(harness.base, token, chosen.id, { reserved: true });
      expect(refused.status, await refused.clone().text()).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "conflict" } });
      expect((await read(harness.base, token, chosen.id)).reserved).toBe(false);
      expect(await harness.audit("runner.updated")).toHaveLength(0);

      const flipped = await patch(harness.base, token, other.id, { reserved: true });
      expect(flipped.status, await flipped.clone().text()).toBe(200);
      expect(await flipped.json()).toMatchObject({ id: other.id, reserved: true });
      expect((await read(harness.base, token, other.id)).reserved).toBe(true);

      const entries = await harness.audit("runner.updated");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
      expect(JSON.stringify(entries[0]?.payload)).toContain("reserved");
    });
  });
});

describe("PATCH /runners/{id}: the name a fleet has only one of", () => {
  it("refuses a name another runner holds, and takes one nobody does", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const iris = await harness.insertRunner({ name: "iris", labels: ["gpu"] });
      await harness.insertRunner({ name: "atlas" });

      const taken = await patch(harness.base, token, iris.id, { name: "atlas" });
      expect(taken.status, await taken.clone().text()).toBe(409);
      expect(await taken.json()).toMatchObject({ error: { code: "conflict" } });
      expect(await read(harness.base, token, iris.id)).toMatchObject({
        name: "iris",
        labels: ["gpu"],
      });
      expect(names(await list(harness.base, token))).toEqual(["atlas", "iris"]);

      // A name that differs only in case is a different name: the fleet reads
      // what the user typed, and nothing here folds case.
      const cased = await patch(harness.base, token, iris.id, { name: "Atlas" });
      expect(cased.status, await cased.clone().text()).toBe(200);

      const free = await patch(harness.base, token, iris.id, { name: "vega" });
      expect(free.status).toBe(200);
      expect(names(await list(harness.base, token))).toEqual(["atlas", "vega"]);
    });
  });
});

describe("how many sessions a runner will take", () => {
  it("derives one per 2 GiB with a floor of 1, until somebody says otherwise", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris" });

      // Nothing has said how big the machine is, so the fleet claims the least
      // it can rather than nothing at all.
      expect((await read(harness.base, token, runner.id)).maxConcurrentSessions).toBe(1);

      const capped = await patch(harness.base, token, runner.id, { maxConcurrentSessions: 4 });
      expect(capped.status, await capped.clone().text()).toBe(200);
      expect(await capped.json()).toMatchObject({ maxConcurrentSessions: 4 });
      expect((await read(harness.base, token, runner.id)).maxConcurrentSessions).toBe(4);

      const refused = await patch(harness.base, token, runner.id, { maxConcurrentSessions: 0 });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: { code: "validation" } });
      expect((await read(harness.base, token, runner.id)).maxConcurrentSessions).toBe(4);
    });
  });
});

describe("POST /runners/{id}/drain and /runners/{id}/undrain", () => {
  it("takes a runner out of service and puts it back, recording each move", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner = await harness.insertRunner({ name: "iris", connectivity: "online" });

      const drained = await move(harness.base, token, runner.id, "drain");
      expect(drained.status, await drained.clone().text()).toBe(200);
      // Where the runner stands with its owner moved; whether the controller can
      // see it did not.
      expect(await drained.json()).toMatchObject({
        id: runner.id,
        lifecycle: "draining",
        connectivity: "online",
      });
      expect(await read(harness.base, token, runner.id)).toMatchObject({
        lifecycle: "draining",
        connectivity: "online",
      });

      const drainedRows = await harness.audit("runner.drained");
      expect(drainedRows).toHaveLength(1);
      expect(drainedRows[0]?.actor).toBe("user");
      expect(drainedRows[0]?.payload).toMatchObject({ runnerId: runner.id });

      // A drain is a decision, not a door that locks behind you.
      const undrained = await move(harness.base, token, runner.id, "undrain");
      expect(undrained.status, await undrained.clone().text()).toBe(200);
      expect(await undrained.json()).toMatchObject({ id: runner.id, lifecycle: "active" });
      expect(await read(harness.base, token, runner.id)).toMatchObject({ lifecycle: "active" });

      const undrainedRows = await harness.audit("runner.undrained");
      expect(undrainedRows).toHaveLength(1);
      expect(undrainedRows[0]?.actor).toBe("user");
      expect(undrainedRows[0]?.payload).toMatchObject({ runnerId: runner.id });
    });
  });

  it("refuses each move the runner is not standing where it needs to be for", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const active = await harness.insertRunner({ name: "iris" });
      const draining = await harness.insertRunner({ name: "atlas", lifecycle: "draining" });
      const retired = await harness.insertRunner({ name: "vega", lifecycle: "retired" });

      const refusals: ReadonlyArray<readonly [string, string]> = [
        [draining.id, "drain"],
        [retired.id, "drain"],
        [active.id, "undrain"],
        [retired.id, "undrain"],
        [retired.id, "retire"],
      ];
      for (const [id, verb] of refusals) {
        const response = await move(harness.base, token, id, verb);
        expect(response.status, `${verb} on ${id}`).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
      }

      // Nothing moved and nothing was written down.
      expect((await read(harness.base, token, active.id)).lifecycle).toBe("active");
      expect((await read(harness.base, token, draining.id)).lifecycle).toBe("draining");
      expect((await read(harness.base, token, retired.id)).lifecycle).toBe("retired");
      expect(await harness.audit("runner.drained")).toHaveLength(0);
      expect(await harness.audit("runner.undrained")).toHaveLength(0);
      expect(await harness.audit("runner.retired")).toHaveLength(0);
    });
  });
});

describe("POST /runners/{id}/retire", () => {
  it("retires a runner the controller can still account for, drained or not", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      // A runner that is connected, and one that announced it was going: both
      // have had their say about the sessions they were running.
      const online = await harness.insertRunner({ name: "iris", connectivity: "online" });
      const offline = await harness.insertRunner({
        name: "atlas",
        connectivity: "offline",
        lifecycle: "draining",
      });

      for (const runner of [online, offline]) {
        const response = await move(harness.base, token, runner.id, "retire");
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toMatchObject({ id: runner.id, lifecycle: "retired" });
        expect((await read(harness.base, token, runner.id)).lifecycle).toBe("retired");
      }
    });
  });

  it("will not retire a runner it cannot reach until it is told to force it", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const active = await harness.insertRunner({ name: "iris", connectivity: "unreachable" });
      const draining = await harness.insertRunner({
        name: "atlas",
        connectivity: "unreachable",
        lifecycle: "draining",
      });

      for (const runner of [active, draining]) {
        const refused = await move(harness.base, token, runner.id, "retire");
        expect(refused.status, runner.name).toBe(409);
        // A machine that is not answering cannot say its sessions have finished,
        // so the refusal names the reachability rather than the sessions.
        const body = (await refused.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("invalid_state");
        expect(body.error.message).toContain("unreachable");
      }

      expect(await read(harness.base, token, active.id)).toMatchObject({
        lifecycle: "active",
        connectivity: "unreachable",
      });
      expect((await read(harness.base, token, draining.id)).lifecycle).toBe("draining");
      expect(await harness.audit("runner.retired")).toHaveLength(0);

      for (const runner of [active, draining]) {
        const forced = await move(harness.base, token, runner.id, "retire", { force: true });
        expect(forced.status, await forced.clone().text()).toBe(200);
        expect(await forced.json()).toMatchObject({ id: runner.id, lifecycle: "retired" });
      }
      expect(await harness.audit("runner.retired")).toHaveLength(2);
    });
  });
});

describe("what retiring a runner leaves behind", () => {
  it("keeps the row, records the retirement, and gives up the fleet default it held", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const chosen = await harness.insertRunner({ name: "iris" });
      const other = await harness.insertRunner({ name: "atlas" });
      expect(
        (await patchController(harness.base, token, { defaultRunnerId: chosen.id })).status,
      ).toBe(200);
      const defaultRunner = async (): Promise<string | null> =>
        (
          (await (await get(harness.base, "/api/v1/controller", token)).json()) as {
            defaultRunnerId: string | null;
          }
        ).defaultRunnerId;

      // A runner that is not the default takes nothing with it.
      expect((await move(harness.base, token, other.id, "retire")).status).toBe(200);
      expect(await defaultRunner()).toBe(chosen.id);

      expect((await move(harness.base, token, chosen.id, "retire")).status).toBe(200);
      // An empty default is the honest answer: nothing else is promoted into it.
      expect(await defaultRunner()).toBeNull();

      // Nothing is deleted: the row and everything that will hang off it stay.
      expect(await read(harness.base, token, chosen.id)).toMatchObject({
        id: chosen.id,
        name: "iris",
        lifecycle: "retired",
      });
      expect(names(await list(harness.base, token))).toEqual(["atlas", "iris"]);

      // The trail says the fleet lost its default, which is the part of a
      // retirement nothing else records.
      const entries = await harness.audit("runner.retired");
      expect(entries.map((entry) => entry.payload["lostDefaultRunner"])).toEqual([false, true]);
    });
  });
});

describe("GET /runners/join-tokens", () => {
  it("lists the tokens that can still be spent, and nothing anybody could join with", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      // All three are minted before either of the first two is put out of use:
      // a mint sweeps the expired rows away, so ageing one out first would
      // leave the listing right for the wrong reason.
      const spent = await mint(harness.base, token);
      const stale = await mint(harness.base, token);
      const live = await mint(harness.base, token);
      const [, staleId, liveId] = await mintedIds(harness);

      expect((await join(harness.base, spent.token)).status).toBe(201);
      await expireById(harness.sql, staleId!);

      // A token that has been used and one that ran out are both worthless to
      // whoever holds them, so neither is something the fleet still offers.
      const items = await outstanding(harness.base, token);
      expect(items.map((item) => item.id)).toEqual([liveId]);
      const only = items[0]!;
      expect(Object.keys(only).sort()).toEqual(["createdAt", "expiresAt", "id"]);
      expect(Number.isNaN(Date.parse(only.createdAt)), only.createdAt).toBe(false);
      expect(Date.parse(only.expiresAt)).toBe(Date.parse(live.expiresAt));

      // Whoever reads this listing can mint a token of their own; what they
      // must not be handed is the one somebody is carrying to another machine.
      const body = JSON.stringify(items);
      for (const minted of [spent, stale, live]) {
        expect(body).not.toContain(minted.token);
        expect(body).not.toContain(hashToken(minted.token));
      }
    });
  });
});

describe("DELETE /runners/join-tokens/{id}", () => {
  it("takes an outstanding token back, and no machine can join with it after", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const revoked = await mint(harness.base, token);
      const other = await mint(harness.base, token);
      const [revokedId, otherId] = await mintedIds(harness);

      const response = await revoke(harness.base, token, revokedId!);
      expect(response.status, await response.clone().text()).toBe(200);

      // The token was pasted into a chat window an hour too early: the point of
      // revoking it is that the machine reading it is turned away.
      expect((await join(harness.base, revoked.token)).status).toBe(401);
      expect(await runnerCount(harness.base, token)).toBe(0);
      expect((await outstanding(harness.base, token)).map((one) => one.id)).toEqual([otherId]);

      const entries = await harness.audit("runner.joinToken.revoked");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("user");
      expect(JSON.stringify(entries[0]?.payload), "the trail names the token taken back").toContain(
        revokedId,
      );
      expect(JSON.stringify(entries[0]?.payload)).not.toContain(revoked.token);

      // Revoking one token is not revoking the fleet's outstanding invitations.
      expect((await join(harness.base, other.token)).status).toBe(201);
    });
  });

  it("has nothing to take back for an id that is unknown, spent or expired", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const spent = await mint(harness.base, token);
      await mint(harness.base, token);
      const live = await mint(harness.base, token);
      const [spentId, staleId, liveId] = await mintedIds(harness);

      // Minted first, put out of use after, for the same reason as above: the
      // third mint's sweep would have taken an already-expired row with it.
      expect((await join(harness.base, spent.token)).status).toBe(201);
      await expireById(harness.sql, staleId!);

      for (const id of [UNKNOWN_ID, spentId!, staleId!]) {
        const refused = await revoke(harness.base, token, id);
        expect(refused.status, id).toBe(404);
        expect(await refused.json()).toMatchObject({ error: { code: "not_found" } });
      }
      expect(await harness.audit("runner.joinToken.revoked")).toHaveLength(0);

      // The one token that was still outstanding was left alone, and can be
      // taken back.
      expect((await outstanding(harness.base, token)).map((one) => one.id)).toEqual([liveId]);
      expect((await revoke(harness.base, token, liveId!)).status).toBe(200);
      expect((await join(harness.base, live.token)).status).toBe(401);
    });
  });
});
