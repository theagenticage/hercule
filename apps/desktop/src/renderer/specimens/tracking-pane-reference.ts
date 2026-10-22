/**
 * Edits the Tracking drawing's pane (docs/design/tracking, `?state=finished`
 * or `?state=failed`) to what the app draws, then marks the page ready.
 * `pnpm compare:bureau` imports this module into the drawing once its scripts
 * have drawn it, and compares the pane with the Intake specimen's
 * `tracking-pane-finished` and `tracking-pane-failed` scenes (intake.tsx).
 *
 * The drawing is the design, and the app knowingly differs from it in the
 * parts below, so each is changed here and the comparison holds the rest to
 * the pixel. It:
 *
 * 1. stops every animation and transition;
 * 2. cuts the harness, the model and the runner from the line under the
 *    title, because no read of a run carries them (spec 17 §Tracking);
 * 3. removes the foot of the pane, which the app does not draw;
 * 4. cuts the fine print under Try again's describe line (the same harness,
 *    model and runner as in point 2), because the app draws no fine print
 *    under the answers (spec 17 §Tracking, Departures from the drawing);
 * 5. draws the colleague's face from the look the app gives the workflow's
 *    id, in the head and before the agent's message, because the book casts
 *    Investigate a look (a tache and a homburg) that no id hashes to;
 * 6. writes the step the output comes from, which the drawing leaves out for
 *    a text output, and the failure reason as the run records it.
 *
 * It fails when the drawing has no part it edits, because the drawing has
 * changed and the comparison would no longer compare what it claims to.
 */
import { buildLook } from "../faces/look";
import { findElement } from "./book-page";
import { drawBookFace, markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
const style = document.createElement("style");
style.textContent = "* { transition: none !important; }";
document.head.append(style);

const state = new URLSearchParams(location.search).get("state");
const pane = findElement(document, ".asks-detail .rt-pane");

// The standing line ends in the worker: the harness, the model and the
// runner, three parts joined by " · ".
const standing = findElement(pane, ".ad-asked");
standing.textContent = standing.textContent.split(" · ").slice(0, -3).join(" · ");

findElement(pane, ".ad-foot").remove();
findElement(findElement(pane, '[data-answer="again"]').closest(".ans")!, ".ad-fine").remove();

const did = findElement(pane, ".rt-msg--did .rt-msg-body");
const agentName = findElement(did, ".rt-name") as HTMLElement;
const workflowName = agentName.firstChild!.textContent!.trim();

// The specimen's workflow ids are the workflows' names, which the app draws the face from.
const look = buildLook(workflowName);
const pose = state === "failed" ? "failed" : "done";
agentName.style.setProperty("--hue", `var(--hue-${look.hue})`);
findElement(pane, ".ad-kind .src > svg").replaceWith(drawBookFace(workflowName, look, pose, 18));
findElement(did.parentElement!, ".rt-av > svg").replaceWith(
  drawBookFace(workflowName, look, pose, 28),
);

if (state === "failed") {
  // The run records a short cause ("permission denied on ops-db"), which the
  // row's line shows too, and the drawing writes it out as a sentence.
  findElement(did, ".rt-fail").textContent = "permission denied on ops-db";
  const from = document.createElement("p");
  from.className = "rt-out-from";
  const step = document.createElement("b");
  step.textContent = "Check the backup job";
  from.append("From the step ", step);
  findElement(did, ".rt-did").before(from);
}

await markSheetReady();
