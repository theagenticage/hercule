/**
 * Tests the Office in the packaged app, signed in to a real controller:
 *
 * - the Office button in the sidebar's actions row opens the Office, and is
 *   marked as the current page while the Office is open;
 * - Go › Office opens it too, and carries ⌘⇧O;
 * - nothing in the window is see-through while the Office is open, and the
 *   glass is back once the user leaves it;
 * - the assistants are colleagues in the Secretariat (spec 17, §The Office):
 *   the Rooms directory lists the Secretariat and counts every assistant in
 *   it, and the top bar counts the assistants that work, wait or are idle;
 * - an assistant clicked in the sidebar while the Office is open opens its
 *   Conversation in the Office's drawer; Escape closes the drawer and leaves
 *   the assistant's card, and Open conversation opens the drawer again;
 * - an assistant that waits on the user is in the Office's queue: the
 *   waiting count selects it, and its card shows its Request.
 *
 * Playwright's key presses reach the page, not the macOS menu bar, so they
 * cannot fire a menu item's shortcut. The second test checks that ⌘⇧O is the
 * item's shortcut, and chooses the item as a click with the mouse does.
 *
 * The Office reads keys only while the focus is in the Office or on nothing
 * at all, so a sidebar row keeps its own keys. After clicking a sidebar row,
 * a test clicks into the drawer before it presses Escape, as a user does.
 *
 * With `HERCULE_OFFICE_EVIDENCE=<dir>` set, one more test walks through the
 * Secretariat for a reviewer: it records a video of itself at 1440 × 900
 * into `<dir>`, and takes a light and a dark screenshot at each step:
 * `overview`, `secretariat`, `card`, `drawer` and `waiting`, such as
 * `card-dark.png`. Without it, that test is skipped, because the tests above
 * already check every step it shows.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import type { ScriptedRunner } from "../../apps/desktop/scripts/scripted-runner";
import type { HerculeClient } from "../../packages/client-core/src/index";
import type { Assistant, Session } from "../../packages/contract/src/index";
import {
  arrangeFleet,
  chooseMenuItem,
  createUserDataDirForTest,
  keepWindowOnTop,
  launchForTest,
  openSignedIn,
  readMenuItems,
  readNewestSession,
  signInAndReadToken,
} from "./harness";

/** Returns the backdrop filter the element `locator` finds is drawn with, such as "none". */
function readBackdropFilter(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).backdropFilter);
}

/** Milliseconds the journey waits for the camera to finish a flight, so a screenshot shows where it lands. */
const CAMERA_SETTLE_MS = 2_000;

/** Milliseconds the journey waits for the scene to draw a new theme before a screenshot. */
const THEME_SETTLE_MS = 300;

/** The assistants `arrangeSecretariat` creates, besides Hercule, which setup creates. */
const ASSISTANT_NAMES = ["Ada", "Basil", "Clem", "Dora", "Ezra"] as const;

/** The name of an assistant `arrangeSecretariat` creates. */
type AssistantName = (typeof ASSISTANT_NAMES)[number];

/**
 * The sidebar's Assistants rows once `arrangeSecretariat` is done, top to
 * bottom: every assistant by name, with its pose's word.
 */
const SECRETARIAT_ROWS = [
  "Ada, working",
  "Basil, waiting on you",
  "Clem, idle",
  "Dora, asleep",
  "Ezra, can't be reached",
  "Hercule, idle",
];

/** A controller whose assistants are in every pose, as `arrangeSecretariat` sets them up. */
interface ArrangedSecretariat {
  readonly url: string;
  readonly client: HerculeClient;
  /** The assistants the test created, by name. */
  readonly assistants: ReadonlyMap<AssistantName, Assistant>;
}

/**
 * Starts a controller for the current test with five assistants besides
 * Hercule, one in each pose:
 *
 * - Ada works: her session runs a turn;
 * - Basil waits on the user: his session runs a turn and asks to run a command;
 * - Clem is idle: his session finished its turn;
 * - Dora is asleep: her session exited and can be resumed;
 * - Ezra can't be reached: his session is idle on a runner that went offline;
 * - Hercule is idle: it has had no session yet.
 *
 * Ezra's runner goes offline before the other runner is enlisted, so every
 * other session lands on the one runner that is online, "studio". Fails when
 * a session does not reach the status its pose needs.
 */
