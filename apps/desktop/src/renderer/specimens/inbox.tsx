/**
 * The Inbox specimen: the app's real shell with the Inbox open, drawn from the
 * invented Northwind Market Inbox of inbox-fixture.ts, with the toolbar's
 * defaults. `capture:ui` captures it and `ui:metrics` measures it. The page
 * takes its theme from `?theme=` and its glass from `?glass=`, as every
 * specimen does.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { INBOX, INBOX_SIDEBAR_RECORDS } from "./inbox-fixture";
import { mountInboxSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

await mountInboxSpecimen(INBOX_SIDEBAR_RECORDS, INBOX);
await markSheetReady();
