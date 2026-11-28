/**
 * Tests the app's first run with no saved controller (spec 17, §First run),
 * driven the way a user drives it: by the text on screen. `first-run-mac.test.ts`
 * tests the run on a Mac that starts Hercule itself.
 *
 * - With nothing installed, the welcome offers Open the office.
 * - An install that fails shows its error line.
 * - On a runner Mac, the welcome offers only a way to another machine.
 * - A controller on another machine is never offered an install or Open the
 *   office.
 *
 * Main never runs this Mac's own Hercule: each test writes a stand-in binary
 * with a scratch Hercule Home of its own (see `./stand-in-binary.ts`), and
 * checks which commands main ran it with. Run `pnpm build:desktop` and
 * `pnpm build:binary` first.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import { findCompiledBinary, startController } from "../../scripts/controller-process";
import { createTemporaryHome } from "../harness";
import { createUserDataDirForTest, launchForTest } from "./harness";
import { START_ERROR_LINE, writeStandInBinaryForTest } from "./stand-in-binary";
import { INSTALL } from "./first-run-helpers";

describe("the first run's welcome", () => {
  it("offers Open the office when Hercule is not installed, and installs nothing by itself", async () => {
    const userDataDir = createUserDataDirForTest();
    const standIn = await writeStandInBinaryForTest(userDataDir, "fresh");
    const { page } = await launchForTest(userDataDir);

    await page.getByText("Hercule will run on this Mac").waitFor();
    expect(await page.getByRole("button", { name: "Open the office" }).isEnabled()).toBe(true);
    expect(standIn.readCalls()).toContain("service status --json");
    expect(standIn.readCalls()).not.toContain(INSTALL);
  });

  it("shows the install's error line when Hercule does not start", async () => {
    const userDataDir = createUserDataDirForTest();
    const standIn = await writeStandInBinaryForTest(userDataDir, "start-error");
    const { page } = await launchForTest(userDataDir);

    await page.getByRole("button", { name: "Open the office" }).click();

    await page.getByRole("heading", { name: "Hercule didn’t start" }).waitFor();
    await page.getByText(START_ERROR_LINE).waitFor();
    await page.getByRole("button", { name: "Try again" }).waitFor();
    expect(standIn.readCalls()).toContain(INSTALL);
  });

  it("offers a runner Mac only a way to Hercule on another machine", async () => {
    const userDataDir = createUserDataDirForTest();
    const standIn = await writeStandInBinaryForTest(userDataDir, "runner");
    const { page } = await launchForTest(userDataDir);

    await page.getByRole("heading", { name: "This Mac is a runner" }).waitFor();
    await page.getByText("Hercule’s runner is running on this Mac").waitFor();
    expect(await page.getByRole("button", { name: "Open the office" }).count()).toBe(0);

    await page.getByRole("button", { name: "Connect to it" }).click();
    await page.getByRole("heading", { name: "Connect to Hercule on another machine" }).waitFor();
    expect(await page.getByRole("button", { name: "Use this Mac" }).count()).toBe(0);
    expect(standIn.readCalls()).not.toContain(INSTALL);
  });
});

describe("the first run on a controller on another machine", () => {
  it("asks for the setup address, and never offers an install or Open the office", async () => {
    const { home, remove } = createTemporaryHome();
    onTestFinished(remove);
    const controller = await startController({ home, binary: findCompiledBinary() });
    onTestFinished(async () => {
      await controller.stop();
    });
    // Chromium and Node reach any `*.localhost` name on this machine, but
    // the app counts only `localhost` and loopback addresses as this Mac, so
    // the controller passes for one on another machine.
    const remoteUrl = `http://hercule-e2e.localhost:${String(controller.port)}`;
    const userDataDir = createUserDataDirForTest();
    writeSettings(userDataDir, { controllerUrl: remoteUrl });
    const standIn = await writeStandInBinaryForTest(userDataDir, "fresh");
    const { page } = await launchForTest(userDataDir);

    await page.getByRole("heading", { name: "Connect to Hercule on another machine" }).waitFor();
    await page.getByText(`isn’t set up yet`).waitFor();
    expect(await page.getByRole("button", { name: "Use this Mac" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Open the office" }).count()).toBe(0);

    const setupUrl = new URL(readFileSync(join(home, "setup-url"), "utf8").trim());
    setupUrl.host = new URL(remoteUrl).host;
    await page.getByRole("textbox", { name: "Address", exact: true }).fill(setupUrl.href);
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("heading", { name: "Create your account" }).waitFor();
    expect(await page.getByRole("button", { name: "Open the office" }).count()).toBe(0);
    expect(standIn.readCalls()).not.toContain(INSTALL);
  });
});
