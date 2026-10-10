/**
 * Opens Marta's review request on the Intake design's page
 * (docs/design/intake-directions/asks/desktop/intake.html), then marks the
 * page ready. `pnpm compare:bureau` imports this module into the design's
 * page once asks.js has drawn it, and compares the main pane with the
 * Intake specimen's first scene (intake.tsx).
 *
 * The design's asks are the fixture's (intake-fixture.ts). It:
 *
 * 1. stops every animation and transition, so the list and the pane show
 *    where they end;
 * 2. hides the prototype's switcher bar, which the app does not have;
 * 3. clicks the review row, as the user would, because the design opens
 *    Slack's ask at first and reads `?ask=` only as it loads, while the
 *    comparison opens both pages with the same address;
 * 4. removes what the design draws ahead of the app, listed below;
 * 5. changes the design's words where spec 17 §Intake gives other ones,
 *    listed below;
 * 6. adds the avatar spec 17 draws before a message's author, which the
 *    design does not draw.
 *
 * It fails when the design has no review row, because the design has changed
 * and the comparison would no longer compare what it claims to.
 */
import { findElement, findElementByText, replaceTextAfterIcon } from "./book-page";
import { markSheetReady, stillBookPage } from "./sheet-page";

stillBookPage();
const style = document.createElement("style");
style.textContent = "* { transition: none !important; }";
document.head.append(style);

document.documentElement.setAttribute("data-bar-off", "");
(findElement(document, '[data-asks-list] .ask-row[data-id="review"]') as HTMLElement).click();

// The design draws parts that later tickets build, so they are removed here,
// after the click, because the click redraws the list and the pane:
// - the views over the list (To do, Later, Done, Everything);
// - the hourly triage: its tab, its section and its line in the header;
// - the "waiting" label under an asker's age;
// - the count of asks cleared today;
// - the Snooze… and Stop asking answers;
// - the fine print under an answer, the provider and account it acts as,
//   which a signal's action does not carry;
// - the pane's foot: when the signal leaves the list, and what raised it.
findElement(document, "[data-asks-head]").remove();
findElement(document, "[data-asks-triage]").replaceChildren();
findElement(document, '[data-asks-tabs] [data-filter="triage"]').remove();
const triageHeading = findElement(document, '[data-flip="sec-triage"]');
triageHeading.nextElementSibling?.remove();
triageHeading.remove();
for (const label of document.querySelectorAll(".ask-waiting")) label.remove();
findElement(document, ".asks-cleared").remove();
for (const label of ["Snooze…", "Stop asking"]) {
  findElementByText(document, ".asks-detail .ans .btn", label).closest(".ans")?.remove();
}
for (const fine of document.querySelectorAll(".asks-detail .ad-fine")) fine.remove();
findElement(document, ".asks-detail .ad-foot").remove();

// The design shows when Sentry's alert fired, 08:52, where every other row
// shows its age. Spec 17 gives every row its age, so the alert's row shows
// it here too: the fixture raised the alert 2 hours and 49 minutes ago.
findElement(document, '.ask-row[data-id="alert"] .ask-age').textContent = "2h";

// The All tab counts the triage findings removed above, so it counts only
// the rows that are left.
findElement(document, '[data-asks-tabs] [data-filter="all"] small').textContent = String(
  document.querySelectorAll("[data-asks-list] .ask-row").length,
);

// The design's clock stands at 11:20 and every specimen's at 09:41 (UTC), so
// Marta's message, sent 2 hours and 23 minutes before, shows 07:18 in the app.
findElement(document, ".asks-detail .b-msg-head time").textContent = "07:18";

// Spec 17 §Intake decides where it and the design disagree, so the design's
// words are changed to the ones the spec gives:
// - the middle section is "Signals", not "Asks";
// - the Now row shows its Your work line only when a thread or a Task is on
//   the signal, and the fixture's alert has neither, so the row shows who
//   asks, the kind and where;
// - the provenance line is the source's name and the kind's label, such as
//   "GitHub · Mentioned", and the place moves to the line under the title,
//   which names who asks, where and when;
// - the foot lists the keys this slice has: E and H come with Done and
//   Snooze (#525), M with Stop asking, which the spec does not have, and Esc
//   closes the pane.
const signalsHeading = findElement(document, '[data-flip="sec-asks"]');
signalsHeading.replaceChildren("Signals ", findElement(signalsHeading, ".count"));
const alertSub = findElement(document, '.ask-row[data-id="alert"] .ask-sub');
alertSub.textContent = "Sentry · alert for you · webshop-prod";

const kindLine = findElement(document, ".asks-detail .ad-kind");
const source = findElement(kindLine, ".src");
replaceTextAfterIcon(source, "GitHub · Review requested");
while (source.nextElementSibling?.classList.contains("spacer") === false) {
  source.nextElementSibling.remove();
}
const asked = findElement(document, ".asks-detail .ad-asked");
const askedTime = document.createElement("time");
askedTime.textContent = "07:18";
asked.replaceChildren("Marta asks in payments-api #1294 · ", askedTime);

const keys = findElement(document, ".asks-detail .ad-keys");
for (const label of ["E done", "H snooze", "M stop asking"]) {
  findElementByText(keys, "span", label).remove();
}
const escKey = document.createElement("span");
const escKbd = document.createElement("kbd");
escKbd.textContent = "Esc";
escKey.append(escKbd, " close");
keys.append(escKey);

// Spec 17 draws each message's author's avatar before the name, or the
// initials when there is none, and the design draws no avatars. The
// fixture's Marta has no avatar, so the app draws "M". The design has no
// `.b-avatar` rule, so the app's rule from intake.css is copied in, with the
// head's centring, which the app uses in place of the design's baseline so
// an avatar image sits level with the name.
const avatarStyle = document.createElement("style");
avatarStyle.textContent = `
  .b-msg-head {
    align-items: center;
  }
  .b-avatar {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 18px;
    height: 18px;
    overflow: hidden;
    border-radius: 50%;
    background: var(--sunken);
    color: var(--muted);
    font-size: 9px;
    font-weight: var(--w-bold);
  }
`;
document.head.append(avatarStyle);
const avatar = document.createElement("span");
avatar.className = "b-avatar";
avatar.setAttribute("aria-hidden", "true");
avatar.textContent = "M";
findElement(document, ".asks-detail .b-msg-head").prepend(avatar);

// GitHub labels its kinds itself (spec 05 §4.3). Spec 05 gives
// `github/review-requested` the label "Review requested", and the app labels
// `github/checks-failed` "Checks failed" from its id until GitHub declares
// its labels (#526). The design wrote its own labels for both.
findElement(document, '.ask-row[data-id="review"] .ask-sub').textContent =
  "Marta · review requested · payments-api #1294";
findElement(document, '.ask-row[data-id="checks"] .ask-sub').textContent =
  "GitHub Actions · checks failed · webshop #1300";

await markSheetReady();
