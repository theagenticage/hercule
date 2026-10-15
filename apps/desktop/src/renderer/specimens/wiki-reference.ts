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
 * - the code block's syntax colours are sample highlighting, and the app loads
 *   no highlighter, so its code blocks are plain.
 */
import { removeCodeHighlighting } from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
removeCodeHighlighting();
for (const when of document.querySelectorAll(".rev-when")) {
  if (when.textContent === "Yesterday") when.textContent = "Tue";
}
await markSheetReady();
