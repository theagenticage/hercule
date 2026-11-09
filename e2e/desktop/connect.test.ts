/**
 * Tests connecting the desktop app to a controller (spec 17, §Reaching the
 * controller): main's connect check and what it does with a controller, and the
 * connect screen the app opens on when the saved controller is down.
 * `connect-refusals.test.ts` tests the addresses that are not a usable
 * controller. An app with no saved controller opens on the first run's welcome,
 * so the tests connect through the first run's remote screen, which runs the
 * same check.
 *
 * Each test starts the packaged test package with a fresh user data
 * directory. A controller is the compiled binary in a scratch Hercule Home;
 * the servers that are not controllers are loopback servers in the test. Run
 * `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { readSettings, signIn } from "../../apps/desktop/scripts/packaged-app";
import { PASSWORD, USERNAME } from "../../scripts/controller-process";
import {
  connectTo,
  launchForTest,
  readAlertText,
  recordExternalOpens,
  startControllerForTest,
} from "./harness";

describe("the connect screen", () => {
  it("saves a controller that passes the check, and the app goes on to sign in", async () => {
    const controller = await startControllerForTest({ setUp: true });
    const { page, userDataDir } = await launchForTest();

    await connectTo(page, controller.url);
    // Main saves the URL and reloads the window. With no token, the app then
    // shows the sign-in screen for that controller.
    await page.getByText(`Connected to ${controller.url}`).waitFor();
    expect(readSettings(userDataDir)["controllerUrl"]).toBe(controller.url);

    await signIn(page, { username: USERNAME, password: PASSWORD });
    await page.getByRole("main").waitFor();
  });

  it("saves a controller that is not set up, and opens no browser", async () => {
    const controller = await startControllerForTest({ setUp: false });
    const { app, page, userDataDir } = await launchForTest();
    const readOpened = await recordExternalOpens(app);

    await connectTo(page, controller.url);

    // The app sets the controller up in its first run, so main saves it and
    // reloads the window. Which screen the reloaded window shows is the first
    // run's to test.
    await expect.poll(() => readSettings(userDataDir)["controllerUrl"]).toBe(controller.url);
    expect(await readOpened()).toEqual([]);
  });

  it("is where a signed-in app opens when its controller is down, saying so", async () => {
    const controller = await startControllerForTest({ setUp: true });
    const first = await launchForTest();
    await connectTo(first.page, controller.url);
    await signIn(first.page, { username: USERNAME, password: PASSWORD });
    await first.page.getByRole("main").waitFor();
    // The page saves the token without waiting for main, so the test waits
    // for the file: without a token the relaunch would not be signed in.
    await expect.poll(() => readSettings(first.userDataDir)["token"]).toBeTypeOf("string");
    await first.close();
    await controller.stop();

    const { page } = await launchForTest(first.userDataDir);

    expect(await readAlertText(page)).toBe(
      `Could not reach ${controller.url}. Check that the controller is running.`,
    );
    expect(await page.getByRole("textbox", { name: "Controller address" }).inputValue()).toBe(
      controller.url,
    );
  });
});
