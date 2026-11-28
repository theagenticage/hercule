/** Tests `readRunSessions`: that it reads in one read per `MAX_SESSION_RUN_IDS` runs. */
import { MAX_SESSION_RUN_IDS } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { createApiStub } from "./api-stub";
import { createClient } from "./client";
import { readRunSessions } from "./run-sessions";

/** Returns the canonical id the client accepts for the thing numbered `number`. */
const uuid = (number: number): string =>
  `01a06d02-7400-7000-8000-${String(number).padStart(12, "0")}`;

describe("readRunSessions", () => {
  it("reads one more run than the cap in two reads", async () => {
    const api = createApiStub({ "GET /api/v1/sessions": { body: { items: [] } } });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });
    const ids = Array.from({ length: MAX_SESSION_RUN_IDS + 1 }, (_, index) => uuid(index + 1));

    await readRunSessions(client, ids);

    const queries = api.calls.map((call) => new URLSearchParams(call.search));
    expect(queries.map((query) => query.getAll("runId").length)).toEqual([MAX_SESSION_RUN_IDS, 1]);
  });

  it("reads nothing for no runs", async () => {
    const api = createApiStub({ "GET /api/v1/sessions": { body: { items: [] } } });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });

    expect(await readRunSessions(client, [])).toEqual([]);
    expect(api.calls).toEqual([]);
  });
});
