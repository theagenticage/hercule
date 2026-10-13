/**
 * Edits the Bureau book's desktop/settings-connections.html to show the
 * Settings > Connections specimen's data, then marks the page ready.
 * `pnpm compare:bureau` imports this module into the book's page once
 * crew.js has drawn it, and compares the main pane with the app's
 * (settings-connections.tsx).
 *
 * First it stops every animation. Then it makes these edits, each where the
 * app draws something else than the book, for the reason given:
 *
 * 1. removes the stats strip above the table: the counts and the triage
 *    note come with their own ticket;
 * 2. removes the Default Topic, Last 24 hours and Events columns, from the
 *    column heads and from every row, and lays out the four columns left
 *    with the app's grid: the app reads no event counts yet, and the topic
 *    is set in a Connection's settings;
 * 3. removes the Channels section: chat channels are not Connections the
 *    app lists yet;
 * 4. removes the Cron row: in Hercule the core emits a cron trigger's ticks
 *    and no Connection carries them (CONTEXT.md, Event Source and Core
 *    Kind), so the app lists no such row;
 * 5. narrows the section's column from the 900px the book's page sets to
 *    the 760px spec 17's Settings frame gives every section, with the
 *    book's own `.set-col` rule (system.css). The book widens it only to fit
 *    its seven columns;
 * 6. writes the app's heading and lead line over the table;
 * 7. writes each Connection's account under its name, where the book
 *    describes what the Connection reads. The book's names are the
 *    fixture's;
 * 8. draws the Intercom row as the fixture's failed Connection: the row's
 *    tint and the health in the failure colour, with its dot and the
 *    controller's detail. The book draws its one failure on the Discord
 *    channel, which edit 3 removes;
 * 9. adds an Intake row after Threads in the settings list: the book
 *    predates Settings > Intake, and the app's list has the row.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { describeConnectionHealth } from "@hercule/client-core";
import { findElement, findElementByText, findElements, insertIntakeSettingsRow } from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";
import { CONNECTIONS, FAILED_INTERCOM } from "./settings-connections-fixture";

/** The heading the app writes over the table, and the line beside it. */
const HEADING = "Connections";
const LEAD = "The accounts Hercule acts through";

/** The app's grid of a column head row and of a Connection's row: mark, name, health, ⋯. */
const TABLE_COLUMNS = "34px minmax(0, 1fr) 176px 28px";

/** The book's column heads that edit 2 removes, each with the cells under it. */
const REMOVED_COLUMNS = ["Default Topic", "Last 24 hours", "Events"];

stillBookPage();

// 9. The Intake row.
insertIntakeSettingsRow(document);

const column = findElement(document, ".set-col");

// 1. The stats strip.
findElement(column, ".heads").remove();

// 3. The Channels section.
findElementByText(column, ".sec-top > h2", "Channels").closest("section")!.remove();

const section = findElement(column, "section");

// 4. The Cron row.
findElementByText(section, ".conn .nm > b", "Cron · schedules").closest(".conn")!.remove();

// 2. The three columns. Each removed head's place among the heads is the
// place of its cell in every row, so the cells are found before any is removed.
const heads = findElement(section, ".tbl-h");
const rows = findElements(section, ".conn", CONNECTIONS.length);
const removedPlaces = REMOVED_COLUMNS.map((name) => {
  const head = findElementByText(heads, "span", name);
  return [...heads.children].indexOf(head);
});
for (const row of [heads, ...rows]) {
  const cells = removedPlaces.map((place) => {
    const cell = row.children[place];
    if (cell === undefined)
      throw new Error(`A row of the book's table has no cell ${String(place)}.`);
    return cell;
  });
  for (const cell of cells) cell.remove();
}

// 5. The column's width, and 2. the grid of the four columns left.
const style = document.createElement("style");
style.textContent =
  `.set-col { width: min(760px, 100%); }\n` +
  `.tbl-h, .conn { grid-template-columns: ${TABLE_COLUMNS}; }`;
document.head.append(style);

// 6. The heading and the lead line.
findElement(section, ".sec-top > h2").textContent = HEADING;
findElement(section, ".sec-top > span").textContent = LEAD;

// 7. and 8. Each row's account, and the failed Connection.
rows.forEach((row, index) => {
  const connection = CONNECTIONS[index]!;
  findElement(row, ".nm > span").textContent = connection.displayName;
  if (connection.id !== FAILED_INTERCOM.id) return;
  row.classList.add("is-fail");
  const health = findElement(row, ".health");
  health.classList.add("health--fail");
  const dot = document.createElement("i");
  dot.className = "dot dot--fail";
  health.replaceChildren(dot, describeConnectionHealth(connection).text);
});

await markSheetReady();
