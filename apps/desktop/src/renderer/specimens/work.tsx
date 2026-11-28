/**
 * The Work specimen: the app's real shell with the Work board open, drawn from
 * the invented Northwind Market board of work-fixture.ts, with the Display
 * menu's defaults. `capture:ui` captures it and `ui:metrics` measures it. The
 * page takes its theme from `?theme=` and its glass from `?glass=`, as every
 * specimen does. With `?details` in the address, the details of the Task that
 * asks a question are open beside the board, and with `?details=failed`, those of the Task whose run failed.
 * With `?initiatives`, the board has Initiatives: four rows On top, one of them opened in place.
 * Beside `?initiatives`, `labels=side-labels`, `place=lanes` and `groupBy=initiative` draw the
 * other Display choices, so each can be compared with the Overview drawing, and `details=blocked`
 * or `details=blocking` opens the details of a Task of One price engine that waits on another, or
 * that two others wait on.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import {
  WORK_DETAILS_RECORDS,
  WORK_BLOCKED_TASK_ID,
  WORK_BLOCKING_TASK_ID,
  WORK_FAILED_TASK_ID,
  WORK_INITIATIVES_RECORDS,
  WORK_OPEN_TASK_ID,
  WORK_RECORDS,
  WORK_SIDEBAR_RECORDS,
} from "./work-fixture";
import { INITIATIVE_FACET_ID } from "@hercule/client-core/work";
import { mountWorkSpecimen } from "./shell-page";
import { DEFAULT_WORK_DISPLAY } from "../screens/work/work-view-storage";
import { markSheetReady } from "./sheet-page";

const query = new URLSearchParams(location.search);
const details = query.get("details");
if (query.has("initiatives")) {
  const laneLabels = query.get("labels") === "side-labels" ? "side-labels" : "bands";
  const initiativePlace = query.get("place") === "lanes" ? "lanes" : "top";
  const groupBy = query.get("groupBy") === "initiative" ? INITIATIVE_FACET_ID : undefined;
  const openTaskId =
    details === "blocked"
      ? WORK_BLOCKED_TASK_ID
      : details === "blocking"
        ? WORK_BLOCKING_TASK_ID
        : undefined;
  await mountWorkSpecimen(WORK_SIDEBAR_RECORDS, WORK_INITIATIVES_RECORDS, openTaskId, {
    ...(groupBy === undefined ? {} : { groupBy }),
    display: { ...DEFAULT_WORK_DISPLAY, laneLabels, initiativePlace },
  });
  if (openTaskId !== undefined) await waitForSheetAtRest();
} else if (details !== null) {
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
