/**
 * Stills the Bureau book's desktop/discussions.html, then marks the page
 * ready. `pnpm compare:bureau` imports this module into the book's page and
 * compares the page with the app's (discussions.tsx), whose fixture holds the
 * book's Discussions and its open "Edits overlap in src/cart/totals.ts".
 *
 * Its times ("Mon", "Tue", "Sun") are the weekdays of the specimen's clock,
 * Wednesday 14 October (list-week-clock.ts), so they need no edit. The one
 * edit is the code block's syntax colours: they are sample highlighting, and
 * the app loads no highlighter, so its code blocks are plain.
 */
import { removeCodeHighlighting } from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
removeCodeHighlighting();
await markSheetReady();
