/**
 * Tests the Storage section of a machine's page (spec 17 §Fleet, A machine's
 * page, point 5): the head with the free space and the forecast, the parts of
 * the disk, the largest idle workspaces with the Threads that name them, the
 * state of a runner that is too old to measure, and when the section reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildSession, buildWorkspace } from "@hercule/client-core/threads/testing";
import { DISK_USAGE_CAPABILITY } from "@hercule/contract";
import type { EventWithFacts, RunnerMetricsPoint, Session, Workspace } from "@hercule/contract";
import { buildErrorBody, stubIntersectionObserver, type Call } from "../../../../app/testing";
import {
  buildFacts,
  buildMetrics,
  buildRunner,
  GIB,
  NOW,
} from "../../../../screens/fleet/fleet.testing";
import { ATLAS, buildAuditEvent, openMachineWithEvents } from "./-machine-activity.testing";

beforeEach(() => {
  stubIntersectionObserver();
  vi.stubEnv("TZ", "UTC");
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  localStorage.clear();
});

const GB = 1e9;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A 1,000 GB disk with 412 GB free, and 40 GB of repository caches and 20 GB of Harness Homes around its workspaces. */
const MEASURED_ATLAS = buildRunner({
  id: ATLAS.id,
  name: "atlas",
  facts: buildFacts({ diskTotalBytes: 1000 * GB }),
  metrics: buildMetrics({ diskFreeBytes: 412 * GB }),
  diskWatermarkBytes: 10 * GIB,
  diskUsage: {
    repositoryCacheBytes: 40 * GB,
    harnessHomeBytes: 20 * GB,
    measuredAt: "2026-11-02T13:40:00.000Z",
  },
});

/** Returns a canonical UUIDv7 for the record numbered `number`. */
const buildId = (number: number): string =>
  `01a06d02-5000-7000-8000-${String(number).padStart(12, "0")}`;

/** Returns the ISO instant `days` before the tests' clock. */
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

/** Returns an idle workspace of atlas that nobody has used for `idleDays`, with what its runner measured. */
const buildIdle = (
  id: string,
  idleDays: number,
  usage: { readonly sizeGB: number; readonly freesGB: number } | null,
  diskUsageError: string | null = null,
): Workspace =>
  buildWorkspace({
    id,
    runnerId: ATLAS.id,
    kind: "ephemeral",
    lastUsedAt: daysAgo(idleDays),
    createdAt: daysAgo(idleDays + 1),
    diskUsage:
      usage === null
        ? null
        : {
            sizeBytes: usage.sizeGB * GB,
            freesBytes: usage.freesGB * GB,
            measuredAt: daysAgo(diskUsageError === null ? 0 : 3),
          },
    diskUsageError,
  });

/** Returns the Thread, long exited, that gave the workspace `workspaceId` its name. */
const buildThread = (workspaceId: string, number: number, title: string): Session =>
  buildSession({
    id: buildId(200 + number),
    permissionProfileId: buildId(900),
    providerAccountId: buildId(901),
    title,
    runnerId: ATLAS.id,
    workspaceId,
    status: "exited",
    createdAt: daysAgo(30),
  });

/** A workspace with a session working in it: in use, whatever it was last used. */
const IN_USE = buildWorkspace({
  id: buildId(100),
  runnerId: ATLAS.id,
  kind: "ephemeral",
  sessionIds: [buildId(300)],
  diskUsage: { sizeBytes: 6 * GB, freesBytes: 5 * GB, measuredAt: "2026-11-02T13:50:00.000Z" },
});

/**
 * Six workspaces atlas has been idle in, and the Threads that used them. The
 * first frees less than it takes (its packages are linked to a store that
 * stays), the fifth's last measuring failed, and the sixth is too small to be
 * among the five largest.
 */
const IDLE = [
  buildIdle(buildId(1), 38, { sizeGB: 62, freesGB: 25 }),
  buildIdle(buildId(2), 22, { sizeGB: 41, freesGB: 40 }),
  buildIdle(buildId(3), 16, { sizeGB: 28, freesGB: 27 }),
  buildIdle(buildId(4), 52, { sizeGB: 22, freesGB: 9 }),
  buildIdle(buildId(5), 12, { sizeGB: 15, freesGB: 14.6 }, "Measuring took longer than 10 minutes"),
  buildIdle(buildId(6), 9, { sizeGB: 3, freesGB: 3 }),
];
const THREADS = IDLE.map(({ id }, index) =>
  buildThread(
    id,
    index + 1,
    [
      "Move the checkout to Stripe Elements",
      "Rebuild the search index",
      "Fix the flaky payout test",
      "Spike: move the cron jobs to a queue",
      "Draft the Q3 ops runbook",
      "Update the onboarding copy",
    ][index]!,
  ),
);

