/**
 * Tests the decisions behind archiving rows: when a row cannot be archived,
 * which rows "Archive all" takes from the Done shelf and which it leaves,
 * the words of the confirmation, and `archiveRows`, which completes the
 * rows' Threads, packs whole rows under the limit of one call, archives
 * them and words the toast, against a stub controller.
 */
import type { Session } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildProviderAccount, ANTHROPIC_IDENTITY } from "../providers.testing";
import { buildErrorBody, createApiStub, type Handler } from "../api-stub";
import { createClient } from "../client";
import {
  archiveRows,
  buildArchiveTitle,
  findArchiveBlockReason,
  planArchiveAll,
  type ArchivePlan,
} from "./archive";
import type { GroupRow } from "./group-row";
import { prepareSessionPresentation } from "./session-presentation";
import { MOSS, WEBSHOP, WEBSHOP_PROJECT, buildSession } from "./workspaces.testing";

/** Returns a timestamp `minute` minutes after 09:00. */
const at = (minute: number): string =>
  new Date(Date.parse("2026-09-10T09:00:00.000Z") + minute * 60_000).toISOString();

/** Returns a Thread in no workspace, so a row of its own, marked Done at minute `doneMinute`. */
const doneThread = (id: string, doneMinute: number, over: Partial<Session> = {}): Session =>
  buildSession({
    id,
    projectId: WEBSHOP_PROJECT.id,
    title: `Thread ${id}`,
    createdAt: at(0),
    done: { at: at(doneMinute), by: "user" },
    ...over,
  });

/** Returns the rows of `sessions`, in the order the sidebar's presentation holds them. */
const describeRows = (sessions: readonly Session[]): readonly GroupRow[] =>
  prepareSessionPresentation({
    listedSessions: sessions,
    openSession: null,
    projects: [WEBSHOP_PROJECT],
    workspaces: [],
    resources: [WEBSHOP],
    runners: [MOSS],
    accounts: [buildProviderAccount(ANTHROPIC_IDENTITY)],
  }).groupRows;

/** Returns the one row `sessions` form. */
const describeRow = (sessions: readonly Session[]): GroupRow => describeRows(sessions)[0]!;

describe("findArchiveBlockReason", () => {
  it("allows a row whose sessions are idle or exited", () => {
    expect(findArchiveBlockReason(describeRow([doneThread("t-1", 5)]))).toBeNull();
    expect(
      findArchiveBlockReason(describeRow([doneThread("t-1", 5, { status: "exited" })])),
    ).toBeNull();
  });

  it.each(["queued", "starting", "busy"] as const)("names the row that is %s", (status) => {
    const row = describeRow([doneThread("t-1", 5, { title: "Ship v2.4", status })]);
    expect(findArchiveBlockReason(row)).toBe("Ship v2.4 is working. Stop it first.");
  });

  it("blocks a Done Thread that is still busy, which the controller refuses too", () => {
    expect(
      findArchiveBlockReason(describeRow([doneThread("t-1", 5, { status: "busy" })])),
    ).not.toBeNull();
  });

  it("blocks a row that waits on the user while its session is busy", () => {
    const waiting = doneThread("t-1", 5, {
      status: "busy",
      openRequests: [
        {
          requestId: "r-1",
          itemId: "tool-1",
          decisions: ["allow", "deny"],
          kind: "command_approval",
          detail: { command: "git push" },
        },
      ],
    });
    expect(findArchiveBlockReason(describeRow([waiting]))).not.toBeNull();
  });
});

