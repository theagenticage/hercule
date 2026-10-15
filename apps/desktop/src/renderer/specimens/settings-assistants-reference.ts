/**
 * Edits the Bureau book's desktop/settings-assistants.html to show the
 * Settings > Assistants specimen's data and the rows the app draws, then
 * marks the page ready. `pnpm compare:bureau` imports this module into the
 * book's page once crew.js has drawn it, and compares the main pane with the
 * app's (settings-assistants.tsx).
 *
 * The app's section is taller than the window, so the pane is compared
 * twice: as it opens, and with `?state=scrolled`, where this module and the
 * specimen both scroll the section's body to its end.
 *
 * First it stops every animation, so the working faces show the frame the
 * app draws. Then it makes these edits, each where the app draws something
 * else than the book, for the reason given:
 *
 * 1. in the right-hand column, removes Reminders, which no operation reads
 *    yet (spec 17 §Settings, Assistants), and edits Memory where the app
 *    draws its records differently: the topics in name order, as the
 *    controller lists them, and a size under 1,000 characters as its exact
 *    count, as the app writes it, where the book writes "0.6k"; the core
 *    note as the fixture's whole text, cut after four lines by the app's
 *    rule, injected here, where the book cuts it by hand; and New topic
 *    under the list, which the book does not draw;
 * 2. removes the role after each tab's name, which an assistant does not
 *    have, and puts the tabs in name order, Ada, Juno and Milo, as the app
 *    and the sidebar sort assistants;
 * 3. draws every face from the fixture's assistant ids, in the book's poses,
 *    and sets Ada's hue from its id, as the app draws every assistant: the
 *    book casts each assistant by hand, with headwear the ids do not pick;
 * 4. removes the line under Ada's name and Open Conversation from the head:
 *    the app draws the name alone (Open Conversation comes with its own
 *    ticket);
 * 5. inserts the rows the app has and the book does not draw: Name and
 *    Persona before Provider, and Permission profile after it. The book has
 *    no design for them, so their pixels only hold the book-designed rows
 *    around them in place. The persona's text area is styled by the app's
 *    own rules, injected here, because the book has none: it grows with its
 *    text, with no scrollbar and no handle to resize it;
 * 6. sets the Provider row's value and each hint the app words differently.
 *    The app never says "she" or "her" of an assistant, so the reply mode's
 *    hint and the heartbeat's and rotation's leads are written neutrally;
 * 7. draws the beats as one mark per hour, as the app does, in place of the
 *    book's pattern repeated every 1/16 of the window. The marks sit at the
 *    same places as the pattern's stripes, but the browser rounds a box's
 *    edges to the screen's pixels differently from a pattern's, so the same
 *    places would differ by a pixel. The pattern also puts its 17th stripe,
 *    23:00, just outside the window, where it is cut off. The schedule beats
 *    at 23:00 too, and spec 17 draws a tick at each beat, so the app draws
 *    that tick just inside the window's end, and so does this edit;
 * 8. puts the "now" line and its label at 09:41 exactly, 581 of the day's
 *    1440 minutes, where the book rounds it to 9.68 hours. A tenth of a
 *    pixel would draw the line's edges differently;
 * 9. gives the timeline's axis the app's 14px below it, and inserts the
 *    heartbeat's Prompt row under it, which the book does not draw;
 * 10. removes the rotation's context meter and Start fresh, and the
 *    bindings, "Where Ada listens": no operation reads them yet;
 * 11. inserts the Delete section at the end, which the book does not draw;
 * 12. (unused: the lines that said the schedules were saved but not run
 *     yet went when the controller began to run them;)
 * 13. gives How Ada works a lead, which says when a saved change reaches
 *     the assistant's session: spec 12 §7 asks the Assistants settings
 *     screen to say so, and the book draws no lead there. The lead is
 *     styled by the app's rule, injected here;
 * 14. draws the Name field and the time fields, 07:00, 23:00 and 04:00, as
 *     text inputs, as the app does, styled by the app's rules, injected
 *     here. The browser draws an input's text one screen pixel higher or
 *     lower than the same text in a box at some fractional positions, so
 *     the book's text would differ from the app's wherever the rows above
 *     a field happen to put it at such a position;
 * 15. adds an Intake row after Threads in the settings list: the book
 *     predates Settings > Intake, and the app's list has the row.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import {
  describeWhenAssistantChangesApply,
  formatAccessMode,
  formatMemorySize,
} from "@hercule/client-core";
import { buildAssistantLook } from "../faces/look";
import { ADA, JUNO, MILO } from "./assistant-states-fixture";
import { findElement, findElementByText, findElements, insertIntakeSettingsRow } from "./book-page";
import { drawBookFace, markSheetReady, stillBookPage } from "./sheet-page";
import { ADA_CORE_NOTE, ADA_MEMORY, SETTINGS_ADA } from "./settings-assistants-fixture";

/** Returns a new `tag` element with the class `className`, holding `children`. */
function buildElement(
  tag: string,
  className: string,
  ...children: Array<Node | string>
): HTMLElement {
  const element = document.createElement(tag);
  if (className !== "") element.className = className;
  element.append(...children);
  return element;
}

