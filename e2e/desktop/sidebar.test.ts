/**
 * Tests the sidebar's thread list in the packaged app, signed in to a real
 * controller whose threads a fleet of scripted runners puts in known states
 * (spec 17, §Design system, **The sidebar**). The files `sidebar-faces.test.ts`
 * and `sidebar-large-project.test.ts` test the rest of it:
 *
 * - the live socket connects from `app://hercule` under the release policy;
 * - the list groups the threads by project, then by workspace: the threads that
 *   work in one workspace are one row, with dots for its threads, and the other
 *   rows come newest first; each row names its workspace and ends in the right
 *   mark, word or age;
 * - a Request that opens brings its thread into Waiting on you within 1 s, and
 *   takes it out again when it closes; a Request from a thread in a shared
 *   workspace names the row and the thread that asks;
 * - a new thread joins the row of its workspace, or appears at the top of its
 *   project when it works alone, also one in a new worktree, which its row
 *   names;
 * - a runner that goes offline shows its threads as offline until it returns.
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
  launchPlainAppForTest,
  launchWithSavedController,
  openSignedIn,
  signInAndReadToken,
} from "./harness";
import { readCounts } from "./sidebar-helpers";

/** Whether the tests that take minutes run. */
const longTests = process.env["HERCULE_LONG_TESTS"] === "1";

/**
 * Returns every item the thread list has mounted, top to bottom, each as one
 * line of text:
 *
 * - a section header: "Waiting on you 2", or "project Webshop";
 * - a Waiting on you row: its accessible name and its question, after the
 *   name of the thread that asks when it is not the row's lead, as
 *   "Thread 1, waiting on you: Run pnpm test?" or
 *   "Thread 1, waiting on you: Thread 3 asks · Run pnpm test?";
 * - a row of one thread: its accessible name, its second line and its status,
 *   as "Thread 1, working | main | Working",
 *   "Thread 4, working | studio | Queued" or
 *   "Thread 5, idle | laptop | now". While a Request waits, the second line is
 *   its question, as "Thread 1, waiting on you | Run pnpm test? | Approval";
 * - a row of 2 or more threads: the same, then the accessible name of its dots,
 *   which counts the threads in words, as
 *   "Thread 1, working | main | Working | 2 threads: 2 working. Unfold";
 * - a "more" row: its label, which counts rows, "35 more";
 * - the Draft Thread's row: its name and its end, "New thread | draft".
 *
 * The app opens on a Draft Thread in no project, so every list has the
 * draft's row first under "No project", which is the last section.
 */
function readSidebarItems(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('nav[aria-label="Threads"] .side-item')].map((item) => {
      // The drawn text only: an age carries its words, "just now", in a
      // hidden element beside it.
      const readText = (selector: string) =>
        item.querySelector<HTMLElement>(selector)?.innerText ?? "";
      // A thread row's item holds its link and its Done button; the link,
      // the first element in it with a key, carries the row's name. The
      // draft's row is not a link, so its text is its name.
      const keyed = item.matches("[data-key]") ? item : item.querySelector("[data-key]");
      const name = keyed?.getAttribute("aria-label") ?? readText(".side-name");
      if (item.matches(".side-h--proj")) return `project ${readText(".proj-name")}`;
      if (item.matches(".side-h")) return item.textContent;
      if (item.matches(".side-row--wait")) return `${name}: ${readText(".side-ask")}`;
      if (item.matches(".side-row--more")) return item.textContent;
      if (keyed?.getAttribute("data-key") === "draft") return `${name} | ${readText(".side-end")}`;
      const row = `${name} | ${readText(".side-detail")} | ${readText(".side-end")}`;
      // Only a row of 2 or more threads has dots.
      const dots = item.querySelector(".side-dots")?.getAttribute("aria-label");
      return dots === null || dots === undefined ? row : `${row} | ${dots}`;
    }),
  );
}

/**
 * Returns the branch of the worktree a thread works in. The controller picks
 * the branch, so a test reads it back rather than guessing it. The sidebar's
 * row leaves a branch the controller generated out, and names the machine.
 */
