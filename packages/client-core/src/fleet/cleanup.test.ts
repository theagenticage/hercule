/**
 * Tests the cleanup logic of the Fleet screen through its interface: which
 * workspaces are candidates, the dialog's groups and the button's words, the
 * archive-then-remove call against a stub controller, and the words of the
 * outcome.
 */
import { USED_SINCE_LOOKED_REFUSAL, type Session, type Workspace } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildErrorBody, createApiStub, type Handler } from "../api-stub";
import { createClient } from "../client";
import { buildSession, buildWorkspace } from "../threads/workspaces.testing";
import {
  archiveAndRemoveWorkspaces,
  buildCleanupSnapshot,
  decideRemovalOutcome,
  describeCleanupDialog,
  describeCleanupOutcome,
  listCleanupCandidates,
  readCleanupThreads,
  type CleanupItem,
  type CleanupPlan,
  type RemovalOutcome,
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

describe("readCleanupThreads", () => {
  it("reads archived Threads too, in one read per 500 workspaces", async () => {
    const api = createApiStub({ "GET /api/v1/sessions": { body: { items: [] } } });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });
    const ids = Array.from({ length: 501 }, (_, index) => uuid(index + 1));

    await readCleanupThreads(client, ids);

    const queries = api.calls.map((call) => new URLSearchParams(call.search));
    expect(queries.map((query) => query.getAll("workspaceId").length)).toEqual([500, 1]);
    expect(queries[0]!.get("kind")).toBe("thread");
    expect(queries[0]!.has("archived")).toBe(false);
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
    expect(dialog.plan).toEqual({
      threadIds: [uuid(101), uuid(103)],
      items: [
        { workspaceId: uuid(10), expectedLastUsedAt: daysAgo(10), freesBytes: 30 * GB },
        { workspaceId: uuid(11), expectedLastUsedAt: daysAgo(10), freesBytes: 11 * GB },
        { workspaceId: uuid(13), expectedLastUsedAt: daysAgo(10), freesBytes: 5 * GB },
      ],
    });
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
    expect(dialog.plan!.items[1]!.freesBytes).toBe(0);
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
      describeCleanupDialog(once, once.initialTicked).plan!.items[0]!.expectedLastUsedAt,
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

  const plan: CleanupPlan = {
    threadIds: [uuid(101), uuid(103)],
    items: [
      { workspaceId: uuid(10), expectedLastUsedAt: daysAgo(10), freesBytes: 30 * GB },
      { workspaceId: uuid(11), expectedLastUsedAt: null, freesBytes: 11 * GB },
    ],
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
      status: "archiveRefused",
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
      status: "started",
      archivedCount: 2,
      removals: [
        { workspaceId: uuid(10), outcome: { kind: "removing" } },
        { workspaceId: uuid(11), outcome: { kind: "removing" } },
      ],
    });
  });

  it("still reports the archive when every removal is refused, and words a workspace used since", async () => {
    const { client } = buildController(archiveAll, {
      body: {
        results: [
          {
            workspaceId: uuid(10),
            outcome: "refused",
            message: USED_SINCE_LOOKED_REFUSAL,
          },
          {
            workspaceId: uuid(11),
            outcome: "refused",
            message: "Stop sessions 01a0 first.",
          },
        ],
      },
    });

    const start = await archiveAndRemoveWorkspaces(client, plan);

    expect(start).toEqual({
      status: "started",
      archivedCount: 2,
      removals: [
        {
          workspaceId: uuid(10),
          outcome: { kind: "refused", message: "Used since you looked.", retry: false },
        },
        {
          workspaceId: uuid(11),
          outcome: { kind: "refused", message: "Stop sessions 01a0 first.", retry: true },
        },
      ],
    });
  });

  it("counts Threads only: the Agent sessions archived with them are not counted", async () => {
    const { client } = buildController(
      { body: [archivedOnWire(uuid(101)), archivedOnWire(uuid(500), "agent")] },
      { body: { results: [{ workspaceId: uuid(10), outcome: "requested" }] } },
    );

    const start = await archiveAndRemoveWorkspaces(client, { ...plan, items: [plan.items[0]!] });

    expect(start).toMatchObject({ archivedCount: 1 });
  });

  it("skips the archive when no Thread is left to archive, as Try again does", async () => {
    const { api, client } = buildController(archiveAll, {
      body: { results: [{ workspaceId: uuid(10), outcome: "requested" }] },
    });

    const start = await archiveAndRemoveWorkspaces(client, {
      threadIds: [],
      items: [plan.items[0]!],
    });

    expect(api.calls.map((call) => call.path)).toEqual(["/api/v1/workspaces/dispose"]);
    expect(start).toMatchObject({ status: "started", archivedCount: 0 });
  });

  it("still returns the archived count when the archive is done and the removal call fails", async () => {
    const { client } = buildController(archiveAll, {
      status: 500,
      body: buildErrorBody("internal", "The controller is restarting."),
    });

    const start = await archiveAndRemoveWorkspaces(client, plan);

    expect(start).toEqual({
      status: "removalUnknown",
      archivedCount: 2,
      message: "The controller is restarting.",
    });
  });

  it("fails on an error that is not the controller's refusal", async () => {
    const { client } = buildController(
      () => {
        throw new Error("network down");
      },
      { body: { results: [] } },
    );

    await expect(archiveAndRemoveWorkspaces(client, plan)).rejects.toThrow();
  });
});

