/**
 * Tests the native notification of an urgent signal in the packaged app,
 * signed in to a real controller (spec 17 §Native behaviour): a signal about
 * an External Entity that turns urgent while the window is not focused shows
 * a notification, and a click on it shows the window with the Inbox open on
 * the signal's thing.
 *
 * Only a plugin's signal can be urgent, and only one about an External Entity
 * is notified. No plugin in the test binary can raise one offline, so the
 * things of the Inbox's invented world, each with an open signal, are written
 * into the scratch database while the controller is stopped
 * (`writeInboxWorld`, which the perf script and `inbox.test.ts` share). One
 * of those signals is raised to `urgent` the same way.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { isWindowVisible } from "../../apps/desktop/scripts/packaged-app";
import {
  buildInboxCard,
  INBOX_CARDS,
  writeInboxWorld,
} from "../../apps/desktop/scripts/perf-inbox.ts";
import {
  arrangeFleet,
  clickWaitingNotification,
  hideWindow,
  openSignedIn,
  readWaitingNotifications,
} from "./harness";

/** The thing of the world whose signal turns urgent. */
const URGENT_CARD = buildInboxCard(7);

/**
 * Opens the database of the stopped controller whose Hercule Home is `home`,
 * and calls `write` with it.
 */
function writeDatabase(home: string, write: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    write(database);
  } finally {
    database.close();
  }
}

describe("an urgent signal's notification", () => {
  it("notifies a signal that turns urgent while the window is not focused, and opens the Inbox on its thing when the notification is clicked", async () => {
    const arranged = await arrangeFleet();
    await arranged.restartController(() => writeDatabase(arranged.home, writeInboxWorld));
    const { app, page } = await openSignedIn(arranged.url);
    // The shell has read the open signals, none of them urgent, once the
    // Work segment counts the Inbox.
    await expect
      .poll(() =>
        page
          .getByRole("tablist", { name: "Sidebar" })
          .getByRole("tab", { name: /^Work/ })
          .getAttribute("aria-label"),
      )
      .toBe(`Work, ${String(INBOX_CARDS)} waiting`);
    await hideWindow(app);
    expect(await readWaitingNotifications(app)).toEqual([]);

    // The app reads the open signals again once it reconnects, and the list
    // then holds an urgent signal it has not seen.
    await arranged.restartController(() =>
      writeDatabase(arranged.home, (database) => {
        database
          .prepare("UPDATE signals SET priority = 'urgent' WHERE thread_ref = ?")
          .run(URGENT_CARD.ref);
      }),
    );

    await expect
      .poll(() => readWaitingNotifications(app))
      .toEqual([{ title: "GitHub", body: URGENT_CARD.title, state: "shown" }]);

    await clickWaitingNotification(app, 0);
    await expect.poll(() => isWindowVisible(app)).toBe(true);
    await page.locator(".ib").waitFor();
    await expect
      .poll(() =>
        page
          .getByLabel("The open thing")
          .locator(".ib-pane-title")
          .evaluate((element) => element.firstChild?.textContent?.trim()),
      )
      .toBe(URGENT_CARD.title);
  });
});