/** Hour points of atlas for the last 3 days whose free space falls 0.6 GB an hour, ending at 412 GB. */
const buildFallingDiskPoints = (): RunnerMetricsPoint[] =>
  Array.from({ length: 73 }, (_, index) => 72 - index).map((hoursAgo) => ({
    runnerId: ATLAS.id,
    at: new Date(NOW.getTime() - hoursAgo * HOUR_MS).toISOString(),
    minutes: 60,
    diskFreeBytes: 412 * GB + hoursAgo * 0.6 * GB,
    availableMemoryBytes: 8 * GIB,
    availableMemoryLowestBytes: 7 * GIB,
    cpuAveragePercent: 20,
    cpuPeakPercent: 40,
    sessionsRunning: 1,
    sessionsQueued: 0,
  }));

/** What the controller holds about atlas's storage, which a test changes between pushes. */
interface World {
  workspaces: Workspace[];
  threads: Session[];
  capabilities: readonly string[] | null;
  hourPoints: RunnerMetricsPoint[];
  /** While set, a read of Threads fails with this message. */
  threadsFail: string | null;
}

const buildWorld = (): World => ({
  workspaces: [IN_USE, ...IDLE],
  threads: THREADS,
  capabilities: [DISK_USAGE_CAPABILITY],
  // The runner has reported for one hour, which is too little for a forecast.
  hourPoints: buildFallingDiskPoints().slice(-1),
  threadsFail: null,
});

/** Returns the reads of Threads by workspace that `calls` holds, each as the workspace ids it asked for. */
const readThreadReads = (calls: readonly Call[]): readonly (readonly string[])[] =>
  calls
    .filter((call) => call.method === "GET" && call.path === "/api/v1/sessions")
    .map((call) => new URLSearchParams(call.search).getAll("workspaceId"))
    .filter((ids) => ids.length > 0);

/**
 * Opens atlas's page over `world`: the runner as `MEASURED_ATLAS`, the
 * workspaces, what the runner negotiated, the hour points, and the Threads of
 * the workspaces a read names.
 */
const openStorage = async (world: World, events: readonly EventWithFacts[] = []) => {
  const opened = await openMachineWithEvents(`/fleet/${ATLAS.id}`, events, {
    overrides: {
      "GET /api/v1/runners": { body: { items: [MEASURED_ATLAS] } },
      [`GET /api/v1/runners/${ATLAS.id}`]: () => ({
        body: { ...MEASURED_ATLAS, negotiatedCapabilities: world.capabilities, protocolVersion: 1 },
      }),
      "GET /api/v1/workspaces": () => ({ body: { items: world.workspaces } }),
      "GET /api/v1/sessions": (call) => {
        const ids = new URLSearchParams(call.search).getAll("workspaceId");
        if (ids.length === 0) return { body: { items: [] } };
        if (world.threadsFail !== null) {
          return { status: 500, body: buildErrorBody("internal", world.threadsFail) };
        }
        return {
          body: { items: world.threads.filter(({ workspaceId }) => ids.includes(workspaceId!)) },
        };
      },
      "GET /api/v1/runner-metrics": (call) => ({
        body: {
          items:
            new URLSearchParams(call.search).get("resolution") === "hour" ? world.hourPoints : [],
        },
      }),
    },
  });
  const storage = await screen.findByRole("region", { name: "Storage" });
  return { ...opened, storage };
};

/** Returns the text of the head's note: the free space and, after a dot, the forecast. */
const readHead = (storage: HTMLElement): string =>
  storage.querySelector(".machine-page-section-head small")!.textContent;

/** Returns the text of each entry of the legend, in order: the part's name, then its size. */
const readLegend = (storage: HTMLElement): readonly string[] =>
  Array.from(storage.querySelectorAll(".machine-storage-legend li"), (item) => item.textContent);

/** Returns the text of each of the largest idle workspaces, in order: its name, why its sizes are old, when it was used and what removing it frees. */
const readIdleRows = (storage: HTMLElement): readonly string[] =>
  Array.from(storage.querySelectorAll(".machine-storage-idle-row"), (row) => row.textContent);

