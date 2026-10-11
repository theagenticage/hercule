/**
 * Stills the Bureau book's desktop/run.html, then marks the page ready.
 * `pnpm compare:bureau` imports this module into the book's page once
 * workflows.js has drawn it, and compares the page with the app's (run.tsx),
 * whose fixture holds the book's runs of Ship release.
 *
 * It stops every animation, so the running and waiting marks show the frame
 * the app draws, and it stops the graph's fade at its cut edge, which
 * Chromium draws differently from one capture to the next (see
 * `stillGraphPane`). It gives every `.pop`, a step's card and a dialog,
 * the shadow and rim the app's `.pop` has (menus.css): the book's own `.pop`
 * follows the glass level and draws a lighter shadow. Then it makes three
 * edits:
 *
 * 1. it draws the GitHub mark on the open_pr step in place of the book's
 *    puzzle piece. Spec 17 draws an action step with the mark of the plugin
 *    whose action it calls, and open_pr calls `github/pr.create`. The book
 *    draws a puzzle piece for every action;
 * 2. on the waiting run, it adds the Workspace row the app draws under the
 *    inputs, in the app's facts list: words in the interface's face, not in
 *    mono. Spec 17 shows a run's workspace on its page, and the run's
 *    automatic workspace is what makes Cancel run offer to delete it, as the
 *    book's dialog does. The book draws no workspace;
 * 3. with `&dialog=`, it opens the dialog as a modal `<dialog>` in the top
 *    layer, as the app does, instead of inside the book's fixed `.modal`.
 *    The dialog keeps the focus the book gives it.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { findElement } from "./book-page";
import { markSheetReady, readCrew, stillBookPage, stillGraphPane } from "./sheet-page";

stillBookPage();
stillGraphPane();
const style = document.createElement("style");
style.textContent = `
  .pop { box-shadow: inset 0 0 0 1px var(--line), inset 0 1px 0 var(--glass-edge), var(--shadow-3); }
  dialog.pop { border: 0; padding: 0; color: var(--ink); font-size: var(--t-13); margin: 18vh auto auto; }
  dialog.pop[open] { display: flex; flex-direction: column; }
  dialog.pop::backdrop { background: var(--scrim); }
  .run-facts dd { font-family: inherit; font-variation-settings: inherit; font-size: inherit; }
`;
document.head.append(style);

// 1. The graph is drawn only in the graph view.
const lead = document.querySelector('[data-node="open_pr"] > .node-lead');
if (lead !== null) {
  // Unlike workflows.html, run.html does not load the book's brand marks.
  const brands = document.createElement("script");
  brands.src = "../brands.js";
  const loaded = new Promise((resolve, reject) => {
    brands.addEventListener("load", resolve);
    brands.addEventListener("error", () => reject(new Error("The book's brands.js did not load.")));
  });
  document.head.append(brands);
  await loaded;
  const mark = document.createElement("i");
  mark.dataset.brand = "github";
  mark.dataset.size = "14";
  lead.replaceChildren(mark);
  readCrew().drawPlaceholders(lead);
}

// 2. Only the waiting run, the book's default, has a workspace.
const state = new URLSearchParams(location.search).get("state") ?? "waiting";
if (state === "waiting") {
  const branch = "release/2.14.0";
  const facts = document.createElement("dl");
  facts.className = "run-inputs run-facts";
  facts.setAttribute("aria-label", "Where the run works");
  const row = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = "Workspace";
  const value = document.createElement("dd");
  value.title = branch;
  value.textContent = branch;
  row.append(term, value);
  facts.append(row);
  const openNode = document.querySelector<HTMLElement>("[data-node].is-open");
  const nodeTop = openNode?.getBoundingClientRect().top ?? 0;
  findElement(document, "[data-inputs]").after(facts);
  // The book placed an open card under its node before the row pushed the
  // node down, so the card moves down with it, as the book would have placed it.
  if (openNode !== null) {
    const card = document.querySelector<HTMLElement>(".node-pop:popover-open");
    if (card === null) throw new Error("The book's page has an open node but no open card.");
    const moved = openNode.getBoundingClientRect().top - nodeTop;
    card.style.top = `${String(Number.parseFloat(card.style.top) + moved)}px`;
  }
}

// 3. The book opens a dialog only with `&dialog=`.
const modal = document.querySelector<HTMLElement>(".modal:not([hidden])");
if (modal !== null) {
  const pop = findElement(modal, ".pop");
  const focused = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.className = pop.className;
  dialog.setAttribute("aria-labelledby", pop.getAttribute("aria-labelledby") ?? "");
  dialog.append(...pop.childNodes);
  modal.replaceWith(dialog);
  dialog.showModal();
  // Opening a modal dialog moves the focus to its first control.
  if (focused instanceof HTMLElement && dialog.contains(focused)) focused.focus();
}

await markSheetReady();
