/**
 * Edits the Bureau book's desktop/assistant.html to show the Conversation
 * specimen's data, then marks the page ready. `pnpm compare:bureau` imports
 * this module into the book's page once crew.js has drawn it, and compares
 * the Conversation with the app's (conversation.tsx).
 *
 * First it stops every animation, so the working face and the caret show the
 * frame the app draws. Then it makes these edits, each where the app draws
 * something else than the book, for the reason given:
 *
 * 1. removes the bar at the top and the rail beside the Conversation, so the
 *    Conversation fills the pane at the thread's 760px column: the desktop
 *    draws the Conversation full width under a floating header, and opens
 *    the rail as a drawer (spec 17 §Design system, The assistant). The
 *    header and the drawer are not compared;
 * 2. puts an empty floating header before the transcript, so that the
 *    book's rule for a transcript under a floating header fades its top out
 *    as the app's does, and starts the column's first block at the header's
 *    clearance, 108px down;
 * 3. removes the quiet check-ins, the refs chips with the action button, and
 *    the reminder card: no operation reads them;
 * 4. sets each reply's time to the fixture's, where the first reads
 *    "heartbeat · 09:00": the app draws no heartbeat;
 * 5. sets the notice's text in one weight, and its time by the thread's
 *    rule, which names the day of a time that is not today;
 * 6. draws the mention chip as the plain name, "Milo": nothing says which
 *    assistant a name means. It also draws the open paragraph's inline code
 *    as plain text, because the app draws the paragraph being written as
 *    plain text until it ends;
 * 7. removes the composer's channel pick, its model pill and its lip: the
 *    desktop shows no channels, the model is a setting of the assistant, and
 *    the lip waits for memory and heartbeats;
 * 8. gives Stop Send's 4px left margin, as the thread's reference does: the
 *    app keeps it, so that the controls beside it do not move when a turn
 *    starts or ends;
 * 9. draws Ada's faces from the fixture's assistant id, as the app draws
 *    every assistant's face from its id. The book casts Ada by hand;
 * 10. sets Ada's hue on each reply, so that the name is drawn in her hue, as
 *    the book's `.msg-name` rule asks and the prototype draws it. The book's
 *    replies set no hue, so their names fall back to the ink.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { formatMessageTime, resolveBrowserTimezone } from "@hercule/client-core";
import { SPECIMEN_NOW } from "./sidebar-fixture";
import { findElement, findElements } from "./book-page";
import { drawBookFace, markSheetReady, stillBookPage } from "./sheet-page";
import { buildAssistantLook } from "../faces/look";
import { ADA } from "./assistant-states-fixture";
import { CONVERSATION_MESSAGES } from "./conversation-fixture";

const timezone = resolveBrowserTimezone();

/** Returns the time the app draws for the fixture's message by `role` at `index` among that role's messages. */
function formatFixtureTime(role: "assistant" | "notice", index: number): string {
  const message = CONVERSATION_MESSAGES.filter(({ senderRole }) => senderRole === role)[index];
  if (message === undefined) {
    throw new Error(`The Conversation fixture has no ${role} message ${String(index + 1)}.`);
  }
  return formatMessageTime(new Date(message.createdAt), timezone, new Date(SPECIMEN_NOW)) ?? "";
}

stillBookPage();

const main = findElement(document, "main.main");

// 1. The bar and the rail, and the column at the thread's width.
findElement(main, ".bar").remove();
findElement(main, ".rail").remove();
(findElement(main, ".split") as HTMLElement).style.gridTemplateColumns = "minmax(0, 1fr)";
const column = findElement(main, ".tx") as HTMLElement;
column.style.width = "min(760px, 100% - 48px)";

// 2. The floating header, empty, and its clearance.
const header = document.createElement("header");
header.className = "top";
findElement(main, ".transcript").before(header);
column.style.paddingTop = "var(--header-clearance)";

// 3. The quiet check-ins, the refs chips and the reminder card.
findElement(column, ".quiet").remove();
findElement(column, ".refs").remove();
findElement(column, ".reminder").remove();

// 4. The replies' times. The last reply is the one being written.
const replies = findElements(column, ".msg", 3);
replies.slice(0, 2).forEach((reply, index) => {
  findElement(reply, ".msg-name small").textContent = formatFixtureTime("assistant", index);
});

// 5. The notice in one weight, and its time.
const bold = findElement(column, ".notice b");
const noticeText = bold.parentElement!;
bold.replaceWith(bold.textContent);
// One text node, as the app draws it, so the browser shapes the line as one run.
noticeText.normalize();
findElement(column, ".notice .time").textContent = formatFixtureTime("notice", 0);

// 6. The mention chip and the open paragraph's code, as plain text.
const openParagraph = findElement(replies[2]!, ".msg-body > p");
findElement(openParagraph, ".mention").replaceWith("Milo");
for (const code of openParagraph.querySelectorAll("code")) code.replaceWith(code.textContent);
openParagraph.normalize();

// 7. The channel pick, the model pill and the lip.
const composer = findElement(main, "[data-composer]");
findElement(composer, ".composer-row > .pick:not(.pick--pill)").remove();
findElement(composer, ".pick--pill").remove();
findElement(composer, ".lip").closest(".fold")!.remove();

// 8. Send's margin on Stop.
(findElement(composer, ".stop") as HTMLElement).style.marginLeft = "4px";

// 9. Ada's faces, from her id, in the book's poses and sizes, in page order.
const BOOK_FACES = [
  { pose: "failed", size: 28 },
  { pose: "idle", size: 34 },
  { pose: "idle", size: 34 },
  { pose: "working", size: 34 },
];
const adaLook = buildAssistantLook(ADA.id);
findElements(column, ".notice > .cr, .msg > .cr", BOOK_FACES.length).forEach((face, index) => {
  const { pose, size } = BOOK_FACES[index]!;
  face.replaceWith(drawBookFace(ADA.id, adaLook, pose, size));
});

// 10. Ada's hue on each reply.
for (const reply of replies) {
  (reply as HTMLElement).style.setProperty("--hue", `var(--hue-${adaLook.hue})`);
}

await markSheetReady();
