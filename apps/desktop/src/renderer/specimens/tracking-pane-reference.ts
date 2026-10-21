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
 * 3. removes the foot of the pane, which the app does not draw, and "Try
 *    again", which comes with #804;
 * 4. makes Mark done the answer ahead of Cancel in a Failed pane, where the
 *    drawing suggests Try again, so no answer is suggested there and Mark
 *    done's key is E, as the keys line says;
 * 5. draws the run's line under what the agent did, which the drawing draws
 *    only for two runs or more and for a Working one, because the app always
 *    draws it: the time, the run's mark, the workflow's name, how the run
 *    went, and a link to the run's thread;
 * 6. draws the colleague's face from the look the app gives the workflow's
 *    id, in the head and before the agent's message, because the book casts
 *    Investigate a look (a tache and a homburg) that no id hashes to;
 * 7. writes the step the output comes from, which the drawing leaves out for
 *    a text output, and the failure reason as the run records it.
 *
 * It fails when the drawing has no part it edits, because the drawing has
 * changed and the comparison would no longer compare what it claims to.
 */
import { buildLook } from "../faces/look";
import { findElement, findElementByText } from "./book-page";
import { drawBookFace, drawBookMark, markSheetReady, stillBookPage } from "./sheet-page";

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

// The app writes the "· " before the kind and the place as a text node of its
// own, which shapes the text in two runs and makes the line 1/128 px wider
// than the drawing's one run. The drawing is changed to match, so the
// comparison stays exact.
const kindAndPlace = findElement(pane, ".rt-orig-h > span:last-child");
kindAndPlace.replaceChildren("· ", kindAndPlace.textContent.slice("· ".length));

findElement(pane, ".ad-foot").remove();
findElement(pane, '[data-answer="again"]').closest(".ans")?.remove();

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
  const done = findElement(pane, '[data-answer="done"]');
  done.classList.remove("btn--accent");
  findElement(done.closest(".ans")!, "kbd").textContent = "E";
  findElementByText(findElement(document, ".asks-detail .ad-keys"), "span", "↩ try again").remove();
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

// The app's rules for the run's line, which the drawing has none of: the
// words are a flex row with the link to the thread at its end.
const runStyle = document.createElement("style");
runStyle.textContent = `
  .rt-pane .rt-step-text {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .rt-pane .rt-step-who {
    color: var(--who-ink);
    text-decoration: underline;
    text-decoration-color: transparent;
    text-underline-offset: 2px;
  }
  .rt-pane .rt-step-thread {
    flex: none;
    margin-left: auto;
    color: var(--faint);
    font-size: var(--t-12);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
`;
document.head.append(runStyle);

const finishedAt = state === "failed" ? "09:26" : "09:20";
const outcome = state === "failed" ? "failed: permission denied on ops-db" : "finished";
const time = document.createElement("time");
time.textContent = finishedAt;
// The workflow's name is a button that opens the run, in its colleague's hue, as the drawing writes the agent's name.
const who = document.createElement("button");
who.className = "rt-step-who who-ink";
who.style.setProperty("--hue", agentName.style.getPropertyValue("--hue"));
who.textContent = workflowName;
const words = document.createElement("span");
// The space and the outcome are two text nodes, as the app writes them.
words.append(who, " ", outcome);
const thread = document.createElement("span");
thread.className = "rt-step-thread";
thread.textContent = "Thread";
const text = document.createElement("span");
text.className = "rt-step-text";
text.append(words, thread);
const line = document.createElement("li");
line.append(time, drawBookMark(state === "failed" ? "failed" : "done", 14), text);
const steps = document.createElement("ol");
steps.className = "rt-steps";
steps.append(line);
did.append(steps);

await markSheetReady();
