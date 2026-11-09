/**
 * Tests the Fleet page in the packaged app, signed in to a real controller
 * whose machines are scripted runners (spec 17 §Fleet). `fleet-machine.test.ts`
 * tests a machine's page:
 *
 * - the Fleet row of the Hercule face opens the page, the row stays selected
 *   on a machine's page, and the sidebar shows the Hercule face on both;
 * - a second machine joins with the command Add a machine shows, and its card
 *   appears on the open page;
 * - the card of the controller's own, real runner shows its disk as a
 *   percentage, from the size the runner reports;
 * - a machine whose session cap holds a thread back says so on its card, and
 *   Allow raises the cap so the waiting thread starts;
 * - the Software grid shows the git version the controller's own, real runner
 *   probed on this machine, and a column head opens the machine's page at its
 *   Software section.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  arrangeFleet,
  chooseMenuItem,
  locateCard,
  openFleet,
  openSignedIn,
  startControllerForTest,
} from "./harness";
import { readSidebarList } from "./fleet-page-helpers";

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

  it("shows the git version of the real runner in the Software grid, and a column head opens the machine's page at its Software", async () => {
    // The controller starts a real runner of its own, which probes the git on
    // this machine. Its column of the grid must show the version `git` prints.
    const printed = execFileSync("git", ["--version"], { encoding: "utf8" });
    const gitVersion = /\d+\.\d+\.\d+/.exec(printed)![0];
    const { url } = await startControllerForTest({ setUp: true });
    const { page } = await openSignedIn(url);
    await openFleet(page);

    const grid = page.getByRole("table", { name: "Software on each machine" });
    await grid.waitFor();
    // Tool and Latest come first, so the runner's head is the third. In a row the name is its
    // row header, so the runner's cell follows the Latest cell.
    const machineHead = grid.getByRole("columnheader").nth(2);
    const gitRow = grid
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: "git", exact: true }) });
    // The first report follows the hello, so the cell shows "Not installed" until then.
    await expect.poll(() => gitRow.getByRole("cell").nth(1).innerText()).toContain(gitVersion);

    await machineHead.getByRole("button").click();
    // The Fleet page has a Software region of its own, and the app's address is not in the
    // window's URL, so wait for the machine's page before looking for its section.
    await page.locator(".machine-page").waitFor();
    const software = page.locator("#machine-software");
    await software.waitFor();
    await expect
      .poll(() =>
        software.evaluate((section) => {
          const area = section.closest(".fleet-scroll")!;
          const top = section.getBoundingClientRect().top - area.getBoundingClientRect().top;
          // The section starts under the header (80px) and not far below it.
          return top >= 0 && top < 200;
        }),
      )
      .toBe(true);
  });
});