async function arrangeSecretariat(): Promise<ArrangedSecretariat> {
  const { url, fleet, client, waitForStatus } = await arrangeFleet();
  const assistants = new Map<AssistantName, Assistant>();
  for (const name of ASSISTANT_NAMES) {
    assistants.set(name, await client.assistant.create({ payload: { name } }));
  }
  const startSession = async (name: AssistantName, runner: ScriptedRunner): Promise<Session> => {
    const { mainConversationId } = assistants.get(name)!;
    await client.conversation.send({
      params: { id: mainConversationId },
      payload: { text: "Tidy up the inbox, please" },
    });
    await expect
      .poll(async () => {
        const session = await readNewestSession(client, mainConversationId);
        return session === null ? null : { runnerId: session.runnerId, status: session.status };
      })
      .toEqual({ runnerId: runner.runnerId, status: "busy" });
    return (await readNewestSession(client, mainConversationId))!;
  };

  const laptop = await fleet.enlistRunner("laptop");
  const ezra = await startSession("Ezra", laptop);
  laptop.completeTurn(ezra.id);
  await waitForStatus(ezra.id, "idle");
  await laptop.goOffline();
  await expect
    .poll(async () => (await client.runner.read({ params: { id: laptop.runnerId } })).connectivity)
    .toBe("offline");

  const studio = await fleet.enlistRunner("studio");
  await startSession("Ada", studio);
  const basil = await startSession("Basil", studio);
  studio.openRequest(basil.id, "command_approval");
  const clem = await startSession("Clem", studio);
  studio.completeTurn(clem.id);
  await waitForStatus(clem.id, "idle");
  const dora = await startSession("Dora", studio);
  studio.endSession(dora.id, "crash");
  await waitForStatus(dora.id, "exited");
  return { url, client, assistants };
}

/** Returns the Assistants section of the sidebar. */
const findAssistantsSection = (page: Page) =>
  page.getByRole("navigation", { name: "Assistants", exact: true });

/**
 * Returns the accessible names of the Assistants section's rows, top to
 * bottom, such as "Ada, working".
 */
async function readAssistantRows(page: Page): Promise<Array<string | null>> {
  const links = await findAssistantsSection(page).getByRole("link").all();
  return Promise.all(links.map((link) => link.getAttribute("aria-label")));
}

/**
 * Opens the Office from the sidebar's Office button, once the sidebar shows
 * every assistant in the pose `arrangeSecretariat` set, and waits for the
 * Office to show.
 */
async function openOffice(page: Page): Promise<void> {
  await expect.poll(() => readAssistantRows(page)).toEqual(SECRETARIAT_ROWS);
  await page.getByRole("link", { name: "Office ⌘⇧O" }).click();
  await page.locator(".office").waitFor();
}

/** Returns the accessible names of the top bar's counts, left to right, such as "2 idle". */
async function readPoseCounts(page: Page): Promise<Array<string | null>> {
  const counts = await page
    .getByRole("group", { name: "Who is doing what" })
    .getByRole("button")
    .all();
  return Promise.all(counts.map((count) => count.getAttribute("aria-label")));
}

/** Returns the Office's top-bar pill, which holds Overview and the room directory. */
const findOfficePill = (page: Page) =>
  page.getByRole("navigation", { name: "Office", exact: true });

/** Opens the room directory from the top bar, and returns the directory. */
async function openRoomDirectory(page: Page): Promise<Locator> {
  await findOfficePill(page).getByRole("button", { name: "Rooms", exact: true }).click();
  const directory = page.getByRole("dialog", { name: "Room directory" });
  await directory.waitFor();
  return directory;
}

/**
 * Returns the rooms the open room directory lists under "The Office", top
 * to bottom, each with the number of colleagues it counts, such as
 * `{ room: "The Secretariat", count: "6 colleagues" }`. The directory lists
 * no rooms until the scene has built the Office.
 */
