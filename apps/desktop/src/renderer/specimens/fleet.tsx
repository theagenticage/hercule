/**
 * The Fleet specimen: the app's real shell with the Fleet page open, drawn
 * from five machines (fleet-fixture.ts). `capture:ui` captures it and
 * `ui:metrics` measures it. The page reads these parameters:
 *
 * - no parameter: the Fleet page, its machines as a grid of cards;
 * - `?view=list`: the Fleet page with its machines as rows;
 * - `?machine=atlas`: the page of the machine called that. `capture:ui`
 *   captures atlas; `?machine=mini` shows the page of the offline machine;
 * - `?machine=atlas&activity`: the Activity page of that machine, which lists
 *   the machine's audit log (fleet-activity-fixture.ts);
 * - `?cleanup`: the Fleet page with nine idle workspaces on studio
 *   (fleet-cleanup-fixture.ts), for the cleanup dialog its Clean up… opens.
 *   `?cleanup=pending` has the controller never answer the read that follows a
 *   removal, so the rows stay "Removing…"; `?cleanup=partial` answers it with
 *   some workspaces deleted and some refused;
 * - `?empty`: the Fleet page of an empty fleet, where only the controller's
 *   own machine is online, with the dashed card that adds a machine.
 *
 * The page takes its theme from `?theme=` and its glass from `?glass=`, as
 * every specimen does.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { rememberMachineView } from "../screens/fleet/machine-view";
import { buildCleanupAnswers, STUDIO_CLEANUP_WORKSPACES } from "./fleet-cleanup-fixture";
import { FLEET_ALONE_SIDEBAR_RECORDS, FLEET_RECORDS, FLEET_SIDEBAR_RECORDS } from "./fleet-fixture";
import { mountFleetSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

const params = new URLSearchParams(location.search);
const machineName = params.get("machine");
const baseRecords = params.has("empty") ? FLEET_ALONE_SIDEBAR_RECORDS : FLEET_SIDEBAR_RECORDS;
const records = params.has("cleanup")
  ? { ...baseRecords, workspaces: [...baseRecords.workspaces, ...STUDIO_CLEANUP_WORKSPACES] }
  : baseRecords;
const machine =
  machineName === null ? undefined : records.runners.find((runner) => runner.name === machineName);
if (machineName !== null && machine === undefined) {
  throw new Error(`The Fleet specimen has no machine called ${machineName}.`);
}
if (params.has("activity") && machine === undefined) {
  throw new Error("The Fleet specimen's activity page needs a machine: pass ?machine=<name>.");
}

rememberMachineView(params.get("view") === "list" ? "list" : "grid");
await mountFleetSpecimen(
  records,
  params.has("cleanup")
    ? {
        ...FLEET_RECORDS,
        cleanupAnswers: buildCleanupAnswers(
          params.get("cleanup") === "pending" ? "pending" : "partial",
        ),
      }
    : FLEET_RECORDS,
  machine === undefined
    ? "/fleet"
    : `/fleet/${machine.id}${params.has("activity") ? "/activity" : ""}`,
);
await markSheetReady();
