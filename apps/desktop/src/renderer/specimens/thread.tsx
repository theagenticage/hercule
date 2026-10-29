/**
 * The thread specimen: the app's real shell with the Fix thread open, drawn
 * from the records in thread-fixture.ts. `capture:ui` captures it and
 * `ui:metrics` measures it.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 * With `?state=scrolled`, it scrolls the transcript 42% of the way down (see
 * `computeScrolledTop`), and the composer shrinks as it does when the user
 * scrolls there. With `?state=warning`, the thread shows two
 * runtime warnings and a runtime error among its work. With
 * `?state=runtime-notices`, it shows runtime notices, a step the runner could not map
 * and a finished compaction among its work, and `?state=compacting` shows a
 * compaction that is still running. With
 * `?state=steps`, the first stretch holds a web search, a read that returned
 * text and a command that failed, for what an open stretch draws. With
 * `?state=senders`, other agents' messages are in its transcript and its
 * queue: a thread's, an assistant's and one from a session the user cannot
 * read, beside the user's own steered message. With
 * `?state=permission`, the thread waits on no agent Request and the dock
 * shows a Permission Request instead; `?state=permissions` opens two, so the
 * pager shows, `?state=permission-scrolled` shrinks the composer, as
 * `?state=scrolled` does, `?state=permission-unnamed` fails to read the
 * profiles, so "Add to profile" names none and cannot be given, and
 * `?state=permission-long-profile` names a profile of 128 characters with no
 * space, which the answer's line wraps. These states are for a check by eye. With
 * `?state=syncing`, the thread was opened from its
 * saved copy and the read that brings it up to date never answers, so the
 * header says "Syncing…" once 400 ms have passed. With `?state=long`, the thread has finished three turns of
 * long messages, with headings, lists, code and a link, enough to fill about
 * three windows of 900 px, and waits on nothing; the transcript opens at its
 * bottom.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import {
  buildFixThreadWithPermissionRequests,
  FIX_THREAD,
  FIX_THREAD_COMPACTING,
  FIX_THREAD_WITH_RUNTIME_NOTICES,
  FIX_THREAD_WITH_RESULTS,
  FIX_THREAD_WITH_SENDERS,
  FIX_THREAD_WITH_WARNINGS,
  SENDERS_PAGE_RECORDS,
  THREAD_PAGE_RECORDS,
} from "./thread-fixture";
import { FIX_THREAD_LONG } from "./thread-long-fixture";
import { mountThreadSpecimen, type ThreadScreenRecords } from "./shell-page";
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

/**
 * Mounts the shell with `thread` open and its session in the sidebar, so the
 * sidebar draws the same Requests the thread does.
 */
async function mountWithSidebarSession(thread: ThreadScreenRecords): Promise<void> {
  await mountThreadSpecimen(
    {
      ...THREAD_PAGE_RECORDS,
      threads: THREAD_PAGE_RECORDS.threads.map((each) =>
        each.id === thread.session.id ? thread.session : each,
      ),
    },
    thread,
  );
}

const state = new URLSearchParams(location.search).get("state");
if (state === "senders") {
  await mountThreadSpecimen(SENDERS_PAGE_RECORDS, FIX_THREAD_WITH_SENDERS);
} else if (state?.startsWith("permission") === true) {
  const withRequests = buildFixThreadWithPermissionRequests(state === "permissions");
  const thread =
    state === "permission-unnamed"
      ? { ...withRequests, profiles: null }
      : state === "permission-long-profile"
        ? {
            ...withRequests,
            profiles: (withRequests.profiles ?? []).map((profile) => ({
              ...profile,
              name: "staging_release_".repeat(8),
            })),
          }
        : withRequests;
  await mountWithSidebarSession(thread);
} else if (state === "long") {
  await mountWithSidebarSession(FIX_THREAD_LONG);
} else if (state === "syncing") {
  await mountThreadSpecimen(THREAD_PAGE_RECORDS, { ...FIX_THREAD, syncing: true });
} else {
  await mountThreadSpecimen(
    THREAD_PAGE_RECORDS,
    state === "warning"
      ? FIX_THREAD_WITH_WARNINGS
      : state === "runtime-notices"
        ? FIX_THREAD_WITH_RUNTIME_NOTICES
        : state === "compacting"
          ? FIX_THREAD_COMPACTING
          : state === "steps"
            ? FIX_THREAD_WITH_RESULTS
            : FIX_THREAD,
  );
}
if (state === "scrolled") {
  // 42% of the way down, so every capture scrolls to the same place.
  await scrollTranscriptAway(computeScrolledTop);
} else if (state === "permission-scrolled") {
  // The Fix thread without its agent Request overflows the window by only a
  // few lines, so a scroll part of the way could land close enough to the
  // bottom to count as at the bottom. The top is always far enough away.
  await scrollTranscriptAway(() => 0);
}
await markSheetReady();
