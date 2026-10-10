/**
 * The sidebar states specimen: the app's real shell and sidebar, drawn from
 * one scene of sidebar-states-fixture.ts, to check by eye the states the
 * Bureau book never draws. `node scripts/capture-sidebar-states.ts` captures
 * every scene in both themes.
 *
 * The page takes its scene from `?scene=1` to `?scene=4`, and its theme from
 * `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { flushSync } from "react-dom";
import { SIDEBAR_SCENES, type SidebarScene } from "./sidebar-states-fixture";
import { mountSidebarSpecimen } from "./shell-page";
import type { SidebarFace } from "../shell/sidebar-face";
import { markSheetReady } from "./sheet-page";

/** Returns the scene the page's `?scene=` names. Fails when it names none of the scenes. */
function readScene(): SidebarScene {
  const number = new URLSearchParams(location.search).get("scene") ?? "";
  const scene = SIDEBAR_SCENES[Number(number) - 1];
  if (!/^[1-9]\d*$/.test(number) || scene === undefined) {
    throw new Error(
      `Unknown scene "${number}" in the URL. Use ?scene=1 to ?scene=${String(SIDEBAR_SCENES.length)}.`,
    );
  }
  return scene;
}

/**
 * Presses the sidebar's "more" row whose text is `label`, as a click would,
 * and waits for the sidebar to draw the threads it showed. Fails when no
 * "more" row has that text, or when the row is still there afterwards.
 */
function pressMoreRow(label: string): void {
  const findRow = () =>
    [...document.querySelectorAll<HTMLElement>(".side-row--more")].find(
      (row) => row.textContent === label,
    );
  const row = findRow();
  if (row === undefined) throw new Error(`The sidebar has no "more" row "${label}".`);
  // The click's state update is drawn before flushSync returns.
  flushSync(() => {
    row.click();
  });
  if (findRow() !== undefined) {
    throw new Error(`The sidebar still shows "${label}" after it was pressed.`);
  }
}

/**
 * Presses the face switch's segment for `face`, as a click would, and waits
 * for the sidebar to draw that face. Fails when the switch has no such
 * segment, or when the segment is not selected afterwards.
 */
function pressFaceSegment(face: SidebarFace): void {
  const label = face === "threads" ? "Threads" : "Hercule";
  const segment = [...document.querySelectorAll<HTMLElement>('.seg--side [role="tab"]')].find(
    (tab) => tab.textContent === label,
  );
  if (segment === undefined) throw new Error(`The face switch has no "${label}" segment.`);
  flushSync(() => {
    segment.click();
  });
  if (segment.getAttribute("aria-selected") !== "true") {
    throw new Error(`The "${label}" segment is not selected after it was pressed.`);
  }
}

const scene = readScene();
// The capture script reads this to know how many scenes there are to capture.
document.documentElement.dataset.sceneCount = String(SIDEBAR_SCENES.length);
await mountSidebarSpecimen(scene.records, scene.path, scene.unsentThreadIds);
if (scene.pressMore !== null) pressMoreRow(scene.pressMore);
pressFaceSegment(scene.face);
await markSheetReady();
