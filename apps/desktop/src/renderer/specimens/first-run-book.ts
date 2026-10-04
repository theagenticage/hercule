/**
 * Holds the Bureau book's desktop/first-run.html still for a capture, with
 * its card, step ladder and room showing, and marks it ready. Only the
 * prototype's controls that float over the page are hidden.
 * `node scripts/capture-first-run.ts` captures it beside the first-run
 * specimen, to compare the two.
 */
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
const style = document.createElement("style");
style.textContent = ".proto { visibility: hidden; }";
document.head.append(style);
await document.fonts.ready;
await markSheetReady();
