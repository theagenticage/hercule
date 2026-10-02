/**
 * The room specimen: the Office as the first run furnishes it, drawn by the
 * app's OfficeRoom from room-fixture.ts, to check by eye against the Bureau
 * book's desktop/first-run.html in variant B. `node scripts/capture-room.ts`
 * captures every step beside the book's, in both themes.
 *
 * The page takes two options from its URL:
 * - `?step=welcome`, `account`, `providers`, `github`, `project` or `done`
 *   draws that step's room filling the window, as the capture needs it.
 *   Without `?step=`, the page draws every step in both themes, at half size;
 * - `?theme=whitehaven` or `?theme=orient-express`, for a single step.
 */
import "../styles/base-layer.css";
import "./room.css";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { OfficeRoom } from "../screens/office";
import { ROOM_PROJECTS, ROOM_STEPS, type RoomStep } from "./room-fixture";
import { ROOM_STEP_NAMES } from "./room-steps";
import { applySheetTheme, markSheetReady } from "./sheet-page";
import { THEMES } from "./sheet-themes";

/** Returns the step the page's `?step=` names, or `null` without one. Fails when it names no step. */
function readStep(): RoomStep | null {
  const name = new URLSearchParams(location.search).get("step");
  if (name === null) return null;
  const known = ROOM_STEP_NAMES.find((step) => step.name === name);
  if (known === undefined) {
    throw new Error(
      `Unknown step "${name}" in the URL. Use ?step=${ROOM_STEP_NAMES.map((step) => step.name).join(", ")}.`,
    );
  }
  return ROOM_STEPS[known.name];
}

const step = readStep();
applySheetTheme();
const root = createRoot(document.getElementById("root")!);
// The room measures its stage once it is in the document, so the first
// render is flushed before the sheet waits for its frame.
flushSync(() => {
  root.render(
    step !== null ? (
      <div className="room-stage">
        <OfficeRoom contents={step.contents} projects={ROOM_PROJECTS} shot={step.shot} />
      </div>
    ) : (
      <div className="room-sheet">
        {ROOM_STEP_NAMES.map(({ name }) =>
          THEMES.map((theme) => {
            const each = ROOM_STEPS[name];
            return (
              <figure key={`${name}-${theme}`} className="room-cell" data-theme={theme}>
                <figcaption>
                  {name} · {each.shot} · {theme}
                </figcaption>
                <div className="room-cell-window">
                  <div className="room-stage">
                    <OfficeRoom
                      contents={each.contents}
                      projects={ROOM_PROJECTS}
                      shot={each.shot}
                    />
                  </div>
                </div>
              </figure>
            );
          }),
        )}
      </div>
    ),
  );
});
await document.fonts.ready;
await markSheetReady();
