/**
 * The Intake specimen: the app's real shell with Intake open, drawn from one
 * scene of intake-fixture.ts, for a check by eye.
 * `node scripts/capture-intake.ts` captures every scene in both themes.
 *
 * The page takes its scene from `?scene=<name>`, such as `?scene=review`, and
 * its theme from `?theme=whitehaven` or `?theme=orient-express`. With no
 * `?scene=`, it draws the first scene.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { INTAKE_SCENES, type IntakeScene } from "./intake-fixture";
import { mountIntakeSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

/** Returns the scene the page's `?scene=` names. Fails when it names none of the scenes. */
function readScene(): IntakeScene {
  const name = new URLSearchParams(location.search).get("scene") ?? INTAKE_SCENES[0]!.name;
  const scene = INTAKE_SCENES.find((each) => each.name === name);
  if (scene === undefined) {
    throw new Error(
      `Unknown scene "${name}" in the URL. Use one of: ${INTAKE_SCENES.map((each) => each.name).join(", ")}.`,
    );
  }
  return scene;
}

const scene = readScene();
// The capture script reads this to know which scenes there are to capture.
document.documentElement.dataset.scenes = INTAKE_SCENES.map((each) => each.name).join(" ");
await mountIntakeSpecimen(scene.records, { signal: scene.signal, event: scene.event });
await markSheetReady();
