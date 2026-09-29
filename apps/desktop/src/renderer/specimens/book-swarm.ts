/**
 * Stills the Bureau book's session-active.html, opened with `?state=swarm`,
 * and marks it ready to be captured. The swarm state is the book's only
 * drawing of "more" rows. `node scripts/capture-sidebar-states.ts` captures
 * it beside the sidebar states specimen, to compare the rows by eye.
 */
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
await markSheetReady();
