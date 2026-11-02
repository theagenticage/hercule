/**
 * PROTOTYPE - throwaway. The Fleet page prototype: the app's real shell and
 * sidebar, on the Hercule face, with three variants of a Fleet screen in the
 * main pane. Start it with `pnpm prototype:fleet` and open the URL it prints.
 *
 * - `?variant=A`, `B` or `C` picks the variant; the bar at the bottom, or the
 *   ← and → keys, switch between them.
 * - `?theme=` takes any of the five themes.
 *
 * Everything the page shows comes from screens/fleet-prototype/fleet-world.ts.
 * Nothing talks to a controller.
 */
import "./fixed-clock";
import { FleetPrototypeScreen } from "../screens/fleet-prototype/fleet-prototype-screen";
import { mountPrototypeSpecimen } from "./shell-page";
import { SPECIMEN_RECORDS } from "./sidebar-fixture";
import { WORKFLOWS_RECORDS } from "./workflows-fixture";

await mountPrototypeSpecimen(
  {
    ...SPECIMEN_RECORDS,
    agentSessions: WORKFLOWS_RECORDS.agentSessions,
    plugins: WORKFLOWS_RECORDS.plugins,
  },
  FleetPrototypeScreen,
);

// The sidebar's Fleet row is inert until a Fleet screen exists. Here it is
// drawn as the open screen's row.
for (const row of document.querySelectorAll<HTMLElement>(".side-sec .nav-row")) {
  if (row.textContent?.trim() === "Fleet") {
    row.classList.add("is-on");
    row.removeAttribute("title");
  }
}
