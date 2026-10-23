/**
 * Edits the sidebar of the Workbench, refined drawing's `?state=rows`
 * (docs/design/sidebar-directions/workbench-refined/desktop.html) to show the
 * sidebar rows specimen's data, then marks the page ready. `pnpm
 * compare:bureau` imports this module into the drawing's page once its
 * scripts have drawn the sidebar, and compares the result with the app's
 * sidebar (sidebar-rows.tsx).
 *
 * The drawing's page draws one row each for 1, 2, 3 and 10 Threads, and
 * nothing else of a real list. First it stops every animation, so the
 * waiting faces show the frame the app draws, and it hides the
 * traffic-light placeholders, where macOS draws the real ones over the app's
 * window. Then it makes exactly eight edits, where the app shows what its
 * data holds, or what the product decided, and the drawing does not:
 *
 * 1. removes the count on the Threads | Hercule switch: the specimen holds no
 *    signal, so the app draws none;
 * 2. removes the Assistants section: the specimen has no assistant;
 * 3. sets the counts line to the specimen's counts;
 * 4. gives each row a project heading in place of the drawing's caption
 *    ("One thread: today's row"), in the project the specimen puts the row
 *    in, in the order the app lists projects, with the markup the drawing's
 *    own list gives a project heading, and the name in the clipping span the
 *    app puts round it;
 * 5. writes the words of each question, and the counts line, as the several
 *    text nodes React writes them as: Chromium places the glyphs of a text
 *    in several nodes up to 1/64 px apart from those of the same text in
 *    one, which shows as differing pixels along the whole line;
 * 6. draws Waiting on you above the projects, as the drawing's list does
 *    whenever a Thread waits: the page leaves it out, because it draws only
 *    the four rows. Each row is named by its group's lead and shows the
 *    question the row's second line shows, and its face is the face the app
 *    gives the Thread that asks;
 * 7. makes the second line of the lone Thread's row say the machine only:
 *    the drawing's Thread works in a main workspace on another machine, and
 *    the specimen's works in no workspace, where the app shows the machine;
 * 8. writes "Done" on the hover button of a group's row, where the drawing
 *    writes "Finish": the product decided on Done for a group too.
 *
 * Besides the edits, the list is given a layer of its own, as the specimen
 * gives the app's (see "The rows' layer" in sidebar-rows.tsx).
 *
 * The drawing's rows also differ from the app's where a group has a pull
 * request: the drawing's second line shows it, and the app shows the branch.
 * No row of this state has one, so no edit covers it.
 */
import { pickProjectHue } from "@hercule/client-core";
import { buildLook } from "../faces/look";
import { findElement } from "./book-page";
import { drawBookFace, drawBookIcon, markSheetReady, stillBookPage } from "./sheet-page";
import { ROW_PROJECTS, ROWS_COUNTS, ROWS_RECORDS } from "./sidebar-rows-fixture";

/**
 * What the specimen holds of each of the drawing's four rows, in the order
 * the app lists them: the drawing's id for the row's lead, the project the
 * specimen puts the row in, and the id of the Thread that asks in the row,
 * or `null` when none does.
 */
const ROWS: ReadonlyArray<{
  readonly bench: string;
  readonly projectId: string;
  readonly askerId: string | null;
}> = [
  { bench: "tPayout", projectId: "p-reporting", askerId: "s-payout-check" },
  { bench: "t3ds", projectId: "p-webshop", askerId: "s-3ds-lead" },
  { bench: "tIdeal", projectId: "p-payments-api", askerId: null },
  { bench: "xLead", projectId: "p-billing", askerId: "s-result-review" },
];

/**
 * The book's three project tints, in the order the app gives them to
 * projects (`PROJECT_TINTS` in screens/project-tile.tsx, which a page without
 * React's refresh preamble cannot import).
 */
const PROJECT_TINTS = ["webshop", "payments", "ops"] as const;

/** Returns an element `tag` with the classes `className`, holding `children`. */
function buildElement(
  tag: string,
  className: string,
  ...children: ReadonlyArray<Node | string>
): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.append(...children);
  return element;
}

