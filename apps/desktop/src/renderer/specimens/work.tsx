/**
 * The Work specimen: the app's real shell with the Work board open, drawn from
 * the invented Northwind Market board of work-fixture.ts. `capture:ui`
 * captures it and `ui:metrics` measures it. The page reads these parameters:
 *
 * - no parameter: the lane labels the Display menu starts with;
 * - `?lanes=bands`: the lane names in bands over the lanes, which is also how
 *   the board draws itself in a window narrower than 1320px.
 *
 * The page takes its theme from `?theme=` and its glass from `?glass=`, as
 * every specimen does.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { WORK_RECORDS, WORK_SIDEBAR_RECORDS } from "./work-fixture";
import { mountWorkSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

const laneLabels =
  new URLSearchParams(location.search).get("lanes") === "bands" ? "bands" : undefined;
await mountWorkSpecimen(WORK_SIDEBAR_RECORDS, {
  ...WORK_RECORDS,
  ...(laneLabels === undefined ? {} : { laneLabels }),
});
await markSheetReady();
