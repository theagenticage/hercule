/**
 * Tests the sidebar's thread list in the packaged app, signed in to a real
 * controller whose threads a fleet of scripted runners puts in known states
 * (spec 17 §Slices, slice 4):
 *
 * - the live socket connects from `app://hercule` under the release policy;
 * - the list groups the threads by project and by workspace, and each row
 *   ends in the right mark, word or age;
 * - a Request that opens brings its thread into Waiting on you within 1 s, and
 *   takes it out again when it closes;
 * - a new thread appears, and a thread in a new workspace brings its label;
 * - a runner that goes offline shows its threads as offline until it returns;
 * - the list mounts about as many rows for 500 threads as for 40.
 *
 * One more test runs only with `HERCULE_LONG_TESTS=1`, because it takes over
 * 6 minutes: a push still arrives after the window has been hidden that long.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ConsoleMessage, Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import type { HerculeClient } from "../../packages/client-core/src/index";
import {
  evaluateInMain,
  launchPlainApp,
  signInOnce,
  stopApp,
  writeSettings,
} from "../../apps/desktop/scripts/packaged-app";
import {
  arrangeFleet,
  createUserDataDirForTest,
  launchWithSavedController,
  openSignedIn,
  signInAndReadToken,
} from "./harness";

/** Whether the tests that take minutes run. */
const longTests = process.env["HERCULE_LONG_TESTS"] === "1";

/**
 * Returns every item the thread list has mounted, top to bottom, each as one
 * line of text:
 *
 * - a section header: "Waiting on you 2", or "project Webshop";
 * - a workspace label: "workspace webshop · studio";
 * - a Waiting on you row: its accessible name and its question, as
 *   "Thread 3, waiting on you: Run pnpm test?";
 * - a thread row: its accessible name and its end, as
 *   "Thread 1, working | mark:working", "Thread 4, working | queued" or
 *   "Thread 5, idle | now";
 * - a "more" row: its label, "35 more threads".
 */
function readSidebarItems(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('nav[aria-label="Threads"] .side-item')].map((item) => {
      const readText = (selector: string) => item.querySelector(selector)?.textContent ?? "";
      const name = item.getAttribute("aria-label");
      if (item.matches(".side-h--proj")) return `project ${readText(".proj-name")}`;
      if (item.matches(".side-h")) return item.textContent;
      if (item.matches(".side-ws")) return `workspace ${readText(".side-ws-name")}`;
      if (item.matches(".side-row--wait")) return `${name}: ${readText(".side-ask")}`;
      if (item.matches(".side-row--more")) return item.textContent;
      const mark = item.querySelector(".side-end .mark");
      const end =
        mark === null
          ? (item.querySelector(".side-age")?.textContent ?? readText(".side-end"))
          : `mark:${mark.className.replace(/^mark mark--/, "")}`;
      return `${name} | ${end}`;
    }),
  );
}

/**
 * Returns the branch of the worktree a thread works in, which names the
 * worktree in the sidebar. The controller picks the branch, so a test reads it
 * back rather than guessing it.
 */
async function readBranch(client: HerculeClient, sessionId: string): Promise<string | null> {
  const { workspaceId } = await client.session.read({ params: { id: sessionId } });
  const workspace = await client.workspace.read({ params: { id: workspaceId! } });
  return workspace.checkouts[0]!.branch;
}

/** Returns the counts line at the foot of the sidebar, such as "3 working · 1 waiting · 0 idle". */
function readCounts(page: Page): Promise<string | null> {
  return page.locator(".side-sum").textContent();
}

