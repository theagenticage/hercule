/**
 * Edits the Bureau book's desktop/settings-profiles.html to show the
 * Settings > Permission profiles specimen's data, then marks the page ready.
 * `pnpm compare:bureau` imports this module into the book's page once
 * crew.js has drawn it, and compares the main pane with the app's
 * (settings-profiles.tsx), in the four states the book draws with `?state=`:
 * the list, `reviewer`, `shipped` and `confirm`. It also compares the pages of
 * Reviewer and `unrestricted` scrolled to the end of their body, which the
 * pages' lower sections need: both pages are opened with `?scrolled=1`, and
 * this module and the specimen scroll the section's body to its end.
 *
 * The book's profiles, their grant counts and the users it names are the
 * fixture's (settings-profiles-fixture.ts), so this module does not edit
 * them. It edits only where the app draws something else than the book, for
 * the reason given:
 *
 * 1. stops every animation, so the working faces show the frame the app
 *    draws;
 * 2. puts the users of each profile in the app's order: assistants first,
 *    then agents, each by name. The book lists them in the order it was
 *    written, such as triage-step before fix-step on `worker`;
 * 3. draws every agent in the idle pose, because an agent has no state the
 *    app could pose it from: only an assistant's session has a status. The
 *    book poses pr-review as working;
 * 4. draws each face in the look the app takes from the user's id, where the
 *    book casts or hashes it from the name;
 * 5. splits four texts into the text nodes the app's JSX makes: the Grants
 *    count ("16", " of ", "42"), the Delete heading ("Delete ", the name), the
 *    Used by lead before its link, and the dialog's second paragraph around
 *    the profile's name. The browser measures text that is split
 *    into nodes a fraction of a pixel (1/64) differently from one node, which
 *    shows in the pixel comparison;
 * 6. gives the dialog the shadow and rim the app's `.pop` has (menus.css, the
 *    one in the book's glance.html page): the book's own system.css `.pop`
 *    follows the glass level (`--glass-shadow`, `--glass-rim`) and draws a
 *    lighter shadow;
 * 7. opens the dialog as a modal `<dialog>` in the top layer, as the app
 *    does, instead of inside the book's fixed `.scrim`. The two draw the
 *    corners of the Change button a level apart.
 *
 * An edit that finds nothing to edit fails, because the book has changed and
 * the comparison would no longer compare what it claims to.
 */
import { describeProfileUsers, groupProfileUsers, type ProfileUser } from "@hercule/client-core";
import { buildLook } from "../faces/look";
import { findElement, findElements } from "./book-page";
import { markSheetReady, readCrew, stillBookPage } from "./sheet-page";
import { SETTINGS_PROFILES_RECORDS, SETTINGS_PROFILES_SCREEN } from "./settings-profiles-fixture";

/**
 * The pose each assistant is drawn in, from its session's status in the
 * fixture: Ada works, Milo is idle and Juno is asleep.
 */
const ASSISTANT_POSES: Readonly<Record<string, string>> = {
  Ada: "working",
  Milo: "idle",
  Juno: "asleep",
};

/** Returns the pose the app draws `user` in. Fails for an assistant the fixture does not pose. */
function decidePose(user: ProfileUser): string {
  if (user.kind === "agent") return "idle";
  const pose = ASSISTANT_POSES[user.name];
  if (pose === undefined) throw new Error(`The fixture poses no assistant named ${user.name}.`);
  return pose;
}

/**
 * Returns `user`'s face, at `size`, drawn by crew.js in the look the app
 * gives the user's id. The app takes the whole look from the id, while the
 * book casts or hashes it from the name, so the two differ unless the look is
 * passed in.
 */
function buildFace(user: ProfileUser, size: number): Element {
  const { hue, shape, accessories } = buildLook(user.id);
  const look = { hue, shape, acc: accessories.join("+") || "none" };
  const template = document.createElement("template");
  template.innerHTML = readCrew().face(user.name, { pose: decidePose(user), size, look });
  return template.content.firstElementChild!;
}

