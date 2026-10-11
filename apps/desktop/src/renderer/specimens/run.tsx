/**
 * The run page specimen: the app's real shell with a run's page open, its
 * run built from the Bureau book's runs of Ship release (run-fixture.ts).
 * `pnpm compare:bureau` compares it with the book's page
 * (docs/design/crew-bureau-2/desktop/run.html), opening both with the same
 * parameters, which the page reads as the book's page does:
 *
 * - `?state=waiting`, the default, opens the run that waits for an
 *   approval; `?state=failed` opens the run that failed at its iteration
 *   limit;
 * - `&steps=timeline` shows the steps on a timeline, rather than as a graph;
 * - `&card=<step id>` opens that step's card on the graph, as a click on
 *   the step does;
 * - `&dialog=cancel` or `&dialog=rerun` opens that dialog, as a click on
 *   the header's action does.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 * Like the book's page, it draws the graph without the fade at its cut edge
 * (see `stillGraphPane`).
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import { stopSpecimenClockAt } from "./fixed-clock";
import { RUN_RECORDS, type RunState } from "./run-fixture";
import { SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";
import { WORKFLOWS_RECORDS } from "./workflows-fixture";
import { mountRunSpecimen } from "./shell-page";
import { markSheetReady, stillGraphPane } from "./sheet-page";

const search = new URLSearchParams(location.search);

/** Returns the run the page's `?state=` names. Fails when it names none of the runs. */
function readState(): RunState {
  const state = search.get("state") ?? "waiting";
  if (state !== "waiting" && state !== "failed") {
    throw new Error(`Unknown state "${state}" in the URL. Use one of: waiting, failed.`);
  }
  return state;
}

/** Waits until the browser has drawn one more frame, so a click's render is on the page. */
const waitForFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Clicks the graph's node of the step with `stepId`, which opens its card.
 * Fails when the graph has no such node. The app's node carries the step's
 * id only as the first line of its title.
 */
async function openCard(stepId: string): Promise<void> {
  const node = [...document.querySelectorAll<HTMLButtonElement>(".run-page .node")].find((each) =>
    each.title.startsWith(`${stepId}\n`),
  );
  if (node === undefined) throw new Error(`The run's graph has no step "${stepId}".`);
  node.click();
  await waitForFrame();
}

/**
 * Clicks the header's action, Cancel run… or Re-run…, which opens its
 * dialog. Fails when the header has no action of that name, or when no
 * dialog opens.
 */
async function openDialog(dialog: string): Promise<void> {
  const label = { cancel: "Cancel run…", rerun: "Re-run…" }[dialog];
  if (label === undefined) {
    throw new Error(`Unknown dialog "${dialog}" in the URL. Use one of: cancel, rerun.`);
  }
  const action = [...document.querySelectorAll<HTMLButtonElement>(".top .pill-btn")].find(
    (each) => each.textContent === label,
  );
  if (action === undefined) throw new Error(`The run's header has no "${label}" action.`);
  action.click();
  await waitForFrame();
  if (document.querySelector("dialog[open]") === null) {
    throw new Error(`"${label}" opened no dialog. Check the page's console for the error.`);
  }
}

/**
 * Waits until the app's age clock has fired its timer once, checking once a
 * frame. Fails after five seconds when it never does.
 */
async function waitForAgeClockFire(): Promise<void> {
  const deadline = performance.now() + 5000;
  while (performance.getEntriesByName("age-clock-fire").length === 0) {
    if (performance.now() > deadline) {
      throw new Error(
        "The age clock never fired, so the run's durations may still change after the page is ready.",
      );
    }
    await waitForFrame();
  }
}

stillGraphPane();
const state = readState();
// The waiting run is live, so its durations count seconds, rounded to the
// nearest one. The age clock trusts a timer that fires within a second of the
// moment it was set for, and with the page's clock stopped every fire looks
// that early. So the clock's first fire moves its labels to the next change,
// half a second past the stopped moment, and the durations would read one
// second more than the book's. Stopping the page's clock a second before the
// book's moment lets that one move land half a second before it, where the
// durations read as the book's. The page is ready only after the move; later
// fires come too long before their changes to move anything.
if (state === "waiting") stopSpecimenClockAt(SPECIMEN_NOW - 1000);
const records = RUN_RECORDS[state];
await mountRunSpecimen(
  {
    ...SPECIMEN_RECORDS,
    workspaces: [...SPECIMEN_RECORDS.workspaces, ...records.workspaces],
    agentSessions: WORKFLOWS_RECORDS.agentSessions,
    plugins: WORKFLOWS_RECORDS.plugins,
  },
  { records, workflows: WORKFLOWS_RECORDS },
  search.get("steps") === "timeline" ? "timeline" : "graph",
);
const card = search.get("card");
if (card !== null) await openCard(card);
const dialog = search.get("dialog");
if (dialog !== null) await openDialog(dialog);
if (state === "waiting") await waitForAgeClockFire();
await markSheetReady();
