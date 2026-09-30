/**
 * Tests Sign Out in the app menu (spec 17, §Auth and the token): the app
 * shows the sign-in screen, forgets the token, and the controller no longer
 * accepts it.
 *
 * The test starts the packaged test package against the compiled binary in a
 * scratch Hercule Home. Run `pnpm build:desktop` and `pnpm build:binary`
 * first.
 */
import type { ElectronApplication } from "playwright";
import { describe, expect, it } from "vitest";
import { readSettings } from "../../apps/desktop/scripts/packaged-app";
import {
  chooseMenuItem,
  launchWithSavedController,
  signInAndReadToken,
  startControllerForTest,
} from "./harness";

/** Checks whether the Sign Out item in the app menu is enabled. */
function isSignOutEnabled(app: ElectronApplication): Promise<boolean | undefined> {
  return app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("signOut")?.enabled);
}

/**
 * Reads the controller's own record at `controllerUrl` with `token`, and
 * returns the response's status: 200 while the token is valid, 401 once the
 * controller has revoked it.
 */
async function readControllerWithToken(controllerUrl: string, token: string): Promise<number> {
  const response = await fetch(`${controllerUrl}/api/v1/controller`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return response.status;
}

describe("Sign Out", () => {
  it("shows sign-in, forgets the token, and the controller refuses it afterwards", async () => {
    const controller = await startControllerForTest({ setUp: true });
    const { app, page, userDataDir } = await launchWithSavedController(controller.url);
    const token = await signInAndReadToken(page, controller.url);
    await page.getByRole("main").waitFor();
    await expect.poll(() => isSignOutEnabled(app)).toBe(true);
    expect(await readControllerWithToken(controller.url, token)).toBe(200);

    await chooseMenuItem(app, "Hercule", "Sign Out");

    // The sign-in screen shows once the controller has answered the logout.
    await page.getByRole("button", { name: "Sign in" }).waitFor();
    await expect.poll(() => readSettings(userDataDir)).not.toHaveProperty("token");
    expect(await readControllerWithToken(controller.url, token)).toBe(401);
    await expect.poll(() => isSignOutEnabled(app)).toBe(false);
  });
});