describe("the sidebar", () => {
  it("connects the live socket from app://hercule under the release policy", async () => {
    const { url } = await arrangeFleet();
    const launched = await launchWithSavedController(url);
    const { page } = launched;
    // The socket opens once the shell mounts, after sign-in, so the listeners
    // go on before signing in.
    const sockets: Array<{ readonly url: string; received: number }> = [];
    page.on("websocket", (socket) => {
      const seen = { url: socket.url(), received: 0 };
      sockets.push(seen);
      socket.on("framereceived", () => (seen.received += 1));
    });
    const refusals: string[] = [];
    page.on("console", (message: ConsoleMessage) => {
      if (message.text().includes("Content Security Policy")) refusals.push(message.text());
    });

    await signInAndReadToken(page, url);
    await page.getByRole("navigation", { name: "Threads" }).waitFor();

    // The controller greets a new connection, so a socket that received a
    // frame is one the policy let through and the controller accepted.
    const origin = url.replace(/^http:/, "ws:");
    await expect
      .poll(() => sockets.filter((socket) => socket.received > 0).map((socket) => socket.url))
      .toEqual([expect.stringMatching(new RegExp(`^${origin}/`))]);
    expect(refusals).toEqual([]);
  });

  it("lists the threads by project and workspace, each row ending in its mark, word or age", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const webshop = await fleet.createProject("Webshop");
    const payments = await fleet.createProject("Payments");
    const repository = await fleet.createRepository("https://github.com/example/webshop", [
      webshop.id,
    ]);
    const studio = await fleet.enlistRunner("studio", { maxConcurrentSessions: 3 });
    const laptop = await fleet.enlistRunner("laptop");
    const primary = { kind: "primary", resourceId: repository.id } as const;

    // Each step waits for the one before it to land, so every thread's last
    // activity is later than the one before, and the order below is certain.
    const [working] = await fleet.spawnThreads(1, {
      runner: studio,
      projectId: webshop.id,
      workspace: primary,
    });
    await waitForStatus(working!.id, "busy");
    const [inWorktree] = await fleet.spawnThreads(1, {
      runner: studio,
      projectId: webshop.id,
      workspace: { kind: "ephemeral", checkouts: [{ resourceId: repository.id }] },
    });
    await waitForStatus(inWorktree!.id, "busy");
    const [waiting] = await fleet.spawnThreads(1, {
      runner: studio,
      projectId: webshop.id,
      workspace: primary,
    });
    await waitForStatus(waiting!.id, "busy");
    studio.openRequest(waiting!.id, "command_approval");
    await expect
      .poll(async () => (await client.session.read({ params: { id: waiting!.id } })).openRequest)
      .not.toBeNull();
    // The studio's three slots are taken, so this thread waits for one.
    const [queued] = await fleet.spawnThreads(1, { runner: studio, projectId: payments.id });
    await waitForStatus(queued!.id, "queued");
    const [idle] = await fleet.spawnThreads(1, { runner: laptop, projectId: payments.id });
    await waitForStatus(idle!.id, "busy");
    laptop.completeTurn(idle!.id);
    await waitForStatus(idle!.id, "idle");
    const [exited] = await fleet.spawnThreads(1, { runner: laptop, projectId: payments.id });
    await waitForStatus(exited!.id, "busy");
    laptop.endSession(exited!.id, "crash");
    await waitForStatus(exited!.id, "exited");
    await laptop.goOffline();
    const branch = await readBranch(client, inWorktree!.id);

    const { page } = await openSignedIn(url);

    // Payments comes first: its newest activity, the exit, is the latest.
    // Inside a project the worktrees come before the main workspace, and each
    // group lists its newest thread first. Both threads on the offline laptop
    // are away: the idle one shows "offline", and the exited one shows its
    // age, as spec 17's pose table has it for a session that has exited on an
    // offline runner.
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "Waiting on you 1",
        "Thread 3, waiting on you: Run pnpm test?",
        "project Payments",
        "Thread 6, can't be reached | now",
        "Thread 5, can't be reached | offline",
        "Thread 4, working | queued",
        "project Webshop",
        `workspace ${branch}`,
        "Thread 2, working | mark:working",
        "workspace webshop · studio",
        "Thread 3, waiting on you | mark:waiting",
        "Thread 1, working | mark:working",
      ]);
    expect(await readCounts(page)).toBe("3 working · 1 waiting · 0 idle");
  });

  it("brings a thread into Waiting on you within 1 s of its Request opening, and takes it out when it closes", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { page } = await openSignedIn(url);
    const working = ["project No project", "Thread 1, working | mark:working"];
    await expect.poll(() => readSidebarItems(page)).toEqual(working);

    const waitingRow = page.locator("a.side-row--wait", { hasText: "Thread 1" });
    const opened = performance.now();
    const requestId = runner.openRequest(thread!.id, "command_approval");
    await waitingRow.waitFor({ timeout: 1_000 });
    const shownAfterMs = performance.now() - opened;
    console.info(`the waiting row showed ${Math.round(shownAfterMs)} ms after the Request opened`);
    expect(await readSidebarItems(page)).toEqual([
      "Waiting on you 1",
      "Thread 1, waiting on you: Run pnpm test?",
      "project No project",
      "Thread 1, waiting on you | mark:waiting",
    ]);

    await client.session.respond({
      params: { id: thread!.id },
      payload: { requestId, decision: "allow" },
    });
    await waitingRow.waitFor({ state: "detached" });
    await expect.poll(() => readSidebarItems(page)).toEqual(working);
  });

  it("shows a new thread, and a thread in a new workspace under that workspace's label", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const webshop = await fleet.createProject("Webshop");
    const repository = await fleet.createRepository("https://github.com/example/webshop", [
      webshop.id,
    ]);
    const runner = await fleet.enlistRunner("studio");
    const primary = { kind: "primary", resourceId: repository.id } as const;
    const [first] = await fleet.spawnThreads(1, {
      runner,
      projectId: webshop.id,
      workspace: primary,
    });
    await waitForStatus(first!.id, "busy");
    const { page } = await openSignedIn(url);
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "project Webshop",
        "workspace webshop · studio",
        "Thread 1, working | mark:working",
      ]);

    await fleet.spawnThreads(1, { runner, projectId: webshop.id, workspace: primary });
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "project Webshop",
        "workspace webshop · studio",
        "Thread 2, working | mark:working",
        "Thread 1, working | mark:working",
      ]);

    // The new worktree is in no list the app holds, so the app reads the
    // workspaces again to label it.
    const [inWorktree] = await fleet.spawnThreads(1, {
      runner,
      projectId: webshop.id,
      workspace: { kind: "ephemeral", checkouts: [{ resourceId: repository.id }] },
    });
    await waitForStatus(inWorktree!.id, "busy");
    const branch = await readBranch(client, inWorktree!.id);
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "project Webshop",
        `workspace ${branch}`,
        "Thread 3, working | mark:working",
        "workspace webshop · studio",
        "Thread 2, working | mark:working",
        "Thread 1, working | mark:working",
      ]);
  });

  it("shows a runner's threads as offline while it is gone, and as before once it returns", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("laptop");
    const [working, idle] = await fleet.spawnThreads(2, { runner });
    await waitForStatus(working!.id, "busy");
    await waitForStatus(idle!.id, "busy");
    runner.completeTurn(idle!.id);
    await waitForStatus(idle!.id, "idle");
    const { page } = await openSignedIn(url);
    const before = [
      "project No project",
      "Thread 2, idle | now",
      "Thread 1, working | mark:working",
    ];
    await expect.poll(() => readSidebarItems(page)).toEqual(before);

    await runner.goOffline();
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "project No project",
        "Thread 2, can't be reached | offline",
        "Thread 1, can't be reached | offline",
      ]);
    expect(await readCounts(page)).toBe("0 working · 0 waiting · 0 idle");

    await runner.reconnect();
    await expect.poll(() => readSidebarItems(page)).toEqual(before);
    expect(await readCounts(page)).toBe("1 working · 0 waiting · 1 idle");
  });

  it("mounts about as many rows for a project of 500 threads as for one of 40, expanded", async () => {
    const { url, fleet } = await arrangeFleet();
    const project = await fleet.createProject("Fleet");
    const [first, second] = await Promise.all(
      ["studio", "laptop"].map((name) => fleet.enlistRunner(name, { maxConcurrentSessions: 250 })),
    );
    await fleet.spawnThreads(40, { runner: first!, projectId: project.id });
    const { page } = await openSignedIn(url);
    await expect.poll(() => readCounts(page)).toBe("40 working · 0 waiting · 0 idle");

    await page.getByRole("button", { name: "35 more threads" }).click();
    await page.getByRole("button", { name: "35 more threads" }).waitFor({ state: "detached" });
    const countMounted = () =>
      page.evaluate(() => ({
        rows: document.querySelectorAll('nav[aria-label="Threads"] .side-row').length,
        elements: document.querySelectorAll('nav[aria-label="Threads"] *').length,
      }));
    const with40 = await countMounted();

    await Promise.all([
      fleet.spawnThreads(210, { runner: first!, projectId: project.id }),
      fleet.spawnThreads(250, { runner: second!, projectId: project.id }),
    ]);
    await expect
      .poll(() => readCounts(page), { timeout: 30_000 })
      .toBe("500 working · 0 waiting · 0 idle");
    const with500 = await countMounted();

    console.info(
      `mounted in the thread list, one expanded project: ` +
        `40 threads, ${with40.rows} rows and ${with40.elements} elements; ` +
        `500 threads, ${with500.rows} rows and ${with500.elements} elements`,
    );
    // The component test holds the list to 45 mounted items for 500 threads;
    // every row is an item.
    expect(with500.rows).toBeLessThanOrEqual(45);
    expect(with500.rows).toBeLessThanOrEqual(with40.rows + 1);
  });

  it.skipIf(!longTests)(
    "still shows a push after the window has been hidden for 6 minutes",
    async () => {
      const { url, fleet, waitForStatus } = await arrangeFleet();
      const runner = await fleet.enlistRunner("studio");
      const [thread] = await fleet.spawnThreads(1, { runner });
      await waitForStatus(thread!.id, "busy");

      // Playwright's focus emulation keeps a hidden page "visible", so its
      // timers are never throttled. This test starts the app as a plain
      // process instead, and reads the page through main, which attaches
      // nothing to the page.
      const userDataDir = createUserDataDirForTest();
      writeSettings(userDataDir, { controllerUrl: url });
      await signInOnce(userDataDir);
      const { process: child, inspectorUrl } = await launchPlainApp(userDataDir);
      onTestFinished(async () => {
        // The PID of a process that has already exited may belong to another
        // process by now, so only a running app is stopped.
        if (child.exitCode === null && child.signalCode === null) await stopApp(child.pid!);
      });
      const window = `require("electron").BrowserWindow.getAllWindows()[0]`;
      const evaluateInPage = (expression: string) =>
        evaluateInMain(
          inspectorUrl,
          `${window}.webContents.executeJavaScript(${JSON.stringify(expression)})`,
        );
      const hasWaitingRow = `document.querySelector("a.side-row--wait") !== null`;
      await expect
        .poll(() => evaluateInPage(`document.querySelectorAll("a.side-row").length`), {
          timeout: 10_000,
        })
        .toBe(1);
      // The list can be on the page before the window first shows. A window
      // hidden before then would show anyway once its first screen arrives.
      await expect
        .poll(() => evaluateInMain(inspectorUrl, `${window}.isVisible()`), { timeout: 10_000 })
        .toBe(true);

      await evaluateInMain(inspectorUrl, `${window}.hide()`);
      // Chromium throttles a hidden page's timers harder once it has been
      // hidden for 5 minutes.
      await sleep(6 * 60_000);
      runner.openRequest(thread!.id, "command_approval");

      // The page is read once, after 5 s, because reading it wakes it up.
      await sleep(5_000);
      expect(await evaluateInPage(hasWaitingRow)).toBe(true);
      expect(await evaluateInPage("document.visibilityState")).toBe("hidden");
    },
    8 * 60_000,
  );
});
