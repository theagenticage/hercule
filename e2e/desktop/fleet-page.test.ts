/**
 * Tests the Fleet page in the packaged app, signed in to a real controller
 * whose machines are scripted runners (spec 17 §Fleet):
 *
 * - the Fleet row of the Hercule face opens the page, the row stays selected
 *   on a machine's page, and the sidebar shows the Hercule face on both;
 * - a second machine joins with the command Add a machine shows, and its card
 *   appears on the open page;
 * - the card of the controller's own, real runner shows its disk as a
 *   percentage, from the size the runner reports;
 * - a machine whose session cap holds a thread back says so on its card, and
 *   Allow raises the cap so the waiting thread starts;
 * - a machine's page draws the CPU, Memory and Disk graphs from the metrics
 *   its runner reports, and draws a report that arrives while it is open;
 * - a machine's activity lists the session the user spawned and the workspace
 *   the user removed, in Recent on its page and on the Activity page, and the
 *   crumb of the Activity page leads back to the machine;
 * - a thread started on a machine shows on that machine's card as a group at
 *   work, and in the Running here section of its page, which opens the thread.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { findCompiledBinary, PASSWORD, runCli, USERNAME } from "../../scripts/controller-process";
import { arrangeFleet, chooseMenuItem, openSignedIn, startControllerForTest } from "./harness";

/** Returns the label of the sidebar's list, "Threads" or "Hercule": the face it shows. */
function readSidebarList(page: Page): Promise<string | null> {
  return page
    .locator('nav[aria-label="Threads"], nav[aria-label="Hercule"]')
    .getAttribute("aria-label");
}

/** Opens the Fleet page from the sidebar: the Hercule face, then its Fleet row. */
async function openFleet(page: Page): Promise<void> {
  await page
    .getByRole("tablist", { name: "Sidebar" })
    .getByRole("tab", { name: "Hercule" })
    .click();
  await page
    .getByRole("navigation", { name: "Hercule", exact: true })
    .getByRole("link", { name: "Fleet" })
    .click();
  await page.getByRole("heading", { level: 1, name: "Fleet" }).waitFor();
}

/** Returns the Fleet page's card of the machine named `name`. */
function locateCard(page: Page, name: string) {
  return page
    .locator(".fleet-card")
    .filter({ has: page.getByRole("button", { name, exact: true }) });
}

const GIB = 1024 ** 3;

/**
 * The room a graph keeps above and below its line, in drawing units. It is
 * the component's `EDGE_INSET` in `machine-graph.tsx`.
 */
const GRAPH_EDGE_INSET = 1;

/** How far a drawn y may differ from the y computed for its value, in drawing units. */
const Y_MARGIN = 0.05;

/**
 * Reads the line of the graph of the instrument labelled `label` on a
 * machine's page, and returns its path data and the height of its drawing
 * space, or `null` when the instrument draws no line (it shows its "not
 * reported" sentence instead). The svg is hidden from assistive technology,
 * because the numbers beside a graph carry its meaning, so a role or a label
 * cannot reach it.
 */
async function readGraphLine(
  page: Page,
  label: string,
): Promise<{ readonly d: string; readonly height: number } | null> {
  const graph = page
    .locator(".machine-page-instrument")
    .filter({ has: page.locator(".machine-page-instrument-label", { hasText: label }) })
    .locator("svg.machine-graph");
  const line = graph.locator(".machine-graph-line");
  if ((await line.count()) === 0) return null;
  const viewBox = (await graph.getAttribute("viewBox"))!.split(" ").map(Number);
  return { d: (await line.getAttribute("d"))!, height: viewBox[3]! };
}

/** Waits until the graph of `label` draws a line, and returns what `readGraphLine` returns for it. */
async function waitForGraphLine(
  page: Page,
  label: string,
): Promise<NonNullable<Awaited<ReturnType<typeof readGraphLine>>>> {
  let line: Awaited<ReturnType<typeof readGraphLine>> = null;
  await expect
    .poll(async () => {
      line = await readGraphLine(page, label);
      return line !== null;
    })
    .toBe(true);
  return line!;
}

