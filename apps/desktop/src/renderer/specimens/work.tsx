/**
 * The Work specimen: the app's real shell with the Work board open, drawn from
 * the invented Northwind Market board of work-fixture.ts, with the Display
 * menu's defaults. `capture:ui` captures it and `ui:metrics` measures it. The
 * page takes its theme from `?theme=` and its glass from `?glass=`, as every
 * specimen does.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { WORK_RECORDS, WORK_SIDEBAR_RECORDS } from "./work-fixture";
import { mountWorkSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

await mountWorkSpecimen(WORK_SIDEBAR_RECORDS, WORK_RECORDS);
await markSheetReady();