/** Returns a `.set-row` with the label and the hint on the left and `control` on the right. */
function buildRow(label: string, hint: string, control: Element): HTMLElement {
  return buildElement(
    "div",
    "set-row",
    buildElement("div", "set-label", buildElement("b", "", label), buildElement("span", "", hint)),
    control,
  );
}

/** Returns a `.set-row--text`: the label and the hint above a text area holding `text`. */
function buildTextRow(label: string, hint: string, text: string): HTMLElement {
  const area = document.createElement("textarea");
  area.className = "field";
  area.value = text;
  const row = buildRow(label, hint, area);
  row.classList.add("set-row--text");
  return row;
}

/** Returns the `.set-row` whose label is `label`. */
function findRow(scope: ParentNode, label: string): HTMLElement {
  return findElementByText(scope, ".set-label b", label).closest(".set-row") as HTMLElement;
}

/** Sets the hint of the row labelled `label` to `hint`. */
function setHint(scope: ParentNode, label: string, hint: string): void {
  findElement(findRow(scope, label), ".set-label span").textContent = hint;
}

/** Returns the `.set-sec` whose heading's text is `heading`. */
function findSection(scope: ParentNode, heading: string): HTMLElement {
  return findElementByText(scope, ".set-sec > h2", heading).parentElement!;
}

stillBookPage();

// 15. The Intake row.
insertIntakeSettingsRow(document);

// The app's rules for what the book does not draw: a row that stacks its
// label over a text area, and the text area itself (settings.css), a
// heartbeat's mark and the line under a lead (schedule.css), How it works'
// lead and the core note cut after four lines (assistants.css), and a
// field that is a text input (controls.css and schedule.css).
const style = document.createElement("style");
style.textContent = `
.set-row.set-row--text { flex-direction: column; align-items: stretch; gap: 10px; }
.set-row--text > textarea.field { display: block; height: auto; min-height: calc(2lh + 16px); padding: 8px 11px; border: 0; outline: 0; font: inherit; line-height: 1.5; field-sizing: content; overflow: hidden; resize: none; }
.heartbeat-day-beat { position: absolute; top: 10px; width: 2px; height: 10px; background: var(--who); }
.heartbeat-day-beat[data-end] { transform: translateX(-100%); }
.set-sec > p.changes-lead { line-height: 19px; }
.field > input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; outline: 0; background: transparent; }
input.field { border: 0; }
.inline > input.field { field-sizing: content; }
.core-note { display: -webkit-box; white-space: pre-line; overflow: hidden; overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
`;
document.head.append(style);

const ada = SETTINGS_ADA;
const adaHue = `var(--hue-${buildAssistantLook(ADA.id).hue})`;
const record = findElement(document, ".set-body > .rec") as HTMLElement;

