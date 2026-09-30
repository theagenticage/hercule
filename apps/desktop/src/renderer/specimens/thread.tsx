/**
 * The thread specimen: the app's real shell with the Fix thread open, drawn
 * from the records in thread-fixture.ts. `pnpm compare:bureau` compares its
 * main pane pixel for pixel with the Bureau book's session-active.html,
 * edited by thread-reference.ts to show the same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { FIX_THREAD, THREAD_PAGE_RECORDS } from "./thread-fixture";
import { mountThreadSpecimen } from "./sidebar-page";
import { markSheetReady } from "./sheet-page";

await mountThreadSpecimen(THREAD_PAGE_RECORDS, FIX_THREAD);
await markSheetReady();
