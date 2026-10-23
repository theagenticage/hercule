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
 * 1. removes the Default Topic column, from the column heads and from every
 *    row, and lays out the six columns left with the app's grid:
 *    Connections no longer carry a topic;
 * 2. removes the Channels section, and the strip's count of channels: chat
 *    channels are not Connections the app lists yet;
 * 3. removes the Cron row: in Hercule the core emits a cron trigger's ticks
 *    and no Connection carries them (GLOSSARY.md, Event Source and Core
 *    Kind), so the app lists no such row;
 * 4. writes the strip's counts from the fixture: its events, its
 *    Connections, and its failing Connections, where the book counts
 *    channels reconnecting. Only an `error` is drawn as a failure, and no
 *    Connection status reads "reconnecting";
 * 5. writes the app's note beside the strip, which does not mention topics;
 * 6. names the strip's parts as the app does, `.conn-stats`, `.conn-stat`
 *    and `.conn-stats-note`, because Settings already has a `.head` rule;
 * 7. writes each Connection's account under its name, where the book
 *    describes what the Connection reads. The book's names are the
 *    fixture's;
 * 8. draws each row's bars and count from the fixture's counts: each bar as
 *    tall as its hour's share of the row's busiest hour, worked out here
 *    rather than by the app's code, so a fault in that code shows. The
 *    book's own script draws its bars from a hash of each row's count;
 * 9. draws the Intercom row as the fixture's failed Connection: the row's
 *    tint and the health in the failure colour, with its dot and the
 *    controller's detail. The book draws its one failure on the Discord
 *    channel, which edit 2 removes;
 * 10. adds an Intake row after Threads in the settings list: the book
 *    predates Settings > Intake, and the app's list has the row.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { describeConnectionHealth } from "@hercule/client-core";
import { findElement, findElementByText, findElements, insertIntakeSettingsRow } from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";
import {
  CONNECTIONS,
  CONNECTIONS_SETTINGS_RECORDS,
  FAILED_INTERCOM,
} from "./settings-connections-fixture";

/** The app's grid of a column head row and of a Connection's row. */
const TABLE_COLUMNS = "34px minmax(0, 1fr) 144px 52px 176px 28px";

/** The app's note beside the strip, one line per array item. */
const NOTE = ["Triage reads these events", "and prepares work for you."];

/** Each Connection's counts of the 24 hours, by its id. */
const hourlyById = new Map(
  CONNECTIONS_SETTINGS_RECORDS.counts.connections.map((each) => [each.connectionId, each.hourly]),
);
const sumCounts = (counts: ReadonlyArray<number>): number =>
  counts.reduce((total, n) => total + n, 0);
const eventCount = sumCounts([...hourlyById.values()].flat());
const failingCount = CONNECTIONS.filter((each) => each.status === "error").length;

stillBookPage();

// 10. The Intake row.
insertIntakeSettingsRow(document);

const column = findElement(document, ".set-col");

// 2. The Channels section.
findElementByText(column, ".sec-top > h2", "Channels").closest("section")!.remove();

const section = findElement(column, "section");

// 3. The Cron row.
findElementByText(section, ".conn .nm > b", "Cron · schedules").closest(".conn")!.remove();

// 1. The Default Topic column. Its head's place among the heads is the place
// of its cell in every row.
const heads = findElement(section, ".tbl-h");
const rows = findElements(section, ".conn", CONNECTIONS.length);
const topicPlace = [...heads.children].indexOf(findElementByText(heads, "span", "Default Topic"));
for (const row of [heads, ...rows]) {
  const cell = row.children[topicPlace];
  if (cell === undefined)
    throw new Error(`A row of the book's table has no cell ${String(topicPlace)}.`);
  cell.remove();
}
const style = document.createElement("style");
style.textContent = `.tbl-h, .conn { grid-template-columns: ${TABLE_COLUMNS}; }`;
document.head.append(style);

// 2., 4. and 6. The strip: its counts and the names of its parts.
const strip = findElement(column, ".heads");
strip.classList.add("conn-stats");
const counts: ReadonlyArray<readonly [string, number, string]> = [
  ["events in 24 hours", eventCount, "events in 24 hours"],
  ["event sources", CONNECTIONS.length, "event sources"],
  ["reconnecting", failingCount, "failing"],
];
for (const [bookLabel, count, label] of counts) {
  const head = findElementByText(strip, ".head > span", bookLabel).parentElement!;
  head.classList.add("conn-stat");
  findElement(head, "b").textContent = count.toLocaleString("en-US");
  findElement(head, "span").textContent = label;
}
findElementByText(strip, ".head > span", "channels").parentElement!.remove();

// 5. and 6. The note.
const note = findElement(strip, ".note");
note.classList.add("conn-stats-note");
note.replaceChildren(NOTE[0]!, document.createElement("br"), NOTE[1]!);

// 7., 8. and 9. Each row's account, its bars and count, and the failed Connection.
rows.forEach((row, index) => {
  const connection = CONNECTIONS[index]!;
  findElement(row, ".nm > span").textContent = connection.displayName;
  const hourly = hourlyById.get(connection.id)!;
  const busiest = Math.max(...hourly);
  findElements(row, ".spark > i", hourly.length).forEach((bar, hour) => {
    (bar as HTMLElement).style.height = `${String(Math.round((hourly[hour]! / busiest) * 100))}%`;
  });
  findElement(row, ".n").textContent = sumCounts(hourly).toLocaleString("en-US");
  if (connection.id !== FAILED_INTERCOM.id) return;
  row.classList.add("is-fail");
  const health = findElement(row, ".health");
  health.classList.add("health--fail");
  const dot = document.createElement("i");
  dot.className = "dot dot--fail";
  health.replaceChildren(dot, describeConnectionHealth(connection).text);
});

await markSheetReady();