describe("a machine's Storage section", () => {
  it("shows the free space in its head, and the forecast after it when the disk is falling", async () => {
    const world = buildWorld();
    world.hourPoints = buildFallingDiskPoints();
    const { storage } = await openStorage(world);

    expect(readHead(storage)).toBe("412 GB free of 1,000 GB · limit in about 28 days");
    expect(within(storage).getByText("limit in about 28 days").className).toBe(
      "machine-storage-forecast",
    );
  });

  it("shows the free space alone when there is no forecast", async () => {
    const { storage } = await openStorage(buildWorld());

    expect(readHead(storage)).toBe("412 GB free of 1,000 GB");
    expect(storage.querySelector(".machine-storage-forecast")).toBeNull();
  });

  it("counts every part once, and Other is what is left of the disk", async () => {
    const { storage } = await openStorage(buildWorld());

    // The idle workspaces free 25 + 40 + 27 + 9 + 14.6 + 3 GB, which is 118.6 GB. The disk's
    // 1,000 GB less 412 free, 5 in use, 118.6 idle, 40 of caches and 20 of session data
    // leaves 404.4 GB. Sizes of 100 GB and more are shown in whole gigabytes.
    expect(readLegend(storage)).toEqual([
      "Workspaces in use5 GB",
      "Idle workspaces119 GB",
      "Repository caches40 GB",
      "Session data20 GB",
      "Other404 GB",
    ]);
    // The free space is the bar's background and the head's words, not a legend entry.
    expect(within(storage).getByText(/412 GB free of 1,000 GB/)).toBeTruthy();
    expect(within(storage).getByText("Other").closest("li")!.getAttribute("title")).toBe(
      "Everything else on the disk: your own files, and package stores such as pnpm's, which workspaces link to.",
    );
  });

  it("lists the five largest idle workspaces by the Thread that named them", async () => {
    const { storage } = await openStorage(buildWorld());

    // "of 62 GB" under the first and the fourth, whose removal frees less than they take.
    // The fifth's newest measuring failed three days after its last good one.
    expect(readIdleRows(storage)).toEqual([
      "Move the checkout to Stripe Elements5 weeks ago25 GBof 62 GB",
      "Rebuild the search index3 weeks ago40 GB",
      "Fix the flaky payout test2 weeks ago27 GB",
      "Spike: move the cron jobs to a queue7 weeks ago9 GBof 22 GB",
      "Draft the Q3 ops runbookSizes from 3 days ago: measuring took longer than 10 minutes.1 week ago14.6 GB",
    ]);
    const frees = storage.querySelector(".machine-storage-idle-frees")!;
    expect(frees.getAttribute("title")).toBe("62 GB on disk; removing it frees 25 GB");
  });

  it("words the last removal the sweep made, and lists the rules in the info popover", async () => {
    const sweep = (id: number) =>
      buildAuditEvent(id, "workspace.deleted", 30, {
        payload: { workspaceId: buildId(id), reason: "none" },
      });
    const { storage } = await openStorage(buildWorld(), [sweep(2), sweep(1)]);

    // The last word shares a span with the info button, so the sentence is read whole from the line.
    expect(storage.querySelector(".machine-storage-auto-last")!.textContent).toBe(
      "Last: removed 2 workspaces of finished runs, today.",
    );
    const info = within(storage).getByRole("button", {
      name: "When Hercule removes a workspace by itself",
    });
    const rules = document.getElementById(info.getAttribute("popovertarget")!)!;
    expect(rules.textContent).toBe(
      "When Hercule removes a workspace by itself, with everything in it:" +
        "a workflow run's workspace, as soon as the run finishes, or 14 days after it failed;" +
        "a thread's workspace, once every thread in it is archived and nobody has used it for 7 days." +
        "Everything else stays until you clean it up.",
    );
  });

  it("says a runner too old to measure its storage is, and reads no workspace's Threads", async () => {
    const world = buildWorld();
    world.capabilities = [];
    const { storage, calls } = await openStorage(world);

    expect(
      within(storage).getByText(
        "This machine's runner is too old to measure its storage. Update it to see what fills the disk.",
      ),
    ).toBeTruthy();
    expect(readLegend(storage)).toEqual([]);
    expect(storage.querySelector(".machine-storage-bar")).not.toBeNull();
    expect(within(storage).queryByText("Largest idle workspaces")).toBeNull();
    expect(readThreadReads(calls)).toEqual([]);
  });

  it("reads the Threads again only when the set of idle workspaces changes", async () => {
    const world = buildWorld();
    const { storage, calls, app } = await openStorage(world);
    await waitFor(() => expect(app.live.readTopics()).toContain("workspace"));
    await app.live.waitForFirstPushes();
    expect(readThreadReads(calls)).toHaveLength(1);

    // A push that changes nothing about the idle workspaces reads no Threads.
    act(() => app.live.pushInvalidation("workspace", []));
    await waitFor(() => expect(app.context.queryClient.isFetching()).toBe(0));
    expect(readThreadReads(calls)).toHaveLength(1);

    // A workspace that becomes idle is a new set, and its Thread names its row.
    const added = buildIdle(buildId(7), 30, { sizeGB: 80, freesGB: 79 });
    world.workspaces = [...world.workspaces, added];
    world.threads = [...world.threads, buildThread(added.id, 7, "Port the importer")];
    act(() => app.live.pushInvalidation("workspace", [added.id]));

    await waitFor(() => expect(readIdleRows(storage)[0]).toContain("Port the importer"));
    expect(readThreadReads(calls)).toHaveLength(2);
    expect(readThreadReads(calls)[1]).toContain(added.id);
  });

  it("shows a failed read of the Threads as a line with a Retry, and the rest of the section stays", async () => {
    const world = buildWorld();
    world.threadsFail = "The controller is busy";
    const { storage } = await openStorage(world);

    const alert = await within(storage).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't read the idle workspaces.");
    expect(readHead(storage)).toBe("412 GB free of 1,000 GB");

    world.threadsFail = null;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(readIdleRows(storage)).toHaveLength(5));
    expect(within(storage).queryByRole("alert")).toBeNull();
  });
});
