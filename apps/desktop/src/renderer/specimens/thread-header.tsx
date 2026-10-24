/**
 * The thread header specimen: the app's real shell with the lead of a piece of
 * work of ten Threads open, drawn from the records in
 * thread-header-fixture.ts. `pnpm compare:bureau` compares the header of its
 * main pane pixel for pixel with the header of the Workbench, refined
 * drawing's `?state=stress&header=a`, edited by thread-header-reference.ts to
 * show the same data. With `?state=menu`, it opens the "+n" menu, as the
 * drawing's `?state=menu` does.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { mountThreadSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";
import { THREAD_HEADER_RECORDS, THREAD_HEADER_THREAD } from "./thread-header-fixture";

// The pair compares the header alone, so what the transcript and the composer hold is hidden, as
// thread-header-reference.ts hides it on the drawing. The empty transcript still draws its
// "Starting..." line.
const hide = document.createElement("style");
hide.textContent = "main.main > :not(.top) > * { visibility: hidden; }";
document.head.append(hide);

await mountThreadSpecimen(THREAD_HEADER_RECORDS, THREAD_HEADER_THREAD);

if (new URLSearchParams(location.search).get("state") === "menu") {
  const overflow = document.querySelector<HTMLElement>("[data-tab-overflow]");
  if (overflow === null) throw new Error('The thread header draws no "+n" button to open.');
  overflow.click();
  // The menu opens in the top layer; wait for it before the capture.
  while (document.querySelector("[popover]:popover-open") === null) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}
await markSheetReady();
