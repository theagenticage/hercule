/**
 * Edits the sidebar of the Bureau book's session-active.html to show the
 * sidebar specimen's data, then marks the page ready. `pnpm compare:bureau`
 * imports this module into the book's page once crew.js has drawn the
 * sidebar, and compares the result with the app's sidebar (sidebar.tsx).
 *
 * First it stops every animation, so the waiting faces show the frame the
 * app draws, and it hides the traffic-light placeholders, where macOS draws
 * the real ones over the app's window. Then it makes exactly five edits,
 * each where the app shows what its data holds and the book shows its own
 * sample data:
 *
 * 1. removes the Threads and Hercule tabs and the Assistants section, which
 *    v1 does not have (spec 17 §Scope);
 * 2. removes "Ship release v2.15" from Waiting on you and sets the count to
 *    2: it is a Run, and v1 lists threads only;
 * 3. sets the counts line to the fixture's counts, without "paused", which
 *    the app does not count;
 * 4. sets each waiting row's name to the thread's full title: a thread has
 *    one title, and the book's shorter names exist only in its sample data;
 * 5. sets each project row's second line to the name of the model the
 *    fixture gives the thread: v1's second line is the model, where the
 *    book's is a branch and a machine.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { SPECIMEN_COUNTS, SPECIMEN_THREADS } from "./sidebar-fixture";
import { findElement } from "./book-page";
import { markSheetReady, readCrew, stillBookPage } from "./sheet-page";

/** Returns the text of the `.side-name` inside a sidebar row. Fails when the row has none. */
function readRowName(row: Element): string {
  return findElement(row, ".side-name").textContent;
}

/** Returns a `b` element holding `count`, with the class `className` when one is given. */
function buildCount(count: number, className?: string): HTMLElement {
  const bold = document.createElement("b");
  bold.textContent = String(count);
  if (className !== undefined) bold.className = className;
  return bold;
}

stillBookPage();

const side = findElement(document, "aside.side");

// 1. The tabs and the Assistants section.
findElement(side, ".seg--side").remove();
const assistants = [...side.querySelectorAll(".side-sec")].find(
  (section) => section.querySelector(".side-h > span")?.textContent === "Assistants",
);
if (assistants === undefined) throw new Error("The book's sidebar has no Assistants section.");
assistants.remove();

// 2. The Run in Waiting on you, and the count.
const waiting = findElement(side, ".side-sec--you");
const waitingRows = [...waiting.querySelectorAll(".side-row--wait")];
const run = waitingRows.find((row) => readRowName(row) === "Ship release v2.15");
if (run === undefined) throw new Error('The book\'s Waiting on you has no "Ship release v2.15".');
run.remove();
findElement(waiting, ".count--you").textContent = String(SPECIMEN_COUNTS.waiting);

// 3. The counts line.
findElement(side, ".side-sum").replaceChildren(
  buildCount(SPECIMEN_COUNTS.working),
  " working · ",
  buildCount(SPECIMEN_COUNTS.waiting, "you-ink"),
  " waiting · ",
  buildCount(SPECIMEN_COUNTS.idle),
  " idle",
);

// 4. The full titles in Waiting on you.
const waitingItems = readCrew().WAITING;
for (const row of waiting.querySelectorAll(".side-row--wait")) {
  const name = findElement(row, ".side-name");
  const item = waitingItems.find(({ short }) => short === name.textContent);
  if (item === undefined) throw new Error(`crew.js lists no waiting item "${name.textContent}".`);
  name.textContent = item.name;
}

// 5. The model names on the project rows.
for (const row of side.querySelectorAll('[data-pane="threads"] .side-row')) {
  const title = readRowName(row);
  const thread = SPECIMEN_THREADS.find((each) => each.title === title);
  if (thread === undefined) throw new Error(`The sidebar fixture has no thread "${title}".`);
  findElement(row, ".side-meta").textContent = thread.model.name;
}

await markSheetReady();
