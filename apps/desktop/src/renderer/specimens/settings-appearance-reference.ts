/**
 * Edits the Bureau book's desktop/settings-appearance.html to show the rows
 * the app draws, then marks the page ready. `pnpm compare:bureau` imports
 * this module into the book's page once crew.js has drawn it, and compares
 * the main pane with the app's (settings-appearance.tsx).
 *
 * First it stops every animation, so the working faces show the frame the
 * app draws. Then it makes these edits, each where the app draws something
 * else than the book, for the reason given:
 *
 * 1. removes the Density and Text size rows: the app has neither setting
 *    yet, and each comes with its own ticket;
 * 2. removes the Start and motion section, which comes with its own ticket.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { findElement, findElementByText } from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";

/** Returns the `.set-row` whose label is `label`. */
function findRow(scope: ParentNode, label: string): HTMLElement {
  return findElementByText(scope, ".set-label b", label).closest(".set-row") as HTMLElement;
}

stillBookPage();

const body = findElement(document, ".set-body");

// 1. Density and Text size.
findRow(body, "Density").remove();
findRow(body, "Text size").remove();

// 2. Start and motion.
findElementByText(body, ".set-sec > h2", "Start and motion").parentElement!.remove();

await markSheetReady();
