/**
 * The draft specimen: the app's real shell with a Draft Thread in webshop
 * open, drawn from the records in draft-fixture.ts. `pnpm compare:bureau`
 * compares its main pane pixel for pixel with the Bureau book's
 * session-empty.html, edited by draft-reference.ts to show the same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { DRAFT_PAGE_RECORDS, WEBSHOP_DRAFT } from "./draft-fixture";
import { mountDraftSpecimen } from "./sidebar-page";
import { markSheetReady } from "./sheet-page";

await mountDraftSpecimen(DRAFT_PAGE_RECORDS, WEBSHOP_DRAFT);
await markSheetReady();
