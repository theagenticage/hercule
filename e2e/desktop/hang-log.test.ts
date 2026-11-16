/**
 * Tests that a page that stops responding leaves a trace in main's log file
 * (spec 17, §Main's log): the screen it was on, the JavaScript it was
 * running, and how long it was stuck.
 *
 * Chromium's hang monitor does not run while a debugger is attached to the
 * page, and Playwright attaches one. So the test emits `unresponsive` and
 * `responsive` on the window's web contents itself, as Chromium does about
 * 15 seconds after an input event went unanswered. The rest is the app's
 * own: main's listener, Chromium reading the stack of the spinning page, which
 * it does only because the page opted in with its Document-Policy, and the
 * write to the log file.
 *
 * Run `pnpm build:desktop` first.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchForTest } from "./harness";

/** How long the page spins, in milliseconds: long enough for main to read its stack. */
const SPIN_MS = 4000;

/** Reads main's log file in `userDataDir`, or returns "" while it does not exist. */
const readMainLog = (userDataDir: string): string => {
  const file = join(userDataDir, "logs", "main.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

describe("main's log", () => {
  it("is not written by a launch and a quit where nothing went wrong", async () => {
    const { close, userDataDir } = await launchForTest();
    await close();
    expect(existsSync(join(userDataDir, "logs"))).toBe(false);
  });

  it("records the stack of a page that stopped responding, and when it responds again", async () => {
    const { app, page, userDataDir } = await launchForTest();

    // A named function, so the stack in the log can be told from any other.
    await page.evaluate((spinMs) => {
      setTimeout(function spinForTheHangLog() {
        const until = Date.now() + spinMs;
        while (Date.now() < until) {
          // Holds the page, as a render loop would.
        }
      }, 0);
    }, SPIN_MS);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.emit("unresponsive");
    });
    await expect
      .poll(() => readMainLog(userDataDir), { timeout: SPIN_MS + 5000 })
      .toMatch(
        /level=WARN .*stopped responding on \/\..*level=WARN .*was running this JavaScript.*at spinForTheHangLog/s,
      );

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.emit("responsive");
    });
    await expect
      .poll(() => readMainLog(userDataDir))
      .toMatch(/level=INFO .*The window's page responds again, \d+\.\d seconds after it stopped\./);
  });
});
