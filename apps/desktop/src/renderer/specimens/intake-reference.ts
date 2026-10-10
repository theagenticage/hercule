/**
 * Opens Marta's review request on the Intake design's page
 * (docs/design/intake-directions/asks/desktop/intake.html), then marks the
 * page ready. `pnpm compare:bureau` imports this module into the design's
 * page once asks.js has drawn it, and compares the main pane with the
 * Intake specimen's first scene (intake.tsx).
 *
 * The design's asks are the fixture's (intake-fixture.ts), so this module
 * edits no data. It:
 *
 * 1. stops every animation and transition, so the list and the pane show
 *    where they end;
 * 2. hides the prototype's switcher bar, which the app does not have;
 * 3. clicks the review row, as the user would, because the design opens
 *    Slack's ask at first and reads `?ask=` only as it loads, while the
 *    comparison opens both pages with the same address;
 * 4. removes what the design draws ahead of the app, listed below.
 *
 * It fails when the design has no review row, because the design has changed
 * and the comparison would no longer compare what it claims to.
 */
import { findElement, findElementByText } from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
const style = document.createElement("style");
style.textContent = "* { transition: none !important; }";
document.head.append(style);

document.documentElement.setAttribute("data-bar-off", "");
(findElement(document, '[data-asks-list] .ask-row[data-id="review"]') as HTMLElement).click();

// The design draws parts that later tickets build, so they are removed here,
// after the click, because the click redraws the list and the pane:
// - the views over the list (To do, Later, Done, Everything);
// - the hourly triage: its tab, its section and its line in the header;
// - the "waiting" label under an asker's age;
// - the count of asks cleared today;
// - the Snooze… and Stop asking answers;
// - the fine print under an answer, the provider and account it acts as,
//   which a signal's action does not carry;
// - the pane's foot: when the signal leaves the list, and what raised it.
findElement(document, "[data-asks-head]").remove();
findElement(document, "[data-asks-triage]").replaceChildren();
findElement(document, '[data-asks-tabs] [data-filter="triage"]').remove();
const triageHeading = findElement(document, '[data-flip="sec-triage"]');
triageHeading.nextElementSibling?.remove();
triageHeading.remove();
for (const label of document.querySelectorAll(".ask-waiting")) label.remove();
findElement(document, ".asks-cleared").remove();
for (const label of ["Snooze…", "Stop asking"]) {
  findElementByText(document, ".asks-detail .ans .btn", label).closest(".ans")?.remove();
}
for (const fine of document.querySelectorAll(".asks-detail .ad-fine")) fine.remove();
findElement(document, ".asks-detail .ad-foot").remove();

// The design shows when Sentry's alert fired, 08:52, where every other row
// shows its age. Spec 17 gives every row its age, so the alert's row shows
// it here too: the fixture raised the alert 2 hours and 49 minutes ago.
findElement(document, '.ask-row[data-id="alert"] .ask-age').textContent = "2h";

// The All tab counts the triage findings removed above, so it counts only
// the rows that are left.
findElement(document, '[data-asks-tabs] [data-filter="all"] small').textContent = String(
  document.querySelectorAll("[data-asks-list] .ask-row").length,
);

// The design's clock stands at 11:20 and every specimen's at 09:41 (UTC), so
// Marta's message, sent 2 hours and 23 minutes before, shows 07:18 in the app.
findElement(document, ".asks-detail .b-msg-head time").textContent = "07:18";

await markSheetReady();
