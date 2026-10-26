/**
 * Stills the Bureau book's desktop/discussions.html, then marks the page
 * ready. `pnpm compare:bureau` imports this module into the book's page and
 * compares the page with the app's (discussions.tsx), whose fixture holds the
 * book's Discussions and its open "Edits overlap in src/cart/totals.ts".
 *
 * Its times ("Mon", "Tue", "Sun") are the weekdays of the specimen's clock,
 * Wednesday 14 October (list-week-clock.ts), so they need no edit. The one
 * edit is the code block: the app draws it with a header row (the language and
 * the wrap and copy buttons) and without the book's syntax colours, which are
 * sample highlighting that the app, with no highlighter loaded, does not draw.
 */
import { drawCodeBlocksWithHeader } from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
drawCodeBlocksWithHeader("ts");
await markSheetReady();
