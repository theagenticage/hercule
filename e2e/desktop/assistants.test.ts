/**
 * Tests the assistants in the packaged app, signed in to a real controller
 * (spec 17, §Design system, **The assistant**):
 *
 * - the sidebar pins the Assistants section between the thread list and the
 *   foot, and lists every assistant by name, with its pose's word: Hercule,
 *   which setup creates, and the assistants a test creates;
 * - clicking an assistant opens its screen: its name in the header and its
 *   empty Conversation;
 * - an assistant that is deleted while its screen is open, or that a
 *   notification names after it is gone, shows "This assistant was not
 *   found.";
 * - an assistant whose session asks the user something is a row of Waiting
 *   on you, counts on the dock badge, is in Go, and shows a notification
 *   titled with its name, which opens its screen.
 *
 * The controller places an assistant's session on any runner that can run
 * its provider. The harness retires the controller's own runner, so a
 * session lands on the scripted runner the test enlists, which can open a
 * Request in it.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { isWindowVisible } from "../../apps/desktop/scripts/packaged-app";
import {
  arrangeFleet,
  clickWaitingNotification,
  hideWindow,
  openSignedIn,
  readAssistant,
  readBadgeCount,
  readMenuItems,
  readNewestSession,
  readWaitingNotifications,
} from "./harness";

/** An assistant id that no controller holds. */
const GONE_ASSISTANT_ID = "01a06d02-a000-7000-8000-0000000000ff";

/** Returns the Assistants section of the sidebar. */
const findAssistantsSection = (page: Page) =>
  page.getByRole("navigation", { name: "Assistants", exact: true });

/**
 * Returns the accessible names of the Assistants section's rows, top to
 * bottom, such as "Ada, idle". A row is named for its assistant and its
 * pose's word.
 */
async function readAssistantRows(page: Page): Promise<Array<string | null>> {
  const links = await findAssistantsSection(page).getByRole("link").all();
  return Promise.all(links.map((link) => link.getAttribute("aria-label")));
}

/** Returns the floating header's pill, which holds the assistant's face, name and pose word. */
const findHeaderPill = (page: Page) => page.locator("header.top .pill--who");

