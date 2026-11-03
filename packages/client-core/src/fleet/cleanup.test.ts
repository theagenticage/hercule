/**
 * Tests the cleanup logic of the Fleet screen through its interface: which
 * workspaces are candidates, the dialog's groups and the button's words, the
 * archive-then-remove call against a stub controller.
 */
import type { Session, Workspace } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildErrorBody, createApiStub, type Handler } from "../api-stub";
import { createClient } from "../client";
import { buildSession, buildWorkspace } from "../threads/workspaces.testing";
import {
  archiveAndRemoveWorkspaces,
  buildCleanupSnapshot,
  describeCleanUpDisabledHint,
  describeCleanupDialog,
  listCleanupCandidates,
  requestRemovals,
  type CleanupPlan,
} from "./cleanup";

const GB = 1e9;
const NOW = new Date("2026-11-03T12:00:00.000Z");

/** Returns the instant `days` days before `NOW`. */
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** Returns the canonical id the client accepts for the thing numbered `number`. */
const uuid = (number: number): string =>
  `01a06d02-7400-7000-8000-${String(number).padStart(12, "0")}`;

const RUNNER = uuid(1);

/** Returns an idle ephemeral workspace on the machine, last used `usedDaysAgo` days ago, that frees `freesGb` GB. */
const buildIdle = (
  number: number,
  freesGb: number | null,
  over: Partial<Workspace> = {},
  usedDaysAgo = 10,
): Workspace =>
  buildWorkspace({
    id: uuid(number),
    runnerId: RUNNER,
    kind: "ephemeral",
    lastUsedAt: daysAgo(usedDaysAgo),
    diskUsage:
      freesGb === null
        ? null
        : { sizeBytes: freesGb * 2 * GB, freesBytes: freesGb * GB, measuredAt: daysAgo(1) },
    ...over,
  });

/**
 * Returns a Thread placed in `workspace`. It is Done unless `isDone` is false,
 * and archived when `isArchived` is true (an archived Thread is Done too).
 */
const buildThread = (
  number: number,
  workspace: Workspace,
  { isDone = true, isArchived = false } = {},
): Session =>
  buildSession({
    id: uuid(number),
    workspaceId: workspace.id,
    title: `Thread ${String(number)}`,
    createdAt: daysAgo(20 - number / 1000),
    ...(isDone || isArchived ? { done: { at: daysAgo(9), by: "user" } } : {}),
    ...(isArchived ? { archived: { at: daysAgo(8), by: "user" } } : {}),
  });

describe("describeCleanUpDisabledHint", () => {
  it("is null while the machine is online", () => {
    expect(describeCleanUpDisabledHint("atlas", true)).toBeNull();
  });

  it("names the machine and says it must be online otherwise", () => {
    expect(describeCleanUpDisabledHint("atlas", false)).toBe(
      "atlas is offline. Cleaning up needs it online.",
    );
  });
});

describe("listCleanupCandidates", () => {
  it("lists the machine's idle ephemeral workspaces that are ready or failed", () => {
    const workspaces = [
      buildIdle(10, 5),
      buildIdle(11, 5, { status: "failed" }),
      buildIdle(12, 5, { runnerId: uuid(2) }),
      buildIdle(13, 5, { kind: "primary" }),
      buildIdle(14, 5, { status: "disposing" }),
      buildIdle(15, 5, { status: "deleted" }),
      buildIdle(16, 5, { sessionIds: [uuid(900)] }),
      buildIdle(17, 5, {}, 6),
      buildIdle(18, 5, {}, 7),
    ];

    const ids = listCleanupCandidates(workspaces, RUNNER, NOW).map((workspace) => workspace.id);

    expect(ids).toEqual([uuid(10), uuid(11), uuid(18)]);
  });
});

