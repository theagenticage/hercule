/**
 * Tests Settings > Intake in the packaged app, signed in to a real
 * controller with two GitHub Connections, "work" and "personal" (spec 17
 * §Settings, Intake, and §Testing):
 *
 * - the Settings list's Intake row opens the section, which draws GitHub
 *   with a segment for all its Connections and one for each Connection;
 * - a signal kind switched off on the "work" segment shows "Off · this
 *   connection" and a Reset button, and the API agrees: the kind is off at
 *   the level `connection` on "work", while "personal" and the plugin's own
 *   level still have it on, and the other segments of the screen show it on;
 * - Reset brings the kind back to following the plugin: the line and the
 *   button go, and the API reads the kind on at the level `default` again.
 *
 * Creating a GitHub Connection asks api.github.com whether the token works,
 * which a test cannot reach. So, like `workspace-lifecycle.test.ts`, the test
 * writes the two Connection rows into the scratch database while the
 * controller is stopped, and starts it again. A Connection needs nothing
 * more to show its Intake settings, which the controller works out from the
 * plugin's declared kinds.
 *
 * With `HERCULE_SETTINGS_INTAKE_EVIDENCE=<dir>` set, one more test walks
 * through the section for a reviewer, at a pace a person can follow, in the
 * light theme Whitehaven and the dark theme Orient Express. It records a
 * video of itself at 1440 × 900 into `<dir>` and saves a screenshot of each
 * state it reaches beside the video. Without it, that test is skipped,
 * because the first test already checks every step it shows.
 *
 * The screenshot of a row highlighted by the link from a signal is not taken:
 * the link exists only on a signal raised from an event of a plugin, and
 * `hercule signal raise` cannot raise one.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Locator, Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import {
  arrangeFleet,
  createUserDataDirForTest,
  keepWindowOnTop,
  launchForTest,
  openSignedIn,
  signInAndReadToken,
  writeConnectionRows,
  type ArrangedFleet,
} from "./harness";

/** The id of the GitHub plugin, whose Intake settings the tests change. */
const GITHUB_PLUGIN_ID = "github";

/** The name Settings > Intake gives the segment that edits the plugin's own level. */
const ALL_CONNECTIONS = "All GitHub connections";

/** The ids and labels of the Connections the tests write, in the order the segments list them. */
const CONNECTIONS = [
  { id: "019a1234-5678-7000-8000-000000000001", label: "work" },
  { id: "019a1234-5678-7000-8000-000000000002", label: "personal" },
] as const;

const [WORK, PERSONAL] = CONNECTIONS;

/** What an Intake setting is, as the API reports it: whether it is on, and the level that says so. */
interface KindValue {
  readonly on: boolean;
  readonly level: "default" | "plugin" | "connection";
}

/** Starts a fleet whose controller holds the two GitHub Connections. */
async function arrangeGithubConnections(): Promise<ArrangedFleet> {
  const arranged = await arrangeFleet();
  await arranged.restartController(() => {
    writeConnectionRows(
      arranged.home,
      CONNECTIONS.map((connection) => ({ ...connection, status: "connected" })),
    );
  });
  return arranged;
}

/** Reads the value in effect of a signal kind, for one Connection or, with no id, for the whole plugin. */
async function readSignalKind(
  { client }: ArrangedFleet,
  kind: string,
  connectionId?: string,
): Promise<KindValue> {
  const { signalKinds } =
    connectionId === undefined
      ? (await client.plugin.read({ params: { id: GITHUB_PLUGIN_ID } })).intake
      : (await client.connection.read({ params: { id: connectionId } })).intake;
  const row = signalKinds.find((candidate) => candidate.kind === kind);
  expect(row, `no signal kind ${kind}`).toBeDefined();
  return { on: row!.on, level: row!.level };
}

/**
 * Returns the first two signal kinds GitHub declares, with their labels as
 * the section draws them. Both are on by default, which the test relies on.
 */
async function readSignalKindsToSwitch({ client }: ArrangedFleet) {
  const { signalKinds } = (await client.plugin.read({ params: { id: GITHUB_PLUGIN_ID } })).intake;
  expect(signalKinds.length).toBeGreaterThanOrEqual(2);
  const [first, second] = signalKinds;
  for (const row of [first!, second!]) {
    expect(row, `${row.kind} starts on, from the plugin's default`).toMatchObject({
      on: true,
      level: "default",
    });
  }
  return { first: first!, second: second! };
}

