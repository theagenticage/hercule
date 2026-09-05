/**
 * The runner read side over a real socket: what a listing carries, what one
 * row carries, what a patch may change, and what an anonymous caller gets.
 *
 * Rows are arranged through the harness's `insertRunner`, which goes through
 * the real repository: no operation creates a runner in this slice, join lands
 * later.
 */
import { describe, expect, it } from "vitest";
import type { Runner } from "@hydra/contract";
import type { ServerHarness } from "../http/testing";
import { completeSetup, get, send, withServer } from "../http/testing";

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

const read = async (base: string, token: string, id: string): Promise<Runner> => {
  const response = await get(base, `/api/v1/runners/${id}`, token);
  expect(response.status).toBe(200);
  return (await response.json()) as Runner;
};

const patch = (base: string, token: string, id: string, body: unknown): Promise<Response> =>
  send("PATCH", base, `/api/v1/runners/${id}`, { body, token });

const names = (page: RunnerPage): ReadonlyArray<string> =>
  page.items.map((runner) => runner.name).sort();

/** Three rows: three states, one of them labelled `gpu`. */
const three = async (harness: ServerHarness) => ({
  online: await harness.insertRunner({ name: "iris", state: "online", labels: ["gpu"] }),
  offline: await harness.insertRunner({ name: "atlas", state: "offline" }),
  retired: await harness.insertRunner({ name: "vega", state: "retired" }),
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
        "state",
        "version",
        "labels",
        "facts",
        "watermark",
        "maxConcurrentSessions",
        "lastSeenAt",
      ]) {
        expect(Object.keys(row ?? {}), `a listed runner carries ${field}`).toContain(field);
      }
      expect(row).toMatchObject({
        id: online.id,
        name: "iris",
        state: "online",
        labels: ["gpu"],
        maxConcurrentSessions: 1,
      });
    });
  });

  it("filters by state and by label", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await three(harness);

      expect(names(await list(harness.base, token, "?state=online"))).toEqual(["iris"]);
      expect(names(await list(harness.base, token, "?label=gpu"))).toEqual(["iris"]);
      expect(names(await list(harness.base, token, "?state=online&label=gpu"))).toEqual(["iris"]);
      expect(names(await list(harness.base, token, "?state=offline&label=gpu"))).toEqual([]);
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

  it("refuses a state that is not one of the five", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      await three(harness);

      const response = await get(harness.base, "/api/v1/runners?state=asleep", token);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
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
        "state",
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
      expect(row).toMatchObject({ id: online.id, name: "iris", state: "online" });
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
        state: "online",
        labels: ["gpu"],
        maxConcurrentSessions: 3,
      });

      const renamed = await patch(harness.base, token, runner.id, { name: "iris-2" });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({
        id: runner.id,
        name: "iris-2",
        state: "online",
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
        state: "online",
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
      const runner = await harness.insertRunner({ name: "iris", labels: ["gpu"] });

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
      const runner = await harness.insertRunner({ name: "iris", state: "online" });

      // Each one rides beside a field the patch may set, so the refusal is the
      // unknown key and not the empty patch.
      for (const body of [
        { name: "iris-2", facts: { os: "linux" } },
        { name: "iris-2", state: "retired" },
        { name: "iris-2", watermark: { diskFreeBytes: 1 } },
      ]) {
        const response = await patch(harness.base, token, runner.id, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      }

      expect(await read(harness.base, token, runner.id)).toMatchObject({
        name: "iris",
        state: "online",
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
