/**
 * Tests the sidebar's thread list in the packaged app, signed in to a real
 * controller whose threads a fleet of scripted runners puts in known states
 * (spec 17, §Design system, **The sidebar**):
 *
 * - the live socket connects from `app://hercule` under the release policy;
 * - the list groups the threads by project, newest created first, each row
 *   names its workspace and ends in the right mark, word or age;
 * - a Request that opens brings its thread into Waiting on you within 1 s, and
 *   takes it out again when it closes;
 * - a new thread appears at the top of its project, also one in a new
 *   worktree, which its row names;
 * - a runner that goes offline shows its threads as offline until it returns;
 * - the list mounts about as many rows for 500 threads as for 40;
 * - the face switch, Threads | Hercule, sits in the window's drag strip and
 *   still takes a click; it, View › Threads and View › Hercule (⌥⌘1, ⌥⌘2),
 *   and ← and → on its focused segment change the face without leaving the
 *   screen;
 * - the Office and Settings keep the Hercule face, and opening a thread shows
 *   the Threads face.
 *
 * One more test runs only with `HERCULE_LONG_TESTS=1`, because it takes over
 * 6 minutes: a push still arrives after the window has been hidden that long.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ConsoleMessage, Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { HerculeClient } from "../../packages/client-core/src/index";
import {
  arrangeFleet,
  chooseMenuItem,
  launchPlainAppForTest,
  launchWithSavedController,
  openSignedIn,
  openThread,
  signInAndReadToken,
} from "./harness";

/** Whether the tests that take minutes run. */
const longTests = process.env["HERCULE_LONG_TESTS"] === "1";

/**
 * Returns every item the thread list has mounted, top to bottom, each as one
 * line of text:
 *
 * - a section header: "Waiting on you 2", or "project Webshop";
 * - a Waiting on you row: its accessible name and its question, as
 *   "Thread 3, waiting on you: Run pnpm test?";
 * - a thread row: its accessible name, its workspace line and its end, as
 *   "Thread 1, working | webshop · studio | mark:working",
 *   "Thread 4, working | No workspace | queued" or
 *   "Thread 5, idle | No workspace | now";
 * - a "more" row: its label, "35 more threads";
 * - the Draft Thread's row: its name and its end, "New thread | draft".
 *
 * The app opens on a Draft Thread in no project, so every list has the
 * draft's row first under "No project", which is the last section.
 */
