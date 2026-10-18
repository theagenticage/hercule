/**
 * PROTOTYPE (#766): skills in the desktop composer, drawn on the app's real
 * thread screen, in the scenes the switcher at the bottom offers. Run it
 * with
 *
 *   cd apps/desktop && pnpm exec vite --config vite.renderer.config.ts --port 5198
 *
 * and open /specimens/composer-skills-prototype/index.html. The URL keeps
 * `?scene=` and `?theme=` (whitehaven or orient-express); ← and → step
 * through the scenes. Opening a scene loads the page again, because the
 * scene decides the records the thread is mounted with.
 */
import "../fixed-clock";
import "./prototype.css";
import type { JSX, ReactNode } from "react";
import { SkillPrototypeSeam } from "../../screens/session/skill-prototype-seam";
import { mountThreadSpecimen } from "../shell-page";
import { computeScrolledTop, markSheetReady, scrollTranscriptAway } from "../sheet-page";
import { THREAD_PAGE_RECORDS } from "../thread-fixture";
import { renderMessageText } from "./message-text";
import { readSceneKey } from "./prototype-state";
import { buildSceneThread } from "./scene-thread";
import { findScene } from "./scenes";
import { SkillField } from "./skill-field";
import { buildSteerAnswer, steerRefusedInputs } from "./steer-refusal";
import { Switcher } from "./switcher";

const scene = findScene(readSceneKey());

/** Draws the shell with the scene's field and message text in place of the real ones, beside the switcher. */
function Wrap({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <SkillPrototypeSeam value={{ composerField: <SkillField scene={scene} />, renderMessageText }}>
      {children}
      <Switcher />
    </SkillPrototypeSeam>
  );
}

await mountThreadSpecimen(
  THREAD_PAGE_RECORDS,
  { ...buildSceneThread(scene), answerSteer: buildSteerAnswer(scene) },
  Wrap,
);
if (scene.shrunk === true) {
  await scrollTranscriptAway(scene.transcriptAt === "start" ? () => 0 : computeScrolledTop);
}
await steerRefusedInputs(scene);
await markSheetReady();
