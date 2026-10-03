/**
 * Edits the main pane of the Bureau book's session-empty.html to show the
 * draft specimen's data, then marks the page ready. `pnpm compare:bureau`
 * imports this module into the book's page once crew.js has drawn it, and
 * compares the main pane with the app's draft screen (draft.tsx).
 *
 * The book's page has three states, and the specimen is opened with the same
 * one (draft-fixture.ts):
 *
 * - no state: the draft with the start cards that start from Intake;
 * - `first`: a fresh install whose Intake is empty, so starter threads about
 *   code take the cards' place;
 * - `first-no-repo`: the same, in a project with no repository, so the draft
 *   works without a checkout and the starters are about knowledge work.
 *
 * First it stops every animation, so the face shows the frame the app draws.
 * Then it makes only the edits below, each where the app draws something else
 * than the book, for the reason given. In every state:
 *
 * 1. sets the model pill's text to the model's name, "Opus 5.5": the pill
 *    shows the name the provider's catalog gives the model, and shows the
 *    provider by its logo, as the thread's composer does;
 * 2. sets the lip's workspace to client-core's words: "New workspace" for
 *    the book's "New worktree", because CONTEXT.md keeps "worktree" for the
 *    git mechanism and the lip names the workspace the thread will work in
 *    (spec 17 §Design system, A new thread), and "No workspace" for the
 *    book's "No checkout", the name the workspace menu gives that pick. The
 *    book's worktree glyph is the app's workspace glyph.
 *
 * With no state, the start cards:
 *
 * 3. sets each start card's mark to the one the app draws for the fixture's
 *    task: the GitHub mark for a task from GitHub, and the tasks glyph for
 *    any other. The app has no Sentry or Stripe mark, so the book's two
 *    Proposals show the GitHub mark and the tasks glyph;
 * 4. sets the third card's "Task · 2 new events" to "Task", and adds the
 *    task's priority bars after a spacer, as the other cards have them: the
 *    card names what the task is, and nothing counts a task's new events
 *    yet. Every task has a priority, so every card draws its bars.
 *
 * In the two `first` states, the starters:
 *
 * 3. sets the line under the starters to client-core's words: the app does
 *    not say how often Triage reads GitHub, because Triage is not built yet
 *    (spec 17 §Design system, A new thread);
 * 4. in `first-no-repo` only, sets the lead to client-core's words for a
 *    thread that works without a checkout, "It works without a checkout.":
 *    spec 14 §The composer owns the lead's wording, and has one sentence for
 *    that pick whatever the reason.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import {
  buildDraftView,
  buildStartCards,
  describeEmptyIntake,
  filterGitHubConnections,
  joinPhraseText,
} from "@hercule/client-core";
import { CLAUDE_OPUS } from "./sidebar-fixture";
import { chooseDraftFixture } from "./draft-fixture";
import { findElement, findElementByText, findElements, replaceTextAfterIcon } from "./book-page";
import { markSheetReady, readCrew, stillBookPage } from "./sheet-page";

const state = document.documentElement.dataset.state ?? null;
const { records, draft } = chooseDraftFixture(state);
const isFirstRun = state === "first" || state === "first-no-repo";

/** The draft as the app builds it from the fixture, with nothing set in the settings. */
const view = buildDraftView(
  {
    ...records,
    sessions: records.threads,
    settings: { controller: {}, user: {} },
    profiles: [],
    thisMacRunnerId: null,
  },
  { projectId: draft.projectId, workspaceId: null },
  draft.picks,
);
const crew = readCrew();

stillBookPage();

const main = findElement(document, "main.main");
const composer = findElement(main, ".composer");

// 1. The model pill.
replaceTextAfterIcon(findElement(composer, ".pick--pill"), CLAUDE_OPUS.name);

// 2. The lip's workspace.
replaceTextAfterIcon(
  findElementByText(
    composer,
    ".lip > span",
    state === "first-no-repo" ? "No checkout" : "New worktree",
  ),
  view.workspaceLabel,
);

if (isFirstRun) {
  // 3. The line under the starters. The book's page holds one line for each
  // first-run state, and hides the other.
  const note = findElement(
    main,
    state === "first-no-repo" ? ".intake-note.when-no-repo" : ".intake-note.when-repo",
  );
  replaceTextAfterIcon(
    note,
    describeEmptyIntake(filterGitHubConnections(draft.connections).length > 0),
  );

  // 4. The lead of a draft that works without a checkout.
  if (state === "first-no-repo") {
    findElement(main, ".newbie p.when-no-repo").textContent = joinPhraseText(
      view.fields.lead ?? [],
    );
  }
} else {
  const cards = buildStartCards(draft.startTasks);
  // The book's page also holds the starters of a fresh install, hidden in
  // this state. Only the cards that start from Intake are compared.
  const starts = findElements(main, ".when-busy .start", cards.length);

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
}

await markSheetReady();
