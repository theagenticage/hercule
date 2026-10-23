/**
 * Edits the header of the Workbench, refined drawing's `?state=stress` at
 * `?header=a` (docs/design/sidebar-directions/workbench-refined/desktop.html)
 * to show the thread header specimen's data, then marks the page ready. `pnpm
 * compare:bureau` imports this module into the drawing's page once its
 * scripts have drawn it, and compares the header of the main pane with the
 * app's (thread-header.tsx). With `?state=menu` the drawing opens the "+n"
 * menu, and so does the specimen; the comparison then covers the menu too.
 *
 * The drawing draws the ten Threads of one piece of work, with the lead open.
 * First it stops every animation, so the waiting mark shows the frame the app
 * draws, and it hides the traffic-light placeholders. Then it makes exactly
 * eight edits, where the app shows what the product decided and the drawing
 * does not:
 *
 * 1. hides what the transcript and the composer hold, which the pair does
 *    not compare: the specimen's thread has no transcript, and the header
 *    floats over whatever sits under it. Their own backgrounds stay, because
 *    they are the pane's;
 * 2. replaces the Duet button with the side pane's toggle: the drawing's
 *    Duet comes with its own ticket (#831), and the app's thread header has
 *    the toggle in the place the drawing's right-hand buttons start (#829);
 * 3. writes "Done" on the button the drawing calls "Finish": the product
 *    decided on one word, Done, for a group too (#828, #829);
 * 4. draws the header's tabs again: the drawing fits its tabs in the room
 *    the right-hand buttons leave, and edits 2 and 3 changed their width.
 *    The drawing does it itself whenever the window resizes, so the page is
 *    asked to resize;
 * 5. gives the work's name and the separator after it the markup and the
 *    style of the app's (see `addWorkNameStyle`): the slash is the name's
 *    first part, and the space after the name belongs to the separator.
 *    It runs after edit 4, so the drawing's own fit decides which tabs stay,
 *    with its own geometry. The slash, the text and the line land on the same
 *    pixels as in the drawing. The text is cut at 272px, as the drawing's
 *    name is cut at 280px with 8px of padding, or where the drawing's fit
 *    cuts it, when the room is short;
 * 6. in `?state=menu`, opens the "+n" menu again, because edit 4 closes it;
 * 7. gives the header's pills the Bureau book's glass, which the app draws
 *    (spec 17 §Design system): the drawing's stage restyles its pills with a
 *    flatter fill, a hairline and a smaller shadow (`.stage-main .top .pill`
 *    in shared/stage.css), for the drawing's own shell;
 * 8. in `?state=menu`, writes the menu's heading as "5 more", the count and
 *    one word, as the two text nodes React writes: the drawing's "5 more on
 *    this bench" uses "bench", which is not the product's word for a piece
 *    of work.
 *
 * The drawing's lead is called "lead", and the specimen's lead has that word
 * as its role (see thread-header-fixture.ts), so no edit covers the label.
 */
import {
  addWorkNameStyle,
  buildSidePaneTogglePill,
  buildWorkName,
  buildWorkNameSeparator,
  findElement,
} from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();

// In `?state=menu` the drawing opens its menu 60 ms after its fonts load, and that would replace
// the menu this module edits. Waiting for it to open first leaves this module the last to edit.
if (document.documentElement.dataset.state === "menu") {
  await document.fonts.ready;
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const main = findElement(document, "main.main");

// 1. The transcript and the composer.
const hide = document.createElement("style");
hide.textContent =
  "main.main > .transcript > *, main.main > .composer-wrap > * { visibility: hidden; }";
document.head.append(hide);

// 7. The pills' glass. The values are the book's `.pill` rule (system.css), which the
// stage's rule is more specific than.
const glass = document.createElement("style");
glass.textContent = `.stage-main .top .pill {
  background: var(--glass-fill);
  backdrop-filter: var(--glass-filter);
  box-shadow: inset 0 0 0 1px var(--glass-rim), inset 0 1px 0 var(--glass-edge), var(--glass-shadow);
}`;
document.head.append(glass);

// 2. Duet, replaced by the side pane's toggle.
findElement(main, '.b2-right a.pill-btn[title^="Seat two"]')
  .closest(".pill")!
  .replaceWith(buildSidePaneTogglePill());

// 3. Finish.
findElement(main, ".b2-right [data-finish]").lastChild!.textContent = "Done";

// 4. The fit of the tabs.
window.dispatchEvent(new Event("resize"));

// 5. The work's name and the separator.
addWorkNameStyle();
const name = findElement(main, ".b2-bench-name");
const separator = findElement(main, ".b2-sep");
const appName = buildWorkName(name.textContent);
appName.title = name.getAttribute("title") ?? "";
// When the room is short, the drawing's fit cuts its name with an inline `max-width`, 8px of
// which are the name's padding. The text takes the rest.
const cut = Number.parseFloat((name as HTMLElement).style.maxWidth);
if (!Number.isNaN(cut)) {
  (findElement(appName, ".work-name-text") as HTMLElement).style.maxWidth = `${String(cut - 8)}px`;
}
name.replaceWith(appName);
separator.replaceWith(buildWorkNameSeparator());

// 6. The menu, and 8. its heading.
if (document.documentElement.dataset.state === "menu") {
  findElement(main, "[data-menu-btn]:not([hidden])").dispatchEvent(new MouseEvent("click"));
  const heading = findElement(main, ".b2-menu-h");
  // The count and the word are two text nodes, as React writes them: Chromium places the glyphs
  // of a text in several nodes up to 1/64 px apart from those of the same text in one.
  heading.replaceChildren(heading.textContent.split(" ")[0]!, " more");
}

await markSheetReady();
