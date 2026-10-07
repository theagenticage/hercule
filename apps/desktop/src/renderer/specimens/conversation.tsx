/**
 * The Conversation specimen: the app's real shell with Ada's page open,
 * drawn from the records in conversation-fixture.ts. `pnpm compare:bureau`
 * compares its Conversation pixel for pixel with the Bureau book's
 * desktop/assistant.html, edited by conversation-reference.ts to show the
 * same data.
 *
 * The page takes its theme from `?theme=whitehaven` or `?theme=orient-express`.
 *
 * The open reply's face works, and its paws tap. The page removes every
 * animation, as the book's page is held still, so the paws rest where they
 * start. A capture taken mid-tap would differ from one run to the next, and
 * a paused animation still keeps the paws on a layer of their own, which
 * the browser draws a shade differently from the book's.
 */
// The fixed clock comes first: the app's age clock reads the time as soon as
// its module loads.
import "./fixed-clock";
import { CONVERSATION_PATH, CONVERSATION_RECORDS } from "./conversation-fixture";
import { mountSidebarSpecimen } from "./shell-page";
import { markSheetReady } from "./sheet-page";

await mountSidebarSpecimen(CONVERSATION_RECORDS, CONVERSATION_PATH);
if (document.querySelector(".atx .streaming") === null) {
  throw new Error("The Conversation specimen draws no open reply. Check the page's console.");
}
const style = document.createElement("style");
style.textContent = "* { animation: none !important; }";
document.head.append(style);
await markSheetReady();
