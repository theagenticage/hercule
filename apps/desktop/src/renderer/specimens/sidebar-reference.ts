/**
 * Edits the sidebar of the Bureau book's session-active.html to show the
 * sidebar specimen's data, then marks the page ready. `pnpm compare:bureau`
 * imports this module into the book's page once crew.js has drawn the
 * sidebar, and compares the result with the app's sidebar (sidebar.tsx).
 *
 * First it stops every animation, so the waiting faces show the frame the
 * app draws, and it hides the traffic-light placeholders, where macOS draws
 * the real ones over the app's window. Then it makes exactly seven edits.
 * The first five are where the app shows what its data holds and the book
 * shows its own sample data; the last two are where the app's layout departs
 * from the book's:
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
 *    book's is a branch and a machine;
 * 6. draws New thread, Search and the Office in one row, as the app's
 *    sidebar.css lays them out: the book draws New thread and Search as two
 *    rows and has no Office button. Search becomes a 30px icon button with
 *    the book's search icon, and the Office button follows it with the icon
 *    of the Office row in the book's Hercule tab;
 * 7. gives each project row a third line, the thread's workspace, "No
 *    workspace" for every fixture thread, styled as sidebar.css styles
 *    `.side-ws-line`, and makes the row 59px tall, as `ITEM_HEIGHTS` in
 *    sidebar-items.ts has it: the book's rows have two lines.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { SPECIMEN_COUNTS, SPECIMEN_THREADS } from "./sidebar-fixture";
import { findElement, findElementByText } from "./book-page";
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

// 6. The actions row.
const actions = findElement(side, ".side-actions") as HTMLElement;
const searchRow = findElementByText(actions, ".nav-row", "Search⌘K");
const search = document.createElement("button");
search.className = "icon-btn";
search.title = "Search ⌘K";
search.append(findElement(searchRow, "svg"));
const office = document.createElement("a");
office.className = "icon-btn";
office.title = "Office ⌘⇧O";
// The Office row of the book's Hercule tab, which the sidebar keeps but hides, holds the icon.
office.append(findElement(side, '[data-pane="hercule"] a[href="office.html"] > svg'));
searchRow.replaceWith(search, office);
Object.assign(actions.style, { flexDirection: "row", alignItems: "center", gap: "2px" });
Object.assign((findElement(actions, ".nav-row") as HTMLElement).style, {
  flex: "1",
  minWidth: "0",
});
for (const button of [search, office])
  Object.assign(button.style, { width: "30px", height: "30px" });

// 7. The workspace line under each project row.
for (const row of side.querySelectorAll<HTMLElement>('[data-pane="threads"] .side-row')) {
  const line = document.createElement("span");
  Object.assign(line.style, {
    display: "flex",
    minWidth: "0",
    color: "var(--faint)",
    fontSize: "var(--t-12)",
    whiteSpace: "nowrap",
  });
  const clip = document.createElement("span");
  Object.assign(clip.style, { overflow: "hidden", textOverflow: "ellipsis" });
  clip.textContent = "No workspace";
  line.append(clip);
  findElement(row, ".side-text").append(line);
  row.style.height = "59px";
}

await markSheetReady();