async function readOfficeRooms(
  directory: Locator,
): Promise<Array<{ room: string | null; count: string | null }>> {
  const group = directory.locator(".pop-sec", {
    has: directory.page().locator(".q-h", { hasText: /^The Office$/ }),
  });
  const rows = await group.locator("button.line").all();
  return Promise.all(
    rows.map(async (row) => ({
      room: await row.locator("b").textContent(),
      count: await row.locator(".count").getAttribute("aria-label"),
    })),
  );
}

/** Returns the dossier card while it shows, named for the selected colleague. */
const findOpenCard = (page: Page) => page.locator('section.office-card[data-open="true"]');

/** Returns the value of the card's fact named `name`, such as "Room", or null when the card has no such fact. */
async function readCardFact(card: Locator, name: string): Promise<string | null> {
  const factName = card.locator(".office-card-facts dt", { hasText: new RegExp(`^${name}$`) });
  if ((await factName.count()) === 0) return null;
  return factName.locator("xpath=following-sibling::dd[1]").textContent();
}

/** Returns the Office's drawer while it is open. */
const findOpenDrawer = (page: Page) => page.locator('aside.office-drawer[data-open="true"]');

/** Returns the name of the assistant whose Conversation the open drawer shows. */
const readDrawerName = (page: Page) =>
  findOpenDrawer(page).locator("header.top .pill--who b").textContent();

/**
 * Presses Escape with the focus inside the drawer, as a user who reads the
 * Conversation does: the click lands on the drawer's header, which takes no
 * focus, so the focus leaves the sidebar row that opened the drawer.
 */
async function pressEscapeInDrawer(page: Page): Promise<void> {
  await findOpenDrawer(page).locator("header.top .pill--who").click();
  await page.keyboard.press("Escape");
}

