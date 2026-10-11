/**
 * Stills the Bureau book's desktop/workflows.html in its table view, then
 * marks the page ready. `pnpm compare:bureau` imports this module into the
 * book's page once workflows.js has drawn it, and compares the workflow list
 * with the app's (workflows.tsx), whose fixture holds the book's workflows.
 *
 * It stops every animation, so Fix bug's stepped strip and the running marks
 * show the frame the app draws.
 */
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();

await markSheetReady();