stillBookPage();

const side = findElement(document, "aside.side");
const list = findElement(side, ".side-scroll") as HTMLElement;
// See "The rows' layer" in sidebar-rows.tsx.
list.style.willChange = "transform";

// 1. The count on the switch.
findElement(side, ".seg--side .count").remove();

// 2. The Assistants section.
findElement(side, ".stage-assistants").remove();

// 3. The counts line.
const counts = [ROWS_COUNTS.working, ROWS_COUNTS.waiting, ROWS_COUNTS.idle];
findElement(side, ".side-sum")
  .querySelectorAll("b")
  .forEach((count, index) => {
    count.textContent = String(counts[index]);
  });

// 4. A project heading over each row, and the rows in the app's order.
const sections = ROWS.map(({ bench, projectId }) => {
  const section = findElement(list, `[data-bench="${bench}"]`).closest(".side-sec")!;
  const project = ROW_PROJECTS.find(({ id }) => id === projectId)!;
  const tint = pickProjectHue(projectId, ROW_PROJECTS, PROJECT_TINTS);
  const waiting = section.querySelectorAll(".b2-ask").length;
  // The app wraps a project's name in a span that clips it, so that a long name ends in an
  // ellipsis. The box also clips the tail of a letter such as "g" by a pixel.
  const name = buildElement("span", "", project.name);
  Object.assign(name.style, { overflow: "hidden", textOverflow: "ellipsis" });
  const plus = buildElement("button", "icon-btn icon-btn--sm", drawBookIcon("plus", 14));
  plus.title = `New thread in ${project.name}`;
  const heading = findElement(section, ".side-h");
  heading.className = "side-h side-h--proj";
  heading.replaceChildren(
    buildElement("span", `proj proj--${tint}`, name),
    ...(waiting > 0
      ? [
          buildElement(
            "span",
            "st-need",
            `${String(waiting)} ${waiting === 1 ? "needs" : "need"} you`,
          ),
        ]
      : []),
    plus,
  );
  return section;
});
list.replaceChildren(...sections);

// 5. The text nodes of the questions and of the counts line.
for (const asker of list.querySelectorAll(".b2-asker")) {
  // " asks · <question>" becomes " asks ·", " " and the question, as the app draws it.
  (asker.nextSibling as Text).splitText(" asks ·".length).splitText(1);
}
// " waiting · " becomes " " and "waiting · ".
(findElement(side, ".side-sum .you-ink").nextSibling as Text).splitText(1);

// 6. Waiting on you.
const askers = ROWS.flatMap(({ bench, askerId }) => {
  if (askerId === null) return [];
  const asker = ROWS_RECORDS.threads.find(({ id }) => id === askerId)!;
  const row = findElement(list, `[data-bench="${bench}"]`);
  return [
    {
      id: askerId,
      askedAt: asker.lastActivityAt,
      title: findElement(row, ".side-name").textContent,
      ask: findElement(row, ".b2-ask"),
    },
  ];
}).sort((a, b) => b.askedAt.localeCompare(a.askedAt));
list.prepend(
  buildElement(
    "section",
    "side-sec",
    buildElement(
      "h3",
      "side-h",
      buildElement("span", "", "Waiting on you"),
      buildElement("b", "count count--you", String(askers.length)),
    ),
    ...askers.map(({ id, title, ask }) => {
      const question = buildElement("span", "side-ask", ...ask.cloneNode(true).childNodes);
      const row = buildElement(
        "a",
        "side-row side-row--wait",
        drawBookFace(id, buildLook(id), "waiting", 24),
        buildElement("span", "side-text", buildElement("span", "side-name", title), question),
      );
      row.setAttribute("href", "#");
      return row;
    }),
  ),
);

// 7. The second line of the lone Thread's row.
const lone = findElement(list, '[data-bench="tIdeal"] .st-detail');
findElement(lone, ".st-clip").textContent = "studio-mac";
findElement(lone, ".st-keep").remove();

// 8. The hover button of a group's row.
for (const act of list.querySelectorAll(".has-crew .b2-act")) act.lastChild!.textContent = "Done";

await markSheetReady();