// 1. The Memory column: no reminders, the topics in name order, the whole
// core note, and New topic, drawn as the bindings' Bind a channel is.
const side = findElement(record, ".rec-side") as HTMLElement;
side.style.setProperty("--hue", adaHue);
const [memory, reminders] = findElements(side, ":scope > .side-sec", 2) as [Element, Element];
reminders.remove();
findElement(memory, ".core-note").textContent = ADA_CORE_NOTE.body;
const topics = findElements(memory, ".topic", 7).toSorted((a, b) =>
  findElement(a, "b").textContent < findElement(b, "b").textContent ? -1 : 1,
);
for (const topic of topics) {
  const size = findElement(topic, "small");
  const entry = ADA_MEMORY.find(({ name }) => name === findElement(topic, "b").textContent);
  if (entry === undefined) throw new Error("The book draws a topic the fixture does not hold.");
  size.textContent = formatMemorySize(entry.size);
}
const topicsFoot = findElement(memory, ".topics-foot");
topicsFoot.before(...topics);
const newTopic = findElement(record, ".bind-add").cloneNode(true) as HTMLElement;
newTopic.className = "btn btn--sm";
newTopic.style.alignSelf = "flex-start";
newTopic.style.marginTop = "12px";
newTopic.replaceChildren(findElement(newTopic, "svg"), "New topic");
topicsFoot.after(newTopic);

// 2. The tabs' roles, and the tabs in name order.
const people = findElement(record, ".people");
const tabs = findElements(people, ".person", 3);
for (const tab of tabs) findElement(tab, "small").remove();
const [adaTab, miloTab, junoTab] = tabs as [HTMLElement, HTMLElement, HTMLElement];
people.replaceChildren(adaTab, junoTab, miloTab);

// 3. The faces from the fixture's ids, and Ada's hue.
const TAB_FACES = [
  { tab: adaTab, id: ADA.id },
  { tab: junoTab, id: JUNO.id },
  { tab: miloTab, id: MILO.id },
];
for (const { tab, id } of TAB_FACES) {
  const face = findElement(tab, "svg.cr");
  face.replaceWith(redrawFace(face, id));
  // Each tab carries its own hue in the app, which only the picked tab shows.
  tab.style.setProperty("--hue", `var(--hue-${buildAssistantLook(id).hue})`);
}
const main = findElement(record, ".rec-main") as HTMLElement;
main.style.setProperty("--hue", adaHue);

// 4. The head: the face and the name alone.
const head = findElement(main, ".head");
head.replaceChildren(redrawFace(findElement(head, "svg.cr"), ADA.id), findElement(head, "h2"));

// 5, 6 and 13. How Ada works: the lead, and the app's rows, values and hints.
const howItWorks = findSection(main, `How ${ada.name} works`);
findElement(howItWorks, ":scope > h2").after(
  buildElement("p", "changes-lead", describeWhenAssistantChangesApply(ada.name)),
);
const provider = findRow(howItWorks, "Provider");
// The book sets the gap under the heading on its first row; the lead's margin sets it in the app.
provider.style.removeProperty("margin-top");
const nameField = buildElement("span", "field", buildTextInput(ada.name));
nameField.style.width = "214px";
const nameRow = buildRow(
  "Name",
  "The name it signs with, in the sidebar and in every channel.",
  nameField,
);
provider.before(
  nameRow,
  buildTextRow(
    "Persona",
    `Instructions added to every session ${ada.name} starts, on top of the provider’s own.`,
    ada.systemPrompt,
  ),
);
const providerValue = findElement(provider, ".field");
providerValue.replaceChildren(findElement(providerValue, "svg"), "Claude Code · Claude Sonnet 5");
const profileField = buildElement("span", "field field--select", "assistant");
profileField.style.minWidth = "214px";
provider.after(
  buildRow(
    "Permission profile",
    "What its sessions may reach: folders, network and secrets.",
    profileField,
  ),
);
setHint(howItWorks, "Access mode", "How much its sessions do without asking you first.");
const accessValue = findElement(findRow(howItWorks, "Access mode"), ".field");
accessValue.replaceChildren(findElement(accessValue, "svg"), formatAccessMode(ada.accessMode));
setHint(howItWorks, "Disallowed tools", `Tools ${ada.name}’s sessions may never use.`);
setHint(howItWorks, "Reply mode", "One message when the turn ends, or each part as it is written.");

