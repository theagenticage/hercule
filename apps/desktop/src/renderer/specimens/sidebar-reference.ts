/**
 * Edits the sidebar of the Bureau book's session-active.html to show the
 * sidebar specimen's data, then marks the page ready. `pnpm compare:bureau`
 * imports this module into the book's page once crew.js has drawn the
 * sidebar, and compares the result with the app's sidebar (sidebar.tsx).
 *
 * First it stops every animation, so the waiting faces show the frame the
 * app draws, and it hides the traffic-light placeholders, where macOS draws
 * the real ones over the app's window. Then it makes exactly eight edits.
 * The first five are where the app shows what its data holds and the book
 * shows its own sample data; the last three are where the app's layout
 * departs from the book's:
 *
 * 1. removes the Assistants section: the sidebar fixture has no assistant,
 *    so the app draws none. The Threads | Hercule switch stays;
 * 2. removes "Ship release v2.15" from Waiting on you and sets the count to
 *    2: it is a run's session, and the sidebar fixture holds threads only.
 *    The app lists such a session under "From runs", which this comparison
 *    does not cover;
 * 3. sets the counts line to the fixture's counts, without "paused", which
 *    the app does not count;
 * 4. sets each waiting row's name to the thread's full title: a thread has
 *    one title, and the book's shorter names exist only in its sample data;
 * 5. sets each project row's status slot and second line to what the app
 *    draws for the fixture's thread. The slot holds a word, "Approval",
 *    "Question" or "Working", where the book draws a state mark, and keeps
 *    the book's age for an idle thread. The second line is the provider's
 *    mark and the thread's machine, where the book's is a branch and a
 *    machine: every fixture thread is in no workspace. While the thread
 *    waits on the user, the machine gives way to the open Request's
 *    question, in the colour of a question to the user;
 * 6. draws New thread, Search and the Office in one row, as the app's
 *    sidebar.css lays them out: the book draws New thread and Search as two
 *    rows and has no Office button. Search becomes a 30px icon button with
 *    the book's search icon, and the Office button follows it with the icon
 *    of the Office row in the book's Hercule tab;
 * 7. lays each project row out as the app's thread row, styled as
 *    sidebar.css styles `.side-thread`: two lines in a row 52px tall, the
 *    status slot at the end of the title's line, 2px between two rows where
 *    the book has 1px, and a working thread's row at 72% opacity. The book's
 *    rows are 35px, with the state mark beside both lines;
 * 8. puts "1 needs you" in the header of each project with a thread waiting
 *    on the user, styled as sidebar.css styles `.side-need`. The book's
 *    headers have no count.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { SPECIMEN_COUNTS, SPECIMEN_THREADS, STUDIO_MAC } from "./sidebar-fixture";
import { findElement, findElementByText } from "./book-page";
import { drawBookBrand, markSheetReady, readCrew, stillBookPage } from "./sheet-page";

/** Returns the text of the `.side-name` inside a sidebar row. Fails when the row has none. */
function readRowName(row: Element): string {
  return findElement(row, ".side-name").textContent;
}

/**
 * Returns the fixture's thread whose title is the name of the project row
 * `row`. Fails when the fixture has none.
 */
function findRowThread(row: Element): (typeof SPECIMEN_THREADS)[number] {
  const title = readRowName(row);
  const thread = SPECIMEN_THREADS.find((each) => each.title === title);
  if (thread === undefined) throw new Error(`The sidebar fixture has no thread "${title}".`);
  return thread;
}

/**
 * Returns the word the app's status slot shows for `thread`, or `null` when
 * it shows the thread's age: "Approval" or "Question" while a Request waits,
 * "Working" while the thread is busy.
 */
function readStatusWord(thread: (typeof SPECIMEN_THREADS)[number]): string | null {
  const request = thread.openRequests[0];
  if (request !== undefined) return request.kind === "question" ? "Question" : "Approval";
  return thread.status === "busy" ? "Working" : null;
}

/**
 * Returns the question the app's second line shows while `thread` waits, or
 * `null` when it waits on nothing: "Run git push?" for a command's approval,
 * a question's first line as asked. Fails for any other kind of Request,
 * which the sidebar fixture has none of.
 */
