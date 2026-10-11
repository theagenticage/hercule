/**
 * Stills the Bureau book's desktop/workflows.html, then marks the page ready.
 * `pnpm compare:bureau` imports this module into the book's page once
 * workflows.js has drawn it, and compares the page with the app's
 * (workflows.tsx), whose fixture holds the book's workflows and its open
 * Ship release.
 *
 * It stops every animation, so Fix bug's stepped strip and the running marks
 * show the frame the app draws, and it stops the graph's fade at its cut
 * edge, which Chromium draws differently from one capture to the next (see
 * `stillGraphFade`).
 *
 * With `&runs=timeline`, it also moves the day's hour axis from the top of
 * the timeline into the tab band, under the tabs. Spec 17 puts the axis in
 * the sticky band, as the run list's column heads are, so the hours stay in
 * view while the lanes scroll beneath them. The book draws the axis at the
 * top of the lanes, where it scrolls away. Both places draw the axis at the
 * same height on a page that has not scrolled.
 *
 * With an open workflow (`?view=split` or `?view=full`), it also draws the
 * GitHub mark on the open_pr step in place of the book's puzzle piece. Spec
 * 17 draws an action step with the mark of the plugin whose action it calls,
 * and open_pr calls `github/pr.create`. The book draws a puzzle piece for
 * every action.
 */
import { findElement } from "./book-page";
import { markSheetReady, readCrew, stillBookPage, stillGraphFade } from "./sheet-page";

const params = new URLSearchParams(location.search);
stillBookPage();
stillGraphFade();

if (params.get("view") === "split" || params.get("view") === "full") {
  const lead = findElement(document, '[data-node="open_pr"] > .node-lead');
  const mark = document.createElement("i");
  mark.dataset.brand = "github";
  mark.dataset.size = "14";
  lead.replaceChildren(mark);
  readCrew().drawPlaceholders(lead);
}

if (params.get("runs") === "timeline") {
  const axis = document.querySelector("[data-run-day] > .axis");
  const band = document.querySelector(".open-pane .tab-band");
  if (axis === null || band === null) {
    throw new Error(
      "The book's timeline has no hour axis or no tab band. Check workflows.js's drawRunDay and the page's open workflow.",
    );
  }
  band.append(axis);
}

await markSheetReady();