async function readBranch(client: HerculeClient, sessionId: string): Promise<string | null> {
  const { workspaceId } = await client.session.read({ params: { id: sessionId } });
  const workspace = await client.workspace.read({ params: { id: workspaceId! } });
  return workspace.checkouts[0]!.branch;
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
    await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();

    // The controller greets a new connection, so a socket that received a
    // frame is one the policy let through and the controller accepted.
    const origin = url.replace(/^http:/, "ws:");
    await expect
      .poll(() => sockets.filter((socket) => socket.received > 0).map((socket) => socket.url))
      .toEqual([expect.stringMatching(new RegExp(`^${origin}/`))]);
    expect(refusals).toEqual([]);
  });

  it("lists the rows by project, newest started first, each row naming where it works and ending in its status, and holds the threads of one workspace in one row", async () => {
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
    expect(await readBranch(client, inWorktree!.id)).toMatch(/^hercule\/thread-[0-9a-f]+$/);

    const { page } = await openSignedIn(url);

    // Payments comes first: its newest thread, Thread 6, is the newest of
    // all. Inside a project the row that started last comes first. Thread 3
    // works in the same main workspace as Thread 1, so they are one row,
    // named by Thread 1, the lead, and it started when Thread 1 did: Thread 2,
    // in a worktree of its own, comes before it. The row waits because Thread
    // 3 asks, so its second line is Thread 3's question, and Waiting on you
    // lists Thread 3's question under the row's name. Both threads on the
    // offline laptop are away: the idle one shows "offline", and the exited
    // one shows its age, as spec 17's pose table has it for a session that
    // has exited on an offline runner.
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "Waiting on you 1",
        "Thread 1, waiting on you: Thread 3 asks · Run pnpm test?",
        "project Payments",
        "Thread 6, can't be reached | laptop | now",
        "Thread 5, can't be reached | laptop | Offline",
        "Thread 4, working | studio | Queued",
        "project Webshop",
        "Thread 2, working | studio | Working",
        "Thread 1, waiting on you | Thread 3 asks · Run pnpm test? | Approval | 2 threads: 1 waiting on you, 1 working. Unfold",
        "project No project",
        "New thread | draft",
      ]);
    // The foot counts threads, not rows.
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
      "Thread 1, working | studio | Working",
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
      "Thread 1, waiting on you | Run pnpm test? | Approval",
    ]);

    await client.session.respondToApprovalRequest({
      params: { id: thread!.id },
      payload: { requestId, decision: "allow" },
    });
    await waitingRow.waitFor({ state: "detached" });
    await expect.poll(() => readSidebarItems(page)).toEqual(working);
  });

  it("puts a new thread in the row of its workspace, or at the top of its project when it works in a new worktree, whose generated branch its row leaves out", async () => {
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
        "Thread 1, working | main | Working",
        "project No project",
        "New thread | draft",
      ]);

    // Thread 2 works in the same main workspace, so it joins Thread 1's row
    // instead of getting one, and the row does not move.
    const [second] = await fleet.spawnThreads(1, {
      runner,
      projectId: webshop.id,
      workspace: primary,
    });
    await waitForStatus(second!.id, "busy");
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "project Webshop",
        "Thread 1, working | main | Working | 2 threads: 2 working. Unfold",
        "project No project",
        "New thread | draft",
      ]);

    // The new worktree's branch was generated, so the row names the machine.
    const [inWorktree] = await fleet.spawnThreads(1, {
      runner,
      projectId: webshop.id,
      workspace: { kind: "ephemeral", checkouts: [{ resourceId: repository.id }] },
    });
    await waitForStatus(inWorktree!.id, "busy");
    expect(await readBranch(client, inWorktree!.id)).toMatch(/^hercule\/thread-[0-9a-f]+$/);
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "project Webshop",
        "Thread 3, working | studio | Working",
        "Thread 1, working | main | Working | 2 threads: 2 working. Unfold",
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
      "Thread 2, idle | laptop | now",
      "Thread 1, working | laptop | Working",
    ];
    await expect.poll(() => readSidebarItems(page)).toEqual(before);

    await runner.goOffline();
    await expect
      .poll(() => readSidebarItems(page))
      .toEqual([
        "project No project",
        "New thread | draft",
        "Thread 2, can't be reached | laptop | Offline",
        "Thread 1, can't be reached | laptop | Offline",
      ]);
    expect(await readCounts(page)).toBe("0 working · 0 waiting · 0 idle");

    await runner.reconnect();
    await expect.poll(() => readSidebarItems(page)).toEqual(before);
    expect(await readCounts(page)).toBe("1 working · 0 waiting · 1 idle");
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
        .poll(
          () =>
            evaluateInPage(
              `document.querySelectorAll('nav[aria-label="Threads"] a.side-row').length`,
            ),
          {
            timeout: 10_000,
          },
        )
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
