/**
 * Tests the decisions behind archiving rows: when a row cannot be archived,
 * which rows "Archive all" takes from the Done shelf and which it leaves,
 * and the words of the confirmation and the toast.
 */
import type { Session } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildProviderAccount, ANTHROPIC_IDENTITY } from "../providers.testing";
import {
  buildArchiveCall,
  buildArchivedToast,
  buildArchiveTitle,
  findArchiveBlockReason,
  listArchiveWorkspaceIds,
  planArchiveAll,
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

describe("buildArchivedToast", () => {
  it("reads only Archived for one row, and counts several", () => {
    const none = { skippedWorking: 0, leftOver: 0 };
    expect(buildArchivedToast(1, none)).toBe("Archived");
    expect(buildArchivedToast(12, none)).toBe("Archived 12");
  });

  it("adds the rows Archive all skipped as working and the rows it left over", () => {
    expect(buildArchivedToast(12, { skippedWorking: 2, leftOver: 0 })).toBe(
      "Archived 12. 2 working rows skipped.",
    );
    expect(buildArchivedToast(12, { skippedWorking: 0, leftOver: 1 })).toBe(
      "Archived 12. 1 row left.",
    );
    expect(buildArchivedToast(1, { skippedWorking: 1, leftOver: 3 })).toBe(
      "Archived. 1 working row skipped. 3 rows left.",
    );
  });
});

describe("listArchiveWorkspaceIds", () => {
  it("lists each workspace once, and none for Threads with no workspace", () => {
    const rows = describeRows([
      doneThread("t-1", 5, { workspaceId: "w-1" }),
      doneThread("t-2", 6, { workspaceId: "w-1", createdAt: at(1) }),
      doneThread("t-3", 7, { workspaceId: "w-2" }),
      doneThread("t-4", 8),
    ]);
    expect(listArchiveWorkspaceIds(rows)).toEqual([["w-1", "w-2"]]);
  });

  it("splits the workspaces into reads of at most 500", () => {
    const rows = describeRows(
      Array.from({ length: 501 }, (_, index) =>
        doneThread(`t-${String(index)}`, index, { workspaceId: `w-${String(index)}` }),
      ),
    );
    const chunks = listArchiveWorkspaceIds(rows);
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 1]);
  });
});

describe("buildArchiveCall", () => {
  it("adds the Threads of the row's workspace that the sidebar's read missed, such as one marked Done long ago", () => {
    const [row] = describeRows([doneThread("t-new", 20, { workspaceId: "w-1" })]);
    const old = doneThread("t-old", 1, { workspaceId: "w-1", createdAt: at(-1) });

    const call = buildArchiveCall([row!], [old, doneThread("t-new", 20, { workspaceId: "w-1" })]);

    expect(call.sessionIds).toEqual(["t-new", "t-old"]);
    expect(call.rows).toEqual([row]);
    expect(call.droppedRows).toBe(0);
  });

  it("leaves out archived Threads, Agent sessions and Threads of other workspaces", () => {
    const [row] = describeRows([doneThread("t-1", 5, { workspaceId: "w-1" })]);
    const others = [
      doneThread("t-archived", 1, { workspaceId: "w-1", archived: { at: at(2), by: "user" } }),
      doneThread("a-1", 1, { workspaceId: "w-1", kind: "agent", agentId: "ag-1" }),
      doneThread("t-elsewhere", 1, { workspaceId: "w-2" }),
    ];
    expect(buildArchiveCall([row!], others).sessionIds).toEqual(["t-1"]);
  });

  it("sends a Thread with no workspace as it is", () => {
    const [row] = describeRows([doneThread("t-1", 5)]);
    expect(buildArchiveCall([row!], []).sessionIds).toEqual(["t-1"]);
  });

  it("takes whole rows only while the complete Threads stay within 500, and counts the rows dropped", () => {
    const { rows } = planArchiveAll(
      describeRows([
        ...Array.from({ length: 499 }, (_, index) => doneThread(`t-${String(index)}`, index)),
        doneThread("w-lead", 600, { workspaceId: "w-1" }),
      ]),
    );
    // The sidebar holds one Thread of the last row, so the plan fits: 500. Its workspace holds a
    // second Thread the sidebar did not list, which makes 501.
    const hidden = doneThread("w-old", 1, { workspaceId: "w-1", createdAt: at(-1) });

    const call = buildArchiveCall(rows, [hidden]);

    expect(rows).toHaveLength(500);
    expect(call.rows).toHaveLength(499);
    expect(call.sessionIds).toHaveLength(499);
    expect(call.droppedRows).toBe(1);
  });
});
