/**
 * Stills the Bureau book's desktop/wiki.html, then marks the page ready.
 * `pnpm compare:bureau` imports this module into the book's page and compares
 * the page with the app's (wiki.tsx), whose fixture holds the book's pages and
 * the open "Checkout architecture" with its seven revisions.
 *
 * It makes two edits:
 * - the book's History says "Yesterday" beside revision 6, and the app says
 *   the weekday, "Tue", as it does for every day within the last six that is
 *   not today. The book's list says "Tue" for the same day;
 * - the app draws the code block with a header row (the language and the wrap
 *   and copy buttons) and without the book's syntax colours, which are sample
 *   highlighting that the app, with no highlighter loaded, does not draw.
 */
import { drawCodeBlocksWithHeader } from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
drawCodeBlocksWithHeader("ts");
for (const when of document.querySelectorAll(".rev-when")) {
  if (when.textContent === "Yesterday") when.textContent = "Tue";
}
await markSheetReady();