/** Returns GitHub's segmented control, the group of buttons that picks the level to edit. */
const findSegments = (page: Page): Locator =>
  page.getByRole("group", { name: "GitHub connections" });

/** Picks the segment named `name` and waits until it is the pressed one. */
async function pickSegment(page: Page, name: string): Promise<void> {
  const segment = findSegments(page).getByRole("button", { name, exact: true });
  await segment.click();
  await expect.poll(() => segment.getAttribute("aria-pressed")).toBe("true");
}

/** Returns the row whose switch is named `label`. */
const findRow = (page: Page, label: string): Locator =>
  page
    .locator(".intake-row")
    .filter({ has: page.getByRole("switch", { name: label, exact: true }) });

/** Returns the line under a row's label that says where its value comes from, or null when it has none. */
async function readSource(row: Locator): Promise<string | null> {
  const source = row.locator(".intake-source");
  return (await source.count()) === 0 ? null : source.textContent();
}

/** Returns whether the row's switch is on. */
async function readSwitch(row: Locator): Promise<boolean> {
  return (await row.getByRole("switch").getAttribute("aria-checked")) === "true";
}

/** Presses the row's switch and waits until it shows the opposite value. */
async function pressSwitch(row: Locator): Promise<void> {
  const before = await readSwitch(row);
  await row.getByRole("switch").click();
  await expect.poll(() => readSwitch(row)).toBe(!before);
}

/** Opens Settings from the sidebar's foot, then the section whose row in the Settings list is named `section`. */
async function openSection(page: Page, section: string): Promise<void> {
  const settings = page.locator(".side-foot").getByRole("link", { name: "Settings" });
  if ((await settings.getAttribute("aria-current")) !== "page") await settings.click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByText(section, { exact: true })
    .click();
  await expect.poll(() => page.locator(".bar .title").textContent()).toBe(section);
}

/** The folder the journey's video and screenshots are written to, when they are asked for. */
const evidence = process.env["HERCULE_SETTINGS_INTAKE_EVIDENCE"];

/** How long the journey waits after each step, so a reviewer can see what changed. */
const PAUSE_MS = 1200;

