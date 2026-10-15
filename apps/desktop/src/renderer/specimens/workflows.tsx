/**
 * The Workflows specimen: the app's real shell with Workflows open, its
 * list built from the Bureau book's 44 workflows (workflows-fixture.ts).
 * `pnpm compare:bureau` compares it with the book's page
 * (docs/design/crew-bureau-2/desktop/workflows.html), opening both with the
 * same parameters, which the page reads as the book's page does:
 *
 * - `?view=table`, the default, shows the list as a table, with no workflow
 *   open;
 * - `?view=split` opens Ship release beside the list, drawn as a column;
 * - `?view=full` opens Ship release across the whole pane;
 * - `&runs=timeline` shows the open workflow's runs on today's timeline,
 *   rather than as a list.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 * Like the book's page, it draws the open workflow's graph without the fade
 * at its cut edge (see `stillGraphPane`).
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { SPECIMEN_RECORDS } from "./sidebar-fixture";
import { WORKFLOWS_RECORDS } from "./workflows-fixture";
import { mountWorkflowsSpecimen } from "./shell-page";
import { markSheetReady, readListView, stillGraphPane } from "./sheet-page";

stillGraphPane();
await mountWorkflowsSpecimen(
  {
    ...SPECIMEN_RECORDS,
    agentSessions: WORKFLOWS_RECORDS.agentSessions,
    plugins: WORKFLOWS_RECORDS.plugins,
  },
  WORKFLOWS_RECORDS,
  readListView(),
  new URLSearchParams(location.search).get("runs") === "timeline" ? "timeline" : "list",
);
await markSheetReady();
