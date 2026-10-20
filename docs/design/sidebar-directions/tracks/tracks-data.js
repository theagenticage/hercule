// PROTOTYPE - what Tracks reads beyond the shared world (../shared/world.js): when each thread's
// turns ran, and when Rogier last looked at each piece of work.
//
// In the app both would be new reads (see the story page, "What it needs"):
//   - activity spans: the start and end of each turn, derived from the session's stored stream
//     (turn started, turn ended), for the last few hours, then kept live from the session
//     updates the app already receives;
//   - last looked: the last time Rogier had a thread of the piece of work open, which the
//     client keeps in localStorage, as it keeps the sidebar's layout.
//
// A span is [start, end]. An end of null means the turn is still running: it reaches now and
// keeps reaching it as time moves. Waiting and idle stretches are not spans: a thread waits from
// its last activity (world.js `last`) while it has an open Request, and is idle between spans.
(function () {
  "use strict";

  var SPANS = {
    // webshop: the 3-D Secure work
    t3ds: [["09:02", "09:04"], ["09:05", "09:07"], ["09:21", "09:26"], ["09:27", "09:29"], ["09:30", "09:31"]],
    tStripe: [["09:05", "09:11"], ["09:19", "09:21"]],
    t3dsReview: [["09:30", "09:34"], ["09:35", "09:38"], ["09:38", null]],
    // webshop: cart totals
    tCart: [["09:19", "09:23"], ["09:24", "09:25"], ["09:26", "09:33"], ["09:35", null]],
    tCartTests: [["09:24", "09:30"], ["09:32", null]],
    // webshop: lone threads
    tCss: [["07:12", "07:20"], ["07:24", "07:31"], ["07:34", "07:40"]],
    tA11y: [["08:40", "08:47"], ["08:49", "08:56"]],
    // payments-api
    tPayout: [["09:32", "09:35"], ["09:36", null]],
    tPayoutCheck: [["09:35", "09:39"]],
    tResult: [["08:48", "08:55"], ["08:58", "09:09"], ["09:10", "09:11"], ["09:12", "09:20"], ["09:32", null]],
    tResultReview: [["09:10", "09:18"], ["09:21", "09:31"], ["09:33", "09:34"]],
    tIdeal: [["08:30", "08:37"], ["08:39", "08:41"]],
    // ops
    tDash: [["08:58", "09:06"], ["09:08", "09:13"], ["09:14", "09:15"], ["09:16", "09:24"], ["09:30", "09:36"]],
    tDashAlerts: [["09:14", "09:22"], ["09:24", "09:29"]],
    tSecrets: [["09:30", "09:36"], ["09:37", null]],
    tSecretsVerify: [["09:41", null]],
    // no project
    tBun: [["06:50", "06:58"]],
  };

  // When Rogier last had a thread of each piece of work open, by its lead. The open piece of work
  // is being looked at now. `away` is the morning he stepped out at 09:01 for 40 minutes.
  var LOOKED = {
    t3ds: "09:41",
    tCart: "09:22",
    tCss: "07:41",
    tA11y: "08:57",
    tPayout: "09:33",
    tResult: "09:13",
    tIdeal: "08:42",
    tDash: "09:02",
    tSecrets: "09:31",
    tBun: "06:59",
  };
  var AWAY_FROM = "09:01";

  // The day sheet starts at 07:00; the sidebar's strips show the last hour. An hour is what a
  // 230px strip can show legibly (3.7px a minute); the day sheet holds the rest of the morning.
  var SHEET_FROM = "07:00";
  var STRIP_MINUTES = 60;

  window.TRACKS_DATA = {
    spans: SPANS,
    looked: LOOKED,
    awayFrom: AWAY_FROM,
    sheetFrom: SHEET_FROM,
    stripMinutes: STRIP_MINUTES,
  };
})();
