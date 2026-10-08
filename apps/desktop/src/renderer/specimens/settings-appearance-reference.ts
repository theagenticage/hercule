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
 * 2. removes the Start and motion section, which comes with its own ticket;
 * 3. redraws Ada's face in every theme card without the cloche the book
 *    casts her with: the app's wardrobe has no cloche, so the app draws Ada
 *    with no accessory, in the same hue, shape and pose.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { findElement, findElementByText, findElements } from "./book-page";
import { markSheetReady, readCrew, stillBookPage } from "./sheet-page";

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

// 3. Ada without the cloche: one face in each of the five cards. crew.js
// draws a face with a given look only as a string of markup, so the face is
// parsed from it, as the reference sheet (reference.ts) parses its pieces.
const crew = readCrew();
for (const face of findElements(body, ".tp-row:nth-child(2) > svg", 5)) {
  const template = document.createElement("template");
  template.innerHTML = crew.face("Ada", {
    look: { hue: "iris", shape: "egg", acc: "none" },
    pose: "working",
    size: 20,
  });
  face.replaceWith(template.content);
}

await markSheetReady();