describe("describeCleanupDialog", () => {
  const big = buildIdle(10, 30);
  const small = buildIdle(11, 11);
  const stale = buildIdle(12, 20);
  const archivedOnly = buildIdle(13, 5);
  const unused = buildIdle(14, 50);
  const threads = [
    buildThread(101, big),
    buildThread(102, big, { isArchived: true }),
    buildThread(103, small),
    buildThread(104, stale),
    buildThread(105, stale, { isDone: false }),
    buildThread(106, archivedOnly, { isArchived: true }),
  ];
  const snapshot = buildCleanupSnapshot(
    "atlas",
    [big, small, stale, archivedOnly, unused],
    threads,
    NOW,
  );

  it("lists the workspaces a Thread used, largest first, in the two groups", () => {
    const dialog = describeCleanupDialog(snapshot, snapshot.initialTicked);

    expect(dialog.head).toBe("Clean up atlas");
    expect(
      dialog.groups.map((group) => ({
        title: group.title,
        hint: group.hint,
        rows: group.rows.map((row) => row.workspaceId),
      })),
    ).toEqual([
      {
        title: "Threads Done",
        hint: "Not used for a week or more, and every thread in them is Done.",
        rows: [uuid(10), uuid(11), uuid(13)],
      },
      {
        title: "Threads not Done",
        hint: "Some threads here are not Done. Removing marks them Done and archives them.",
        rows: [uuid(12)],
      },
    ]);
    expect(dialog.foot).toBe(
      "Everything in these workspaces is deleted, files you never committed included.",
    );
    expect(dialog.empty).toBeNull();
  });

  it("describes a row by its name, what it frees and when it was last used", () => {
    const row = describeCleanupDialog(snapshot, new Set()).groups[0]!.rows[0]!;

    expect(row).toMatchObject({
      name: "Thread 101",
      freesText: "30 GB",
      lastUsedText: "1 week ago",
      expectedLastUsedAt: daysAgo(10),
    });
  });

  it("ticks the Threads Done group when the dialog opens and words the button from the ticked rows", () => {
    const dialog = describeCleanupDialog(snapshot, snapshot.initialTicked);

    expect(dialog.groups.map((group) => group.checked)).toEqual(["all", "none"]);
    expect(dialog.button).toEqual({
      label: "Archive and remove 3, frees 46 GB",
      disabled: false,
      hint: null,
    });
    // The archived Thread of the first workspace and the whole archived workspace are not archived again.
    expect(dialog.plan?.threadIds).toEqual([uuid(101), uuid(103)]);
    expect(
      dialog.plan?.rows.map((row) => [row.workspaceId, row.expectedLastUsedAt, row.freesBytes]),
    ).toEqual([
      [uuid(10), daysAgo(10), 30 * GB],
      [uuid(11), daysAgo(10), 11 * GB],
      [uuid(13), daysAgo(10), 5 * GB],
    ]);
  });

  it("words the button again when the user ticks and unticks", () => {
    const dialog = describeCleanupDialog(snapshot, new Set([uuid(12), uuid(10)]));

    expect(dialog.button.label).toBe("Archive and remove 2, frees 50 GB");
    expect(dialog.groups.map((group) => group.checked)).toEqual(["some", "all"]);
    expect(dialog.groups[1]!.summary).toBe("1 · frees 20 GB");
  });

  it("disables the button with no ticks", () => {
    const dialog = describeCleanupDialog(snapshot, new Set());

    expect(dialog.button).toEqual({ label: "Archive and remove", disabled: true, hint: null });
    expect(dialog.plan).toBeNull();
  });

  it("disables the button when the ticked workspaces hold more than 500 Threads to archive", () => {
    const heavy = buildIdle(20, 9);
    const light = buildIdle(21, 8);
    const crowd = Array.from({ length: 501 }, (_, index) => buildThread(1000 + index, heavy));
    const crowdSnapshot = buildCleanupSnapshot(
      "atlas",
      [heavy, light],
      [...crowd, buildThread(2000, light)],
      NOW,
    );

    const tooMany = describeCleanupDialog(crowdSnapshot, new Set([heavy.id]));
    const fewer = describeCleanupDialog(crowdSnapshot, new Set([light.id]));

    expect(tooMany.button).toEqual({
      label: "Archive and remove 1, frees 9 GB",
      disabled: true,
      hint: "Tick fewer: one cleanup archives at most 500 threads.",
    });
    expect(tooMany.plan).toBeNull();
    expect(fewer.button.disabled).toBe(false);
  });

  it("counts only the Threads that are not archived yet against the limit of 500", () => {
    const heavy = buildIdle(20, 9);
    const crowd = Array.from({ length: 500 }, (_, index) =>
      buildThread(1000 + index, heavy, { isArchived: index < 400 }),
    );
    const crowdSnapshot = buildCleanupSnapshot("atlas", [heavy], crowd, NOW);

    expect(describeCleanupDialog(crowdSnapshot, new Set([heavy.id])).button.disabled).toBe(false);
  });

  it("keeps the 200 largest rows", () => {
    const workspaces = Array.from({ length: 205 }, (_, index) =>
      buildIdle(3000 + index, index + 1),
    );
    const crowded = buildCleanupSnapshot(
      "atlas",
      workspaces,
      workspaces.map((workspace, index) => buildThread(5000 + index, workspace)),
      NOW,
    );

    expect(crowded.rows).toHaveLength(200);
    expect(crowded.rows[0]!.freesBytes).toBe(205 * GB);
    expect(crowded.rows.at(-1)!.freesBytes).toBe(6 * GB);
  });

  it("puts a workspace that was never measured last and leaves its size out of the button", () => {
    const unmeasured = buildIdle(30, null);
    const measured = buildIdle(31, 4);
    const mixed = buildCleanupSnapshot(
      "atlas",
      [unmeasured, measured],
      [buildThread(301, unmeasured), buildThread(302, measured)],
      NOW,
    );

    const dialog = describeCleanupDialog(mixed, mixed.initialTicked);

    expect(dialog.groups[0]!.rows.map((row) => row.workspaceId)).toEqual([
      measured.id,
      unmeasured.id,
    ]);
    expect(dialog.button.label).toBe("Archive and remove 2, frees 4 GB");
    expect(dialog.plan!.rows[1]!.freesBytes).toBeNull();
  });

  it("says nothing is left to clean up when no Thread used an idle workspace", () => {
    const empty = buildCleanupSnapshot("atlas", [unused], [], NOW);

    const dialog = describeCleanupDialog(empty, empty.initialTicked);

    expect(dialog.empty).toBe(
      "Nothing to clean up. Every workspace here was used in the last 7 days.",
    );
    expect(dialog.groups).toEqual([]);
    expect(dialog.foot).toBeNull();
    expect(dialog.button.disabled).toBe(true);
  });

  it("sends no last-used time for a workspace that has none", () => {
    const none = buildIdle(40, 3, { lastUsedAt: null });
    const once = buildCleanupSnapshot("atlas", [none], [buildThread(401, none)], NOW);

    expect(
      describeCleanupDialog(once, once.initialTicked).plan!.rows[0]!.expectedLastUsedAt,
    ).toBeNull();
  });
});

