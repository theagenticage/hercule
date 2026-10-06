/**
 * The assistant states specimen: the app's real shell, sidebar and assistant
 * page, drawn from one scene of assistant-states-fixture.ts, to check by eye
 * the Assistants section and an assistant's page. `node
 * scripts/capture-assistant.ts` captures every scene in all five themes.
 *
 * The page takes its scene from `?scene=1` and up, and its theme from
 * `?theme=`, one of the five in sheet-themes.ts.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { ASSISTANT_SCENES, type AssistantScene } from "./assistant-states-fixture";
import { mountSidebarSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

/** Returns the scene the page's `?scene=` names. Fails when it names none of the scenes. */
function readScene(): AssistantScene {
  const number = new URLSearchParams(location.search).get("scene") ?? "";
  const scene = ASSISTANT_SCENES[Number(number) - 1];
  if (!/^[1-9]\d*$/.test(number) || scene === undefined) {
    throw new Error(
      `Unknown scene "${number}" in the URL. Use ?scene=1 to ?scene=${String(ASSISTANT_SCENES.length)}.`,
    );
  }
  return scene;
}

/**
 * Checks that the page drew the Assistants section, and the assistant's page
 * or its not-found screen when the address opens one. Fails with what is
 * missing otherwise.
 */
function assertAssistantsDrawn(scene: AssistantScene): void {
  if (document.querySelector(".side-sec--who") === null) {
    throw new Error("The sidebar drew no Assistants section. Check the page's console.");
  }
  if (
    scene.path.startsWith("/assistants/") &&
    document.querySelector(".pill--who, .not-found") === null
  ) {
    throw new Error(`The page drew no assistant at ${scene.path}. Check the page's console.`);
  }
}

const scene = readScene();
// The capture script reads these to know which scenes there are, what each
// is called and which part of the window each one captures.
document.documentElement.dataset.scenes = JSON.stringify(
  ASSISTANT_SCENES.map(({ name, region }) => ({ name, region })),
);
await mountSidebarSpecimen(scene.records, scene.path);
assertAssistantsDrawn(scene);
await markSheetReady();