/**
 * Returns the `y` of the last point of the graph line of `label`, in drawing
 * units (it grows downward), or infinity when there is no line, so
 * that no check of a rise passes for a graph that draws nothing. The `x` of every
 * point depends on when the page read the history, so only the `y` tells
 * which value was drawn.
 */
async function readLastPointY(page: Page, label: string): Promise<number> {
  const line = await readGraphLine(page, label);
  if (line === null) return Number.POSITIVE_INFINITY;
  return Number(line.d.match(/,(-?[\d.]+)\s*$/)![1]);
}

/**
 * Returns the `y` at which a graph draws `share`, a value from 0 (the bottom)
 * to 1 (the top) of the graph, in a drawing space `height` units tall.
 */
const placeOnGraph = (share: number, height: number): number =>
  height - GRAPH_EDGE_INSET - share * (height - 2 * GRAPH_EDGE_INSET);

describe("the Fleet page", () => {
  it("opens from the Fleet row, keeps the row selected on a machine's page, and gives way to the Threads face when a thread opens", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { app, page } = await openSignedIn(url);
    expect(await readSidebarList(page)).toBe("Threads");

    await openFleet(page);
    const fleetRow = page
      .getByRole("navigation", { name: "Hercule", exact: true })
      .getByRole("link", { name: "Fleet" });
    expect(await readSidebarList(page)).toBe("Hercule");
    await expect.poll(() => fleetRow.getAttribute("aria-current")).toBe("page");
    await locateCard(page, "studio").waitFor();

    // A machine's page is a Fleet route too: the face and the row stay.
    await locateCard(page, "studio").getByRole("button", { name: "studio", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Fleet", exact: true })
      .getByText("studio")
      .waitFor();
    expect(await readSidebarList(page)).toBe("Hercule");
    await expect.poll(() => fleetRow.getAttribute("aria-current")).toBe("page");

    // Opening a thread leaves Fleet, and the sidebar shows the Threads face.
    await chooseMenuItem(app, "Go", "Thread 1");
    await page.locator('section[aria-label="Transcript"]').waitFor();
    await expect.poll(() => readSidebarList(page)).toBe("Threads");
  });

  it("shows the card of a machine that joins with the command Add a machine shows", async () => {
    const { url, fleet } = await arrangeFleet();
    await fleet.enlistRunner("studio");
    const { page } = await openSignedIn(url);
    await openFleet(page);
    await locateCard(page, "studio").waitFor();
    expect(await locateCard(page, "laptop").count()).toBe(0);

    await page
      .getByRole("navigation", { name: "Fleet actions", exact: true })
      .getByRole("button", { name: "Add a machine" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Add a machine" });
    const command = dialog.locator(".fleet-add-command code");
    await expect.poll(() => command.innerText()).toMatch(/^hercule runner join \S+ --token \S+$/);
    const [, origin, token] = (await command.innerText()).match(/join (\S+) --token (\S+)$/)!;
    expect(origin).toBe(url);

    // The machine joins with the dialog's own token, as `hercule runner join` would.
    await fleet.enlistRunner("laptop", { joinToken: token! });
    await locateCard(page, "laptop").waitFor();
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "studio", exact: true }).waitFor();
    await page.getByRole("button", { name: "laptop", exact: true }).waitFor();
  });

  it("raises the cap with Allow, and the thread that waited for a slot starts", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio", { maxConcurrentSessions: 1 });
    const [running] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(running!.id, "busy");
    const [waiting] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(waiting!.id, "queued");
    const { page } = await openSignedIn(url);
    await openFleet(page);

    const card = locateCard(page, "studio");
    await card.getByText("1 thread waits for a slot").waitFor();
    await card.getByRole("button", { name: "Allow 2" }).click();

    await expect
      .poll(
        async () =>
          (await client.runner.read({ params: { id: runner.runnerId } })).maxConcurrentSessions,
      )
      .toBe(2);
    await waitForStatus(waiting!.id, "busy");
    // Nothing waits any more, so the card loses its line and its button.
    await expect.poll(() => card.getByText("waits for a slot").count()).toBe(0);
    expect(await card.getByRole("button", { name: /^Allow/ }).count()).toBe(0);
  });

  it("shows the disk of a real runner as a percentage", async () => {
    // The controller starts a real runner of its own, which `arrangeFleet`
    // retires. This test keeps it: it reports its disk, so its card draws a
    // percentage. The scripted runners send no metrics, so their cards draw a
    // dash.
    const { url } = await startControllerForTest({ setUp: true });
    const { page } = await openSignedIn(url);
    await openFleet(page);

    const card = page.locator(".fleet-card");
    await card.waitFor();
    const disk = card.locator(".fleet-gauge").filter({ hasText: "Disk" });
    // The first report follows the hello, so the card shows a dash until then.
    // The percent sign may sit in its own element, so the text is read whole.
    await expect
      .poll(async () => (await disk.locator("b").innerText()).replace(/\s+/g, ""))
      .toMatch(/^\d+%$/);
  });

  it("draws the graphs of a machine's page from its reports, and draws a report that arrives while the page is open", async () => {
    const { url, fleet } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio", {
      machine: { totalMemoryBytes: 64 * GIB, diskTotalBytes: 1000 * GIB },
    });
    runner.reportMetrics({
      diskFreeBytes: 800 * GIB,
      availableMemoryBytes: 48 * GIB,
      cpu: { averagePercent: 10, peakPercent: 20 },
    });
    const { page } = await openSignedIn(url);
    await openFleet(page);
    await locateCard(page, "studio").getByRole("button", { name: "studio", exact: true }).click();

    // Report 1: CPU at 10%, and memory 25% in use (48 of 64 GiB available).
    // Disk only needs to draw a line.
    const height = (await waitForGraphLine(page, "Disk")).height;
    await expect.poll(() => readLastPointY(page, "CPU")).toBeCloseTo(placeOnGraph(0.1, height), 1);
    await expect
      .poll(() => readLastPointY(page, "Memory"))
      .toBeCloseTo(placeOnGraph(0.25, height), 1);

    // Report 2 usually lands in the same minute as report 1 and replaces its
    // row, but the test cannot control the controller's clock. When the two
    // reports straddle a minute boundary, they are two rows of one five-minute
    // point, which averages them (CPU 40%, memory 50% in use), or of two
    // points (70% and 75%). So the last point must have risen to at least the
    // mean of the two reports. Every one of those outcomes passes, and a page
    // still drawing report 1 (10% and 25%) fails. The page is not navigated or
    // reloaded: the report reaches it as a push.
    //
    // The last point's y is checked, not the whole path, because every x moves
    // with the time the page reads the history, so any re-read changes the
    // path even when it brings the old values. Only CPU and Memory are checked
    // for a change: they draw five-minute points, and the page re-reads the
    // hour points of Disk at most once an hour. A higher value has a lower y,
    // and the margin covers the two decimals the path is rounded to.
    runner.reportMetrics({
      diskFreeBytes: 200 * GIB,
      availableMemoryBytes: 16 * GIB,
      cpu: { averagePercent: 70, peakPercent: 90 },
    });
    await expect
      .poll(() => readLastPointY(page, "CPU"))
      .toBeLessThanOrEqual(placeOnGraph(0.4, height) + Y_MARGIN);
    await expect
      .poll(() => readLastPointY(page, "Memory"))
      .toBeLessThanOrEqual(placeOnGraph(0.5, height) + Y_MARGIN);
  });

  it("lists a session spawn and a workspace removal in a machine's activity", async () => {
    const { url, home, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, {
      runner,
      workspace: { kind: "ephemeral", checkouts: [] },
    });
    await waitForStatus(thread!.id, "busy");
    const workspaceId = (await client.session.read({ params: { id: thread!.id } })).workspaceId!;
    // A workspace is removed only once its session has ended.
    await client.session.stop({ params: { id: thread!.id } });
    await waitForStatus(thread!.id, "exited");
    await client.workspace.dispose({ params: { id: workspaceId }, payload: {} });
    await expect
      .poll(async () => (await client.workspace.read({ params: { id: workspaceId } })).status)
      .toBe("deleted");

    // The CLI lists the same audit log entries of the machine, by the tail of its id.
    const login = await runCli(
      ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-fleet"],
      { home, binary: findCompiledBinary(), stdin: PASSWORD },
    );
    expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
    const listed = await runCli(
      ["event", "list", "--runner", runner.runnerId.slice(-12), "--limit", "100", "--json"],
      { home, binary: findCompiledBinary() },
    );
    expect(listed.code, `${listed.stdout}\n${listed.stderr}`).toBe(0);
    const kinds = (
      JSON.parse(listed.stdout) as { items: ReadonlyArray<{ kind: string }> }
    ).items.map((row) => row.kind);
    expect(kinds).toEqual(expect.arrayContaining(["session.spawned", "workspace.deleted"]));

    const { page } = await openSignedIn(url);
    await openFleet(page);
    await locateCard(page, "studio").getByRole("button", { name: "studio", exact: true }).click();

    // Recent lists the newest entries of the machine's audit log, each with who did it.
    const recent = page.getByRole("region", { name: "Recent" });
    await recent.getByText("Session spawned", { exact: true }).waitFor();
    await recent.getByText("Removed a workspace", { exact: true }).waitFor();
    await recent.getByText("by you").first().waitFor();

    await recent.getByRole("link", { name: "All activity" }).click();
    await page.getByRole("heading", { level: 2, name: "Activity" }).waitFor();
    await page.getByRole("heading", { level: 3, name: "Today" }).waitFor();
    await page.getByText("Session spawned", { exact: true }).waitFor();
    await page.getByText("Removed a workspace", { exact: true }).waitFor();

    // The Workspaces filter keeps the removal and drops the spawn.
    await page
      .getByRole("group", { name: "Show" })
      .getByRole("button", { name: "Workspaces" })
      .click();
    await page.getByText("Removed a workspace", { exact: true }).waitFor();
    await page.getByText("Session spawned", { exact: true }).waitFor({ state: "detached" });

    // The crumb "Fleet / studio / Activity" leads back to the machine's page.
    await page
      .getByRole("navigation", { name: "Fleet", exact: true })
      .getByRole("link", { name: "studio" })
      .click();
    await page.getByRole("region", { name: "Recent" }).waitFor();
    await page.getByRole("heading", { level: 2, name: "Activity" }).waitFor({ state: "detached" });
  });

  it("lists a thread started on a machine in that machine's Running here, and the row opens the thread", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { page } = await openSignedIn(url);
    await openFleet(page);

    // The card counts the thread as one group at work.
    const card = locateCard(page, "studio");
    await card.getByRole("img", { name: "1 group at work here" }).waitFor();

    // The machine's page lists it under the title the sidebar gives the thread.
    await card.getByRole("button", { name: "studio", exact: true }).click();
    const runningHere = page.getByRole("region", { name: "Running here" });
    await runningHere.getByRole("link", { name: /Thread 1/ }).click();

    await page.locator('section[aria-label="Transcript"]').waitFor();
    await expect.poll(() => readSidebarList(page)).toBe("Threads");
    await expect
      .poll(() =>
        page
          .getByRole("navigation", { name: "Threads", exact: true })
          .getByRole("link", { name: /Thread 1/ })
          .getAttribute("aria-current"),
      )
      .toBe("page");
  });
});
