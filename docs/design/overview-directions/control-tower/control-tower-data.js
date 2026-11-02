// PROTOTYPE - Control Tower's own data, on top of ../../sidebar-directions/shared/world.js and
// ../shared/world-plus.js. Load it after both. It adds WORLD.tower and changes no fact the two
// worlds state.
//
// Vocabulary (see ../BRIEF.md §7.2):
//   flight     a Turn: from an input until the agent goes idle
//   holding    an open Request, circling until Rogier clears it
//   approach   a busy thread predicted to need Rogier within about 15 minutes
//   cruising   a busy thread that will need him later, or has no prediction yet
//   on stand   an idle thread whose last turn ended after Rogier last looked (a result unread)
//   parked     an idle thread with nothing unread
//   hangar     Done
//   call sign  a short name for a thread: the project's two letters and the title's most telling
//              word, picked once when the title is written. A partner flies in its lead's
//              formation and takes the lead's call sign with its number: WS·3DS 2, WS·3DS 3.
//   slot       a time at which held Requests land together (landing slots)
(function () {
  "use strict";

  var W = window.WORLD;
  if (!W || !W.eta) throw new Error("control-tower-data.js: load world.js and world-plus.js first");

  W.tower = {
    // The two letters a project's call signs start with. A thread with no project has none.
    projectCodes: { webshop: "WS", "payments-api": "PA", ops: "OP" },

    // The title's most telling word, for every lead and lone thread (partners take their lead's).
    keywords: {
      t3ds: "3DS", tCart: "CART", tCss: "CSS", tA11y: "A11Y",
      tPayout: "PAYOUT", tResult: "RESULT", tIdeal: "IDEAL",
      tDash: "DASH", tSecrets: "SECRETS", tBun: "BUN",
      rShip: "SHIP",
      // the swarm
      sImg: "IMAGES", sApple: "APPLE", sCoupon: "COUPON", sDe: "GERMAN",
      sSig: "SIGNING", sRefunds: "REFUND", sRate: "RATE",
      sPg: "PG18", sBackups: "BACKUP", sDisk: "DISK", sTalk: "TALK",
    },

    /*
     * What a holding strip says, so its two quick answers complete the sentence:
     *   lead      the strip's words before the buttons
     *   answers   [label on the strip, label on the card, kind]; kind is "accent" (the one
     *             suggested answer), "quiet" (a decline) or "" (a neutral answer)
     *   more      extra answers only the selection card has room for
     *   code      true when the card shows the full ask as a command
     */
    asks: {
      t3ds: { lead: "Run git push?", answers: [["Allow", "Allow once", "accent"], ["Deny", "Deny", "quiet"]], more: [["Allow always", ""]], code: "git push -u origin fix/3ds-eu-cards" },
      tPayoutCheck: { lead: "Refunds by", answers: [["Settlement", "Settlement date", ""], ["Payout", "Payout date", ""]] },
      tDash: { lead: "Grafana folder?", answers: [["Keep", "Keep it", "accent"], ["Delete", "Delete it", "quiet"]] },
      rShip: { lead: "Publish to npm?", answers: [["Allow", "Allow once", "accent"], ["Deny", "Deny", "quiet"]], code: "npm publish payments-api@2.15.0" },
      // the swarm
      sAppleE2e: { lead: "Stripe's test card?", answers: [["Yes", "Yes, use it", "accent"], ["No", "No", "quiet"]] },
      sSigReview: { lead: "Run db:migrate?", answers: [["Allow", "Allow once", "accent"], ["Deny", "Deny", "quiet"]], code: "pnpm db:migrate" },
      sPgRollback: { lead: "Keep 17 a week?", answers: [["Keep", "Keep a replica", ""], ["No", "No", "quiet"]] },
      sDisk: { lead: "Run du -sh?", answers: [["Allow", "Allow once", "accent"], ["Deny", "Deny", "quiet"]], code: "du -sh /var/lib/docker" },
    },

    // What a flight brings Rogier when it lands, from WORLD.eta[id].next.
    brings: { request: "asks you", "turn-end": "a result" },

    // A Request may be marked urgent: it lands at once even when slots are on. In the slots state
    // the 3-D Secure push is, because its Task is.
    urgent: { t3ds: "Its Task is marked urgent: EU checkout fails." },

    /*
     * Landing slots, per state. Off by default. In the slots state Rogier lands requests on the
     * hour and the half hour: the four that asked between 09:31 and 09:39 wait for 10:00, except
     * the urgent push, which came through at 09:31.
     */
    slots: {
      off: { mode: "off", every: 30, until: "10:30", urgent: true },
      slots: { mode: "every", every: 30, until: "10:30", urgent: true },
    },

    /*
     * The conflict: three arrivals within 10:02-10:06. Staggering lands the one that asks first,
     * because holding a Request stalls its agent, and holds the two that only bring results to
     * read for later slots, which costs their agents nothing.
     */
    conflict: {
      ids: ["tPayout", "tCart", "tResult"],
      from: "10:02",
      to: "10:06",
      first: "tResult",
      hold: [
        { id: "tPayout", to: "10:15" },
        { id: "tCart", to: "10:30" },
      ],
      why: "Migrate payout endpoints asks before it pushes, so it lands first. The payout report and the cart refactor only bring results to read: they wait for 10:15 and 10:30, and neither agent stops.",
    },

    // Where each project's sector sits on the Radar, clockwise from 12 o'clock, in degrees. Fixed,
    // so a project is always in the same place.
    sectors: [
      { project: "webshop", from: -55, to: 55 },
      { project: "payments-api", from: 55, to: 165 },
      { project: "ops", from: 165, to: 275 },
      { project: null, from: 275, to: 305 },
    ],
  };
})();
