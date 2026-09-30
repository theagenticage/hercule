/**
 * Tests starting a thread in the packaged app, signed in to a real controller
 * (spec 17 §Slices, slice 7):
 *
 * - File › New Thread opens the project picker, and ⌘1 opens a Draft Thread
 *   in the first project;
 * - the local-runner probe, which main sends, marks the runner that answers
 *   on this machine as "this machine";
 * - a project with no repository says why the draft has no workspace;
 * - typing and ⏎ start the thread where the lip says, and open it.
 *
 * The controller starts a runner of its own on this machine, which may be
 * logged in to a real provider. The test retires it before the app opens, so
 * the probe cannot pick it and no thread can land on it. The scripted runner
 * stands in for the runner on this machine: it reports the port of a server
 * the test runs, which answers the probe with the scripted runner's id.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import type { HerculeClient } from "../../packages/client-core/src/index";
import {
  arrangeFleet,
  chooseMenuItem,
  keepWindowOnTop,
  openSignedIn,
  startIdentityServerForTest,
} from "./harness";

/**
 * Waits until the controller's own runner is online, then retires it. Fails
 * if the retirement is refused.
 */
async function retireControllerRunner(client: HerculeClient): Promise<void> {
  const readRunners = async () => (await client.runner.query({ query: { limit: 10 } })).items;
  await expect
    .poll(async () => (await readRunners()).map((runner) => runner.connectivity))
    .toEqual(["online"]);
  const [own] = await readRunners();
  await client.runner.retire({ params: { id: own!.id }, payload: {} });
}

describe("a new thread", () => {
  it("opens as a draft from the picker, runs on this machine, and starts with ⏎", async () => {
    const { url, fleet, client } = await arrangeFleet();
    await retireControllerRunner(client);
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
