/**
 * Shows only the room on the Bureau book's desktop/first-run.html in variant
 * B, and marks it ready to be captured: it holds the page still and hides the
 * card, the step ladder and the prototype's controls that float over the
 * room. `node scripts/capture-room.ts` captures it beside the room specimen,
 * to compare the two.
 */
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
const style = document.createElement("style");
style.textContent = ".fr-panel, .fr-ladder, .proto { visibility: hidden; }";
document.head.append(style);
await document.fonts.ready;
await markSheetReady();