stillBookPage();

const popStyle = document.createElement("style");
popStyle.textContent = `
  .pop { box-shadow: inset 0 0 0 1px var(--line), inset 0 1px 0 var(--glass-edge), var(--shadow-3); }
  dialog.pop { border: 0; padding: 0; color: var(--ink); font-size: var(--t-13); margin: 18vh auto auto; }
  dialog.pop[open] { display: flex; flex-direction: column; }
  dialog.pop::backdrop { background: var(--scrim); }
`;
document.head.append(popStyle);

const users = groupProfileUsers(
  SETTINGS_PROFILES_SCREEN.agents,
  SETTINGS_PROFILES_RECORDS.assistants.map(({ assistant }) => assistant),
);
const profiles = SETTINGS_PROFILES_SCREEN.profiles;

/** Returns the users of the profile named `name`, in the app's order. */
function findUsers(name: string): ReadonlyArray<ProfileUser> {
  const profile = profiles.find((each) => each.name === name);
  if (profile === undefined) throw new Error(`The fixture has no profile named ${name}.`);
  return users.get(profile.id) ?? [];
}

// 2 to 4. The list's rows: the stack of faces, and the names after it.
const rows = findElements(document, "[data-rows] .prof", profiles.length);
for (const row of rows) {
  const rowUsers = findUsers(findElement(row, ".nm > b").textContent);
  const used = findElement(row, ".used");
  if (rowUsers.length === 0) {
    // The "Nothing" row has no stack, and the book already says "Nothing".
    continue;
  }
  const stack = document.createElement("span");
  stack.className = "stack";
  stack.append(...rowUsers.map((user) => buildFace(user, 24)));
  used.replaceChildren(stack, describeProfileUsers(rowUsers));
}

// 2 to 5. A profile's page: its users, one row each, and the count.
const record = findElement(document, "[data-record]") as HTMLElement;
if (!record.hidden) {
  const pageUsers = findUsers(findElement(document, ".bar .title").textContent);
  const userRows = findElements(record, "[data-users] .user", pageUsers.length);
  const count = findElement(record, "[data-count]");
  const [held, total] = count.textContent.split(" of ");
  count.replaceChildren(held!, " of ", total!);
  const deleteTitle = findElement(record, "[data-delete-title]");
  deleteTitle.replaceChildren("Delete ", deleteTitle.textContent.slice("Delete ".length));
  const usedByLead = findElement(record, ".set-sec > p > a").parentElement!;
  usedByLead.replaceChildren(
    "Change an assistant's profile on",
    " ",
    findElement(usedByLead, "a"),
    ".",
  );
  userRows.forEach((row, index) => {
    const user = pageUsers[index]!;
    findElement(row, ":scope > svg").replaceWith(buildFace(user, 30));
    findElement(row, ".set-label > b").textContent = user.name;
    findElement(row, ".set-label > span").textContent =
      user.kind === "agent" ? "Agent" : "Assistant";
  });
}

const dialogLead = findElement(document, "[data-confirm] .pop-sec > p:nth-of-type(2)");
const [beforeName, afterName] = dialogLead.textContent.split("unrestricted");
dialogLead.replaceChildren(beforeName!, "unrestricted", afterName!);

// 7. The book shows the dialog in its `.scrim` only in the confirm state.
const scrim = findElement(document, "[data-confirm]") as HTMLElement;
if (!scrim.hidden) {
  const pop = findElement(scrim, ".pop");
  const dialog = document.createElement("dialog");
  dialog.className = pop.className;
  dialog.setAttribute("aria-label", pop.getAttribute("aria-label")!);
  dialog.append(...pop.childNodes);
  scrim.replaceWith(dialog);
  dialog.showModal();
}

readCrew().drawPlaceholders(document);

if (new URLSearchParams(location.search).has("scrolled")) {
  const body = findElement(document, ".set-body");
  body.scrollTop = body.scrollHeight;
}

await markSheetReady();
