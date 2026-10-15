/**
 * The Wiki specimen: the app's real shell with the Wiki open, its list and
 * its open page built from the records of wiki-fixture.ts.
 * `pnpm compare:bureau` compares it with the book's page
 * (docs/design/crew-bureau-2/desktop/wiki.html), opening both with the same
 * parameters, which the page reads as the book's page does:
 *
 * - `?view=table`, the default, shows the list as a table, with no page open;
 * - `?view=split` opens "Checkout architecture" beside the list, drawn as a
 *   column;
 * - `?view=full` opens it across the whole pane;
 * - `&rev=4` opens the page as of its older revision 4.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first, and moves to the week the book's times are in:
// the app's age clock reads the time as soon as its module loads.
import "./fixed-clock";
import "./list-week-clock";
import { DISCUSSIONS_WIKI_RECORDS } from "./discussions-wiki-world";
import { WIKI_RECORDS } from "./wiki-fixture";
import { mountWikiSpecimen } from "./shell-page";
import { markSheetReady, readListView } from "./sheet-page";

/** Returns whether the page's `?rev=` asks for the older revision the fixture holds. Fails when it names another revision. */
function readOlderRevisionAsked(): boolean {
  const rev = new URLSearchParams(location.search).get("rev");
  if (rev === null) return false;
  if (Number(rev) !== WIKI_RECORDS.olderRevisionNumber) {
    throw new Error(
      `Unknown rev "${rev}" in the URL. The fixture holds revision ${WIKI_RECORDS.olderRevisionNumber}.`,
    );
  }
  return true;
}

await mountWikiSpecimen(
  DISCUSSIONS_WIKI_RECORDS,
  WIKI_RECORDS,
  readListView(),
  readOlderRevisionAsked(),
);
await markSheetReady();