describe("archiveAndRemoveWorkspaces", () => {
  /** Returns the session the controller sends back for an archived Thread. */
  const archivedOnWire = (id: string, kind: Session["kind"] = "thread"): Session => ({
    ...buildSession({ id, kind, archived: { at: daysAgo(0), by: "user" } }),
    permissionProfileId: uuid(7001),
    providerAccountId: uuid(7002),
    runnerId: uuid(7003),
    projectId: null,
  });

  // The first workspace has a last-used time and frees 30 GB. The second has no last-used time.
  const plan: CleanupPlan = {
    threadIds: [uuid(101), uuid(103)],
    rows: buildCleanupSnapshot(
      "atlas",
      [buildIdle(10, 30), buildIdle(11, 11, { lastUsedAt: null })],
      [buildThread(101, buildIdle(10, 30)), buildThread(103, buildIdle(11, 11))],
      NOW,
    ).rows,
  };

  /** Returns a client on a stub controller with `archive` and `dispose` handlers, and the calls it receives. */
  const buildController = (archive: Handler, dispose: Handler) => {
    const api = createApiStub({
      "POST /api/v1/sessions/archive": archive,
      "POST /api/v1/workspaces/dispose": dispose,
    });
    return { api, client: createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch }) };
  };

  const archiveAll: Handler = (call) => ({
    body: (call.body as { sessionIds: string[] }).sessionIds.map((id) => archivedOnWire(id)),
  });

  it("removes nothing and returns the controller's message when the archive is refused", async () => {
    const { api, client } = buildController(
      {
        status: 409,
        body: buildErrorBody("invalid_state", "Thread 103 is working. Stop it first."),
      },
      { body: { results: [] } },
    );

    const start = await archiveAndRemoveWorkspaces(client, plan);

    expect(start).toEqual({
      status: "archiveFailed",
      message: "Thread 103 is working. Stop it first.",
    });
    expect(api.calls.map((call) => call.path)).toEqual(["/api/v1/sessions/archive"]);
  });

  it("archives the Threads, then asks to remove each workspace with the last-used time the dialog showed", async () => {
    const { api, client } = buildController(archiveAll, (call) => ({
      body: {
        results: (call.body as { items: { workspaceId: string }[] }).items.map((item) => ({
          workspaceId: item.workspaceId,
          outcome: "requested",
        })),
      },
    }));

    const start = await archiveAndRemoveWorkspaces(client, plan);

    expect(api.calls.map((call) => [call.path, call.body])).toEqual([
      ["/api/v1/sessions/archive", { sessionIds: [uuid(101), uuid(103)] }],
      [
        "/api/v1/workspaces/dispose",
        {
          items: [
            { workspaceId: uuid(10), expectedLastUsedAt: daysAgo(10) },
            { workspaceId: uuid(11) },
          ],
        },
      ],
    ]);
    expect(start).toEqual({
      status: "archived",
      archivedCount: 2,
      removal: {
        status: "started",
        results: [
          { workspaceId: uuid(10), outcome: "requested" },
          { workspaceId: uuid(11), outcome: "requested" },
        ],
      },
    });
  });

  it("still reports the archive when every removal is refused", async () => {
    const results = [
      { workspaceId: uuid(10), outcome: "refused", message: "Stop sessions 01a0 first." },
      { workspaceId: uuid(11), outcome: "refused", message: "A process had a file open." },
    ];
    const { client } = buildController(archiveAll, { body: { results } });

    const start = await archiveAndRemoveWorkspaces(client, plan);

    expect(start).toEqual({
      status: "archived",
      archivedCount: 2,
      removal: { status: "started", results },
    });
  });

  it("counts Threads only: the Agent sessions archived with them are not counted", async () => {
    const { client } = buildController(
      { body: [archivedOnWire(uuid(101)), archivedOnWire(uuid(500), "agent")] },
      { body: { results: [{ workspaceId: uuid(10), outcome: "requested" }] } },
    );

    const start = await archiveAndRemoveWorkspaces(client, { ...plan, rows: [plan.rows[0]!] });

    expect(start).toMatchObject({ archivedCount: 1 });
  });

  it("skips the archive when no Thread is left to archive, as Try again does", async () => {
    const { api, client } = buildController(archiveAll, {
      body: { results: [{ workspaceId: uuid(10), outcome: "requested" }] },
    });

    const start = await archiveAndRemoveWorkspaces(client, {
      threadIds: [],
      rows: [plan.rows[0]!],
    });

    expect(api.calls.map((call) => call.path)).toEqual(["/api/v1/workspaces/dispose"]);
    expect(start).toMatchObject({ status: "archived", archivedCount: 0 });
  });

  it("still returns the archived count when the archive is done and the removal call fails", async () => {
    const { client } = buildController(archiveAll, {
      status: 500,
      body: buildErrorBody("internal", "The controller is restarting."),
    });

    const start = await archiveAndRemoveWorkspaces(client, plan);

    expect(start).toEqual({
      status: "archived",
      archivedCount: 2,
      removal: { status: "removalUnknown", message: "The controller is restarting." },
    });
  });

  it("does not claim the archive was refused when the controller answers with a body the client cannot read", async () => {
    const { api, client } = buildController(
      { body: { archived: "yes" } },
      { body: { results: [] } },
    );

    const start = await archiveAndRemoveWorkspaces(client, plan);

    expect(start.status).toBe("archiveFailed");
    expect(api.calls.map((call) => call.path)).toEqual(["/api/v1/sessions/archive"]);
  });

  it("treats an internal error from the controller as unconfirmed, not refused", async () => {
    const { client } = buildController(
      { status: 500, body: buildErrorBody("internal", "The controller failed.") },
      { body: { results: [] } },
    );

    const start = await archiveAndRemoveWorkspaces(client, plan);

    expect(start.status).toBe("archiveFailed");
  });

  it("does not claim the archive failed when the call gets no answer", async () => {
    const { client } = buildController(
      () => {
        throw new Error("network down");
      },
      { body: { results: [] } },
    );

    const start = await archiveAndRemoveWorkspaces(client, plan);

    if (start.status !== "archiveFailed") throw new Error(`Unexpected status ${start.status}`);
    expect(start.message).toMatch(
      /^Could not confirm that the threads were archived: .+[^.]\. Check them before you try again\.$/,
    );
  });
});

describe("requestRemovals", () => {
  const rows = buildCleanupSnapshot(
    "atlas",
    [buildIdle(10, 30), buildIdle(11, 11, { lastUsedAt: null })],
    [buildThread(101, buildIdle(10, 30)), buildThread(102, buildIdle(11, 11))],
    NOW,
  ).rows;

  it("sends each row's last-used time, and none for a row that has none, without archiving", async () => {
    const api = createApiStub({
      "POST /api/v1/workspaces/dispose": { body: { results: [] } },
    });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });

    await requestRemovals(client, rows);

    expect(api.calls.map((call) => [call.path, call.body])).toEqual([
      [
        "/api/v1/workspaces/dispose",
        {
          items: [
            { workspaceId: uuid(10), expectedLastUsedAt: daysAgo(10) },
            { workspaceId: uuid(11) },
          ],
        },
      ],
    ]);
  });

  it("returns the failure instead of throwing when the call fails", async () => {
    const api = createApiStub({
      "POST /api/v1/workspaces/dispose": {
        status: 500,
        body: buildErrorBody("internal", "The controller is restarting."),
      },
    });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });

    expect(await requestRemovals(client, rows)).toEqual({
      status: "removalUnknown",
      message: "The controller is restarting.",
    });
  });
});
