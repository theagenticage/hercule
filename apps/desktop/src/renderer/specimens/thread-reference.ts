/**
 * Edits the main pane of the Bureau book's session-active.html to show the
 * thread specimen's data, then marks the page ready. `pnpm compare:bureau`
 * imports this module into the book's page once crew.js has drawn it, and
 * compares the main pane with the app's thread screen (thread.tsx).
 *
 * First it stops every animation, so the waiting faces show the frame the
 * app draws. Then it makes exactly fourteen edits, each where the app draws
 * something else than the book, for the reason given:
 *
 * 1. removes the provenance line, "Started 09:02 from ...": v1 does not
 *    start a thread from Intake, so it has no provenance to show;
 * 2. removes the changed-files card and the test result line from the
 *    second message, which are not built yet, and the 14px space above the
 *    message's paragraph, which only separated it from them;
 * 3. sets each divider's summary to the fixture's words: the summary counts
 *    items by kind, and no item kind says that a tool read a file, so the
 *    book's "read 6 files" is "used 6 tools" (spec 17 §Design system, The
 *    thread);
 * 4. sets the dock's question and its answers' labels and descriptions to
 *    client-core's words, which no screen may reword (spec 17 §Design
 *    system, The thread);
 * 5. removes the "Changes +48 -12 | Commit" pill: nothing reports those
 *    numbers yet (spec 17 §Design system, The thread);
 * 6. sets the meta line's agent and time to the fixture's, and the
 *    composer's placeholder to spec 14's words for a thread whose turn is
 *    running, "Queued until the turn finishes…";
 * 7. sets the queued row's words to the app's: the fixture's queued input,
 *    and "queued · runs next";
 * 8. adds the meta line to the second message, which the book leaves out:
 *    each agent message has its own face, meta line and body (spec 17
 *    §Design system, The thread);
 * 9. removes "Own worktree" from the lip: CONTEXT.md keeps "worktree" for
 *    the git mechanism, so the lip names the branch alone (spec 17 §Design
 *    system, The thread);
 * 10. sets the model pill's text to the model's name, "Opus 5.5": the pill
 *     shows the name the provider's catalog gives the model, and shows the
 *     provider by its logo, as the web app's composer does;
 * 11. removes the syntax colours from the code block: the book's colours are
 *     sample highlighting, and the app loads no highlighter;
 * 12. replaces Send with Stop: the fixture's turn is running, and while a
 *     turn runs the app draws Stop where Send stands, as the book's
 *     assistant.html draws it. The app's Stop keeps Send's 4px left margin,
 *     which the book's lacks, so that the controls beside it do not move
 *     when a turn starts or ends (spec 17 §Design system, The thread);
 * 13. sets the question in `dock-mini`, the dock's one line while the
 *     composer is shrunk, to client-core's short question in plain text,
 *     and its two answers' labels to the card's: the app asks a Request in
 *     the same line as the sidebar's Waiting on you row (spec 17 §Design
 *     system, The thread);
 * 14. sets the lip's branch in the UI face, where the book sets it in
 *     monospace: monospace is kept for code, commands and diffs (spec 17
 *     §Design system, item 2).
 *
 * Last, it scrolls the transcript back to where crew.js put it before the
 * edits changed its height: to its bottom, or on the page's
 * `?state=scrolled`, 42% of the way down, where the composer stays shrunk.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import {
  buildApprovalCard,
  buildThreadBlocks,
  describeAgent,
  formatMessageTime,
  formatRequestQuestion,
  resolveBrowserTimezone,
  summarizeWork,
  type AgentBlock,
  type WorkBlock,
} from "@hercule/client-core";
import { CLAUDE_OPUS, SPECIMEN_INSTANCES, SPECIMEN_NOW } from "./sidebar-fixture";
import { findElement, findElementByText, findElements, replaceTextAfterIcon } from "./book-page";
import { computeScrolledTop, markSheetReady, readCrew, stillBookPage } from "./sheet-page";
import { FIX_THREAD, PUSH_REQUEST } from "./thread-fixture";

/** Returns a new element named `tag`, with the class `className` and the text `text`. */
function buildElement(tag: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== "") element.className = className;
  element.textContent = text;
  return element;
}

const blocks = buildThreadBlocks(FIX_THREAD.transcript, FIX_THREAD.session);
const workBlocks = blocks.filter((block): block is WorkBlock => block.kind === "work");
const agentBlocks = blocks.filter((block): block is AgentBlock => block.kind === "agent");
const instance = SPECIMEN_INSTANCES.find(({ id }) => id === FIX_THREAD.session.instanceId);
const timezone = resolveBrowserTimezone();