describe("the assistants", () => {
  it("pins the Assistants section above the foot, listing every assistant by name with its pose", async () => {
    const { url, client } = await arrangeFleet();
    await client.assistant.create({ payload: { name: "Zed" } });
    await client.assistant.create({ payload: { name: "Ada" } });

    const { page } = await openSignedIn(url);

    await expect
      .poll(() => readAssistantRows(page))
      .toEqual(["Ada, idle", "Hercule, idle", "Zed, idle"]);
    // The section sits below the thread list and above the foot, and the
    // thread list, not the section, takes the height that is left.
    const threads = await page
      .getByRole("navigation", { name: "Threads", exact: true })
      .boundingBox();
    const assistants = await findAssistantsSection(page).boundingBox();
    const foot = await page.locator(".side-sum").boundingBox();
    expect(threads!.y + threads!.height).toBeLessThanOrEqual(assistants!.y);
    expect(assistants!.y + assistants!.height).toBeLessThanOrEqual(foot!.y);
    // The foot counts threads only; the assistants are not in it.
    expect(await page.locator(".side-sum").textContent()).toBe("0 working · 0 waiting · 0 idle");
  });

  it("opens an assistant's screen, with its name and its empty Conversation, when its row is clicked", async () => {
    const { url } = await arrangeFleet();
    const { page } = await openSignedIn(url);

    const row = findAssistantsSection(page).getByRole("link", { name: "Hercule, idle" });
    await row.click();

    const pill = findHeaderPill(page);
    await pill.waitFor();
    expect(await pill.locator("b").textContent()).toBe("Hercule");
    expect(await pill.getByText("idle", { exact: true }).count()).toBe(1);
    const main = page.getByRole("main");
    await main.getByRole("heading", { level: 2, name: "Hercule" }).waitFor();
    await main
      .getByText(
        "Send a message to start. Hercule falls asleep after a quiet spell and picks up where it left off.",
        { exact: true },
      )
      .waitFor();
    expect(await row.getAttribute("aria-current")).toBe("page");
  });

  it("shows that an assistant is not found once it is deleted, or when main asks the page to open one that is gone", async () => {
    const { url, client } = await arrangeFleet();
    const ada = await client.assistant.create({ payload: { name: "Ada" } });
    const { app, page } = await openSignedIn(url);
    await findAssistantsSection(page).getByRole("link", { name: "Ada, idle" }).click();
    await findHeaderPill(page).waitFor();

    // The live connection reports the deletion, and the open screen follows.
    await client.assistant.delete({ params: { id: ada.id } });

    const notFound = page.getByRole("heading", { name: "This assistant was not found." });
    await notFound.waitFor();
    await expect.poll(() => readAssistantRows(page)).toEqual(["Hercule, idle"]);
    expect(await page.getByRole("main").getByRole("button").count()).toBe(0);

    // A notification clicked after its assistant is gone opens the screen of
    // an id the controller no longer holds. Main sends the page the same
    // message a click sends.
    await findAssistantsSection(page).getByRole("link", { name: "Hercule, idle" }).click();
    await notFound.waitFor({ state: "detached" });
    await app.evaluate(({ BrowserWindow }, assistantId) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("destination.open", {
        kind: "assistant",
        assistantId,
      });
    }, GONE_ASSISTANT_ID);
    await notFound.waitFor();
  });

  it("puts an assistant that asks the user something in Waiting on you, on the badge, in Go and in a notification that opens its screen", async () => {
    const { url, fleet, client } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const hercule = await readAssistant(client, "Hercule");
    const { app, page } = await openSignedIn(url);
    await hideWindow(app);

    await client.conversation.send({
      params: { id: hercule.mainConversationId },
      payload: { text: "Run the tests, please" },
    });
    await expect
      .poll(async () => {
        const session = await readNewestSession(client, hercule.mainConversationId);
        return session === null ? null : { runnerId: session.runnerId, status: session.status };
      })
      .toEqual({ runnerId: runner.runnerId, status: "busy" });
    const session = (await readNewestSession(client, hercule.mainConversationId))!;
    expect(await readBadgeCount(app)).toBe(0);

    const requestId = runner.openRequest(session.id, "command_approval");

    await expect.poll(() => readBadgeCount(app)).toBe(1);
    await expect
      .poll(() => readWaitingNotifications(app))
      .toEqual([{ title: "Hercule", body: "Run pnpm test?", state: "shown" }]);
    await expect.poll(() => readAssistantRows(page)).toEqual(["Hercule, waiting on you"]);
    const waitingRow = page
      .getByRole("navigation", { name: "Threads", exact: true })
      .locator("a.side-row--wait", { hasText: "Hercule" });
    expect(await waitingRow.getAttribute("aria-label")).toBe("Hercule, waiting on you");
    expect(await waitingRow.locator(".side-ask").textContent()).toBe("Run pnpm test?");
    await expect
      .poll(async () => (await readMenuItems(app, "Go")).map((item) => item.label))
      .toContain("Hercule");

    await clickWaitingNotification(app, 0);

    const pill = findHeaderPill(page);
    await pill.waitFor();
    expect(await isWindowVisible(app)).toBe(true);
    expect(await pill.locator("b").textContent()).toBe("Hercule");
    expect(await pill.getByText("waiting on you", { exact: true }).count()).toBe(1);

    await client.session.respondToApprovalRequest({
      params: { id: session.id },
      payload: { requestId, decision: "allow" },
    });

    await expect.poll(() => readBadgeCount(app)).toBe(0);
    await waitingRow.waitFor({ state: "detached" });
    await expect.poll(() => readAssistantRows(page)).toEqual(["Hercule, working"]);
    expect(await pill.getByText("working", { exact: true }).count()).toBe(1);
    // macOS takes a clicked notification off the screen itself, so main
    // forgets it on the click and has nothing to remove once the Request is
    // answered.
    expect(await readWaitingNotifications(app)).toEqual([
      { title: "Hercule", body: "Run pnpm test?", state: "shown" },
    ]);
  });
});
