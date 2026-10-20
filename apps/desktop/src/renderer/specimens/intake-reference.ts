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
 * 6. adds the avatar spec 17 draws before a message's author, and the
 *    pane's "More" button, neither of which the design draws;
 * 7. adds folded Tracking at the foot of the list, as the Tracking drawing
 *    (docs/design/tracking) draws it with nothing handed off, because the
 *    Intake design predates Tracking and the app always draws it.
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
// - the hourly triage: its tab, its section and its line in the header;
// - the "waiting" label under an asker's age;
// - the Stop asking answer and its M key, which spec 17 does not have;
// - the fine print under an answer, the provider and account it acts as,
//   which a signal's action does not carry;
// - the pane's foot: when the signal leaves the list, and what raised it.
findElement(document, "[data-asks-triage]").replaceChildren();
findElement(document, '[data-asks-tabs] [data-filter="triage"]').remove();
const triageHeading = findElement(document, '[data-flip="sec-triage"]');
triageHeading.nextElementSibling?.remove();
triageHeading.remove();
for (const label of document.querySelectorAll(".ask-waiting")) label.remove();
findElementByText(document, ".asks-detail .ans .btn", "Stop asking").closest(".ans")?.remove();
for (const fine of document.querySelectorAll(".asks-detail .ad-fine")) fine.remove();
findElement(document, ".asks-detail .ad-foot").remove();

// The design shows when Sentry's alert fired, 08:52, where every other row
// shows its age. Spec 17 gives every row its age, so the alert's row shows
// it here too: the fixture raised the alert 2 hours and 49 minutes ago.
findElement(document, '.ask-row[data-id="alert"] .ask-age').textContent = "2h";

// The All tab and the To do view count the triage findings removed above,
// so they count only the rows that are left.
const rowCount = String(document.querySelectorAll("[data-asks-list] .ask-row").length);
findElement(document, '[data-asks-tabs] [data-filter="all"] small').textContent = rowCount;
findElement(document, '[data-asks-head] [data-mode="todo"] small').textContent = rowCount;

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
// - the pane's foot lists Esc, which closes the pane;
// - the count of signals cleared today says "3 left on their own", not "3 of
//   them left on their own", and ends in "See Done." with a full stop, as the
//   spec writes it.
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
// Spec 17 gives the pane a menu, "More", after the Open button, for a
// plugin's signal with match values, and the review request has them. The
// design draws no menu, so the button is added with the book's more icon,
// drawn into a copy of the Open button's icon, and the app's rules from
// intake.css are copied in.
const openButton = findElement(kindLine, "[data-open]");
const moreIcon = findElement(openButton, "svg").cloneNode() as SVGSVGElement;
moreIcon.setAttribute("width", "14");
moreIcon.setAttribute("height", "14");
moreIcon.replaceChildren(
  ...["3.6", "8", "12.4"].map((cx) => {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", "8");
    dot.setAttribute("r", ".6");
    dot.setAttribute("fill", "currentColor");
    return dot;
  }),
);
const moreButton = document.createElement("button");
moreButton.className = "icon-btn icon-btn--sm ad-more";
moreButton.setAttribute("aria-label", "More");
moreButton.append(moreIcon);
openButton.after(moreButton);
const moreStyle = document.createElement("style");
moreStyle.textContent = `
  .ad-kind .btn--quiet:has(+ .ad-more) {
    margin-right: -6px;
  }
  .ad-more {
    margin-right: -6px;
  }
`;
document.head.append(moreStyle);

const asked = findElement(document, ".asks-detail .ad-asked");
const askedTime = document.createElement("time");
askedTime.textContent = "07:18";
asked.replaceChildren("Marta asks in payments-api #1294 · ", askedTime);

const keys = findElement(document, ".asks-detail .ad-keys");
findElementByText(keys, "span", "M stop asking").remove();
const escKey = document.createElement("span");
const escKbd = document.createElement("kbd");
escKbd.textContent = "Esc";
escKey.append(escKbd, " close");
keys.append(escKey);
const cleared = findElement(document, ".asks-cleared");
// The line's text before the "See Done" link is its first child.
const clearedCount = cleared.firstChild as Text;
clearedCount.data = clearedCount.data.replace(" of them left", " left");
cleared.append(".");

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

// Spec 17 §Tracking puts folded Tracking at the foot of the list on To do.
// The Intake design predates it, so the Tracking drawing's own stylesheet and
// its folded markup with nothing handed off are added (tracking.js,
// `buildFolded`): the head with the label alone, and the line that says what
// Tracking is for. The drawing lays the tray over the foot of the list and
// gives the list room under its last row for it, as tracking.js does. Only
// the tray's own rules apply: the page does not take the drawing's `rt-list`
// class, whose row rules are the Tracking drawing's and not Intake's.
const trackingStyle = document.createElement("link");
trackingStyle.rel = "stylesheet";
trackingStyle.href = new URL("../../../tracking/tracking.css", location.href).href;
const trackingStyleLoaded = new Promise((resolve, reject) => {
  trackingStyle.addEventListener("load", resolve, { once: true });
  trackingStyle.addEventListener("error", reject, { once: true });
});
document.head.append(trackingStyle);
await trackingStyleLoaded;
const tray = document.createElement("section");
tray.className = "rt-tray";
tray.setAttribute("data-tray", "");
tray.setAttribute("aria-label", "Tracking");
// The same elements, classes and attributes as the drawing's markup.
const trackingHead = document.createElement("h2");
trackingHead.className = "tr-bar";
const trackingButton = document.createElement("button");
trackingButton.className = "tr-bar-btn";
trackingButton.setAttribute("data-tracking-toggle", "");
trackingButton.title = "Show all of Tracking (T)";
const trackingLabel = document.createElement("span");
trackingLabel.className = "tr-label";
trackingLabel.append(document.createElement("span"));
trackingLabel.firstElementChild!.textContent = "Tracking";
trackingButton.append(trackingLabel);
trackingHead.append(trackingButton);
const trackingEmpty = document.createElement("p");
trackingEmpty.className = "tr-empty";
trackingEmpty.textContent = "Hand a signal to an agent, and follow it here until you mark it done.";
tray.append(trackingHead, trackingEmpty);
findElement(document, ".asks-list").append(tray);
const scroll = findElement(document, "[data-asks-list]") as HTMLElement;
scroll.style.paddingBottom = `${String(tray.offsetHeight + 12)}px`;

await markSheetReady();
