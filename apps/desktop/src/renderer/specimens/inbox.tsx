/**
 * The Inbox specimen: the app's real shell with the Inbox open, drawn from the
 * invented Northwind Market Inbox of inbox-fixture.ts, with the toolbar's
 * defaults. `capture:ui` captures it and `ui:metrics` measures it. The page
 * takes its theme from `?theme=` and its glass from `?glass=`, as every
 * specimen does. With `?open` in the address, the card of the first Tidewatch
 * ticket is open in its sheet, with its timeline, its answers and its links.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { INBOX, INBOX_OPEN_CARD, INBOX_OPEN_CARD_ID, INBOX_SIDEBAR_RECORDS } from "./inbox-fixture";
import { mountInboxSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

if (new URLSearchParams(location.search).has("open")) {
  await mountInboxSpecimen(INBOX_SIDEBAR_RECORDS, INBOX, INBOX_OPEN_CARD);
  await openCard(INBOX_OPEN_CARD_ID);
} else {
  await mountInboxSpecimen(INBOX_SIDEBAR_RECORDS, INBOX);
}
await markSheetReady();

/**
 * Presses the row of the card `id`, as a click would, and resolves once its
 * sheet shows the timeline and nothing on the sheet moves. Fails when the row
 * is not on the page or the sheet does not come to rest within ten seconds.
 */
async function openCard(id: string): Promise<void> {
  const row = document.querySelector<HTMLElement>(`.inbox-row[data-card-id="${id}"]`);
  if (row === null) throw new Error(`The Inbox draws no row for the card ${id}.`);
  row.click();
  const isAtRest = (): boolean =>
    document.querySelector(".open-card .open-card-timeline") !== null &&
    document.querySelector(".open-card-answers") !== null &&
    document.querySelector(".opening-layer.is-moving") === null;
  const deadline = Date.now() + 10_000;
  while (!isAtRest()) {
    if (Date.now() > deadline) throw new Error("The open card did not come to rest.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