describe("decideRemovalOutcome", () => {
  it("reads a deleted workspace as removed and a disposing one as still being removed", () => {
    expect(decideRemovalOutcome(buildIdle(10, 1, { status: "deleted" }))).toEqual({
      kind: "removed",
    });
    expect(decideRemovalOutcome(buildIdle(10, 1, { status: "disposing" }))).toEqual({
      kind: "removing",
    });
  });

  it("reads a workspace that is back as refused, with its reason", () => {
    const refused = buildIdle(10, 1, { message: "The runner refused safe removal." });

    expect(decideRemovalOutcome(refused)).toEqual({
      kind: "refused",
      message: "The runner refused safe removal.",
      retry: true,
    });
  });

  it("shows the failure of the removal call, not a reason left from an earlier attempt", () => {
    const stale = buildIdle(10, 1, { message: "Refused last week." });

    expect(decideRemovalOutcome(stale, "The controller is restarting.")).toEqual({
      kind: "refused",
      message: "The controller is restarting.",
      retry: true,
    });
    expect(decideRemovalOutcome({ ...stale, status: "deleted" }, "x")).toEqual({ kind: "removed" });
    expect(decideRemovalOutcome({ ...stale, status: "disposing" }, "x")).toEqual({
      kind: "removing",
    });
  });

  it("says so when a workspace is back with no reason", () => {
    expect(decideRemovalOutcome(buildIdle(10, 1, { message: null }))).toEqual({
      kind: "refused",
      message: "The machine did not say why. Try again.",
      retry: true,
    });
  });
});

describe("describeCleanupOutcome", () => {
  const item = (number: number, freesGb: number): CleanupItem => ({
    workspaceId: uuid(number),
    expectedLastUsedAt: null,
    freesBytes: freesGb * GB,
  });
  const removed: RemovalOutcome = { kind: "removed" };
  const refused: RemovalOutcome = { kind: "refused", message: "No.", retry: true };

  it("words the toast when every workspace was removed", () => {
    const items = [item(1, 30), item(2, 11)];
    const outcomes = new Map<string, RemovalOutcome>([
      [uuid(1), removed],
      [uuid(2), removed],
    ]);

    expect(describeCleanupOutcome(9, items, outcomes)).toEqual({
      allRemoved: true,
      text: "Archived 9 threads and removed 2 workspaces. 41 GB freed.",
    });
  });

  it("uses singular words", () => {
    expect(
      describeCleanupOutcome(
        1,
        [item(1, 2)],
        new Map<string, RemovalOutcome>([[uuid(1), removed]]),
      ),
    ).toEqual({
      allRemoved: true,
      text: "Archived 1 thread and removed 1 workspace. 2 GB freed.",
    });
  });

  it("words the dialog's head when some removals were refused, always saying what was archived", () => {
    const items = [item(1, 30), item(2, 11), item(3, 5)];
    const outcomes = new Map<string, RemovalOutcome>([
      [uuid(1), removed],
      [uuid(2), refused],
      [uuid(3), refused],
    ]);

    expect(describeCleanupOutcome(9, items, outcomes)).toEqual({
      allRemoved: false,
      text: "Archived 9 threads. Removed 1 of 3 workspaces.",
    });
    expect(
      describeCleanupOutcome(
        1,
        [item(1, 1)],
        new Map<string, RemovalOutcome>([[uuid(1), refused]]),
      ),
    ).toEqual({
      allRemoved: false,
      text: "Archived 1 thread. Removed 0 of 1 workspace.",
    });
  });

  it("leaves out the archive and the size when there is none", () => {
    expect(
      describeCleanupOutcome(0, [item(1, 0)], new Map<string, RemovalOutcome>([[uuid(1), removed]]))
        ?.text,
    ).toBe("Removed 1 workspace.");
    expect(
      describeCleanupOutcome(0, [item(1, 3)], new Map<string, RemovalOutcome>([[uuid(1), refused]]))
        ?.text,
    ).toBe("Removed 0 of 1 workspace.");
  });

  it("gives no words while a removal is still going or has no outcome", () => {
    const items = [item(1, 3), item(2, 3)];

    expect(
      describeCleanupOutcome(
        2,
        items,
        new Map<string, RemovalOutcome>([
          [uuid(1), removed],
          [uuid(2), { kind: "removing" }],
        ]),
      ),
    ).toBeNull();
    expect(
      describeCleanupOutcome(2, items, new Map<string, RemovalOutcome>([[uuid(1), removed]])),
    ).toBeNull();
  });
});
