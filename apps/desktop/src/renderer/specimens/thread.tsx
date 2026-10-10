/**
 * The thread specimen: the app's real shell with the Fix thread open, drawn
 * from the records in thread-fixture.ts. `pnpm compare:bureau` compares its
 * main pane pixel for pixel with the Bureau book's session-active.html,
 * edited by thread-reference.ts to show the same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 * With `?state=scrolled`, it scrolls the transcript to where the book's
 * `?state=scrolled` page has it, and the composer shrinks as it does when
 * the user scrolls there. With `?state=warning`, the thread shows two
 * runtime warnings among its work, which the book never draws, so
 * `pnpm compare:bureau` does not compare that state. With `?state=steps`,
 * the first stretch holds a web search, a read that returned text and a
 * command that failed, for what an open stretch draws; the book draws no
 * open stretch, so that state is not compared either. With `?state=senders`,
 * other agents' messages are in its transcript and its queue: a thread's,
 * an assistant's and one from a session the user cannot read, beside the
 * user's own steered message. The book draws none of them either. With
 * `?state=permission`, the thread waits on no agent Request and the dock
 * shows a Permission Request instead; `?state=permissions` opens two, so the
 * pager shows, `?state=permission-scrolled` shrinks the composer, as
 * `?state=scrolled` does, and `?state=permission-unnamed` reads no profile of
 * the thread's, so "Add to profile" cannot be given. The book draws no
 * Permission Request, so none of these is compared; they are for comparing
 * by eye with its dock.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import {
  buildFixThreadWithPermissionRequests,
  FIX_THREAD,
  FIX_THREAD_WITH_RESULTS,
  FIX_THREAD_WITH_SENDERS,
  FIX_THREAD_WITH_WARNINGS,
  SENDERS_PAGE_RECORDS,
  THREAD_PAGE_RECORDS,
} from "./thread-fixture";
import { mountThreadSpecimen } from "./shell-page";
import { computeScrolledTop, markSheetReady } from "./sheet-page";

/**
 * Scrolls the transcript away from its bottom, to the top `computeTop`
 * returns for it, and returns once the composer has shrunk. Fails when the
 * page has no transcript.
 */
async function scrollTranscriptAway(computeTop: (transcript: Element) => number): Promise<void> {
  const transcript = document.querySelector(".transcript");
  if (transcript === null) throw new Error("The thread specimen draws no transcript.");
  // A reader scrolls only once the page has been drawn. By then the
  // transcript has noted that it opened at the bottom, so the scroll below
  // counts as a scroll up, which is what shrinks the composer.
  for (let frame = 0; frame < 2; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  // The composer shrinks after the scroll event, which arrives with a later
  // frame. The scroll is made again on each frame until then, because a
  // late change in the page's height can make the transcript follow its
  // bottom again before that event arrives.
  while (document.querySelector(".composer.is-scrolled") === null) {
    transcript.scrollTop = computeTop(transcript);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

const state = new URLSearchParams(location.search).get("state");
if (state === "senders") {
  await mountThreadSpecimen(SENDERS_PAGE_RECORDS, FIX_THREAD_WITH_SENDERS);
} else if (state?.startsWith("permission") === true) {
  const withRequests = buildFixThreadWithPermissionRequests(state === "permissions");
  const thread = state === "permission-unnamed" ? { ...withRequests, profiles: [] } : withRequests;
  await mountThreadSpecimen(
    {
      ...THREAD_PAGE_RECORDS,
      threads: THREAD_PAGE_RECORDS.threads.map((each) =>
        each.id === thread.session.id ? thread.session : each,
      ),
    },
    thread,
  );
} else {
  await mountThreadSpecimen(
    THREAD_PAGE_RECORDS,
    state === "warning"
      ? FIX_THREAD_WITH_WARNINGS
      : state === "steps"
        ? FIX_THREAD_WITH_RESULTS
        : FIX_THREAD,
  );
}
if (state === "scrolled") {
  // Where the book's `?state=scrolled` page has the transcript.
  await scrollTranscriptAway(computeScrolledTop);
} else if (state === "permission-scrolled") {
  // The Fix thread without its agent Request overflows the window by only a
  // few lines, so a scroll part of the way could land close enough to the
  // bottom to count as at the bottom. The top is always far enough away.
  await scrollTranscriptAway(() => 0);
}
await markSheetReady();
