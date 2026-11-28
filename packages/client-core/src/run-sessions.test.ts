/** Tests `readRunSessions`: that it reads in one read per `MAX_SESSION_RUN_IDS` runs and keeps every session. */
import { MAX_SESSION_RUN_IDS } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { createApiStub } from "./api-stub";
import { createClient } from "./client";
import { readRunSessions } from "./run-sessions";
import { buildSession } from "./threads/workspaces.testing";

/** Returns the canonical id the client accepts for the thing numbered `number`. */
const uuid = (number: number): string =>
  `01a06d02-7400-7000-8000-${String(number).padStart(12, "0")}`;

/** Builds a session the client accepts: the fixture's own ids are not canonical. */
const buildReadableSession = (number: number) =>
  buildSession({
    id: uuid(number),
    permissionProfileId: uuid(9001),
    runnerId: uuid(9002),
    providerAccountId: uuid(9003),
  });

describe("readRunSessions", () => {
  it("names each run once, and returns the sessions of every read, every page included", async () => {
    // The first read answers in two pages; the second read in one.
    const api = createApiStub({
      "GET /api/v1/sessions": (call) => {
        const query = new URLSearchParams(call.search);
        const first = query.getAll("runId")[0];
        if (first === uuid(1) && !query.has("cursor"))
          return {
            body: { items: [buildReadableSession(1001)], nextCursor: "next" },
          };
        if (first === uuid(1)) return { body: { items: [buildReadableSession(1002)] } };
        return { body: { items: [buildReadableSession(1003)] } };
      },
    });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });
    const runIds = Array.from({ length: MAX_SESSION_RUN_IDS + 1 }, (_, index) => uuid(index + 1));

    const sessions = await readRunSessions(client, runIds);

    expect(sessions.map((session) => session.id)).toEqual([uuid(1001), uuid(1002), uuid(1003)]);
    const sent = api.calls.map((call) => new URLSearchParams(call.search).getAll("runId"));
    expect(sent).toEqual([
      runIds.slice(0, MAX_SESSION_RUN_IDS),
      runIds.slice(0, MAX_SESSION_RUN_IDS),
      runIds.slice(MAX_SESSION_RUN_IDS),
    ]);
  });

  it("reads nothing for no runs", async () => {
    const api = createApiStub({ "GET /api/v1/sessions": { body: { items: [] } } });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });

    expect(await readRunSessions(client, [])).toEqual([]);
    expect(api.calls).toEqual([]);
  });
});
