/**
 * Edits the main pane of the Bureau book's session-empty.html to show the
 * draft specimen's data, then marks the page ready. `pnpm compare:bureau`
 * imports this module into the book's page once crew.js has drawn it, and
 * compares the main pane with the app's draft screen (draft.tsx).
 *
 * First it stops every animation, so the face shows the frame the app draws.
 * Then it makes exactly four edits, each where the app draws something else
 * than the book, for the reason given:
 *
 * 1. sets the model pill's text to the model's name, "Opus 5.5": the pill
 *    shows the name the provider's catalog gives the model, and shows the
 *    provider by its logo, as the thread's composer does;
 * 2. sets the lip's "New worktree" to client-core's words, "New workspace":
 *    CONTEXT.md keeps "worktree" for the git mechanism, and the lip names
 *    the workspace the thread will work in (spec 17 §Design system, A new
 *    thread). The book's worktree glyph is the app's workspace glyph;
 * 3. sets each start card's mark to the one the app draws for the fixture's
 *    task: the GitHub mark for a task from GitHub, and the tasks glyph for
 *    any other. The app has no Sentry or Stripe mark, so the book's two
 *    Proposals show the GitHub mark and the tasks glyph;
 * 4. sets the third card's "Task · 2 new events" to "Task", and adds the
 *    task's priority bars after a spacer, as the other cards have them: the
 *    card names what the task is, and nothing counts a task's new events
 *    yet. Every task has a priority, so every card draws its bars.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { buildDraftView, buildStartCards } from "@hercule/client-core";
import { CLAUDE_OPUS } from "./sidebar-fixture";
import { DRAFT_PAGE_RECORDS, WEBSHOP_DRAFT } from "./draft-fixture";
import { findElement, findElementByText, findElements, replaceTextAfterIcon } from "./book-page";
import { markSheetReady, readCrew, stillBookPage } from "./sheet-page";

/** The draft as the app builds it from the fixture, with nothing set in the settings. */
const view = buildDraftView(
  {
    ...DRAFT_PAGE_RECORDS,
    sessions: DRAFT_PAGE_RECORDS.threads,
    settings: { controller: {}, user: {} },
    profiles: [],
    localRunnerId: null,
  },
  { projectId: WEBSHOP_DRAFT.projectId, workspaceId: null },
  WEBSHOP_DRAFT.picks,
);
const cards = buildStartCards(WEBSHOP_DRAFT.startTasks);
const crew = readCrew();

stillBookPage();

const main = findElement(document, "main.main");
const composer = findElement(main, ".composer");
const starts = findElements(main, ".start", cards.length);

// 1. The model pill.
replaceTextAfterIcon(findElement(composer, ".pick--pill"), CLAUDE_OPUS.name);

// 2. The lip's workspace.
replaceTextAfterIcon(
  findElementByText(composer, ".lip > span", "New worktree"),
  view.workspaceLabel,
);

// 3. The start cards' marks. crew.js draws each mark in place of its placeholder.
starts.forEach((start, index) => {
  const placeholder = document.createElement("i");
  if (cards[index]!.source === "github") placeholder.dataset.brand = "github";
  else placeholder.dataset.i = "tasks";
  placeholder.dataset.size = "14";
  findElement(start, ".start-top > svg").replaceWith(placeholder);
  crew.drawPlaceholders(start);
});

// 4. The third card's kind and bars.
const third = cards[2]!;
const thirdTop = findElement(starts[2]!, ".start-top");
findElementByText(thirdTop, "span", "Task · 2 new events").textContent = third.kind;
const spacer = document.createElement("span");
spacer.className = "spacer";
const bars = document.createElement("span");
bars.className = "bars";
bars.dataset.p = String(third.bars);
bars.append(...Array.from({ length: 4 }, () => document.createElement("i")));
thirdTop.append(spacer, bars);

await markSheetReady();
