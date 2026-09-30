/**
 * The thread specimen: the app's real shell with the Fix thread open, drawn
 * from the records in thread-fixture.ts. `pnpm compare:bureau` compares its
 * main pane pixel for pixel with the Bureau book's session-active.html,
 * edited by thread-reference.ts to show the same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 * With `?state=scrolled`, it scrolls the transcript to where the book's
 * `?state=scrolled` page has it, and the composer shrinks as it does when
 * the user scrolls there.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { FIX_THREAD, THREAD_PAGE_RECORDS } from "./thread-fixture";
import { mountThreadSpecimen } from "./sidebar-page";
import { computeScrolledTop, markSheetReady } from "./sheet-page";

/**
 * Scrolls the transcript away from its bottom, to where the book's
 * `?state=scrolled` page has it, and returns once the composer has shrunk.
 * Fails when the page has no transcript.
 */
async function scrollTranscriptAway(): Promise<void> {
  const transcript = document.querySelector(".transcript");
  if (transcript === null) throw new Error("The thread specimen draws no transcript.");
  transcript.scrollTop = computeScrolledTop(transcript);
  // The composer shrinks after the scroll event, which arrives with a later frame.
  while (document.querySelector(".composer.is-scrolled") === null) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

await mountThreadSpecimen(THREAD_PAGE_RECORDS, FIX_THREAD);
if (new URLSearchParams(location.search).get("state") === "scrolled") {
  await scrollTranscriptAway();
}
await markSheetReady();
