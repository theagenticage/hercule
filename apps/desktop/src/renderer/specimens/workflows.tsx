/**
 * The Workflows specimen: the app's real shell with Workflows open, its
 * table built from the Bureau book's 44 workflows (workflows-fixture.ts).
 * `pnpm compare:bureau` compares its workflow list with the book's
 * (docs/design/crew-bureau-2/desktop/workflows.html).
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { SPECIMEN_RECORDS } from "./sidebar-fixture";
import { WORKFLOWS_RECORDS } from "./workflows-fixture";
import { mountWorkflowsSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

await mountWorkflowsSpecimen(
  { ...SPECIMEN_RECORDS, agentSessions: WORKFLOWS_RECORDS.agentSessions },
  WORKFLOWS_RECORDS,
);
await markSheetReady();
