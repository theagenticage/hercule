/**
 * The Discussions specimen: the app's real shell with Discussions open, its
 * list and its open Discussion built from the records of
 * discussions-fixture.ts. `capture:ui` captures it and `ui:metrics` measures
 * it. The page reads the same `?view=` as the Bureau book's page
 * (docs/design/crew-bureau-2/desktop/discussions.html):
 *
 * - `?view=table`, the default, shows the list as a table, with no Discussion
 *   open;
 * - `?view=split` opens "Edits overlap in src/cart/totals.ts" beside the
 *   list, drawn as a column;
 * - `?view=full` opens it across the whole pane.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first, and moves to the week the book's times are in:
// the app's age clock reads the time as soon as its module loads.
import "./fixed-clock";
import "./list-week-clock";
import { DISCUSSIONS_RECORDS } from "./discussions-fixture";
import { DISCUSSIONS_WIKI_RECORDS } from "./discussions-wiki-world";
import { mountDiscussionsSpecimen } from "./shell-page";
import { markSheetReady, readListView } from "./sheet-page";

await mountDiscussionsSpecimen(DISCUSSIONS_WIKI_RECORDS, DISCUSSIONS_RECORDS, readListView());
await markSheetReady();