/** Returns the meta line the app draws above an agent message: "Claude Code · Opus 5.5 · 09:04". */
function buildMetaLine(block: AgentBlock): string {
  const time = formatMessageTime(new Date(block.startedAt), timezone, new Date(SPECIMEN_NOW));
  const agent = describeAgent(instance, block.model);
  return time === undefined ? agent : `${agent} · ${time}`;
}

/** Returns the fixture's agent message at `index`. Fails when the fixture has fewer. */
function readAgentBlock(index: number): AgentBlock {
  const block = agentBlocks[index];
  if (block === undefined)
    throw new Error(`The thread fixture has no agent message ${String(index + 1)}.`);
  return block;
}

stillBookPage();

const main = findElement(document, "main.main");
const transcript = findElement(main, "[data-transcript]");
const messages = findElements(transcript, ".tx > .msg", agentBlocks.length);
const composer = findElement(main, "[data-composer]");

// 1. The provenance line.
findElement(transcript, ".provenance").remove();

// 2. The changed-files card, the result line, and the space above the paragraph that follows them.
const secondBody = findElement(messages[1]!, ".msg-body");
findElement(secondBody, ".card.files").remove();
findElement(secondBody, ".result").remove();
findElement(secondBody, "p").removeAttribute("style");

// 3. The dividers' summaries.
const dividers = findElements(transcript, ".worked .tools", workBlocks.length);
dividers.forEach((tools, index) => {
  tools.replaceChildren(
    ...summarizeWork(workBlocks[index]!.items).map((phrase) => buildElement("span", "", phrase)),
  );
});

// 4. The dock's question and answers.
const card = buildApprovalCard(PUSH_REQUEST);
findElement(composer, ".dock-q > span").replaceChildren(
  card.title,
  ...card.subject.flatMap((line) => [" ", card.code ? buildElement("code", "", line) : line]),
);
const answers = findElements(composer, ".dock .ledger > .ans", card.rows.length);
answers.forEach((answer, index) => {
  const row = card.rows[index]!;
  findElement(answer, ".btn").textContent = row.label;
  findElement(answer, ".ans-desc").textContent = row.describe;
});

// 5. The Changes and Commit pill.
findElement(main, ".top .pill-btn").closest(".pill")!.remove();

// 6. The meta line and the placeholder.
findElement(messages[0]!, ".msg-meta").textContent = buildMetaLine(readAgentBlock(0));
const input = findElement(composer, ".composer-input");
if (!(input instanceof HTMLTextAreaElement))
  throw new Error("The book's composer has no textarea.");
input.placeholder = "Queued until the turn finishes…";

// 7. The queued row.
const queuedInput = FIX_THREAD.queuedInputs[0];
if (queuedInput === undefined) throw new Error("The thread fixture queues no input.");
findElement(composer, ".queued-text").textContent = queuedInput.text;
findElement(composer, ".queued > .faint").textContent = "queued · runs next";

// 8. The second message's meta line.
secondBody.prepend(buildElement("div", "msg-meta", buildMetaLine(readAgentBlock(1))));

// 9. "Own worktree" in the lip.
findElementByText(composer, ".lip > span", "Own worktree").remove();

// 10. The model pill.
replaceTextAfterIcon(findElement(composer, ".pick--pill"), CLAUDE_OPUS.name);

// 11. The code block's syntax colours.
for (const span of findElement(transcript, ".codeblock").querySelectorAll("span")) {
  span.replaceWith(span.textContent);
}

// 12. Send, as assistant.html's Stop. crew.js draws the stop icon in place of its placeholder.
const stop = buildElement("button", "stop", "");
stop.title = "Stop";
stop.style.marginLeft = "4px";
const stopIcon = document.createElement("i");
stopIcon.dataset.i = "stop";
stopIcon.dataset.size = "14";
stop.append(stopIcon);
findElement(composer, ".send").replaceWith(stop);
readCrew().drawPlaceholders(stop);

// 13. dock-mini's question and answers.
const mini = findElement(composer, ".dock-mini");
findElement(mini, ".dock-mini-q").textContent = formatRequestQuestion(PUSH_REQUEST);
const miniRows = card.rows.filter((row) => row.decision === "allow" || row.decision === "deny");
findElements(mini, ".btn", miniRows.length).forEach((button, index) => {
  button.textContent = miniRows[index]!.label;
});

// 14. The lip's branch in monospace.
findElement(composer, ".lip .mono").classList.remove("mono");

transcript.scrollTop =
  document.documentElement.dataset.state === "scrolled"
    ? computeScrolledTop(transcript)
    : transcript.scrollHeight;

await markSheetReady();