describe("planArchiveAll", () => {
  it("takes the rows on the Done shelf, the oldest marked Done first", () => {
    const rows = describeRows([
      doneThread("t-new", 30),
      doneThread("t-old", 10),
      doneThread("t-mid", 20),
    ]);
    const plan = planArchiveAll(rows);
    expect(plan.rows.map((row) => row.leadId)).toEqual(["t-old", "t-mid", "t-new"]);
    expect(plan).toMatchObject({ skippedWorking: 0, leftOver: 0 });
  });

  it("leaves out a row that is not Done, without counting it", () => {
    const open = buildSession({ id: "t-open", projectId: WEBSHOP_PROJECT.id, createdAt: at(0) });
    const plan = planArchiveAll(describeRows([open, doneThread("t-1", 5)]));
    expect(plan.rows.map((row) => row.leadId)).toEqual(["t-1"]);
    expect(plan.skippedWorking).toBe(0);
  });

  it("skips the rows that work and counts them", () => {
    const plan = planArchiveAll(
      describeRows([
        doneThread("t-1", 5),
        doneThread("t-busy", 6, { status: "busy" }),
        doneThread("t-queued", 7, { status: "queued" }),
      ]),
    );
    expect(plan.rows.map((row) => row.leadId)).toEqual(["t-1"]);
    expect(plan.skippedWorking).toBe(2);
  });

  it("archives every Thread of a row of several Threads, in one plan", () => {
    const first = doneThread("t-1", 5, { workspaceId: "w-1" });
    const second = doneThread("t-2", 6, { workspaceId: "w-1", createdAt: at(1) });
    const plan = planArchiveAll(describeRows([first, second]));
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.threadIds).toEqual(["t-1", "t-2"]);
  });

  it("takes whole rows only while the Threads stay within 500, and counts the rows left over", () => {
    const older = Array.from({ length: 498 }, (_, index) =>
      doneThread(`t-${String(index)}`, 1 + index / 1000),
    );
    const big = [
      doneThread("big-1", 50, { workspaceId: "w-big" }),
      doneThread("big-2", 50, { workspaceId: "w-big", createdAt: at(1) }),
      doneThread("big-3", 50, { workspaceId: "w-big", createdAt: at(2) }),
    ];
    const newest = doneThread("t-newest", 60);
    const plan = planArchiveAll(describeRows([...older, ...big, newest]));
    // 498 Threads fit; the 3 of the big row would make 501, and the newest row waits behind it.
    expect(plan.rows).toHaveLength(498);
    expect(plan.leftOver).toBe(2);
  });

  it("takes exactly 500 Threads when they fit", () => {
    const sessions = Array.from({ length: 501 }, (_, index) =>
      doneThread(`t-${String(index)}`, index),
    );
    const plan = planArchiveAll(describeRows(sessions));
    expect(plan.rows).toHaveLength(500);
    expect(plan.leftOver).toBe(1);
    expect(plan.rows.at(-1)?.leadId).toBe("t-499");
  });

  it("plans nothing when every row works", () => {
    const plan = planArchiveAll(describeRows([doneThread("t-1", 5, { status: "busy" })]));
    expect(plan).toMatchObject({ rows: [], skippedWorking: 1, leftOver: 0 });
  });
});

describe("buildArchiveTitle", () => {
  it("names a single row", () => {
    expect(buildArchiveTitle([describeRow([doneThread("t-1", 5, { title: "Ship v2.4" })])])).toBe(
      "Archive Ship v2.4?",
    );
  });

  it("counts several rows", () => {
    const rows = describeRows([doneThread("t-1", 5), doneThread("t-2", 6)]);
    expect(buildArchiveTitle(rows)).toBe("Archive 2 rows?");
  });
});