function readQuestionText(thread: (typeof SPECIMEN_THREADS)[number]): string | null {
  const request = thread.openRequests[0];
  if (request === undefined) return null;
  if (request.kind === "command_approval") return `Run ${request.detail.command}?`;
  if (request.kind === "question") return request.detail.questions[0].question;
  throw new Error(
    `The sidebar fixture holds a ${request.kind} Request, which this page cannot word.`,
  );
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

// 1. The Assistants section.
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

// 5. The status slot and the second line of each project row.
for (const row of side.querySelectorAll('[data-pane="threads"] .side-row')) {
  const thread = findRowThread(row);
  const end = findElement(row, ".side-end") as HTMLElement;
  const word = readStatusWord(thread);
  if (word !== null) {
    end.textContent = word;
    end.style.color = word === "Working" ? "var(--accent-ink)" : "var(--you-ink)";
    if (word !== "Working") end.style.fontWeight = "var(--w-bold)";
  }
  const glyph = document.createElement("span");
  Object.assign(glyph.style, {
    display: "inline-grid",
    placeItems: "center",
    flex: "none",
    width: "12px",
    height: "12px",
    marginRight: "6px",
  });
  glyph.append(drawBookBrand(thread.model.instanceId === "i-codex" ? "openai" : "claude", 12));
  const machine = document.createElement("span");
  Object.assign(machine.style, { overflow: "hidden", textOverflow: "ellipsis" });
  const question = readQuestionText(thread);
  machine.textContent = question ?? STUDIO_MAC.name;
  if (question !== null) machine.style.color = "var(--you-ink)";
  const detail = findElement(row, ".side-meta") as HTMLElement;
  detail.className = "side-detail";
  detail.replaceChildren(glyph, machine);
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

// 7. The two-line row.
for (const row of side.querySelectorAll<HTMLElement>('[data-pane="threads"] .side-row')) {
  const wrapper = document.createElement("div");
  wrapper.style.height = "52px";
  if (readStatusWord(findRowThread(row)) === "Working") wrapper.style.opacity = "0.72";
  // The book's section puts 1px between items; two rows get 2px.
  if (row.previousElementSibling?.matches(".side-thread") === true) wrapper.style.marginTop = "1px";
  row.replaceWith(wrapper);
  wrapper.className = "side-thread";
  wrapper.append(row);
  Object.assign(row.style, { height: "100%", minHeight: "0", padding: "6px 8px 6px 10px" });

  const text = findElement(row, ".side-text") as HTMLElement;
  Object.assign(text.style, { gap: "6px", lineHeight: "normal" });
  const line = document.createElement("span");
  Object.assign(line.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    height: "18px",
    fontSize: "var(--t-13)",
    lineHeight: "18px",
  });
  const name = findElement(text, ".side-name") as HTMLElement;
  Object.assign(name.style, { flex: "1", minWidth: "0" });
  const end = findElement(row, ".side-end") as HTMLElement;
  end.style.minWidth = "48px";
  name.replaceWith(line);
  line.append(name, end);

  Object.assign((findElement(text, ".side-detail") as HTMLElement).style, {
    display: "flex",
    alignItems: "center",
    height: "16px",
    minWidth: "0",
    color: "var(--faint)",
    fontSize: "var(--t-12)",
    lineHeight: "16px",
    whiteSpace: "nowrap",
  });
}

// 8. The count of waiting threads in a project's header.
for (const header of side.querySelectorAll('[data-pane="threads"] .side-h--proj')) {
  const rows = [...(header.parentElement?.querySelectorAll(".side-row") ?? [])];
  const waitingCount = rows.filter((row) => findRowThread(row).openRequests.length > 0).length;
  if (waitingCount === 0) continue;
  const need = document.createElement("span");
  need.className = "side-need";
  Object.assign(need.style, {
    flex: "none",
    color: "var(--you-ink)",
    fontSize: "var(--t-12)",
    fontWeight: "var(--w-medium)",
    fontVariantNumeric: "tabular-nums",
  });
  need.textContent = `${String(waitingCount)} ${waitingCount === 1 ? "needs" : "need"} you`;
  findElement(header, ".icon-btn").before(need);
}

await markSheetReady();
