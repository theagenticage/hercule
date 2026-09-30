/**
 * Tests signing in to the desktop app (spec 17, §Auth and the token): a wrong
 * password, the token saved encrypted in the settings file, a relaunch that
 * stays signed in, and a new controller that drops the token.
 *
 * Each test starts the packaged test package, which encrypts with the mock
 * keychain's fixed key, so no test reads or writes the real Keychain. The
 * controller is the compiled binary in a scratch Hercule Home. Run
 * `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSettings, signIn } from "../../apps/desktop/scripts/packaged-app";
import { USERNAME } from "../../scripts/controller-process";
import {
  launchForTest,
  launchWithSavedController,
  readAlertText,
  signInAndReadToken,
  startControllerForTest,
  type PageGlobal,
} from "./harness";

describe("signing in", () => {
  it("says so when the password is wrong, and saves no token", async () => {
    const controller = await startControllerForTest({ setUp: true });
    const { page, userDataDir } = await launchWithSavedController(controller.url);

    await signIn(page, { username: USERNAME, password: "not the password" });

    expect(await readAlertText(page)).toBe("Wrong username or password.");
    expect(readSettings(userDataDir)).not.toHaveProperty("token");
  });

  it("saves the token encrypted, never as it is", async () => {
    const controller = await startControllerForTest({ setUp: true });
    const { page, userDataDir } = await launchWithSavedController(controller.url);

    const token = await signInAndReadToken(page, controller.url);
    await page.getByRole("main").waitFor();
    // The page saves the token without waiting for main.
    await expect.poll(() => readSettings(userDataDir)["token"]).toBeTypeOf("string");

    const file = readFileSync(join(userDataDir, "settings.json"), "utf8");
    expect(file).not.toContain(token);
    // The saved value is base64. Decoded, it must not hold the token either,
    // which rules out the token saved merely encoded.
    const saved = Buffer.from(readSettings(userDataDir)["token"] as string, "base64");
    expect(saved.toString("latin1")).not.toContain(token);
  });

  it("stays signed in after a relaunch", async () => {
    const controller = await startControllerForTest({ setUp: true });
    const first = await launchWithSavedController(controller.url);
    await signInAndReadToken(first.page, controller.url);
    await first.page.getByRole("main").waitFor();
    await expect.poll(() => readSettings(first.userDataDir)["token"]).toBeTypeOf("string");
    await first.close();

    const { page } = await launchForTest(first.userDataDir);

    await page.getByRole("main").waitFor();
    expect(await page.getByRole("button", { name: "Sign in" }).count()).toBe(0);
  });

  it("drops the token when a different controller is saved", async () => {
    const first = await startControllerForTest({ setUp: true });
    const second = await startControllerForTest({ setUp: true });
    const { page, userDataDir } = await launchWithSavedController(first.url);
    await signInAndReadToken(page, first.url);
    await page.getByRole("main").waitFor();
    await expect.poll(() => readSettings(userDataDir)["token"]).toBeTypeOf("string");

    // The save is not awaited in the page: main reloads the window once the
    // new controller is saved, which can end the page's script before the
    // reply arrives.
    await page.evaluate((url) => {
      void (globalThis as PageGlobal).bridge.controllerUrl.save(url);
    }, second.url);

    await page.getByText(`Connected to ${second.url}`).waitFor();
    const settings = readSettings(userDataDir);
    expect(settings["controllerUrl"]).toBe(second.url);
    expect(settings).not.toHaveProperty("token");
  });
});