// 6. The heartbeat's lead.
const heartbeat = findSection(main, "Heartbeat");
const heartbeatLead = findElement(heartbeat, ":scope > p");
heartbeatLead.textContent = `${ada.name} checks in on a schedule and only writes when something matters.`;

// 7. The beats as marks, one per hour from 07:00 to 23:00, the last one
// ending at its beat, under the "now" line as in the app. The marks use the
// app's rule, injected above.
const dayNow = findElement(heartbeat, ".day-now");
const dayWindow = findElement(heartbeat, ".day-window") as HTMLElement;
dayWindow.style.backgroundImage = "none";
for (let hour = 7; hour <= 23; hour++) {
  const beat = buildElement("i", "heartbeat-day-beat");
  beat.style.left = `${String((hour / 24) * 100)}%`;
  if (hour === 23) beat.dataset.end = "true";
  dayNow.before(beat);
}

// 8. "Now" at 09:41 exactly.
const NOW_LEFT = "calc(581 / 1440 * 100%)";
(dayNow as HTMLElement).style.left = NOW_LEFT;
(findElementByText(heartbeat, ".day-axis span", "now") as HTMLElement).style.left = NOW_LEFT;

// 9. The axis's space below, and the Prompt row.
const axis = findElement(heartbeat, ".day-axis") as HTMLElement;
axis.style.marginBottom = "14px";
axis.after(
  buildTextRow("Prompt", `What ${ada.name} is told at each heartbeat.`, ada.heartbeat.prompt),
);

// 6 and 10. The rotation's lead, and no meter.
const rotation = findSection(main, "Rotation");
const rotationLead = findElement(rotation, ":scope > p");
rotationLead.textContent = `${ada.name} starts a fresh context before the current one gets too full.`;
findElement(rotation, ".ctx").remove();

// 10. The bindings.
findSection(main, `Where ${ada.name} listens`).remove();

// 11. The Delete section.
const deleteButton = buildElement("button", "btn btn--danger", "Delete…");
const deleteRow = buildRow(
  "Delete assistant",
  "Removes it and its Conversation. Its sessions stay in the history.",
  deleteButton,
);
deleteRow.style.marginTop = "10px";
main.append(
  buildElement("section", "set-sec", buildElement("h2", "", `Delete ${ada.name}`), deleteRow),
);

// 14. The time fields as text inputs.
const timeFields = findElements(main, ".inline > .field", 7).filter((field) =>
  /^\d\d:\d\d$/.test(field.textContent),
);
if (timeFields.length !== 3) throw new Error("The book no longer draws three time fields.");
for (const field of timeFields) {
  const input = buildTextInput(field.textContent);
  input.className = field.className;
  field.replaceWith(input);
}

if (document.documentElement.dataset.state === "scrolled") {
  const body = findElement(document, ".set-body");
  body.scrollTop = body.scrollHeight;
}

await markSheetReady();

/** Returns a text input holding `value`, as the app draws a field the user types in. */
function buildTextInput(value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  return input;
}

/**
 * Returns the face of the assistant with id `id`, drawn by crew.js in the
 * look the app gives that id, in the pose and at the size of the book's face
 * `face`.
 */
function redrawFace(face: Element, id: string): Element {
  return drawBookFace(
    id,
    buildAssistantLook(id),
    readPose(face),
    Number(face.getAttribute("width")),
  );
}

/** Returns the pose the book drew `face` in, from the class crew.js gives its SVG. */
function readPose(face: Element): string {
  const pose = ["working", "idle", "asleep"].find((each) => face.classList.contains(`cr--${each}`));
  if (pose === undefined) throw new Error("The book's face carries no pose the app draws.");
  return pose;
}
