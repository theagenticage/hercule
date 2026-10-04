/**
 * The draft specimen: the app's real shell with a Draft Thread in webshop
 * open, drawn from the records in draft-fixture.ts. `pnpm compare:bureau`
 * compares its main pane pixel for pixel with the Bureau book's
 * session-empty.html, edited by draft-reference.ts to show the same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`,
 * and the book's state from `?state=first` or `?state=first-no-repo`, see
 * `chooseDraftFixture`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { chooseDraftFixture } from "./draft-fixture";
import { mountDraftSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

const { records, draft } = chooseDraftFixture(new URLSearchParams(location.search).get("state"));
await mountDraftSpecimen(records, draft);
await markSheetReady();