describe("archiveRows", () => {
  /** Returns the canonical id the client accepts for the thing numbered `number`. */
  const uuid = (number: number): string =>
    `01a06d02-7400-7000-8000-${String(number).padStart(12, "0")}`;
  const W1 = uuid(9001);
  const W2 = uuid(9002);

  /** Returns `session` with the ids the fixture spells loosely made canonical, so the client accepts it from the controller. */
  const onWire = (session: Session): Session => ({
    ...session,
    permissionProfileId: uuid(7001),
    providerAccountId: uuid(7002),
    runnerId: uuid(7003),
    projectId: null,
  });

  /**
   * Returns a client on a stub controller that holds `workspaceThreads` for
   * the read by workspace and archives the Threads it is sent, and the
   * calls it received. `archive` answers the archive instead when given.
   */
  const buildController = (workspaceThreads: readonly Session[] = [], archive?: Handler) => {
    const api = createApiStub({
      "GET /api/v1/sessions": { body: { items: workspaceThreads.map(onWire) } },
      "POST /api/v1/sessions/archive":
        archive ??
        ((call) => ({
          body: (call.body as { sessionIds: string[] }).sessionIds.map((id) =>
            onWire(buildSession({ id, archived: { at: at(30), by: "user" } })),
          ),
        })),
    });
    return { api, client: createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch }) };
  };

  /** Returns the plan that archives `rows` alone. */
  const planOf = (rows: readonly GroupRow[], over: Partial<ArchivePlan> = {}): ArchivePlan => ({
    rows,
    skippedWorking: 0,
    leftOver: 0,
    ...over,
  });

  /** Returns the ids each archive call carried. */
  const readArchived = (api: ReturnType<typeof buildController>["api"]) =>
    api.calls
      .filter((call) => call.path === "/api/v1/sessions/archive")
      .map((call) => (call.body as { sessionIds: string[] }).sessionIds);

  it("archives a Thread with no workspace as it is, reads nothing, and says only Archived", async () => {
    const { api, client } = buildController();

    const { sessions, notice } = await archiveRows(
      client,
      planOf([describeRow([doneThread(uuid(11), 5)])]),
    );

    expect(readArchived(api)).toEqual([[uuid(11)]]);
    expect(api.calls.some((call) => call.method === "GET")).toBe(false);
    expect(sessions.map((session) => session.id)).toEqual([uuid(11)]);
    expect(notice).toBe("Archived");
  });

  it("adds the Threads of the row's workspace that the sidebar's read missed, such as one marked Done long ago", async () => {
    const recent = doneThread(uuid(1), 20, { workspaceId: W1 });
    const old = doneThread(uuid(2), 1, { workspaceId: W1, createdAt: at(-1) });
    const { api, client } = buildController([old, recent]);

    await archiveRows(client, planOf([describeRow([recent])]));

    const read = api.calls.find((call) => call.method === "GET")!;
    expect(new URLSearchParams(read.search).getAll("workspaceId")).toEqual([W1]);
    expect(new URLSearchParams(read.search).get("archived")).toBe("false");
    expect(readArchived(api)).toEqual([[uuid(1), uuid(2)]]);
  });

  it("reads every workspace of the rows in one query, and counts the rows in the toast", async () => {
    const first = doneThread(uuid(11), 5, { workspaceId: W1 });
    const second = doneThread(uuid(12), 6, { workspaceId: W2 });
    const hidden = doneThread(uuid(13), 1, { workspaceId: W2, createdAt: at(-1) });
    const { api, client } = buildController([first, second, hidden]);

    const { notice } = await archiveRows(client, planOf(describeRows([first, second])));

    const reads = api.calls.filter((call) => call.method === "GET");
    expect(reads).toHaveLength(1);
    expect(new URLSearchParams(reads[0]!.search).getAll("workspaceId").toSorted()).toEqual([
      W1,
      W2,
    ]);
    expect(readArchived(api)[0]!.toSorted()).toEqual([uuid(11), uuid(12), uuid(13)]);
    expect(notice).toBe("Archived 2");
  });

  it("says how many working rows the plan skipped and how many it left over", async () => {
    const { client } = buildController();

    const { notice } = await archiveRows(
      client,
      planOf(describeRows([doneThread(uuid(11), 5), doneThread(uuid(12), 6)]), {
        skippedWorking: 2,
        leftOver: 1,
      }),
    );

    expect(notice).toBe("Archived 2. 2 working rows skipped. 1 row left.");
  });

  it("takes whole rows only while the complete Threads stay within 500, and counts the rows dropped as left", async () => {
    const { rows } = planArchiveAll(
      describeRows([
        ...Array.from({ length: 499 }, (_, index) => doneThread(uuid(100 + index), index)),
        doneThread(uuid(20), 600, { workspaceId: W1 }),
      ]),
    );
    // The sidebar holds one Thread of the last row, so the plan fits: 500. Its workspace holds a
    // second Thread the sidebar did not list, which makes 501.
    const hidden = doneThread(uuid(21), 1, { workspaceId: W1, createdAt: at(-1) });
    const { api, client } = buildController([hidden]);

    const { notice } = await archiveRows(client, planOf(rows));

    expect(rows).toHaveLength(500);
    expect(readArchived(api)[0]).toHaveLength(499);
    expect(notice).toBe("Archived 499. 1 row left.");
  });

  it("fails without archiving when the first row alone holds more Threads than one call takes", async () => {
    const lead = doneThread(uuid(22), 5, { workspaceId: W1 });
    const hidden = Array.from({ length: 500 }, (_, index) =>
      doneThread(uuid(1000 + index), 1, { workspaceId: W1 }),
    );
    const { api, client } = buildController(hidden);

    await expect(archiveRows(client, planOf([describeRow([lead])]))).rejects.toThrow(
      "more threads than one archive can take",
    );
    expect(readArchived(api)).toEqual([]);
  });

  it("fails with the controller's refusal", async () => {
    const { client } = buildController([], {
      status: 409,
      body: buildErrorBody("invalid_state", "Thread one is working."),
    });

    await expect(
      archiveRows(client, planOf([describeRow([doneThread(uuid(11), 5)])])),
    ).rejects.toThrow("Thread one is working.");
  });
});
