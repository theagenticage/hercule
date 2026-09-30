/**
 * Tests starting a thread in the packaged app, signed in to a real controller
 * (spec 17, §Design system, **A new thread**, and §The "local" runner):
 *
 * - File › New Thread opens the project picker, and ⌘1 opens a Draft Thread
 *   in the first project;
 * - the local-runner probe, which main sends, marks the runner that answers
 *   on this machine as "this machine";
 * - a project with no repository says why the draft has no workspace;
 * - typing and ⏎ start the thread where the lip says, and open it.
 *
 * The harness retires the controller's own runner (see `arrangeFleet`), so
 * the probe cannot pick it and no thread can land on it. The scripted runner
 * stands in for the runner on this machine: it reports the port of a server
 * the test runs, which answers the probe with the scripted runner's id.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import {
  arrangeFleet,
  chooseMenuItem,
  keepWindowOnTop,
  openSignedIn,
  startIdentityServerForTest,
} from "./harness";

describe("a new thread", () => {
  it("opens as a draft from the picker, runs on this machine, and starts with ⏎", async () => {
    const { url, fleet, client } = await arrangeFleet();
    let localRunnerId = "";
    const identityPort = await startIdentityServerForTest(() => localRunnerId);
    const runner = await fleet.enlistRunner("studio", { identityPort });
    localRunnerId = runner.runnerId;
    const notes = await fleet.createProject("notes");
    const webshop = await fleet.createProject("webshop");
    await fleet.createRepository("https://github.com/example/webshop", [webshop.id]);
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);

    await chooseMenuItem(app, "File", "New Thread");
    const picker = page.getByRole("dialog", { name: "New thread in" });
    await picker.waitFor();
    expect(await picker.locator(".proj-name").allTextContents()).toEqual(["notes", "webshop"]);
    await page.keyboard.press("Meta+1");

    await page.getByRole("heading", { name: "What should the agent do in notes?" }).waitFor();
    await picker.waitFor({ state: "hidden" });
    const lip = page.locator(".lip");
    expect(
      await lip.getByTitle("Add a repository to the project to work in one").textContent(),
    ).toBe("None");
    await lip.getByRole("button", { name: "studio" }).click();
    const machineMenu = page.getByRole("dialog", { name: "Machine", exact: true });
    // The note follows the probe's answer, which may come after the menu opens.
    await expect
      .poll(() => machineMenu.getByRole("button", { name: /^studio/ }).textContent())
      .toMatch(/^studiothis machine/);
    await page.keyboard.press("Escape");
    await machineMenu.waitFor({ state: "hidden" });

    const field = page.getByRole("textbox", { name: "Message" });
    await field.fill("Write up the release notes");
    await field.press("Enter");

    // The app keeps its history in memory, so the page's URL does not show
    // the thread. The thread's own transcript, with the message, does.
    await page
      .locator('section[aria-label="Transcript"] .msg--me .bubble', {
        hasText: "Write up the release notes",
      })
      .waitFor();
    const { items } = await client.session.query({ query: { thread: true, limit: 10 } });
    expect(
      items.map(({ runnerId, projectId, workspaceId }) => ({ runnerId, projectId, workspaceId })),
    ).toEqual([{ runnerId: runner.runnerId, projectId: notes.id, workspaceId: null }]);
  });
});
