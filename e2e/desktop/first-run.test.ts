/**
 * Tests the app's first run on a Mac with no saved controller (spec 17,
 * §First run), driven the way a user drives it: by the text on screen.
 *
 * - With nothing installed, the welcome offers Open the office.
 * - An install that fails shows its error line.
 * - On a runner Mac, the welcome offers only a way to another machine.
 * - Open the office starts Hercule, and a step put off and the step reached
 *   both survive a relaunch.
 * - A controller already set up, as the web app's setup does, gets the
 *   sign-in screen, never the account step.
 * - A controller on another machine is never offered an install or Open the
 *   office.
 *
 * Main never runs this Mac's own Hercule: each test writes a stand-in binary
 * with a scratch Hercule Home of its own (see `./stand-in-binary.ts`), and
 * checks which commands main ran it with. Run `pnpm build:desktop` and
 * `pnpm build:binary` first.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  buildStandInBinaryPath,
  signIn,
  writeSettings,
} from "../../apps/desktop/scripts/packaged-app";
import {
  completeSetup,
  findCompiledBinary,
  PASSWORD,
  startController,
  USERNAME,
} from "../../scripts/controller-process";
import { createTemporaryHome } from "../harness";
import { createUserDataDirForTest, launchForTest } from "./harness";
import { START_ERROR_LINE, writeStandInBinaryForTest } from "./stand-in-binary";

const INSTALL = "service install --json";

/** One step of the ladder at the top of the first run, as it reads on screen. */
interface Rung {
  readonly label: string;
  /** The step's number, or null when a mark stands in its place: the step is done or put off. */
  readonly number: string | null;
  readonly current: boolean;
}

/** Reads the ladder of steps at the top of the first run, from left to right. */
function readLadder(page: Page): Promise<Rung[]> {
  return page
    .getByRole("list", { name: "Steps" })
    .getByRole("listitem")
    .evaluateAll((items) =>
      items.map((item) => {
        const number = item.querySelector(".n")?.textContent ?? "";
        return {
          label: (item.textContent ?? "").slice(number.length),
          number: number === "" ? null : number,
          current: item.getAttribute("aria-current") === "step",
        };
      }),
    );
}

/**
 * Waits for `url` to answer the setup read, as it does once a controller is
 * listening there. Fails after 20 seconds.
 */
async function waitForAnswer(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/v1/setup`)).ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`nothing answered at ${url} within 20 seconds`);
    await sleep(100);
  }
}

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

describe("the first run on this Mac", () => {
  it("starts Hercule, and keeps a step put off and the step reached across a relaunch", async () => {
    const userDataDir = createUserDataDirForTest();
    const standIn = await writeStandInBinaryForTest(userDataDir, "serve");
    const first = await launchForTest(userDataDir);

    await first.page.getByRole("button", { name: "Open the office" }).click();
    // Main installs, waits for the controller to answer, saves its URL and
    // reloads the window.
    await first.page.getByRole("heading", { name: "Create your account" }).waitFor();
    expect(standIn.readCalls()).toContain(INSTALL);
    await first.page.getByLabel("Password").fill(PASSWORD);
    await first.page.getByRole("button", { name: "Create account" }).click();
    // The stand-in's controller finds no coding agent, so the providers step
    // can only be put off.
    await first.page.getByRole("button", { name: "Do this later" }).click();
    await first.page.getByRole("heading", { name: "Connect GitHub" }).waitFor();
    await first.close();

    const { page } = await launchForTest(userDataDir);

    await page.getByRole("heading", { name: "Connect GitHub" }).waitFor();
    expect(await readLadder(page)).toEqual([
      { label: "Account", number: null, current: false },
      { label: "Providers", number: null, current: false },
      { label: "GitHub", number: "3", current: true },
      { label: "Project", number: "4", current: false },
    ]);
  });

  it("opens on the sign-in screen when Hercule was set up elsewhere, such as in the web app", async () => {
    const userDataDir = createUserDataDirForTest();
    const standIn = await writeStandInBinaryForTest(userDataDir, "serve");
    // The controller starts the way main would start it, and is set up
    // through the CLI before the app ever runs.
    execFileSync(buildStandInBinaryPath(userDataDir), ["service", "install", "--json"]);
    await waitForAnswer(standIn.controllerUrl);
    const setup = await completeSetup({
      home: standIn.home,
      url: standIn.controllerUrl,
      binary: findCompiledBinary(),
    });
    expect(setup.code, setup.stderr).toBe(0);
    const installs = standIn.readCalls().filter((call) => call === INSTALL).length;

    const { page } = await launchForTest(userDataDir);

    await page.getByText(`Connected to ${standIn.controllerUrl}`).waitFor();
    expect(await page.getByRole("heading", { name: "Create your account" }).count()).toBe(0);
    await signIn(page, { username: USERNAME, password: PASSWORD });
    await page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
    expect(standIn.readCalls().filter((call) => call === INSTALL)).toHaveLength(installs);
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