describe("Settings > Intake", () => {
  it("switches a signal kind off for one Connection, leaves the others on, and brings it back with Reset", async () => {
    const arranged = await arrangeGithubConnections();
    const { first } = await readSignalKindsToSwitch(arranged);
    const { page } = await openSignedIn(arranged.url);

    await openSection(page, "Intake");
    await expect
      .poll(() => findSegments(page).getByRole("button").allTextContents())
      .toEqual([ALL_CONNECTIONS, WORK.label, PERSONAL.label]);
    await expect(page.getByRole("heading", { level: 2, name: "GitHub" }).count()).resolves.toBe(1);

    // Switching the kind off on "work" is a choice of that Connection: the
    // row says so and offers to take it back.
    await pickSegment(page, WORK.label);
    const workRow = findRow(page, first.label);
    expect(await readSwitch(workRow)).toBe(true);
    expect(await readSource(workRow)).toBeNull();
    expect(await workRow.getByRole("button", { name: `Reset ${first.label}` }).count()).toBe(0);
    await pressSwitch(workRow);
    await expect.poll(() => readSource(workRow)).toBe("Off · this connection");
    await expect(
      workRow.getByRole("button", { name: `Reset ${first.label}` }).count(),
    ).resolves.toBe(1);
    await expect
      .poll(() => readSignalKind(arranged, first.kind, WORK.id))
      .toEqual({ on: false, level: "connection" });
    // The controller's own reading of the other levels did not change.
    expect(await readSignalKind(arranged, first.kind, PERSONAL.id)).toEqual({
      on: true,
      level: "default",
    });
    expect(await readSignalKind(arranged, first.kind)).toEqual({ on: true, level: "default" });

    // The other segments of the screen draw the kind on, with no line.
    for (const segment of [PERSONAL.label, ALL_CONNECTIONS]) {
      await pickSegment(page, segment);
      const row = findRow(page, first.label);
      expect(await readSwitch(row), segment).toBe(true);
      expect(await readSource(row), segment).toBeNull();
    }

    // Reset takes the choice back: the kind follows the plugin again.
    await pickSegment(page, WORK.label);
    await expect.poll(() => readSwitch(workRow)).toBe(false);
    await workRow.getByRole("button", { name: `Reset ${first.label}` }).click();
    await expect.poll(() => readSwitch(workRow)).toBe(true);
    expect(await readSource(workRow)).toBeNull();
    await expect
      .poll(() => workRow.getByRole("button", { name: `Reset ${first.label}` }).count())
      .toBe(0);
    await expect
      .poll(() => readSignalKind(arranged, first.kind, WORK.id))
      .toEqual({ on: true, level: "default" });
  });

  it.skipIf(evidence === undefined)(
    "walks through the section for the evidence: a Connection's choice, the plugin's, an event kind and Reset, in both themes",
    async () => {
      mkdirSync(evidence!, { recursive: true });
      const arranged = await arrangeGithubConnections();
      const { first, second } = await readSignalKindsToSwitch(arranged);
      const { eventKinds } = (
        await arranged.client.plugin.read({ params: { id: GITHUB_PLUGIN_ID } })
      ).intake;
      const eventKind = eventKinds[0]!;
      const userDataDir = createUserDataDirForTest();
      writeSettings(userDataDir, {
        controllerUrl: arranged.url,
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
        if (videoPath !== undefined) {
          console.log("Settings > Intake journey recording:", await videoPath);
        }
      });
      await signInAndReadToken(page, arranged.url);
      await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
      // The video records only frames that are drawn, and macOS draws none
      // for a window that another test's window covers.
      await keepWindowOnTop(app);

      /** Waits for a person to take the state in, then saves a screenshot of it. */
      const capture = async (name: string): Promise<void> => {
        await sleep(PAUSE_MS);
        await page.screenshot({ path: join(evidence!, `${name}.png`) });
      };
      /** Picks a theme in Appearance, then opens Intake again. */
      const switchTheme = async (theme: string): Promise<void> => {
        await openSection(page, "Appearance");
        await page.getByRole("button", { name: theme, exact: true }).click();
        await expect
          .poll(() =>
            page.getByRole("button", { name: theme, exact: true }).getAttribute("aria-pressed"),
          )
          .toBe("true");
        await sleep(PAUSE_MS / 2);
        await openSection(page, "Intake");
      };

      await switchTheme("Whitehaven light");
      await capture("01-whitehaven-all-github-connections");

      // The plugin's own choice: it shows what it is for every Connection.
      await pressSwitch(findRow(page, second.label));
      await expect
        .poll(() => readSource(findRow(page, second.label)))
        .toBe("Off · all GitHub connections");
      await capture("02-whitehaven-plugin-level-off");

      // A Connection follows the plugin until it makes a choice of its own.
      await pickSegment(page, WORK.label);
      await expect
        .poll(() => readSource(findRow(page, second.label)))
        .toBe("Off · all GitHub connections");
      await capture("03-whitehaven-work-follows-plugin");

      await pressSwitch(findRow(page, first.label));
      await expect.poll(() => readSource(findRow(page, first.label))).toBe("Off · this connection");
      await capture("04-whitehaven-work-connection-level-off");

      // An event kind, in the list triage reads from.
      const eventRow = findRow(page, eventKind.description);
      await eventRow.scrollIntoViewIfNeeded();
      await pressSwitch(eventRow);
      await expect.poll(() => readSource(eventRow)).toBe("Off · this connection");
      await capture("05-whitehaven-work-event-kind-off");

      await switchTheme("Orient Express dark");
      await pickSegment(page, WORK.label);
      await expect.poll(() => readSource(findRow(page, first.label))).toBe("Off · this connection");
      await capture("06-orient-express-work");
      await pickSegment(page, ALL_CONNECTIONS);
      await capture("07-orient-express-all-github-connections");

      // Reset on the row takes the Connection's choice back.
      await pickSegment(page, WORK.label);
      await findRow(page, first.label)
        .getByRole("button", { name: `Reset ${first.label}` })
        .click();
      await expect.poll(() => readSwitch(findRow(page, first.label))).toBe(true);
      await expect.poll(() => readSource(findRow(page, first.label))).toBeNull();
      await capture("08-orient-express-after-reset");
      await expect
        .poll(() => readSignalKind(arranged, first.kind, WORK.id))
        .toEqual({ on: true, level: "default" });
    },
  );
});