describe("the Office", () => {
  it("opens from the Office button in the sidebar, and marks the button as the current page", async () => {
    const { url } = await arrangeFleet();
    const { page } = await openSignedIn(url);
    const button = page.getByRole("link", { name: "Office ⌘⇧O" });
    expect(await button.getAttribute("aria-current")).toBeNull();

    await button.click();

    await page.locator(".office").waitFor();
    expect(await button.getAttribute("aria-current")).toBe("page");
  });

  it("opens from Go › Office, which carries ⌘⇧O", async () => {
    const { url } = await arrangeFleet();
    const { app, page } = await openSignedIn(url);
    const [first] = await readMenuItems(app, "Go");
    expect(first).toEqual({ label: "Office", accelerator: "CmdOrCtrl+Shift+O", enabled: true });

    await chooseMenuItem(app, "Go", "Office");

    await page.locator(".office").waitFor();
    expect(await page.getByRole("link", { name: "Office ⌘⇧O" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("draws no blur while it is open, and the composer is glass again once the user leaves it", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    // An asleep thread has no colleague, so Go opens it on its own screen
    // even while the Office is open.
    const [thread] = await fleet.spawnThreads(1, { runner });
    await waitForStatus(thread!.id, "busy");
    runner.endSession(thread!.id, "crash");
    await waitForStatus(thread!.id, "exited");
    const { app, page } = await openSignedIn(url);

    await chooseMenuItem(app, "Go", "Office");
    const pill = page.locator(".office-top .pill").first();
    await pill.waitFor();
    expect(await readBackdropFilter(pill)).toBe("none");

    await expect
      .poll(async () => (await readMenuItems(app, "Go")).map((item) => item.label))
      .toContain("Thread 1");
    await chooseMenuItem(app, "Go", "Thread 1");
    await page.locator(".office").waitFor({ state: "detached" });
    const composer = page.locator(".composer-card");
    await composer.waitFor();
    expect(await readBackdropFilter(composer)).not.toBe("none");
  });
});

/** The folder the Secretariat's evidence is written to, when one is asked for. */
const evidence = process.env["HERCULE_OFFICE_EVIDENCE"];

describe("the Secretariat", () => {
  it("is in the Rooms directory with every assistant, and the top bar counts the assistants at work", async () => {
    const { url } = await arrangeSecretariat();
    const { page } = await openSignedIn(url);

    await openOffice(page);

    // The counts leave out the asleep and the away assistant, as they leave
    // out those threads. The sidebar's foot counts threads only.
    await expect
      .poll(() => readPoseCounts(page))
      .toEqual(["1 working", "1 waiting on you", "2 idle"]);
    expect(await page.locator(".side-sum").textContent()).toBe("0 working · 0 waiting · 0 idle");
    // The Secretariat counts every assistant, in every pose. Your Office
    // counts the one waiting in its queue.
    const directory = await openRoomDirectory(page);
    await expect
      .poll(() => readOfficeRooms(directory))
      .toEqual(
        expect.arrayContaining([
          { room: "The Secretariat", count: "6 colleagues" },
          { room: "Your Office", count: "1 colleague" },
        ]),
      );

    await directory.locator("button.line", { hasText: "The Secretariat" }).click();

    await directory.waitFor({ state: "hidden" });
    await findOfficePill(page)
      .getByRole("button", { name: "Room: The Secretariat", exact: true })
      .waitFor();
  });

  it("opens an assistant's Conversation in the drawer from its sidebar row without leaving the Office, and Escape leaves its card", async () => {
    const { url, assistants } = await arrangeSecretariat();
    const ada = assistants.get("Ada")!;
    const { page } = await openSignedIn(url);
    await openOffice(page);
    const row = findAssistantsSection(page).getByRole("link", { name: "Ada, working" });
    expect(await row.getAttribute("href")).toBe(`/office?assistant=${ada.id}`);

    await row.click();

    await findOpenDrawer(page).waitFor();
    expect(await page.locator(".office").count()).toBe(1);
    expect(await readDrawerName(page)).toBe("Ada");
    expect(await row.getAttribute("aria-current")).toBe("page");

    await pressEscapeInDrawer(page);

    await findOpenDrawer(page).waitFor({ state: "detached" });
    expect(await row.getAttribute("aria-current")).toBeNull();
    const card = findOpenCard(page);
    await card.waitFor();
    expect(await card.getAttribute("aria-label")).toBe("Ada");
    expect(await card.locator(".who-name").textContent()).toBe("Ada");
    const state = card.locator(".who-state");
    expect(await state.getByText("Assistant", { exact: true }).count()).toBe(1);
    expect(await state.getByText("working", { exact: true }).count()).toBe(1);
    expect(await readCardFact(card, "Room")).toBe("The Secretariat");
    expect(await readCardFact(card, "Runner")).toBe("studio");
    expect(await readCardFact(card, "Last active")).not.toBeNull();

    await card.getByRole("button", { name: /^Open conversation/ }).click();

    await findOpenDrawer(page).waitFor();
    expect(await readDrawerName(page)).toBe("Ada");
    expect(await row.getAttribute("aria-current")).toBe("page");
    await pressEscapeInDrawer(page);
    await card.waitFor();
    await page.keyboard.press("Escape");
    await card.waitFor({ state: "detached" });
    expect(await page.locator(".office").count()).toBe(1);
  });

  it("queues an assistant that waits on the user, and the waiting count selects it and shows its Request", async () => {
    const { url } = await arrangeSecretariat();
    const { page } = await openSignedIn(url);
    await openOffice(page);

    await page
      .getByRole("group", { name: "Who is doing what" })
      .getByRole("button", { name: "1 waiting on you" })
      .click();

    const card = findOpenCard(page);
    await card.waitFor();
    expect(await card.getAttribute("aria-label")).toBe("Basil");
    expect(
      await card.locator(".who-state").getByText("waiting on you", { exact: true }).count(),
    ).toBe(1);
    expect(await card.locator(".office-card-ask-h").textContent()).toMatch(/^Waiting on you · /);
    expect(await card.locator(".office-card-ask .next-of").textContent()).toBe("1 of 1");
    expect(await readCardFact(card, "Room")).toBe("The Secretariat");
  });

  it.skipIf(evidence === undefined)(
    "walks through the Secretariat for the evidence: the overview, the room, a card, the drawer and the queue",
    async () => {
      mkdirSync(evidence!, { recursive: true });
      const { url } = await arrangeSecretariat();
      const userDataDir = createUserDataDirForTest();
      writeSettings(userDataDir, {
        controllerUrl: url,
        window: { bounds: { x: 0, y: 0, width: 1440, height: 940 }, fullScreen: false },
      });
      const { app, page, close } = await launchForTest(
        userDataDir,
        async (application) => {
          await application.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900);
          });
        },
        { dir: evidence!, size: { width: 1440, height: 900 } },
      );
      onTestFinished(async () => {
        await close();
        const videoPath = page.video()?.path();
        if (videoPath !== undefined) console.log("Office journey recording:", await videoPath);
      });
      await signInAndReadToken(page, url);
      await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
      // The Office draws frames only while its window is on screen, and the
      // video records only frames that are drawn.
      await keepWindowOnTop(app);
      const capture = async (name: string) => {
        for (const theme of ["light", "dark"] as const) {
          await app.evaluate(({ nativeTheme }, chosen) => {
            nativeTheme.themeSource = chosen;
          }, theme);
          await page.waitForFunction(
            (dark) => matchMedia("(prefers-color-scheme: dark)").matches === dark,
            theme === "dark",
          );
          // The scene draws the new theme's light on its next frame.
          await sleep(THEME_SETTLE_MS);
          await page.screenshot({ path: join(evidence!, `${name}-${theme}.png`) });
        }
        await app.evaluate(({ nativeTheme }) => {
          nativeTheme.themeSource = "light";
        });
      };
      // The sidebar, with every assistant in its pose, before the Office opens.
      await expect.poll(() => readAssistantRows(page)).toEqual(SECRETARIAT_ROWS);
      await sleep(CAMERA_SETTLE_MS);

      await openOffice(page);
      await expect
        .poll(() => readPoseCounts(page))
        .toEqual(["1 working", "1 waiting on you", "2 idle"]);
      await sleep(CAMERA_SETTLE_MS);
      await capture("overview");

      const directory = await openRoomDirectory(page);
      await expect
        .poll(async () => (await readOfficeRooms(directory)).map((each) => each.room))
        .toContain("The Secretariat");
      await sleep(CAMERA_SETTLE_MS / 2);
      await directory.locator("button.line", { hasText: "The Secretariat" }).click();
      await findOfficePill(page)
        .getByRole("button", { name: "Room: The Secretariat", exact: true })
        .waitFor();
      await sleep(CAMERA_SETTLE_MS);
      await capture("secretariat");

      // A pass of the mouse over the room, for the video only: the colleague
      // under it is drawn in the scene, where the page cannot read it.
      const stage = await page.locator(".office-stage").boundingBox();
      await page.mouse.move(stage!.x + stage!.width * 0.4, stage!.y + stage!.height * 0.5, {
        steps: 20,
      });
      await page.mouse.move(stage!.x + stage!.width * 0.6, stage!.y + stage!.height * 0.5, {
        steps: 20,
      });
      await page
        .getByRole("group", { name: "Who is doing what" })
        .getByRole("button", { name: "1 working" })
        .click();
      const card = findOpenCard(page);
      await card.waitFor();
      expect(await card.getAttribute("aria-label")).toBe("Ada");
      expect(await readCardFact(card, "Room")).toBe("The Secretariat");
      await sleep(CAMERA_SETTLE_MS);
      await capture("card");

      await card.getByRole("button", { name: /^Open conversation/ }).click();
      await findOpenDrawer(page).waitFor();
      expect(await readDrawerName(page)).toBe("Ada");
      await sleep(CAMERA_SETTLE_MS);
      await capture("drawer");

      await pressEscapeInDrawer(page);
      await findOpenDrawer(page).waitFor({ state: "detached" });
      await card.waitFor();
      await page.keyboard.press("Escape");
      await card.waitFor({ state: "detached" });
      await sleep(CAMERA_SETTLE_MS / 2);

      await page
        .getByRole("group", { name: "Who is doing what" })
        .getByRole("button", { name: "1 waiting on you" })
        .click();
      await card.waitFor();
      expect(await card.getAttribute("aria-label")).toBe("Basil");
      expect(await card.locator(".office-card-ask .next-of").textContent()).toBe("1 of 1");
      await sleep(CAMERA_SETTLE_MS);
      await capture("waiting");
    },
    180_000,
  );
});