function readSidebarItems(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('nav[aria-label="Threads"] .side-item')].map((item) => {
      const readText = (selector: string) => item.querySelector(selector)?.textContent ?? "";
      // The draft's row is not a link, so its text is its name.
      const name = item.getAttribute("aria-label") ?? readText(".side-name");
      if (item.matches(".side-h--proj")) return `project ${readText(".proj-name")}`;
      if (item.matches(".side-h")) return item.textContent;
      if (item.matches(".side-row--wait")) return `${name}: ${readText(".side-ask")}`;
      if (item.matches(".side-row--more")) return item.textContent;
      if (item.getAttribute("data-key") === "draft") return `${name} | ${readText(".side-end")}`;
      const mark = item.querySelector(".side-end .mark");
      const end =
        mark === null
          ? (item.querySelector(".side-age")?.textContent ?? readText(".side-end"))
          : `mark:${mark.className.replace(/^mark mark--/, "")}`;
      return `${name} | ${readText(".side-ws-line")} | ${end}`;
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

/**
 * Returns which face the sidebar shows, as the face switch's selected segment
 * and the label of the list under it, such as
 * `{ tab: "Hercule", list: "Hercule" }`. The list is the sidebar's `nav`,
 * named "Threads" on the threads face and "Hercule" on the Hercule face.
 */
async function readSidebarFace(page: Page): Promise<{ tab: string | null; list: string | null }> {
  const tab = page.getByRole("tablist", { name: "Sidebar" }).locator('[aria-selected="true"]');
  const list = page.locator('nav[aria-label="Threads"], nav[aria-label="Hercule"]');
  return { tab: await tab.textContent(), list: await list.getAttribute("aria-label") };
}

const THREADS_FACE = { tab: "Threads", list: "Threads" };
const ORCHESTRATION_FACE = { tab: "Hercule", list: "Hercule" };

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
    await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();

    // The controller greets a new connection, so a socket that received a
    // frame is one the policy let through and the controller accepted.
    const origin = url.replace(/^http:/, "ws:");
    await expect
      .poll(() => sockets.filter((socket) => socket.received > 0).map((socket) => socket.url))
      .toEqual([expect.stringMatching(new RegExp(`^${origin}/`))]);
    expect(refusals).toEqual([]);
  });

  it("lists the threads by project, newest created first, each row naming its workspace and ending in its mark, word or age", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const webshop = await fleet.createProject("Webshop");
    const payments = await fleet.createProject("Payments");
    const repository = await fleet.createRepository("https://github.com/example/webshop", [
      webshop.id,
    ]);
    const studio = await fleet.enlistRunner("studio", { maxConcurrentSessions: 3 });
    const laptop = await fleet.enlistRunner("laptop");
    const primary = { kind: "primary", resourceId: repository.id } as const;

    // Each step waits for the one before it to land, so every thread is
    // created later than the one before, and the order below is certain.
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
      .poll(async () => (await client.session.read({ params: { id: waiting!.id } })).openRequests)
      .not.toEqual([]);
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

    // Payments comes first: its newest thread, Thread 6, is the newest of
    // all. Inside a project the newest thread comes first, whatever workspace
    // it works in. Both threads on the offline laptop are away: the idle one
    // shows "offline", and the exited one shows its age, as spec 17's pose
    // table has it for a session that has exited on an offline runner.
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "Waiting on you 1",
        "Thread 3, waiting on you: Run pnpm test?",
        "project Payments",
        "Thread 6, can't be reached | No workspace | now",
        "Thread 5, can't be reached | No workspace | offline",
        "Thread 4, working | No workspace | queued",
        "project Webshop",
        "Thread 3, waiting on you | webshop · studio | mark:waiting",
        `Thread 2, working | ${branch} | mark:working`,
        "Thread 1, working | webshop · studio | mark:working",
        "project No project",
        "New thread | draft",
      ]);
    expect(await readCounts(page)).toBe("3 working · 1 waiting · 0 idle");
  });

  it("brings a thread into Waiting on you within 1 s of its Request opening, and takes it out when it closes", async () => {
    const { url, fleet, client, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { page } = await openSignedIn(url);
    const working = [
      "project No project",
      "New thread | draft",
      "Thread 1, working | No workspace | mark:working",
    ];
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
      "New thread | draft",
      "Thread 1, waiting on you | No workspace | mark:waiting",
    ]);

    await client.session.respondToApprovalRequest({
      params: { id: thread!.id },
      payload: { requestId, decision: "allow" },
    });
    await waitingRow.waitFor({ state: "detached" });
    await expect.poll(() => readSidebarItems(page)).toEqual(working);
  });

  it("shows a new thread at the top of its project, also one in a new worktree, which its row names", async () => {
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
        "Thread 1, working | webshop · studio | mark:working",
        "project No project",
        "New thread | draft",
      ]);

    await fleet.spawnThreads(1, { runner, projectId: webshop.id, workspace: primary });
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "project Webshop",
        "Thread 2, working | webshop · studio | mark:working",
        "Thread 1, working | webshop · studio | mark:working",
        "project No project",
        "New thread | draft",
      ]);

    // The new worktree is in no list the app holds, so the app reads the
    // workspaces again to name it on the row.
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
        `Thread 3, working | ${branch} | mark:working`,
        "Thread 2, working | webshop · studio | mark:working",
        "Thread 1, working | webshop · studio | mark:working",
        "project No project",
        "New thread | draft",
      ]);
  });

  it("shows a runner's threads as offline while it is gone, and as before once it returns", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("laptop");
    // One at a time, so Thread 2 is created after Thread 1 and comes first.
    const [working] = await fleet.spawnThreads(1, { runner });
    const [idle] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(working!.id, "busy");
    await waitForStatus(idle!.id, "busy");
    runner.completeTurn(idle!.id);
    await waitForStatus(idle!.id, "idle");
    const { page } = await openSignedIn(url);
    const before = [
      "project No project",
      "New thread | draft",
      "Thread 2, idle | No workspace | now",
      "Thread 1, working | No workspace | mark:working",
    ];
    await expect.poll(() => readSidebarItems(page)).toEqual(before);

    await runner.goOffline();
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "project No project",
        "New thread | draft",
        "Thread 2, can't be reached | No workspace | offline",
        "Thread 1, can't be reached | No workspace | offline",
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

  it("changes the face from the switch in the drag strip, from View's items and with ← and →, without leaving the thread", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { app, page } = await openSignedIn(url);
    await openThread(page, "Thread 1");
    const transcript = page.locator('section[aria-label="Transcript"]');
    const switchList = page.getByRole("tablist", { name: "Sidebar" });
    const orchestrationTab = switchList.getByRole("tab", { name: "Hercule" });
    const threadsTab = switchList.getByRole("tab", { name: "Threads" });
    expect(await readSidebarFace(page)).toEqual(THREADS_FACE);

    // The switch sits in the shell's 52px drag strip. macOS hands a mouse
    // press in a drag region to the window, to move it, before the page sees
    // it; Playwright's click reaches the page directly and would not notice.
    // So the test reads that the switch opts out of the drag region, as
    // Chromium reports it to macOS, and then clicks it.
    const box = (await switchList.boundingBox())!;
    expect(box.y).toBeLessThan(52);
    expect(
      await switchList.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");
    await orchestrationTab.click();
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);
    await transcript.waitFor();

    // Only the selected segment is in the tab order, and the arrow keys move
    // both the selection and the focus.
    expect(await orchestrationTab.evaluate((element) => element === document.activeElement)).toBe(
      true,
    );
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => readSidebarFace(page)).toEqual(THREADS_FACE);
    expect(await threadsTab.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);

    await chooseMenuItem(app, "View", "Threads");
    await expect.poll(() => readSidebarFace(page)).toEqual(THREADS_FACE);
    await chooseMenuItem(app, "View", "Hercule");
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);
    await transcript.waitFor();
  });

  it("keeps the Hercule face in the Office and Settings, and shows the Threads face once a thread opens", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    const { app, page } = await openSignedIn(url);
    await page
      .getByRole("tablist", { name: "Sidebar" })
      .getByRole("tab", { name: "Hercule" })
      .click();
    await expect.poll(() => readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);

    await page.getByRole("link", { name: "Office ⌘⇧O" }).click();
    await page.locator(".office").waitFor();
    expect(await readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);

    await page.locator(".side-foot").getByRole("link", { name: "Settings" }).click();
    await expect.poll(() => page.locator(".bar .title").textContent()).toBe("Appearance");
    expect(await readSidebarFace(page)).toEqual(ORCHESTRATION_FACE);

    // The Hercule face lists no threads that do not wait, so the thread opens
    // from Go, which lists the threads whichever face shows.
    await chooseMenuItem(app, "Go", "Thread 1");
    await page.locator('section[aria-label="Transcript"]').waitFor();
    await expect.poll(() => readSidebarFace(page)).toEqual(THREADS_FACE);
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
      // process instead.
      const { evaluateInPage, callWindowMethod } = await launchPlainAppForTest(url);
      const hasWaitingRow = `document.querySelector("a.side-row--wait") !== null`;
      await expect
        .poll(() => evaluateInPage(`document.querySelectorAll("a.side-row").length`), {
          timeout: 10_000,
        })
        .toBe(1);
      // The list can be on the page before the window first shows. A window
      // hidden before then would show anyway once its first screen arrives.
      await expect.poll(() => callWindowMethod("isVisible"), { timeout: 10_000 }).toBe(true);

      await callWindowMethod("hide");
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
