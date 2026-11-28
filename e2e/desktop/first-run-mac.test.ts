/**
 * Tests the app's first run on a Mac that starts Hercule itself (spec 17,
 * §First run), driven the way a user drives it: by the text on screen.
 *
 * - Open the office starts Hercule, and a step put off and the step reached
 *   both survive a relaunch.
 * - The providers step is "Add an account": it opens the add-account sheet,
 *   shows the provider's refusal of a key it cannot accept, and can still be
 *   put off.
 * - A controller already set up, as the web app's setup does, gets the
 *   sign-in screen, never the account step.
 *
 * Main never runs this Mac's own Hercule: each test writes a stand-in binary
 * with a scratch Hercule Home of its own (see `./stand-in-binary.ts`), and
 * checks which commands main ran it with. Run `pnpm build:desktop` and
 * `pnpm build:binary` first.
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildStandInBinaryPath, signIn } from "../../apps/desktop/scripts/packaged-app";
import {
  completeSetup,
  findCompiledBinary,
  PASSWORD,
  USERNAME,
} from "../../scripts/controller-process";
import { startHttpsStandIn } from "../https-stand-in";
import { createUserDataDirForTest, launchForTest } from "./harness";
import { writeStandInBinaryForTest } from "./stand-in-binary";
import { INSTALL } from "./first-run-helpers";

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

  it("asks to add an account on the providers step, and shows why a key was refused", async () => {
    // Z.ai answers a key it does not know with 401 and its own words.
    const standIn = await startHttpsStandIn({
      host: "api.z.ai",
      answer: () => ({ status: 401, json: { error: { message: "Invalid API key" } } }),
    });
    onTestFinished(standIn.stop);
    const userDataDir = createUserDataDirForTest();
    await writeStandInBinaryForTest(userDataDir, "serve", {
      controllerEnv: standIn.controllerEnv,
    });
    const { page } = await launchForTest(userDataDir);

    await page.getByRole("button", { name: "Open the office" }).click();
    await page.getByRole("heading", { name: "Create your account" }).waitFor();
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();

    // A fresh controller has no account. The ladder keeps the step's name.
    await page.getByRole("heading", { name: "Add an account", exact: true }).waitFor();
    expect((await readLadder(page)).map(({ label, current }) => [label, current])).toEqual([
      ["Account", false],
      ["Providers", true],
      ["GitHub", false],
      ["Project", false],
    ]);
    expect(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled()).toBe(
      true,
    );

    await page.getByRole("button", { name: "Add an account", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add an account", exact: true })
      .getByRole("button", { name: "Z.ai" })
      .click();
    const sheet = page.getByRole("dialog", { name: "Add Z.ai", exact: true });
    await sheet.getByLabel("API key", { exact: true }).fill("e2e-key-the-provider-refuses");
    await sheet.getByRole("button", { name: "Done", exact: true }).click();

    // The message is the provider's own words. The test has no key a provider accepts.
    const refusal = sheet.getByRole("alert");
    await refusal.waitFor();
    expect((await refusal.textContent())?.trim()).toBe("Invalid API key");
    expect(await sheet.getByLabel("API key", { exact: true }).inputValue()).toBe(
      "e2e-key-the-provider-refuses",
    );
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await sheet.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Do this later", exact: true }).waitFor();
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
