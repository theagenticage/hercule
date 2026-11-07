/**
 * The Work specimen: the app's real shell with the Work board open, drawn from
 * the invented Northwind Market board of work-fixture.ts, with the Display
 * menu's defaults. `capture:ui` captures it and `ui:metrics` measures it. The
 * page takes its theme from `?theme=` and its glass from `?glass=`, as every
 * specimen does. With `?details` in the address, the details of the Task that
 * asks a question are open beside the board, and with `?details=failed`, those of the Task whose run failed.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import {
  WORK_DETAILS_RECORDS,
  WORK_FAILED_TASK_ID,
  WORK_OPEN_TASK_ID,
  WORK_RECORDS,
  WORK_SIDEBAR_RECORDS,
} from "./work-fixture";
import { mountWorkSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

const details = new URLSearchParams(location.search).get("details");
if (details !== null) {
  await mountWorkSpecimen(
    WORK_SIDEBAR_RECORDS,
    WORK_DETAILS_RECORDS,
    details === "failed" ? WORK_FAILED_TASK_ID : WORK_OPEN_TASK_ID,
  );
  // The sheet opens on a spring: the capture waits until it has come to rest.
  await waitForSheetAtRest();
} else {
  await mountWorkSpecimen(WORK_SIDEBAR_RECORDS, WORK_RECORDS);
}
await markSheetReady();

/** Resolves once the details' sheet is on the page and nothing on it moves. */
async function waitForSheetAtRest(): Promise<void> {
  const isAtRest = (): boolean =>
    document.querySelector(".opening-sheet .task-pane-title") !== null &&
    document.querySelector(".opening-layer.is-moving") === null;
  const deadline = Date.now() + 10_000;
  while (!isAtRest()) {
    if (Date.now() > deadline) throw new Error("The details sheet did not come to rest.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
