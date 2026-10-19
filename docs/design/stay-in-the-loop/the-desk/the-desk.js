// PROTOTYPE - The Desk. Results of work Rogier handed off land on Your desk in the Office, as
// folders in an in-tray. He signs them off when he chooses to sit down; only a question from a
// running piece of work rings the bell. This file holds the morning's content, the desk's state,
// how each part of the desk is drawn, the keys, the small simulation that makes things land, and
// the prototype bar.
//
// How the page is put together:
// - Every part of the desk is drawn from `state` by a render function (renderTray, renderOpen...).
//   A change updates `state`, then calls render(). Motion is added around a render, never instead
//   of it, so a skipped animation never leaves the page wrong.
// - Papers and folders are drawn in the light theme whatever the page's theme, because paper is
//   paper: their elements carry data-theme="whitehaven" (see the-desk.css).
// - Time is simulated: the clock starts at 09:41 and runs ten times faster than real time, so H4
//   lands about 12 seconds in and H7 about 40 seconds in.
(function () {
  "use strict";

  var Crew = window.Crew;
  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var START = 9 * 3600 + 41 * 60; // 09:41:00, in seconds since midnight
  var SPEED = 10; // simulated seconds per real second
  var TRUST_AT = 15; // results signed off unchanged in a row before Hercule offers to stop asking
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (params.get("bar") === "off") root.dataset.barOff = "";

  /* ------------------------------------------------------------------ small helpers */

  /** Returns the inline style that gives an element a colleague's hue, so --who and friends follow. */
  function hueOf(name) {
    return "--hue:var(--hue-" + Crew.lookFor(name).hue + ")";
  }
  function face(name, pose, size) {
    return Crew.face(name, { pose: pose || "idle", size: size || 24 });
  }
  /** Formats seconds since midnight as 09:41. */
  function clock(sec) {
    var m = Math.floor(sec / 60);
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  }
  /** Returns how long ago a time was, as "4m" or "1h 2m", against the simulated clock. */
  function age(sinceSec) {
    var m = Math.max(0, Math.floor((state.now - sinceSec) / 60));
    return m < 60 ? m + "m" : Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  function at(hhmm) {
    var p = hhmm.split(":");
    return Number(p[0]) * 3600 + Number(p[1]) * 60;
  }
  function $(sel, el) {
    return (el || document).querySelector(sel);
  }
  function $all(sel, el) {
    return Array.prototype.slice.call((el || document).querySelectorAll(sel));
  }

  /**
   * Returns a diff excerpt as HTML: a file name, then one row per line with its sign and number.
   * lines - [sign, number, text], where sign is " ", "+" or "-".
   */
  function diff(file, lines) {
    return (
      '<figure class="dk-diff"><figcaption><code>' + file + "</code></figcaption>" +
      lines
        .map(function (l) {
          var cls = l[0] === "+" ? " is-add" : l[0] === "-" ? " is-del" : "";
          return '<div class="dk-diff-row' + cls + '"><span class="dk-diff-n">' + (l[1] || "") + '</span><span class="dk-diff-s">' + (l[0] === " " ? "" : l[0] === "-" ? "−" : "+") + "</span><code>" + l[2] + "</code></div>";
        })
        .join("") +
      "</figure>"
    );
  }

  /**
   * Returns the confidence seal: a scalloped notary seal in the colleague's hue, with the level in
   * its middle. The hue says who sealed it; the word says how sure, so the level never rides on a
   * colour.
   */
  function seal(level) {
    var pts = [];
    for (var i = 0; i < 48; i++) {
      var a = (i / 48) * Math.PI * 2;
      var r = i % 2 ? 29 : 32;
      pts.push((32 + Math.cos(a) * r).toFixed(1) + "," + (32 + Math.sin(a) * r).toFixed(1));
    }
    return (
      '<span class="dk-seal" role="img" aria-label="' + level + ' confidence">' +
      '<svg viewBox="0 0 64 64" width="72" height="72" aria-hidden="true"><polygon points="' + pts.join(" ") + '" class="dk-seal-edge"/>' +
      '<circle cx="32" cy="32" r="26" class="dk-seal-ring"/><circle cx="32" cy="32" r="23.5" class="dk-seal-ring dk-seal-ring--in"/></svg>' +
      '<b' + (level.length > 4 ? ' class="dk-seal-long"' : "") + '>' + level + '</b><small>confidence</small></span>'
    );
  }

  /* ------------------------------------------------------------------ the morning's content */

  // What each result was handed from: the signal as Intake showed it. Space turns the folder over
  // to this side.
  var ASKED = {
    h1: { brand: "github", kind: "GitHub · Review requested", who: "Marta", title: "Retry Stripe webhooks with backoff", where: "rogier/payments-api #1294", at: "09:10", quote: "<code>feat/webhook-backoff</code> → <code>main</code> · 4 files <span class=\"plus\">+112</span> <span class=\"minus\">−18</span> · 3 commits · 18 checks passed", handed: "09:12" },
    h2: { brand: "slack", kind: "Slack · Tagged in a thread", who: "Pieter", title: "Codes with a trailing space are rejected", where: "#acceptance", at: "08:58", quote: "@rogier codes with a trailing space are rejected now. \"SUMMER10 \" fails, and it worked before. Customers paste them from emails.", handed: "09:05" },
    h3: { brand: "gmail", kind: "Gmail · Mail", who: "Marta Visser (Brightline)", title: "Invoice INV-2291 in the company name", where: "rogier@personal", at: "08:41", quote: "Hi Rogier, could you reissue INV-2291 in the company name instead of mine? Our finance team needs it for the books. Thanks, Marta", handed: "09:20" },
    h4: { brand: "linear", kind: "Linear · Question for you", who: "Jonas (Kiteworks)", title: "Refunds for partial captures", where: "PAY-212", at: "09:24", quote: "Can we refund a partially captured payment? We captured €80 of a €120 authorisation and the refund call fails.", handed: "09:33" },
    h5: { brand: "github", kind: "GitHub · Checks failed on your PR", who: "GitHub Actions", title: "Show VAT per line on invoices", where: "rogier/webshop #1300", at: "09:06", quote: "<code>test (ubuntu)</code> failed: <code>invoice.snap.ts › renders VAT per line</code>: Snapshot mismatch: \"29-09-2026 00:00\" vs \"28-09-2026 22:00\"", handed: "09:08" },
    h7: { brand: "grafana", kind: "Triage · Proposal, accepted 09:05", who: "Triage", title: "Nightly backup job timing out on ops-db", where: "ops", at: "09:00", quote: "3 nights in a row; the job hits its 2h limit at 04:00.", handed: "09:35" },
  };

  // The draft reply's first and second attempts, kept as plain text so the change view can diff them.
  var LETTER_1 =
    "Dear Ms. Visser,\n\nThank you for reaching out regarding invoice INV-2291. We would be happy to accommodate your request. Please find the reissued invoice made out to Brightline Ltd attached to this email.\n\nShould you have any further questions, please do not hesitate to contact us.\n\nKind regards,\nRogier Pennink\nAcme";
  var LETTER_2 =
    "Hi Marta,\n\nDone: attached is INV-2291-R, made out to Brightline B.V. (KvK 81234567). I voided the original INV-2291, so your finance team can book this one.\n\nBest,\nRogier";
  var LETTER_2_DENIED =
    "Hi Marta,\n\nThanks for the KvK number. I'll reissue INV-2291 for Brightline B.V. (KvK 81234567) and send it to you later today.\n\nBest,\nRogier";
  var ROGIER_NOTE_H3 = "It's Brightline B.V. (KvK 81234567). First names, short. Reissue it as INV-2291-R in Stripe and attach that.";
  var ROGIER_NOTE_H5 = "You may edit .github/workflows/test.yml";

  /** Returns a letter's text as paragraphs, with the uncertain phrase marked in the colleague's hue. */
  function letterBody(text, unsure) {
    return text
      .split("\n\n")
      .map(function (p) {
        var html = p.replace(/\n/g, "<br />");
        if (unsure) html = html.replace(unsure, '<mark class="dk-unsure">' + unsure + "</mark>");
        return "<p>" + html + "</p>";
      })
      .join("");
  }

  /** Returns the mail's head: from, to and subject, as Gmail would send it. */
  function mailHead(attachment, attachmentNote) {
    return (
      '<div class="dk-letterhead"><span class="dk-lh-mark">Acme</span><span class="dk-lh-rule"></span></div>' +
      '<dl class="dk-mailhead">' +
      "<div><dt>From</dt><dd>Rogier Pennink · Gmail · rogier@personal</dd></div>" +
      "<div><dt>To</dt><dd>Marta Visser &lt;marta@brightline.nl&gt;</dd></div>" +
      "<div><dt>Subject</dt><dd>Re: Invoice INV-2291 in the company name</dd></div>" +
      "</dl>" +
      (attachment ? '<p class="dk-attach">' + Crew.icon("file", 14) + "<code>" + attachment + "</code>" + (attachmentNote ? '<span class="dk-attach-note">' + attachmentNote + "</span>" : "") + "</p>" : "")
    );
  }

  var ORDINAL = ["", "1st", "2nd", "3rd", "4th"];

  /** Returns Send back's describe line: who gets the note, and which draft comes back. */
  function backDesc(r) {
    return "Clips a note and sends it back to <b>" + r.workflow + "</b> for a " + ORDINAL[(r.attempt || 1) + 1] + " draft";
  }
  /** Returns Take over's describe line, naming the machine the run's thread is on. */
  function takeDesc(r) {
    return "Opens the run's thread on <b>" + r.by.split(" · ").pop() + "</b>; you continue yourself";
  }

  /**
   * The results. Each one is a folder: who made it (workflow, its face, the model and machine),
   * when it was handed and when it landed, what it holds (doc), how sure the colleague is, and the
   * answers its routing slip offers. An answer's describe line is the core's: it says what the
   * press does, with live names in ink.
   */
  var RESULTS = {
    h1: {
      id: "h1",
      workflow: "Review PR",
      title: "Retry Stripe webhooks with backoff",
      ref: "#1294",
      by: "Claude Code · Sonnet 5 · build-box-2",
      handed: "09:12",
      landed: "09:20",
      ran: "7m 40s",
      status: "landed",
      confidence: "High",
      checked: "Read all 4 files and ran the tests: 18 passed.",
      kind: "review",
      doc: function () {
        return (
          '<header class="dk-doc-h"><span class="dk-doc-kind">' + Crew.brand("github", 13) + "Draft review, not posted</span>" +
          "<h2>Retry Stripe webhooks with backoff</h2>" +
          '<p class="dk-doc-ref">rogier/payments-api #1294 · <code>feat/webhook-backoff</code> → <code>main</code><br />4 files <span class="plus">+112</span> <span class="minus">−18</span> · 3 commits · 18 checks passed</p></header>' +
          '<p class="dk-verdict"><b>Approve, with 2 comments</b></p>' +
          '<p class="dk-editable">Exponential backoff with full jitter, base 2s, cap 30m. Idempotency keys survive retries, so a retry never double-books a payout. Safe to merge once the cap is configurable.</p>' +
          '<section class="dk-comment">' +
          diff("src/webhooks/retry.ts", [
            [" ", 40, "export function computeDelay(attempt: number): number {"],
            [" ", 41, "  const base = 2_000;"],
            ["+", 42, "  const cap = 30 * 60 * 1000;"],
            [" ", 43, "  return Math.random() * Math.min(cap, base * 2 ** attempt);"],
          ]) +
          '<p class="dk-editable">The 30-minute cap is hard-coded. Stripe retries for 3 days; read <code>WEBHOOK_RETRY_CAP_MS</code> so ops can raise it.</p></section>' +
          '<section class="dk-comment"><figure class="dk-diff"><figcaption><code>src/webhooks/retry.test.ts</code></figcaption></figure>' +
          '<p class="dk-editable">No test covers the jitter. A seeded random would make <code>computeDelay</code> testable.</p></section>'
        );
      },
      answers: function (r) {
        return [
          { act: "outward", label: "Post and sign off", kbd: "⌘↩", accent: true, desc: "Posts an approving review with <b>2 comments</b> on <b>#1294</b> in <b>rogier/payments-api</b> as <b>GitHub · rogier</b>", stamp: "Review posted", outcome: "Review posted on #1294" },
          { act: "sign", label: "Sign off", kbd: "S", desc: "Files it as signed off. The review is not posted", stamp: "Nothing sent", outcome: "Signed off, not posted" },
          { act: "back", label: "Send back", kbd: "B", desc: backDesc(r) },
          { act: "take", label: "Take over", kbd: "T", desc: takeDesc(r) },
          { act: "discard", label: "Discard draft", danger: true, desc: "Deletes the draft review. Nothing was posted, so GitHub is not told", stamp: "Discarded", outcome: "Draft discarded" },
        ];
      },
      undo: { label: "Dismiss review", desc: "Dismisses your review on <b>#1294</b> on GitHub. The 2 comments stay" },
    },

    h2: {
      id: "h2",
      workflow: "Fix bug",
      title: "Trim discount codes before lookup",
      ref: "#1302",
      by: "Claude Code · Opus 5.5 · studio-mac",
      handed: "09:05",
      landed: "09:27",
      ran: "22m",
      status: "seen",
      confidence: "High",
      checked: "Reproduced it with a failing test first.",
      kind: "pr",
      alsoReply: true,
      doc: function (r) {
        return (
          '<header class="dk-doc-h"><span class="dk-doc-kind">' + Crew.brand("github", 13) + "Draft pull request</span>" +
          "<h2>Trim discount codes before lookup</h2>" +
          '<p class="dk-doc-ref">rogier/webshop #1302 · <code>fix/trim-discount-codes</code> → <code>main</code><br />2 files <span class="plus">+14</span> <span class="minus">−3</span> · 26 checks passed</p></header>' +
          "<h3>Cause</h3>" +
          '<p>#1287 "Discount codes ignore letter case" replaced <code>code.trim()</code> with <code>code.toLowerCase()</code> in <code>normalizeCode</code>, so "SUMMER10 " no longer matches.</p>' +
          '<p class="dk-provenance">' + Crew.icon("undo", 14) + "<span>You signed off <b>#1287</b> yesterday at 19:12. This is where it came from.</span></p>" +
          "<h3>Fix</h3>" +
          diff("src/discounts/normalize.ts", [
            [" ", 14, "export function normalizeCode(code: string): string {"],
            ["-", 15, "  return code.toLowerCase();"],
            ["+", 15, "  return code.trim().toLowerCase();"],
            [" ", 16, "}"],
          ]) +
          diff("src/discounts/normalize.test.ts", [
            ["+", 31, 'it("accepts a code with a trailing space", () => {'],
            ["+", 32, '  expect(normalizeCode("SUMMER10 ")).toBe("summer10");'],
            ["+", 33, "});"],
          ]) +
          '<section class="dk-enclosure">' +
          '<div class="dk-enclosure-h">' + Crew.brand("slack", 13) + "<b>Also drafted, not sent:</b> a reply to Pieter in #acceptance</div>" +
          '<blockquote class="dk-editable">Fixed in #1302. It reaches acceptance with the next deploy.</blockquote>' +
          '<label class="dk-check"><span class="choice-box"><input type="checkbox" data-also-reply' + (r.alsoReply ? " checked" : "") + " />" + Crew.icon("check", 12) + "</span>Send it when I merge</label>" +
          "</section>"
        );
      },
      answers: function (r) {
        return [
          {
            act: "outward",
            label: "Merge and sign off",
            kbd: "⌘↩",
            accent: true,
            desc: "Squash-merges <b>#1302</b> into <b>main</b> in <b>rogier/webshop</b> as <b>GitHub · rogier</b>" + (r.alsoReply ? ", then replies to <b>Pieter</b> in <b>#acceptance</b> as <b>Slack · rogier</b>" : ""),
            stamp: r.alsoReply ? "Merged · replied" : "Merged",
            outcome: r.alsoReply ? "Merged #1302 · replied to Pieter" : "Merged #1302",
          },
          { act: "sign", label: "Sign off", kbd: "S", desc: "Files it as signed off. #1302 stays a draft and Pieter is not told", stamp: "Nothing sent", outcome: "Signed off, #1302 left open" },
          { act: "back", label: "Send back", kbd: "B", desc: backDesc(r) },
          { act: "take", label: "Take over", kbd: "T", desc: takeDesc(r) },
          { act: "discard", label: "Close #1302", danger: true, desc: "Closes <b>#1302</b> on GitHub and deletes <b>fix/trim-discount-codes</b>", stamp: "Closed", outcome: "Closed #1302" },
        ];
      },
      undo: { label: "Revert #1302", desc: "Opens a pull request in <b>rogier/webshop</b> that reverts <b>#1302</b>. The reply to Pieter stays sent" },
    },

    h3: {
      id: "h3",
      workflow: "Draft reply",
      title: "Invoice INV-2291 in the company name",
      ref: "Marta Visser",
      by: "Claude Code · Haiku 4.5 · build-box-2",
      handed: "09:20",
      landed: "09:22",
      ran: "2m 10s",
      status: "landed",
      attempt: 1,
      confidence: "Medium",
      unsure: "I couldn't find Brightline's legal name in earlier mail, so I guessed 'Ltd'. I attached the existing invoice; I can't create invoices.",
      kind: "mail",
      doc: function (r) {
        if (r.attempt === 2) return letter2Doc(r);
        return (
          mailHead("INV-2291.pdf", "still in Marta's name") +
          "<!--unsure-->" +
          '<div class="dk-letter dk-editable">' + letterBody(LETTER_1, "Brightline Ltd") + "</div>" +
          '<p class="dk-saved">' + Crew.brand("gmail", 13) + "Saved in Gmail Drafts at 09:22</p>"
        );
      },
      answers: function (r) {
        var file = r.attempt === 2 ? (r.denied ? "" : "INV-2291-R.pdf") : "INV-2291.pdf";
        return [
          { act: "outward", label: "Send and sign off", kbd: "⌘↩", accent: true, desc: "Sends the reply to <b>Marta Visser</b> from <b>Gmail · rogier@personal</b>" + (file ? " with <b>" + file + "</b>" : ""), stamp: "Reply sent", outcome: "Reply sent to Marta Visser" },
          { act: "sign", label: "Sign off", kbd: "S", desc: "Files it as signed off. The draft stays in Gmail Drafts and nothing is sent", stamp: "Nothing sent", outcome: "Signed off, draft kept" },
          { act: "back", label: "Send back", kbd: "B", desc: backDesc(r) },
          { act: "take", label: "Take over", kbd: "T", desc: takeDesc(r) },
          { act: "discard", label: "Discard draft", danger: true, desc: "Deletes the draft from Gmail Drafts. Marta is not told", stamp: "Discarded", outcome: "Draft discarded" },
        ];
      },
      undo: null,
    },

    h4: {
      id: "h4",
      workflow: "Investigate",
      title: "Refunds for partial captures",
      ref: "PAY-212",
      by: "Codex · gpt-5.4 · build-box-1",
      handed: "09:33",
      landed: "09:43",
      ran: "10m",
      status: "landed",
      confidence: "High",
      checked: "Reproduced the cause with a failing test.",
      unsure: "I did not call Stripe's test mode.",
      kind: "findings",
      doc: function () {
        return (
          '<header class="dk-doc-h"><span class="dk-doc-kind">' + Crew.brand("linear", 13) + "Findings · PAY-212</span>" +
          "<h2>Refunds for partial captures</h2>" +
          '<p class="dk-doc-ref">Asked by Jonas at Kiteworks · payments-api</p></header>' +
          "<h3>Answer</h3>" +
          "<p>Yes, Stripe allows it. <code>createRefund</code> defaults <code>amount</code> to <code>payment.amountAuthorized</code> when no amount is given. For a partial capture that is €120, more than the €80 captured, so Stripe returns <code>amount_too_large</code>. Passing an explicit amount works today; the fix is one line at <code>src/refunds/refund.ts:88</code>.</p>" +
          diff("src/refunds/refund.ts", [
            [" ", 87, "const amount = input.amount"],
            [" ", 88, "  ?? payment.amountAuthorized; // should be amountCaptured"],
          ]) +
          "<h3>How it checked</h3>" +
          '<ol class="dk-steps"><li><span>09:33</span><span>Read PAY-212 and its 3 comments</span></li><li><span>09:35</span><span>Searched payments-api for partial captures: 6 places</span></li><li><span>09:37</span><span>Read <code>src/refunds/refund.ts</code></span></li><li><span>09:39</span><span>Ran <code>pnpm test refunds</code>: 31 passed</span></li><li><span>09:42</span><span>Wrote a failing test for a refund after a partial capture</span></li></ol>' +
          '<section class="dk-enclosure"><div class="dk-enclosure-h">' + Crew.brand("linear", 13) + "<b>The answer it would post</b> on PAY-212</div>" +
          '<blockquote class="dk-editable">Yes. Until we fix the default, pass the captured amount explicitly (<code>amount: 8000</code>). Without it we refund the authorised €120, and Stripe refuses with <code>amount_too_large</code>.</blockquote></section>'
        );
      },
      answers: function (r) {
        return [
          { act: "outward", label: "Reply and sign off", kbd: "⌘↩", accent: true, desc: "Posts the answer on <b>PAY-212</b> as <b>Linear · rogier</b>", stamp: "Answer posted", outcome: "Answered on PAY-212" },
          { act: "sign", label: "Sign off", kbd: "S", desc: "Files the findings. Nothing is posted on PAY-212", stamp: "Nothing sent", outcome: "Signed off, not posted" },
          { act: "back", label: "Send back", kbd: "B", desc: backDesc(r) },
          { act: "take", label: "Take over", kbd: "T", desc: takeDesc(r) },
          { act: "hand", label: "Hand to Fix bug", desc: "Starts <b>Fix bug</b> on <b>payments-api</b> with these findings as its input", stamp: "Handed on", outcome: "Handed to Fix bug" },
        ];
      },
      undo: { label: "Delete the answer", desc: "Deletes your comment on <b>PAY-212</b> as <b>Linear · rogier</b>" },
    },

    h5: {
      id: "h5",
      workflow: "Fix bug",
      title: "Show VAT per line on invoices",
      ref: "#1300",
      by: "Claude Code · Sonnet 5 · build-box-1",
      handed: "09:08",
      landed: "09:26",
      ran: "18m",
      status: "failed",
      attempt: 1,
      kind: "failed",
      doc: function (r) {
        if (r.attempt === 2) {
          return (
            '<header class="dk-doc-h"><span class="dk-doc-kind">' + Crew.brand("github", 13) + "Fixed on your pull request</span>" +
            "<h2>Show VAT per line on invoices</h2>" +
            '<p class="dk-doc-ref">rogier/webshop #1300 · 1 commit pushed · 31 checks passed</p></header>' +
            "<p>Pinned the test runner's time zone, so the snapshot formats dates the same on CI as on your machine. Checks re-ran on #1300 and pass.</p>" +
            diff(".github/workflows/test.yml", [
              [" ", 18, "    runs-on: ubuntu-latest"],
              ["+", 19, "    env:"],
              ["+", 20, "      TZ: Europe/Amsterdam"],
            ]) +
            '<p class="dk-provenance">' + Crew.icon("undo", 14) + "<span>Attempt 2, after your note: \"" + ROGIER_NOTE_H5 + "\"</span></p>"
          );
        }
        return (
          '<header class="dk-doc-h"><span class="dk-doc-kind dk-doc-kind--fail">' + Crew.mark("failed", 13) + "Failed at 09:26 after 18m</span>" +
          "<h2>Show VAT per line on invoices</h2>" +
          '<p class="dk-doc-ref">rogier/webshop #1300 · <code>test (ubuntu)</code> failed</p></header>' +
          '<p class="dk-reason">Gave up after 3 tries. The snapshot differs only on CI: the runner\'s time zone is UTC and the test formats dates in local time. Pinning the zone needs a change to <code>.github/workflows/test.yml</code>, which this run may not edit.</p>' +
          "<h3>What it tried</h3>" +
          '<ol class="dk-steps"><li><span>1</span><span>Formatted the date in the test with a fixed zone: other snapshots broke</span></li><li><span>2</span><span>Mocked the clock in <code>invoice.snap.ts</code>: still 2 hours off on CI</span></li><li><span>3</span><span>Set <code>TZ</code> in <code>.github/workflows/test.yml</code>: refused, the file is outside what this run may edit</span></li></ol>' +
          "<h3>Partial work</h3>" +
          '<p class="dk-partial">' + Crew.icon("branch", 14) + "<code>fix/invoice-snapshot-tz</code><span>1 commit, not pushed · build-box-1</span></p>"
        );
      },
      answers: function (r) {
        if (r.attempt === 2) {
          return [
            { act: "sign", label: "Sign off", kbd: "S", accent: true, desc: "Files it as signed off. The commit is already on #1300", stamp: "Signed off", outcome: "Fixed on #1300" },
            { act: "back", label: "Send back", kbd: "B", desc: backDesc(r) },
            { act: "take", label: "Take over", kbd: "T", desc: takeDesc(r) },
          ];
        }
        return [
          { act: "again", label: "Try again with a note", kbd: "B", accent: true, desc: "Starts <b>Fix bug</b> again on <b>fix/invoice-snapshot-tz</b> with your note" },
          { act: "take", label: "Take over", kbd: "T", desc: "Opens the run's thread on <b>build-box-1</b>, with the branch as it was left" },
          { act: "letgo", label: "Let it go", kbd: "S", desc: "Files it as failed. <b>fix/invoice-snapshot-tz</b> stays on build-box-1, unpushed", stamp: "Let go", outcome: "Let go, branch kept" },
        ];
      },
      undo: null,
    },

    h7: {
      id: "h7",
      workflow: "Investigate",
      title: "Nightly backup job timing out on ops-db",
      ref: "ops-db",
      by: "Codex · gpt-5.4 · build-box-1",
      handed: "09:35",
      landed: "09:47",
      ran: "12m",
      status: "landed",
      confidence: "Medium",
      unsure: "Measured on a copy, not on ops-db.",
      kind: "findings",
      doc: function () {
        return (
          '<header class="dk-doc-h"><span class="dk-doc-kind">' + Crew.brand("grafana", 13) + "Findings · on the Task</span>" +
          "<h2>Nightly backup job timing out on ops-db</h2>" +
          '<p class="dk-doc-ref">From triage\'s proposal, accepted 09:05 · ops</p></header>' +
          "<!--unsure-->" +
          "<h3>Cause</h3>" +
          "<p><code>pg_dump</code> of <code>events</code> (41 GB) takes 1h 52m; the job's limit is 2h. Any slow night tips it over.</p>" +
          "<h3>Two ways out</h3>" +
          '<ol class="dk-options"><li><b>Dump <code>events</code> in parallel</b> with <code>--jobs 4</code>: 38m on a copy.</li><li><b>Drop the 90-day-old partitions</b> the sweep already ignores.</li></ol>'
        );
      },
      answers: function (r) {
        return [
          { act: "hand", label: "Hand to Fix bug", kbd: "⌘↩", accent: true, desc: "Starts <b>Fix bug</b> on <b>ops</b> with the first way out as its input", stamp: "Handed on", outcome: "Handed to Fix bug" },
          { act: "sign", label: "Sign off", kbd: "S", desc: "Files the findings on the Task. Nothing else happens", stamp: "Signed off", outcome: "Findings filed on the Task" },
          { act: "back", label: "Send back", kbd: "B", desc: backDesc(r) },
          { act: "take", label: "Take over", kbd: "T", desc: takeDesc(r) },
        ];
      },
      undo: null,
    },
  };

  // A brass paperclip holding Rogier's note to the second draft.
  var PAPERCLIP =
    '<svg class="dk-clip" viewBox="0 0 14 30" width="14" height="30" aria-hidden="true"><path d="M4 9V24a3.5 3.5 0 0 0 7 0V6a2.5 2.5 0 0 0-5 0v16.5a1 1 0 0 0 2 0V9" fill="none" stroke="var(--brass)" stroke-width="1.6" stroke-linecap="round"/></svg>';

  /** Returns the second draft's paper: the letter, or what changed from the first draft. */
  function letter2Doc(r) {
    var text = r.denied ? LETTER_2_DENIED : LETTER_2;
    var body = state.showChanges ? '<div class="dk-letter dk-letter--diff">' + wordDiff(LETTER_1, text) + "</div>" : '<div class="dk-letter dk-editable">' + letterBody(text) + "</div>";
    return (
      '<aside class="dk-slip dk-slip--filed" data-theme="whitehaven">' + PAPERCLIP + Crew.you(18) + "<span><b>Your note, " + r.noteAt + "</b>" + ROGIER_NOTE_H3 + "</span></aside>" +
      mailHead(r.denied ? "" : "INV-2291-R.pdf", r.denied ? "" : "made out to Brightline B.V.") +
      '<div class="seg dk-diff-seg" role="tablist" aria-label="Show"><button role="tab" aria-selected="' + !state.showChanges + '" data-changes="off">2nd draft</button><button role="tab" aria-selected="' + state.showChanges + '" data-changes="on">Changes from the 1st <kbd>D</kbd></button></div>' +
      "<!--unsure-->" +
      body +
      (r.denied ? "" : '<p class="dk-saved">' + Crew.brand("stripe", 13) + "You allowed it to void INV-2291 and create INV-2291-R in Stripe · live at " + r.allowedAt + "</p>")
    );
  }

  /**
   * Returns a word-by-word diff of two texts as HTML. Removed words are struck through and added
   * words marked, and each run of changes shows all its removed words before its added ones, so a
   * rewritten sentence reads as "old, then new" instead of a word-by-word zigzag. Paragraph breaks
   * are kept from the new text. A longest common subsequence over words is plenty for a letter.
   */
  function wordDiff(a, b) {
    function words(t) {
      return t.replace(/\n\n/g, " \u00b6 ").replace(/\n/g, " \u21b5 ").split(/\s+/).filter(Boolean);
    }
    var A = words(a);
    var B = words(b);
    var n = A.length;
    var m = B.length;
    var L = [];
    for (var i = 0; i <= n; i++) L.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    var ops = [];
    i = 0;
    j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        ops.push(["=", A[i]]);
        i++;
        j++;
      } else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) ops.push(["-", A[i++]]);
      else ops.push(["+", B[j++]]);
    }
    function text(list) {
      return list.join(" ").replace(/ ?\u00b6 ?/g, "<br /><br />").replace(/ ?\u21b5 ?/g, "<br />");
    }
    var out = [];
    var del = [];
    var add = [];
    function flush() {
      if (del.length) out.push('<span class="dk-del">' + text(del.filter(function (w) { return w !== "\u00b6" && w !== "\u21b5"; })) + "</span>");
      if (add.length) out.push('<span class="dk-add">' + text(add) + "</span>");
      del = [];
      add = [];
    }
    ops.forEach(function (o) {
      if (o[0] === "=") {
        flush();
        out.push(text([o[1]]));
      } else (o[0] === "-" ? del : add).push(o[1]);
    });
    flush();
    return "<p>" + out.join(" ").replace(/ (<br \/>)/g, "$1").replace(/(<br \/>) /g, "$1") + "</p>";
  }

  // The trust ledger: the last 30 days per workflow, as results signed off unchanged and the rest.
  // "streak" counts the unchanged ones in a row, newest last.
  var TRUST = [
    { workflow: "Review PR", total: 14, unchanged: 14, streak: 14, marks: "uuuuuuuuuuuuuu" },
    { workflow: "Draft reply", total: 20, unchanged: 17, streak: 6, marks: "uuuuubuuuuuutuuubuuu".slice(0, 20) },
    { workflow: "Fix bug", total: 12, unchanged: 9, streak: 3, marks: "uuubuufuubuu" },
    { workflow: "Investigate", total: 6, unchanged: 6, streak: 6, marks: "uuuuuu" },
  ];

  // The offer Hercule makes when Review PR reaches TRUST_AT in a row. It lands as a folder, like
  // everything else, so it never interrupts.
  var OFFER = {
    id: "offer",
    workflow: "Hercule",
    title: "Let Review PR post without stopping at your desk",
    ref: "15 in a row, unchanged",
    by: "Hercule",
    handed: "",
    landed: "",
    status: "landed",
    kind: "offer",
    doc: function () {
      return (
        '<header class="dk-doc-h"><span class="dk-doc-kind">' + Crew.icon("shield", 14) + "An offer from Hercule</span>" +
        "<h2>Let Review PR post without stopping at your desk</h2>" +
        '<p class="dk-doc-ref">You signed off its last 15 results without changing a word</p></header>' +
        '<div class="dk-ticks dk-ticks--big" aria-hidden="true" style="' + hueOf("Review PR") + '">' + new Array(16).join('<i class="is-u"></i>') + "</div>" +
        "<h3>What changes</h3>" +
        '<ul class="dk-bullets"><li>Review PR gets a last step, <b>Post review</b>, that posts as <b>GitHub · rogier</b>.</li><li>From its next run on, the review is posted when the run ends. You are not asked first.</li><li>The result still lands on your desk, already posted and signed off, so you can read it after.</li></ul>' +
        "<h3>What it is underneath</h3>" +
        "<p>An edit to the workflow Review PR, saved by you. A workflow's own steps run with your authority, so your click here is what allows it. Hercule never makes this change by itself, and it shows in the workflow's history.</p>"
      );
    },
    answers: function (r) {
      return [
        { act: "trust", label: "Let it post", kbd: "⌘↩", accent: true, desc: "Saves <b>Review PR</b> with a last step that posts each review on GitHub as <b>GitHub · rogier</b>", stamp: "Allowed", outcome: "Review PR now posts by itself" },
        { act: "sign", label: "Not now", kbd: "S", desc: "Keeps Review PR stopping at your desk. Asks again after 15 more", stamp: "Not now", outcome: "Offer declined" },
        { act: "discard", label: "Never for Review PR", quiet: true, desc: "Stops offering this for Review PR", stamp: "Never", outcome: "Won't be offered again" },
      ];
    },
    undo: null,
  };
  RESULTS.offer = OFFER;

  // What the swarm's bundles hold: five more Review PR results besides H1, all high confidence.
  var SWARM_PRS = [
    ["h1", "#1294", "Retry Stripe webhooks with backoff", "Approve, 2 comments"],
    ["s2", "#1295", "Bump stripe-node to 14.2.1", "Approve"],
    ["s3", "#1297", "Idempotency key on payout requests", "Approve, 1 comment"],
    ["s4", "#1301", "Log webhook signature failures", "Approve"],
    ["s5", "#1303", "Tidy refund error messages", "Approve, 1 comment"],
    ["s6", "#1305", "Cache exchange rates for an hour", "Approve, 1 comment"],
  ];

  /* ------------------------------------------------------------------ state */

  var state = {
    view: "desk", // "desk" or "floor"
    now: START,
    playing: true,
    tray: [], // the in-tray, top first: result ids, or bundle ids in the swarm
    open: null, // the result open on the blotter
    filedOpen: null, // an out-tray entry opened again, read-only
    flipped: false,
    showChanges: false,
    slip: null, // the note slip on the open folder: { id, mode: "back" | "again", text }
    editing: false,
    filed: [], // the out-tray, newest first: { id, title, workflow, outcome, stamp, at }
    errands: [], // who is out on Rogier's errands: { id, name, title, note, since, pose, ask }
    bell: [], // questions from running work, oldest first: { id, errand, face, title, q, answers }
    bellOpen: false,
    bellIndex: 0,
    events: [], // the simulation's queue: { at: seconds, fn }
    trustOffered: false,
    swarm: false,
    empty: false,
    held: [], // arrivals waiting while the pointer is over the in-tray
    yesterday: 2,
  };

  function result(id) {
    return RESULTS[id] || BUNDLES[id];
  }

  /* ------------------------------------------------------------------ the out board */

  /** Draws who is out on Rogier's errands: a face at work and one live line each. */
  function renderOut() {
    var el = $("[data-out]");
    if (state.swarm) {
      var names = ["Fix bug", "Investigate", "Draft reply", "Review PR", "Fix 3-D Secure checkout for EU cards", "Label new issues"];
      el.innerHTML =
        '<h2 class="dk-h">Out <span class="count">14</span></h2>' +
        '<div class="dk-out-row"><span class="stack">' + names.map(function (n) { return face(n, "working", 30); }).join("") + '</span><span class="dk-out-sum"><b>14</b> working on your handoffs · <span class="you-ink"><b>2</b> need you</span> · next to land in about 3m</span></div>';
      return;
    }
    if (!state.errands.length) {
      el.innerHTML = '<h2 class="dk-h">Out <span class="count">0</span></h2><p class="dk-out-empty">Nobody is out on your errands.</p>';
      return;
    }
    el.innerHTML =
      '<h2 class="dk-h">Out <span class="count">' + state.errands.length + "</span></h2>" +
      '<div class="dk-out-row">' +
      state.errands
        .map(function (e) {
          var waiting = e.pose === "waiting";
          return (
            '<button class="dk-errand' + (waiting ? " is-waiting" : "") + '" data-errand="' + e.id + '"' + (waiting ? ' data-ring="' + e.id + '"' : "") + ">" +
            face(e.name, e.pose, 32) +
            '<span class="dk-errand-text"><b>' + e.title + "</b><span>" + e.note + "</span></span>" +
            '<span class="dk-errand-age">' + age(e.since) + "</span></button>"
          );
        })
        .join("") +
      "</div>";
  }

  /* ------------------------------------------------------------------ the in-tray */

  var BUNDLES = {};

  /** Returns one folder in the in-tray: its tab in the colleague's hue, the title, and its state. */
  function folderStrip(id) {
    var r = result(id);
    var on = state.open === id && !state.filedOpen;
    if (r.members) return bundleStrip(r, on);
    var failed = r.status === "failed";
    var unseen = r.status === "landed";
    var mark = failed ? Crew.mark("failed", 14) : Crew.mark("done", 14);
    var tabName = r.workflow === "Hercule" ? "Hercule" : r.workflow;
    var tabFace = face(r.workflow, failed ? "failed" : "idle", 16);
    var meta = failed ? "Failed " + r.landed : r.attempt === 2 ? "2nd draft · " + r.landed : r.landed ? "Landed " + r.landed : "Just now";
    return (
      '<button class="dk-folder' + (on ? " is-on" : "") + (failed ? " is-failed" : "") + '" data-folder="' + id + '" data-theme="whitehaven" style="' + hueOf(r.workflow) + '">' +
      '<span class="dk-folder-tab">' + tabFace + "<span>" + tabName + "</span>" + (r.attempt === 2 ? '<em class="dk-tab-2">2nd draft</em>' : "") + "</span>" +
      '<span class="dk-folder-body"><span class="dk-folder-title">' + r.title + "</span>" +
      '<span class="dk-folder-meta">' + r.ref + " · " + meta + "</span>" +
      '<span class="dk-folder-end">' + (unseen ? '<i class="dk-unseen" title="Landed, not seen yet"></i>' : "") + mark + "</span></span>" +
      "</button>"
    );
  }

  /** Returns a bundle in the swarm's in-tray: a thicker stack with its count and what it holds. */
  function bundleStrip(b, on) {
    return (
      '<button class="dk-folder dk-folder--bundle' + (on ? " is-on" : "") + (b.failed ? " is-failed" : "") + '" data-folder="' + b.id + '" data-theme="whitehaven" style="' + hueOf(b.workflow) + '">' +
      '<span class="dk-folder-tab">' + (b.failed ? Crew.mark("failed", 14) : face(b.workflow, "idle", 16)) + "<span>" + b.tab + "</span></span>" +
      '<span class="dk-folder-body"><span class="dk-folder-title">' + b.title + "</span>" +
      '<span class="dk-folder-meta">' + b.meta + "</span>" +
      '<span class="dk-folder-end">' + (b.unseen ? '<i class="dk-unseen"></i>' : "") + '<b class="dk-bundle-n">' + b.members.length + "</b></span></span>" +
      "</button>"
    );
  }

  function renderTray() {
    var el = $("[data-in]");
    $("[data-in-count]").textContent = state.swarm ? 12 : state.tray.length || "";
    if (!state.tray.length) {
      el.innerHTML = state.empty
        ? '<div class="dk-ghosts" aria-hidden="true"><i>Results land here</i><i></i><i></i></div>'
        : '<p class="dk-tray-empty"><b>Nothing left to sign off.</b><span>' + (state.errands.length ? state.errands.length + " still out. Their results land here." : "The tray fills as results land.") + "</span></p>";
      return;
    }
    el.innerHTML = state.tray.map(folderStrip).join("");
  }

  /* ------------------------------------------------------------------ the open folder */

  /**
   * Returns the routing slip under the paper: every answer is a ledger row in the same three
   * columns, the button, the core's describe line and the key, so Rogier reads what a press does
   * before he makes it. The suggested answer comes first.
   */
  function ledger(r) {
    return (
      '<div class="ledger dk-ledger" data-ledger>' +
      r
        .answers(r)
        .map(function (a, i) {
          var cls = a.accent ? "btn btn--accent" : a.danger ? "btn btn--danger" : a.quiet ? "btn btn--quiet" : "btn";
          return (
            '<div class="ans' + (a.kbd === "⌘↩" ? " dk-ans-cmd" : "") + '"><button class="' + cls + '" data-answer="' + i + '">' + a.label + "</button>" +
            '<span class="ans-desc">' + a.desc + "</span>" + (a.kbd ? "<kbd>" + a.kbd + "</kbd>" : "<span></span>") + "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  /** Returns the back of a folder: the signal it was handed from, as Intake showed it. */
  function askedSide(id) {
    var a = ASKED[id];
    if (!a) return '<div class="dk-paper-in"><p class="dk-muted-line">Hercule made this offer itself. Nobody handed it over.</p></div>';
    return (
      '<div class="dk-paper-in dk-asked">' +
      '<span class="dk-doc-kind">' + Crew.brand(a.brand, 13) + a.kind + "</span>" +
      "<h2>" + a.title + "</h2>" +
      '<p class="dk-doc-ref">' + a.who + " · " + a.where + " · " + a.at + "</p>" +
      '<blockquote class="dk-quote">' + a.quote + "</blockquote>" +
      '<ol class="dk-trail">' +
      "<li><span>" + a.at + "</span><span>" + a.who.split(" (")[0] + " asked</span></li>" +
      "<li><span>" + a.handed + "</span><span>You handed it to <b>" + result(id).workflow + "</b>, and it left Intake</span></li>" +
      "<li><span>" + result(id).landed + "</span><span>" + (result(id).status === "failed" ? "It failed and came back to your desk" : "It landed on your desk") + "</span></li>" +
      "</ol>" +
      '<p class="dk-flip-hint"><kbd>Space</kbd> turns it back</p>' +
      "</div>"
    );
  }

  /**
   * Returns what the colleague was unsure about, as a note pinned near the top of the paper in its
   * hue, where Rogier reads it before the result itself. Only a result below high confidence has one.
   */
  function unsureNote(r) {
    if (!r.unsure || r.confidence === "High") return "";
    return '<aside class="dk-note">' + face(r.workflow, "idle", 20) + "<span><b>What I wasn't sure about</b>" + r.unsure + "</span></aside>";
  }

  /** Returns the confidence block at the foot of a paper: how it checked, or what it wasn't sure about. */
  function sureBlock(r) {
    if (!r.confidence || (!r.checked && !(r.unsure && r.confidence === "High"))) return "";
    return (
      '<footer class="dk-sure" style="' + hueOf(r.workflow) + '">' +
      (r.checked ? '<p class="dk-sure-line">' + face(r.workflow, "idle", 20) + "<span><b>How it checked</b>" + r.checked + "</span></p>" : "") +
      (r.unsure && r.confidence === "High" ? '<p class="dk-sure-line dk-sure-line--note">' + face(r.workflow, "idle", 20) + "<span><b>What I didn't do</b>" + r.unsure + "</span></p>" : "") +
      "</footer>"
    );
  }

  /** Returns the open folder: the tab, the paper (or its back), and the routing slip under it. */
  function sheet(id, opts) {
    opts = opts || {};
    var r = result(id);
    if (r.members) return bundleSheet(r);
    var failed = r.status === "failed";
    var who = face(r.workflow, failed ? "failed" : "idle", 28);
    var when = r.workflow === "Hercule" ? "Offered at " + clock(state.now) : (failed ? "Failed " : "Landed ") + r.landed + " · ran " + r.ran + " · " + r.by;
    var conf = r.confidence ? seal(r.confidence) : "";
    var filed = opts.filed;
    var stamp = opts.stamp ? stampMark(opts.stamp) : filed ? stampMark(filed.stamp) : "";
    var docHtml = r.doc(r).replace("<!--unsure-->", unsureNote(r));
    var paper = '<div class="dk-paper-in">' + docHtml + sureBlock(r) + "</div>";
    var editable = !filed && docHtml.indexOf("dk-editable") !== -1;
    return (
      '<article class="dk-sheet' + (failed ? " is-failed" : "") + (state.flipped && !filed ? " is-flipped" : "") + '" data-sheet="' + id + '" style="' + hueOf(r.workflow) + '">' +
      '<div class="dk-sheet-top"><span class="dk-sheet-tab" data-theme="whitehaven" style="' + hueOf(r.workflow) + '">' + who + "<b>" + (r.workflow === "Hercule" ? "Hercule" : r.workflow) + "</b>" +
      (r.attempt === 2 ? '<em class="dk-tab-2">2nd draft</em>' : "") +
      '</span><span class="dk-sheet-when">' + when + "</span>" +
      (editable ? '<button class="dk-edit' + (state.editing ? " is-on" : "") + '" data-edit>' + (state.editing ? "Done editing" : "Edit first") + "<kbd>E</kbd></button>" : "") +
      "</div>" +
      '<div class="dk-card3d">' +
      '<div class="dk-paper dk-face-front" data-theme="whitehaven" data-paper style="' + hueOf(r.workflow) + '">' + conf + paper + stamp + "</div>" +
      '<div class="dk-paper dk-face-back" data-theme="whitehaven" style="' + hueOf(r.workflow) + '">' + askedSide(id) + "</div>" +
      "</div>" +
      (filed ? filedSlip(r, filed) : state.slip && state.slip.id === id ? noteSlip(r) : ledger(r)) +
      "</article>"
    );
  }

  /** Returns the ink a stamp leaves on the paper: double-ruled, slightly askew, with the time and R. */
  function stampMark(text) {
    return '<div class="dk-impress" aria-label="Stamped: ' + text + '"><b>Signed off</b><span>' + text + " · " + clock(state.now) + " · R</span></div>";
  }

  /** Returns the note slip clipped to the folder, for Send back or Try again with a note. */
  function noteSlip(r) {
    var again = state.slip.mode === "again";
    return (
      '<div class="dk-slip-wrap">' +
      '<div class="dk-slip" data-theme="whitehaven">' +
      '<div class="dk-slip-h">' + Crew.you(18) + "<b>" + (again ? "Try again with a note for " : "Note for ") + r.workflow + "</b><span>it goes back with the folder</span></div>" +
      '<textarea class="dk-slip-text" data-slip-text rows="3" placeholder="What should change?">' + (state.slip.text || "") + "</textarea>" +
      "</div>" +
      '<div class="ledger dk-ledger">' +
      '<div class="ans dk-ans-cmd"><button class="btn btn--accent" data-slip-send>' + (again ? "Try again" : "Send back") + '</button><span class="ans-desc">' +
      (again ? "Starts <b>" + r.workflow + "</b> again on <b>fix/invoice-snapshot-tz</b> with your note. It lands here when done" : "Starts attempt " + ((r.attempt || 1) + 1) + " of <b>" + r.workflow + "</b> with your note. " + (r.kind === "mail" ? "The draft in Gmail stays until attempt 2 replaces it" : "It lands here when done")) +
      "</span><kbd>⌘↩</kbd></div>" +
      '<div class="ans"><button class="btn btn--quiet" data-slip-cancel>Cancel</button><span class="ans-desc">Keeps the folder on your desk as it is</span><kbd>Esc</kbd></div>' +
      "</div></div>"
    );
  }

  /** Returns what an out-tray folder offers once filed: how to take its effect back, where that can be done. */
  function filedSlip(r, f) {
    var rows = "";
    if (f.outward && r.undo) {
      rows += '<div class="ans"><button class="btn" data-undo>' + r.undo.label + '</button><span class="ans-desc">' + r.undo.desc + "</span><span></span></div>";
    } else if (f.outward) {
      rows += '<div class="ans"><button class="btn" disabled>Can\'t be undone</button><span class="ans-desc">' + (r.kind === "mail" ? "A sent mail can't be taken back. Write to Marta again instead" : "What it did can't be taken back from here") + "</span><span></span></div>";
    } else {
      rows += '<div class="ans"><button class="btn" data-putback>Put it back</button><span class="ans-desc">Returns it to your in-tray, not signed off. Nothing is sent</span><span></span></div>';
    }
    rows += '<div class="ans"><button class="btn btn--quiet" data-close-filed>Close</button><span class="ans-desc">Back to the in-tray</span><kbd>Esc</kbd></div>';
    return '<div class="ledger dk-ledger"><p class="dk-filed-line">' + Crew.mark("done", 14) + "<span><b>" + f.outcome + "</b> at " + f.at + "</span></p>" + rows + "</div>";
  }

  /** Returns a bundle opened on the blotter: one line per result in it, then the answers for all of them. */
  function bundleSheet(b) {
    var rows = b.members
      .map(function (m) {
        return '<li><span class="dk-b-ref">' + m.ref + '</span><span class="dk-b-title">' + m.title + '</span><span class="dk-b-verdict">' + m.verdict + "</span>" + (m.sure ? '<span class="dk-b-sure">' + m.sure + "</span>" : "") + "</li>";
      })
      .join("");
    var answers = b.failed
      ? [
          { label: "Open one by one", kbd: "↩", accent: true, act: "unbundle", desc: "Puts the 3 failed results in your tray as separate folders, the oldest first" },
          { label: "Let all 3 go", kbd: "S", act: "letgo-all", desc: "Files all 3 as failed. Their branches stay where they were left" },
        ]
      : [
          { label: "Post 6 and sign off", kbd: "⌘↩", accent: true, act: "bundle-post", desc: "Posts <b>6</b> approving reviews with <b>5 comments</b> in all on <b>rogier/payments-api</b> and <b>rogier/webshop</b> as <b>GitHub · rogier</b>" },
          { label: "Sign off 6", kbd: "S", act: "bundle-sign", desc: "Files all 6 as signed off. No review is posted" },
          { label: "Open one by one", kbd: "↩", act: "unbundle", desc: "Puts the 6 in your tray as separate folders" },
        ];
    return (
      '<article class="dk-sheet" data-sheet="' + b.id + '" style="' + hueOf(b.workflow) + '">' +
      '<div class="dk-sheet-top"><span class="dk-sheet-tab" data-theme="whitehaven" style="' + hueOf(b.workflow) + '">' + (b.failed ? Crew.mark("failed", 16) : face(b.workflow, "idle", 28)) + "<b>" + b.tab + '</b></span><span class="dk-sheet-when">' + b.when + "</span></div>" +
      '<div class="dk-card3d"><div class="dk-paper dk-face-front" data-theme="whitehaven" style="' + hueOf(b.workflow) + '"><div class="dk-paper-in">' +
      '<header class="dk-doc-h"><span class="dk-doc-kind">' + (b.failed ? "3 results that failed" : Crew.brand("github", 13) + "6 draft reviews, none posted") + "</span><h2>" + b.title + '</h2><p class="dk-doc-ref">' + b.meta + "</p></header>" +
      '<ol class="dk-bundle">' + rows + "</ol>" +
      (b.failed ? "" : '<p class="dk-saved">' + Crew.icon("shield", 14) + "Review PR has 14 signed off unchanged in a row. Bundles only hold results its colleague marked high.</p>") +
      "</div></div></div>" +
      '<div class="ledger dk-ledger">' +
      answers
        .map(function (a) {
          return '<div class="ans' + (a.kbd === "⌘↩" ? " dk-ans-cmd" : "") + '"><button class="btn' + (a.accent ? " btn--accent" : "") + '" data-bundle-act="' + a.act + '">' + a.label + '</button><span class="ans-desc">' + a.desc + "</span><kbd>" + a.kbd + "</kbd></div>";
        })
        .join("") +
      "</div></article>"
    );
  }

  function renderOpen() {
    var el = $("[data-open]");
    if (state.filedOpen) {
      var f = state.filed.filter(function (x) { return x.key === state.filedOpen; })[0];
      el.innerHTML = sheet(f.id, { filed: f });
      Crew.drawPlaceholders(el);
      return;
    }
    if (!state.open) {
      el.innerHTML = clearBlotter();
      return;
    }
    el.innerHTML = sheet(state.open, { stamp: state.pinStamp });
    if (state.editing) $all(".dk-editable", el).forEach(function (n) { n.contentEditable = "true"; });
  }

  /** Returns the blotter when the tray is empty: one calm line, and how many were signed off today. */
  function clearBlotter() {
    if (state.empty) {
      return (
        '<div class="dk-clear">' +
        '<div class="dk-ghost-sheet" aria-hidden="true"><span>The result, on paper</span></div>' +
        '<div class="dk-ghost-ledger" aria-hidden="true"><i></i><span>What each answer does</span></div>' +
        "<p><b>Nothing handed off today.</b></p><p class=\"dk-clear-sub\">When you hand a signal to an agent in Intake, its result lands in your tray. Yesterday you signed off " + state.yesterday + ".</p></div>"
      );
    }
    var n = state.filed.filter(function (f) { return f.id !== "offer"; }).length;
    return (
      '<div class="dk-clear">' +
      '<b class="deco-num dk-clear-num">' + n + "</b>" +
      "<p><b>Desk clear.</b> " + (n === 1 ? "1 result" : n + " results") + " signed off this morning.</p>" +
      '<p class="dk-clear-sub">' + (state.errands.length ? state.errands.length + " still out: " + state.errands.map(function (e) { return e.title; }).join(", ") + "." : "Nobody is out on your errands.") + "</p>" +
      "</div>"
    );
  }

  /* ------------------------------------------------------------------ the out-tray and the trust ledger */

  function renderFiled() {
    var el = $("[data-filed]");
    $("[data-out-count]").textContent = state.swarm ? 10 + state.filed.length : state.filed.length || "";
    if (state.swarm && !state.filed.length) {
      el.innerHTML = '<p class="dk-filed-sum">10 signed off since 07:00 · 6 posted, 2 merged, 2 replies sent</p>';
      return;
    }
    if (!state.filed.length) {
      el.innerHTML = '<p class="dk-filed-sum">Nothing yet today. Yesterday ' + state.yesterday + ": #1287 merged, a reply to Pieter at Bakkerij Smit.</p>";
      return;
    }
    el.innerHTML = state.filed
      .map(function (f) {
        return (
          '<button class="dk-filed-row' + (state.filedOpen === f.key ? " is-on" : "") + '" data-filed-key="' + f.key + '" style="' + hueOf(f.workflow) + '">' +
          '<i class="dk-filed-hue"></i><span class="dk-filed-text"><b>' + f.title + "</b><span>" + f.outcome + "</span></span>" +
          '<span class="dk-filed-at">' + f.at + "</span></button>"
        );
      })
      .join("");
    // Only a list taller than its tray fades at the bottom, so a short one never looks cut.
    requestAnimationFrame(function () {
      el.classList.toggle("is-cut", el.scrollHeight > el.clientHeight + 1);
    });
  }

  /** Draws the trust ledger: per workflow, a tick per result in the last 30 days and the streak. */
  function renderTrust() {
    var el = $("[data-trust]");
    el.innerHTML =
      '<h2 class="dk-trust-h">Signed off unchanged<span>30 days</span></h2>' +
      TRUST.map(function (t) {
        var ticks = t.marks
          .split("")
          .map(function (c) {
            return '<i class="is-' + c + '"></i>';
          })
          .join("");
        var slot = t.workflow === "Review PR" && t.streak < TRUST_AT ? '<i class="is-slot" title="At ' + TRUST_AT + " in a row Hercule offers to let it post without stopping\"></i>" : "";
        var reached = t.workflow === "Review PR" && t.streak >= TRUST_AT;
        return (
          '<div class="dk-trust-row" style="' + hueOf(t.workflow) + '">' +
          face(t.workflow, "idle", 18) + "<b>" + t.workflow + '</b><span class="dk-trust-n">' + t.unchanged + " of " + t.total + "</span>" +
          '<div class="dk-ticks" aria-label="' + t.streak + ' in a row">' + ticks + slot + "</div>" +
          (reached ? '<p class="dk-trust-note">' + (state.trustAccepted ? "Posts without stopping here since " + state.trustAccepted + ". Its results still land in your out-tray." : t.streak + " in a row. Hercule's offer is in your tray.") + "</p>" : "") +
          "</div>"
        );
      }).join("") +
      '<p class="dk-trust-key"><span><i class="is-u"></i>as it came</span><span><i class="is-b"></i>sent back</span><span><i class="is-t"></i>taken over</span><span><i class="is-f"></i>failed</span></p>';
  }

  /* ------------------------------------------------------------------ the bell */

  function renderBell() {
    var n = state.swarm ? 2 : state.bell.length;
    var btn = $("[data-bell]");
    btn.classList.toggle("is-you", n > 0);
    $("[data-bell-label]").innerHTML = n ? "<b>" + n + "</b> " + (n === 1 ? "needs" : "need") + " you" : "Nothing needs you";
    var card = $("[data-bell-card]");
    if (!state.bellOpen || !state.bell.length) {
      card.hidden = true;
      return;
    }
    var q = state.bell[Math.min(state.bellIndex, state.bell.length - 1)];
    card.hidden = false;
    card.innerHTML =
      '<div class="dk-bell-h">' + face(q.name, "waiting", 34) +
      '<span class="who-text"><span class="who-name">' + q.title + '</span><span class="who-state">' + (q.proj ? '<span class="proj proj--' + q.proj + '">' + q.projName + "</span>" : "") + (q.from ? "<span>" + q.from + "</span>" : "") + "<span>waiting " + (state.now - q.since < 60 ? "now" : age(q.since)) + "</span></span></span>" +
      '<span class="dk-bell-of">' + (state.bell.indexOf(q) + 1) + " of " + state.bell.length + "</span></div>" +
      '<p class="dk-bell-q">' + q.q + "</p>" +
      '<div class="ledger">' +
      q.answers
        .map(function (a, i) {
          return '<div class="ans"><button class="btn' + (a.accent ? " btn--accent" : a.quiet ? " btn--quiet" : "") + '" data-bell-answer="' + i + '">' + a.label + '</button><span class="ans-desc">' + a.desc + "</span>" + (a.kbd ? "<kbd>" + a.kbd + "</kbd>" : "<span></span>") + "</div>";
        })
        .join("") +
      "</div>" +
      '<div class="dk-bell-foot"><button class="btn btn--quiet btn--sm" data-bell-close>Later<kbd>Esc</kbd></button><button class="btn btn--sm">Open thread' + Crew.icon("chev-r", 13) + "</button></div>";
  }

  /** Rings the bell for a new question: the bell swings once and the card drops in. It never takes the keyboard. */
  function ring() {
    state.bellOpen = true;
    state.bellIndex = state.bell.length - 1;
    render();
    if (reduceMotion) return;
    var ic = $("[data-bell-icon]");
    ic.animate(
      [{ transform: "rotate(0)" }, { transform: "rotate(14deg)" }, { transform: "rotate(-11deg)" }, { transform: "rotate(6deg)" }, { transform: "rotate(0)" }],
      { duration: 320, easing: "ease-out" },
    );
    $("[data-bell-card]").animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  }

  /* ------------------------------------------------------------------ counts and the sidebar */

  function renderCounts() {
    var n = state.swarm ? 12 : state.tray.length;
    var unseen = state.swarm ? 9 : state.tray.filter(function (id) { return result(id).status === "landed"; }).length;
    $("[data-tray-count]").textContent = n ? String(n) : "";
    var row = $(".dk-nav-desk");
    if (row) {
      row.querySelector(".count").textContent = n ? String(n) : "";
      row.querySelector(".dk-unseen").hidden = !unseen;
      row.title = n ? n + " results on your desk, " + unseen + " not seen yet" : "Nothing on your desk";
    }
  }

  /**
   * Adds "Your desk" under The office in the sidebar's Hercule tab, with a quiet count and a small
   * marigold dot while something landed that Rogier has not seen. The count stays quiet on
   * purpose: the desk is pulled, not pushed.
   */
  function wireSidebar() {
    var office = $('.side .nav-row[href="office.html"]');
    if (!office) return;
    var desk = document.createElement("a");
    desk.className = "nav-row dk-nav-desk";
    desk.href = "#desk";
    desk.innerHTML = deskIcon() + '<span>Your desk</span><i class="dk-unseen" hidden></i><b class="count"></b>';
    office.after(desk);
    office.addEventListener("click", function (e) {
      e.preventDefault();
      go("floor");
    });
    desk.addEventListener("click", function (e) {
      e.preventDefault();
      go("desk");
    });
  }

  /** Returns the desk's 16px icon: a lamp on a desk, drawn in the icon family's 1.5 stroke. */
  function deskIcon() {
    return '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 9.2h12.4M3.2 9.2v4.4M12.8 9.2v4.4"/><path d="M5 9.2V7.4h3.6v1.8"/><path d="M10.6 9.2l.6-4.2 2.2-1"/><path d="M12.4 3.2l1.8 1.6"/></svg>';
  }
  function bellIcon() {
    return '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 12.4h12.4"/><path d="M3 12.4a5 5 0 0 1 10 0z"/><path d="M8 7.4V5.6"/><circle cx="8" cy="4.6" r="1"/></svg>';
  }

  /* ------------------------------------------------------------------ render */

  function render() {
    root.dataset.view = state.view;
    $all("[data-go]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.go === state.view));
      b.classList.toggle("is-on", b.dataset.go === state.view);
    });
    var office = $('.side .nav-row[href="office.html"]');
    var desk = $(".dk-nav-desk");
    if (office && desk) {
      office.classList.toggle("is-on", state.view === "floor");
      desk.classList.toggle("is-on", state.view === "desk");
    }
    renderOut();
    renderTray();
    renderOpen();
    renderFiled();
    renderTrust();
    renderBell();
    renderCounts();
    renderProto();
  }

  /* ------------------------------------------------------------------ moving through the tray */

  /** Opens a folder from the tray. Opening marks a landed result as seen: its marigold dot goes. */
  function openFolder(id) {
    if (!id) return;
    state.open = id;
    state.filedOpen = null;
    state.flipped = false;
    state.slip = null;
    state.editing = false;
    state.pinStamp = null;
    var r = result(id);
    if (r.status === "landed") r.status = "seen";
    if (r.members && r.unseen) r.unseen = false;
    render();
    var on = $(".dk-folder.is-on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }

  function move(step) {
    if (!state.tray.length) return;
    var i = state.tray.indexOf(state.open);
    var next = i === -1 ? 0 : Math.max(0, Math.min(state.tray.length - 1, i + step));
    openFolder(state.tray[next]);
  }

  /**
   * Takes one of the open folder's answers. Every answer files the folder in the out-tray except
   * Send back and Try again, which open the note slip, and Take over, which hands the thread to Rogier.
   */
  function answer(index) {
    var r = result(state.open);
    if (!r || r.members) return;
    var a = r.answers(r)[index];
    if (!a) return;
    if (a.act === "back" || a.act === "again") {
      openSlip(a.act);
      return;
    }
    if (a.act === "take") {
      file(r, { stamp: "Taken over", outcome: "Taken over in its thread", changed: true, word: "Taken over" });
      toast("Opened the run's thread. It's yours from here.");
      return;
    }
    if (a.act === "hand") {
      file(r, { stamp: a.stamp, outcome: a.outcome, outward: true });
      sendOut({ id: "fix-" + r.id, name: "Fix bug", title: r.title, note: "Starting from the findings", since: state.now, pose: "working" });
      toast("Handed to Fix bug. It lands here when done.");
      return;
    }
    if (a.act === "trust") {
      state.trustAccepted = clock(state.now);
      file(r, { stamp: a.stamp, outcome: a.outcome, outward: true });
      toast("Saved Review PR. Its next review posts by itself.");
      return;
    }
    var changed = state.editing || a.act === "discard";
    file(r, { stamp: a.stamp, outcome: a.outcome, outward: a.act === "outward", changed: changed });
    if (a.act === "outward") toast(a.outcome + ". Signed off.");
  }

  /**
   * Files a result in the out-tray: the stamp goes on the paper, the folder leaves for the
   * out-tray, and the next folder in the tray opens. Signing off unchanged counts toward the
   * workflow's trust; anything else breaks the streak.
   */
  function file(r, how) {
    var leaving = $(".dk-sheet");
    var key = r.id + "-" + state.filed.length;
    state.filed.unshift({ key: key, id: r.id, title: r.title, workflow: r.workflow, outcome: how.outcome, stamp: how.stamp, at: clock(state.now), outward: !!how.outward });
    countTrust(r, !how.changed && r.attempt !== 2);
    var i = state.tray.indexOf(r.id);
    state.tray.splice(i, 1);
    r.status = "filed";
    var next = state.tray[Math.min(i, state.tray.length - 1)] || null;
    flyAway(leaving, how.stamp, "[data-filed]");
    state.open = null;
    if (next) openFolder(next);
    else {
      state.flipped = false;
      state.slip = null;
      state.editing = false;
      render();
    }
    maybeOffer();
  }

  function countTrust(r, unchanged) {
    var t = TRUST.filter(function (x) { return x.workflow === r.workflow; })[0];
    if (!t) return;
    t.total++;
    t.marks = (t.marks + (unchanged ? "u" : "t")).slice(-20);
    if (unchanged) {
      t.unchanged++;
      t.streak++;
    } else t.streak = 0;
  }

  /** Puts Hercule's offer in the tray once Review PR reaches TRUST_AT in a row, at most once. */
  function maybeOffer() {
    var t = TRUST[0];
    if (state.trustOffered || t.streak < TRUST_AT) return;
    state.trustOffered = true;
    OFFER.status = "landed";
    setTimeout(function () {
      arrive("offer", null);
    }, reduceMotion ? 0 : 700);
  }

  /* ------------------------------------------------------------------ send back and try again */

  function openSlip(mode) {
    var r = result(state.open);
    state.flipped = false;
    state.slip = { id: r.id, mode: mode, text: r.id === "h3" ? ROGIER_NOTE_H3 : r.id === "h5" ? ROGIER_NOTE_H5 : "" };
    render();
    var ta = $("[data-slip-text]");
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      if (!reduceMotion) $(".dk-slip-wrap").animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    }
  }

  /**
   * Sends the open folder back with Rogier's note: the folder leaves with its colleague, who shows
   * up on the out board at work on the next attempt.
   */
  function sendSlip() {
    var r = result(state.slip.id);
    var ta = $("[data-slip-text]");
    var text = (ta && ta.value.trim()) || "No note";
    var mode = state.slip.mode;
    var leaving = $(".dk-sheet");
    countTrust(r, false);
    var i = state.tray.indexOf(r.id);
    state.tray.splice(i, 1);
    r.status = "out";
    r.note = text;
    r.noteAt = clock(state.now);
    state.slip = null;
    var errand = { id: r.id, name: r.workflow, title: r.title, note: mode === "again" ? "Attempt 2 · editing .github/workflows/test.yml" : "Attempt " + ((r.attempt || 1) + 1) + " · reading your note", since: state.now, pose: "working" };
    state.errands.push(errand);
    flyAway(leaving, null, "[data-errand=\"" + r.id + "\"]", true);
    var next = state.tray[Math.min(i, state.tray.length - 1)] || null;
    state.open = null;
    if (next) openFolder(next);
    else render();
    toast(mode === "again" ? r.workflow + " is trying again with your note." : "Sent back to " + r.workflow + " with your note.");
    if (r.id === "h3") schedule(40, askStripe);
    else if (r.id === "h5") schedule(100, landSecondTry);
    else
      schedule(100, function () {
        r.attempt = 2;
        r.status = "landed";
        r.landed = clock(state.now);
        arrive(r.id, r.id);
      });
  }

  /** Attempt 2 of the draft reply needs Stripe: it asks, and the bell rings. */
  function askStripe() {
    var e = errand("h3");
    e.pose = "waiting";
    e.note = "Void INV-2291 and create INV-2291-R in Stripe?";
    state.bell.push({
      id: "stripe",
      errand: "h3",
      name: "Draft reply",
      title: "Draft reply · Invoice INV-2291",
      since: state.now,
      from: "attempt 2",
      q: "Void <b>INV-2291</b> and create <b>INV-2291-R</b> for <b>Brightline B.V.</b> in <b>Stripe · live</b>?",
      answers: [
        { label: "Allow once", accent: true, kbd: "↩", act: "allow", desc: "Lets this run void INV-2291 and create INV-2291-R in <b>Stripe · live</b>, this once" },
        { label: "Deny", quiet: true, act: "deny", desc: "Draft reply carries on without touching Stripe" },
      ],
    });
    ring();
  }

  function landSecondTry() {
    var r = RESULTS.h5;
    r.attempt = 2;
    r.status = "landed";
    r.landed = clock(state.now);
    r.ran = "1m 40s";
    arrive("h5", "h5");
  }

  /** Answers a question on the bell. Allow lets the run go on; the bell falls quiet when nothing is left. */
  function answerBell(i) {
    var q = state.bell[Math.min(state.bellIndex, state.bell.length - 1)];
    if (!q) return;
    var a = q.answers[i];
    state.bell.splice(state.bell.indexOf(q), 1);
    state.bellIndex = 0;
    // An answer closes the card. Anything else still waiting stays on the bell's count, so the
    // next question never takes the place of the one just answered under the pointer.
    state.bellOpen = false;
    var e = errand(q.errand);
    if (q.id === "push") {
      e.pose = "working";
      e.note = a.act === "deny" ? "Carrying on without pushing" : "Pushed fix/3ds-eu-cards · opening a pull request";
      toast(a.act === "deny" ? "Denied. It carries on without pushing." : a.act === "always" ? "Allowed. git push won't ask again in this thread." : "Allowed once. It pushed fix/3ds-eu-cards.");
    }
    if (q.id === "stripe") {
      var r = RESULTS.h3;
      r.denied = a.act === "deny";
      r.allowedAt = clock(state.now);
      e.pose = "working";
      e.note = r.denied ? "Rewriting without the new invoice" : "Creating INV-2291-R in Stripe";
      toast(r.denied ? "Denied. Draft reply carries on without Stripe." : "Allowed once. Draft reply is reissuing the invoice.");
      schedule(60, function () {
        r.attempt = 2;
        r.status = "landed";
        r.landed = clock(state.now);
        r.ran = "2m 50s";
        r.confidence = r.denied ? "Medium" : "High";
        r.checked = r.denied ? "" : "Checked INV-2291-R in Stripe: Brightline B.V., KvK 81234567, €2,450.";
        r.unsure = r.denied ? "You said no to Stripe, so I couldn't reissue the invoice. The reply promises it later today." : "";
        arrive("h3", "h3");
      });
    }
    render();
  }

  function errand(id) {
    return state.errands.filter(function (e) { return e.id === id; })[0];
  }
  function sendOut(e) {
    state.errands.push(e);
    render();
  }

  /* ------------------------------------------------------------------ arrivals */

  /**
   * Lands a result in the in-tray. Its colleague leaves the out board, and a small folder travels
   * from where the colleague sat to the top of the tray, where the folders below make room. While
   * the pointer is over the tray the landing waits, so nothing moves under it.
   */
  function arrive(id, errandId) {
    if (trayHovered) {
      state.held.push([id, errandId]);
      return;
    }
    var from = errandId ? $('[data-errand="' + errandId + '"]') : $("[data-bell]");
    var fromRect = from ? from.getBoundingClientRect() : null;
    if (errandId) state.errands = state.errands.filter(function (e) { return e.id !== errandId; });
    var before = rects();
    if (state.tray.indexOf(id) === -1) state.tray.unshift(id);
    if (!state.open && !state.filedOpen) state.open = id;
    render();
    var strip = $('[data-folder="' + id + '"]');
    if (reduceMotion || !strip) return;
    var to = strip.getBoundingClientRect();
    flipTray(before, id);
    if (fromRect) {
      strip.style.opacity = "0";
      var fly = document.createElement("div");
      fly.className = "dk-fly";
      fly.setAttribute("data-theme", "whitehaven");
      fly.style.cssText = hueOf(result(id).workflow) + ";left:" + to.left + "px;top:" + to.top + "px;width:" + to.width + "px;height:" + to.height + "px";
      $("[data-fly]").appendChild(fly);
      var dx = fromRect.left + fromRect.width / 2 - (to.left + to.width / 2);
      var dy = fromRect.top + fromRect.height / 2 - (to.top + to.height / 2);
      fly.animate([{ transform: "translate(" + dx + "px," + dy + "px) scale(0.3)", opacity: 0 }, { transform: "translate(" + dx * 0.15 + "px," + dy * 0.15 + "px) scale(0.85)", opacity: 1, offset: 0.7 }, { transform: "none", opacity: 1 }], {
        duration: 320,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      }).onfinish = function () {
        fly.remove();
        var s = $('[data-folder="' + id + '"]');
        if (s) s.style.opacity = "";
      };
    }
  }

  var trayHovered = false;

  function rects() {
    var out = {};
    $all("[data-folder]").forEach(function (el) {
      out[el.dataset.folder] = el.getBoundingClientRect().top;
    });
    return out;
  }
  /** Slides the folders that moved from where they were to where they are now, on transform alone. */
  function flipTray(before, fresh) {
    $all("[data-folder]").forEach(function (el) {
      var id = el.dataset.folder;
      if (id === fresh || before[id] === undefined) return;
      var dy = before[id] - el.getBoundingClientRect().top;
      if (dy) el.animate([{ transform: "translateY(" + dy + "px)" }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    });
  }

  /**
   * Lifts a copy of the open folder off the blotter and sends it where it is going: the out-tray
   * when filed, or the colleague on the out board when sent back. The stamp, when there is one,
   * lands on the copy first. The copy moves on transform and opacity only, and the next folder is
   * already drawn under it.
   */
  function flyAway(sheetEl, stampText, toSel, up) {
    if (!sheetEl || reduceMotion) return;
    var r0 = sheetEl.getBoundingClientRect();
    var copy = sheetEl.cloneNode(true);
    copy.classList.add("dk-leaving");
    copy.style.cssText += ";position:fixed;left:" + r0.left + "px;top:" + r0.top + "px;width:" + r0.width + "px;height:" + r0.height + "px;margin:0";
    $all(".dk-ledger, .dk-slip-wrap, .dk-edit", copy).forEach(function (n) {
      n.style.visibility = "hidden";
    });
    $("[data-fly]").appendChild(copy);
    var hold = 0;
    if (stampText) {
      var paper = copy.querySelector("[data-paper]");
      if (paper) {
        paper.insertAdjacentHTML("beforeend", stampMark(stampText));
        paper.lastChild.animate([{ opacity: 0, transform: "rotate(-6deg) scale(1.35)" }, { opacity: 1, transform: "rotate(-6deg) scale(1)" }], { duration: 200, easing: "cubic-bezier(0.34, 1.5, 0.64, 1)" });
        hold = 420;
      }
    }
    setTimeout(function () {
      var target = $(toSel);
      var t = target ? target.getBoundingClientRect() : { left: r0.left, top: up ? 0 : r0.top, width: r0.width, height: 40 };
      var dx = t.left + t.width / 2 - (r0.left + r0.width / 2);
      var dy = t.top + Math.min(t.height, 60) / 2 - (r0.top + r0.height / 2);
      copy.animate([{ transform: "none", opacity: 1 }, { transform: "translate(" + dx + "px," + dy + "px) scale(0.18)", opacity: 0 }], { duration: 320, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" }).onfinish = function () {
        copy.remove();
      };
    }, hold);
  }

  /* ------------------------------------------------------------------ toasts */

  var toastTimer = 0;
  function toast(text) {
    var el = $("[data-toast]");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, 4000);
  }

  /* ------------------------------------------------------------------ the simulation */

  function schedule(simSeconds, fn) {
    state.events.push({ at: state.now + simSeconds, fn: fn });
    state.events.sort(function (a, b) {
      return a.at - b.at;
    });
  }

  /** Advances the clock and fires every event that has come due. */
  function advance(to) {
    state.now = to;
    while (state.events.length && state.events[0].at <= state.now) state.events.shift().fn();
  }

  var lastTick = 0;
  function tick(ts) {
    if (!lastTick) lastTick = ts;
    var dt = (ts - lastTick) / 1000;
    lastTick = ts;
    if (state.playing && dt < 1) {
      var before = Math.floor(state.now / 60);
      advance(state.now + dt * SPEED);
      if (Math.floor(state.now / 60) !== before) refreshAges();
      renderProto();
    }
    requestAnimationFrame(tick);
  }

  /** Updates the age labels in place once a simulated minute, without drawing the desk again. */
  function refreshAges() {
    $all("[data-errand]").forEach(function (el) {
      var e = errand(el.dataset.errand);
      if (e) el.querySelector(".dk-errand-age").textContent = age(e.since);
    });
  }

  function nextEvent() {
    if (state.events.length) advance(state.events[0].at);
    renderProto();
  }

  function renderProto() {
    var c = $("[data-sim-clock]");
    if (c) c.textContent = clock(state.now) + ":" + String(Math.floor(state.now % 60)).padStart(2, "0");
    var p = $("[data-sim-play]");
    if (p) {
      p.innerHTML = Crew.icon(state.playing ? "pause" : "play", 14);
      p.setAttribute("aria-label", state.playing ? "Pause the simulation" : "Play the simulation");
    }
    var th = $("[data-sim-theme]");
    if (th) th.innerHTML = Crew.icon(root.dataset.theme === "orient-express" ? "sun" : "moon", 14);
    var nx = $("[data-sim-next]");
    if (nx) nx.disabled = !state.events.length;
  }

  /* ------------------------------------------------------------------ views */

  /** Switches between the Office floor and the desk. Sitting down at the desk zooms in once. */
  function go(view) {
    if (state.view === view) return;
    state.view = view;
    render();
    if (reduceMotion) return;
    var el = $(view === "desk" ? "[data-view-desk]" : "[data-view-floor]");
    el.animate(view === "desk" ? [{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "none" }] : [{ opacity: 0, transform: "scale(1.03)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  }

  /* ------------------------------------------------------------------ the floor's overlay */

  /**
   * Draws what the desk adds to the Office floor, over office.js's drawing and at its scale: a pile
   * of folders on Your desk, a colleague on the way with one, and a tag to sit down. office.js
   * draws the room again on every resize, so this follows it.
   */
  function drawFloorOverlay() {
    var host = $("[data-office]");
    var over = $("[data-floor-over]");
    var O = window.Office;
    if (!host.clientWidth || !O) return;
    var w = host.clientWidth;
    var h = host.clientHeight;
    var x0 = 1.4;
    var y0 = 15.8;
    var top = 0.8;
    var pile = "";
    var hues = ["iris", "teal", "sky", "lime"];
    var n = state.swarm ? 12 : state.tray.length;
    for (var i = 0; i < Math.min(n, 6); i++) {
      pile += O.box(x0 + 0.98 + (i % 2) * 0.04, y0 + 0.3 - (i % 3) * 0.03, top + i * 0.05, 0.66, 0.5, 0.045, "var(--dk-manila)", "dk-pile");
      pile += O.box(x0 + 1.06 + (i % 2) * 0.04, y0 + 0.26 - (i % 3) * 0.03, top + i * 0.05 + 0.005, 0.22, 0.05, 0.04, "oklch(var(--char-l) var(--char-c) var(--hue-" + hues[i % 4] + "))", "dk-pile-tab");
    }
    // The colleague bringing a result: H4's Investigate, crossing the aisle to Your desk.
    var wx0 = 10.6;
    var wy0 = 16.0;
    var walker = "";
    if (!state.swarm && !state.empty) {
      var wx = wx0;
      var wy = wy0;
      walker = O.ellipse(wx, wy, 0, 0.32, "shadow") + O.sprite("Investigate", "done", wx, wy, 0) + O.box(wx + 0.12, wy + 0.18, 0.5, 0.36, 0.3, 0.05, "var(--dk-manila)", "dk-pile") + O.box(wx + 0.14, wy + 0.18, 0.55, 0.12, 0.04, 0.04, "oklch(var(--char-l) var(--char-c) var(--hue-sky))", "dk-pile-tab");
    }
    var walkAt = O.P(wx0, wy0, 1.55);
    var unseen = state.swarm ? 9 : state.tray.filter(function (id) { return result(id).status === "landed"; }).length;
    var rows = state.swarm
      ? [["Review PR", "6 reviews, all high confidence", "done"], ["Draft reply", "Invoice INV-2291 in the company name", "done"], ["Investigate", "Refunds for partial captures", "done"], ["Fix bug", "3 runs gave up", "failed"]]
      : state.tray.map(function (id) {
          var r = result(id);
          return [r.workflow, r.title, r.status === "failed" ? "failed" : "done", r.status === "landed"];
        });
    over.innerHTML =
      '<svg class="dk-floor-svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" aria-hidden="true">' + pile + walker + "</svg>" +
      (walker ? '<div class="tag dk-tag-walk" style="left:' + walkAt[0].toFixed(1) + "px;top:" + walkAt[1].toFixed(1) + 'px"><b>Refunds for partial captures</b><span>bringing it to your desk</span></div>' : "") +
      '<section class="dk-sit glass" aria-label="On your desk">' +
      '<div class="dk-sit-h"><b class="deco-num">' + (state.swarm ? 12 : n) + '</b><span><b>On your desk</b><span>' + (unseen ? '<i class="dk-unseen"></i>' + unseen + " not seen yet" : n ? "all seen" : "nothing to sign off") + "</span></span></div>" +
      (rows.length
        ? '<ul class="dk-sit-list">' +
          rows.slice(0, 4).map(function (row) {
            return '<li style="' + hueOf(row[0]) + '"><i class="dk-sit-hue"></i><span class="dk-sit-title">' + row[1] + "</span>" + (row[3] ? '<i class="dk-unseen"></i>' : "") + Crew.mark(row[2], 13) + "</li>";
          }).join("") +
          "</ul>"
        : "") +
      '<div class="dk-sit-foot"><span>Only a question rings the bell. The rest waits here.</span><button class="btn btn--accent btn--sm" data-go="desk">Sit down<kbd>↩</kbd></button></div>' +
      "</section>";
  }

  /* ------------------------------------------------------------------ keys and clicks */

  function onKey(e) {
    var inText = e.target.matches && e.target.matches("textarea, input[type=text], [contenteditable=true]");
    if (e.key === "Escape") {
      if (state.bellOpen) state.bellOpen = false;
      else if (state.slip) state.slip = null;
      else if (state.editing) state.editing = false;
      else if (state.flipped) state.flipped = false;
      else if (state.filedOpen) {
        state.filedOpen = null;
        state.open = state.open || state.tray[0] || null;
      } else if (state.view === "desk") go("floor");
      render();
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (state.slip) return sendSlip();
      if (state.bellFocus && state.bellOpen) return answerBell(0);
      var r = result(state.open);
      if (!r) return;
      if (r.members) return bundleAct(r.failed ? "unbundle" : "bundle-post");
      var list = r.answers(r);
      var idx = list.findIndex(function (a) { return a.kbd === "⌘↩"; });
      if (idx !== -1) answer(idx);
      return;
    }
    if (inText || e.metaKey || e.ctrlKey || e.altKey) return;
    if (state.view === "floor") {
      if (e.key === "Enter") go("desk");
      return;
    }
    var k = e.key.toLowerCase();
    if (k === "j" || e.key === "ArrowDown") move(1);
    else if (k === "k" || e.key === "ArrowUp") move(-1);
    else if (k === "n") {
      if (state.bell.length) {
        state.bellOpen = true;
        render();
        var b = $("[data-bell-answer]");
        if (b) b.focus();
      }
    } else if (e.key === " ") {
      if (!state.open || result(state.open).members) return;
      e.preventDefault();
      state.flipped = !state.flipped;
      var card = $(".dk-sheet");
      if (card) card.classList.toggle("is-flipped", state.flipped);
    } else if (k === "d" && state.open === "h3" && RESULTS.h3.attempt === 2) {
      state.showChanges = !state.showChanges;
      renderOpen();
    } else if (k === "e" && state.open && $("[data-edit]")) {
      toggleEdit();
      e.preventDefault();
    } else if (e.key === "Enter" && state.open && result(state.open).members) bundleAct("unbundle");
    else if (k === "s" || k === "b" || k === "t") {
      var r2 = result(state.open);
      if (!r2) return;
      if (r2.members) return bundleAct(k === "s" ? (r2.failed ? "letgo-all" : "bundle-sign") : null);
      // The key is spent here, so B never types itself into the note slip it opens.
      e.preventDefault();
      var want = k.toUpperCase();
      var list2 = r2.answers(r2);
      var j = list2.findIndex(function (a) { return a.kbd === want; });
      if (j !== -1) answer(j);
    }
  }

  function toggleEdit() {
    state.editing = !state.editing;
    renderOpen();
    if (state.editing) {
      var first = $(".dk-editable");
      if (first) first.focus();
    }
  }

  /** Acts on a bundle: posts or signs off all of it, or opens it into separate folders. */
  function bundleAct(act) {
    var b = result(state.open);
    if (!b || !act) return;
    var i = state.tray.indexOf(b.id);
    if (act === "unbundle") {
      var ids = b.members.map(function (m) { return m.id; });
      ids.forEach(function (id) {
        if (!RESULTS[id]) RESULTS[id] = swarmResult(id);
      });
      state.tray.splice.apply(state.tray, [i, 1].concat(ids));
      openFolder(ids[0]);
      return;
    }
    var leaving = $(".dk-sheet");
    var outward = act === "bundle-post";
    state.filed.unshift({ key: b.id + "-" + state.filed.length, id: "h1", title: b.title, workflow: b.workflow, outcome: outward ? "6 reviews posted" : act === "letgo-all" ? "3 let go" : "6 signed off, not posted", stamp: outward ? "6 reviews posted" : "Signed off", at: clock(state.now), outward: outward });
    state.tray.splice(i, 1);
    flyAway(leaving, outward ? "6 reviews posted" : act === "letgo-all" ? "3 let go" : "6 signed off", "[data-filed]");
    state.open = null;
    openFolder(state.tray[Math.min(i, state.tray.length - 1)]);
    if (!state.tray.length) render();
    toast(outward ? "Posted 6 reviews. Signed off." : act === "letgo-all" ? "Let 3 go." : "Signed off 6.");
  }

  /** Builds a Review PR result for one of the swarm's bundled pull requests, from its one line. */
  function swarmResult(id) {
    var row = SWARM_PRS.filter(function (p) { return p[0] === id; })[0];
    return {
      id: id,
      workflow: "Review PR",
      title: row[2],
      ref: (id === "s2" || id === "s3" || id === "s5" ? "payments-api " : "webshop ") + row[1],
      by: "Claude Code · Sonnet 5 · build-box-2",
      handed: "08:50",
      landed: "09:1" + id.slice(1),
      ran: "6m",
      status: "seen",
      confidence: "High",
      checked: "Read every file and ran the tests: all passed.",
      kind: "review",
      doc: function () {
        return '<header class="dk-doc-h"><span class="dk-doc-kind">' + Crew.brand("github", 13) + "Draft review, not posted</span><h2>" + row[2] + '</h2><p class="dk-doc-ref">' + this.ref + '</p></header><p class="dk-verdict"><b>' + row[3] + "</b></p><p>Small and well covered by tests. Nothing here changes behaviour outside the files it touches.</p>";
      },
      answers: function (r) {
        return [
          { act: "outward", label: "Post and sign off", kbd: "⌘↩", accent: true, desc: "Posts the review on <b>" + row[1] + "</b> as <b>GitHub · rogier</b>", stamp: "Review posted", outcome: "Review posted on " + row[1] },
          { act: "sign", label: "Sign off", kbd: "S", desc: "Files it as signed off. The review is not posted", stamp: "Nothing sent", outcome: "Signed off, not posted" },
          { act: "back", label: "Send back", kbd: "B", desc: backDesc(r) },
          { act: "take", label: "Take over", kbd: "T", desc: takeDesc(r) },
        ];
      },
      undo: { label: "Dismiss review", desc: "Dismisses your review on <b>" + row[1] + "</b> on GitHub" },
    };
  }

  function onClick(e) {
    var t = e.target.closest("button, a, input");
    if (!t) return;
    if (t.dataset.go) return go(t.dataset.go);
    if (t.dataset.folder) return openFolder(t.dataset.folder);
    if (t.dataset.answer !== undefined) return answer(Number(t.dataset.answer));
    if (t.dataset.bundleAct) return bundleAct(t.dataset.bundleAct);
    if (t.hasAttribute("data-slip-send")) return sendSlip();
    if (t.hasAttribute("data-slip-cancel")) {
      state.slip = null;
      return render();
    }
    if (t.hasAttribute("data-edit")) return toggleEdit();
    if (t.hasAttribute("data-also-reply")) {
      RESULTS.h2.alsoReply = t.checked;
      var led = $("[data-ledger]");
      if (led) led.outerHTML = ledger(RESULTS.h2);
      return;
    }
    if (t.dataset.changes) {
      state.showChanges = t.dataset.changes === "on";
      return renderOpen();
    }
    if (t.dataset.errand) {
      if (t.dataset.ring) {
        state.bellOpen = true;
        state.bellIndex = Math.max(0, state.bell.findIndex(function (q) { return q.errand === t.dataset.ring; }));
        return render();
      }
      return;
    }
    if (t.hasAttribute("data-bell")) {
      state.bellOpen = !state.bellOpen && state.bell.length > 0;
      return render();
    }
    if (t.hasAttribute("data-bell-close")) {
      state.bellOpen = false;
      return render();
    }
    if (t.dataset.bellAnswer !== undefined) return answerBell(Number(t.dataset.bellAnswer));
    if (t.dataset.filedKey) {
      state.filedOpen = t.dataset.filedKey;
      state.flipped = false;
      state.slip = null;
      return render();
    }
    if (t.hasAttribute("data-close-filed")) {
      state.filedOpen = null;
      return render();
    }
    if (t.hasAttribute("data-putback")) {
      var f = state.filed.filter(function (x) { return x.key === state.filedOpen; })[0];
      state.filed.splice(state.filed.indexOf(f), 1);
      RESULTS[f.id].status = "seen";
      state.tray.unshift(f.id);
      state.filedOpen = null;
      openFolder(f.id);
      return toast("Back in your tray, not signed off.");
    }
    if (t.hasAttribute("data-undo")) {
      var g = state.filed.filter(function (x) { return x.key === state.filedOpen; })[0];
      g.outcome = RESULTS[g.id].undo.label + ": done";
      g.outward = false;
      state.filedOpen = null;
      toast(RESULTS[g.id].undo.label + ". Undone where it could be.");
      return render();
    }
    if (t.hasAttribute("data-sim-play")) {
      state.playing = !state.playing;
      return renderProto();
    }
    if (t.hasAttribute("data-sim-next")) return nextEvent();
    if (t.hasAttribute("data-sim-reset")) return location.reload();
    if (t.hasAttribute("data-sim-theme")) {
      root.dataset.theme = root.dataset.theme === "orient-express" ? "whitehaven" : "orient-express";
      return render();
    }
  }

  /* ------------------------------------------------------------------ the morning, and its states */

  /** Sets up the morning at 09:41: four results in the tray, three colleagues out, one on the bell. */
  function setUpMorning() {
    state.tray = ["h2", "h5", "h3", "h1"];
    state.errands = [
      { id: "h4", name: "Investigate", title: "Refunds for partial captures", note: "Writing a failing test for a refund after a partial capture…", since: at("09:33"), pose: "working" },
      { id: "h7", name: "Investigate", title: "Nightly backup job timing out", note: "pg_dump of events (41 GB) takes 1h 52m; the job's limit is 2h", since: at("09:35"), pose: "working" },
      { id: "h6", name: "Fix 3-D Secure checkout for EU cards", title: "Fix 3-D Secure checkout", note: "Run git push -u origin fix/3ds-eu-cards?", since: at("09:02"), pose: "waiting" },
    ];
    state.bell = [
      {
        id: "push",
        errand: "h6",
        name: "Fix 3-D Secure checkout for EU cards",
        title: "Fix 3‑D Secure checkout for EU cards",
        proj: "webshop",
        projName: "webshop",
        since: at("09:31"),
        from: "",
        q: "Run <code>git push -u origin fix/3ds-eu-cards</code>?",
        answers: [
          { label: "Allow once", accent: true, kbd: "↩", act: "allow", desc: "Pushes <b>fix/3ds-eu-cards</b> to <b>rogier/webshop</b> from studio-mac, this once" },
          { label: "Always allow git push", act: "always", desc: "This thread may push without asking from now on" },
          { label: "Deny", quiet: true, act: "deny", desc: "The thread carries on without pushing" },
        ],
      },
    ];
    state.open = "h2";
    schedule(120, function () {
      arrive("h4", "h4");
    });
    schedule(400, function () {
      arrive("h7", "h7");
    });
  }

  /** Sets up the 10x morning: the tray holds bundles, so 12 results take five rows. */
  function setUpSwarm() {
    state.swarm = true;
    BUNDLES.bpr = {
      id: "bpr",
      workflow: "Review PR",
      tab: "Review PR · 6",
      title: "6 reviews, all high confidence",
      meta: "payments-api 3 · webshop 3 · landed 09:10 to 09:21",
      when: "Landed 09:10 to 09:21 · Claude Code · Sonnet 5",
      unseen: true,
      status: "landed",
      members: SWARM_PRS.map(function (p) {
        return { id: p[0], ref: p[1], title: p[2], verdict: p[3], sure: "High" };
      }),
    };
    BUNDLES.bfail = {
      id: "bfail",
      workflow: "Fix bug",
      failed: true,
      tab: "Failed · 3",
      title: "3 runs gave up",
      meta: "Fix bug 2 · Investigate 1 · since 08:40",
      when: "Failed 08:40 to 09:26",
      status: "seen",
      members: [
        { id: "h5", ref: "#1300", title: "Show VAT per line on invoices", verdict: "May not edit .github/workflows/test.yml" },
        { id: "h5", ref: "#1291", title: "Flaky checkout test on Safari", verdict: "Gave up after 3 tries" },
        { id: "h5", ref: "ops", title: "Grafana alert noise on ops-db", verdict: "Could not reach Grafana · ops" },
      ],
    };
    state.tray = ["bpr", "h3", "h4", "h7", "bfail"];
    RESULTS.h4.status = "landed";
    RESULTS.h7.status = "landed";
    state.open = "bpr";
    state.bell = [];
  }

  function setUpState(name) {
    if (name === "swarm") return setUpSwarm();
    if (name === "empty") {
      state.empty = true;
      state.tray = [];
      state.open = null;
      return;
    }
    setUpMorning();
    state.playing = !name;
    if (name === "floor") {
      state.view = "floor";
      state.playing = true;
    }
    if (name === "stamp" || name === "flip") {
      state.open = "h1";
      RESULTS.h1.status = "seen";
      if (name === "stamp") state.pinStamp = "Review posted";
      if (name === "flip") state.flipped = true;
    }
    if (name === "redo") {
      state.open = "h3";
      RESULTS.h3.status = "seen";
      state.slip = { id: "h3", mode: "back", text: ROGIER_NOTE_H3 };
    }
    if (name === "failed") state.open = "h5";
    if (name === "bell" || name === "draft2") {
      var r = RESULTS.h3;
      state.tray = state.tray.filter(function (id) { return id !== "h3"; });
      r.noteAt = "09:42";
      r.status = "out";
      countTrust(r, false);
      state.now = at("09:43");
      state.events = [];
      if (name === "bell") {
        state.errands.splice(2, 0, { id: "h3", name: "Draft reply", title: "Invoice INV-2291", note: "Void INV-2291 and create INV-2291-R in Stripe?", since: at("09:42"), pose: "waiting" });
        state.open = "h2";
        askStripe();
        state.bellOpen = true;
        state.bellIndex = 1;
      } else {
        r.attempt = 2;
        r.status = "seen";
        r.landed = "09:44";
        r.ran = "2m 50s";
        r.allowedAt = "09:43";
        r.confidence = "High";
        r.checked = "Checked INV-2291-R in Stripe: Brightline B.V., KvK 81234567, €2,450.";
        r.unsure = "";
        state.tray.unshift("h3");
        state.open = "h3";
        state.showChanges = true;
        state.now = at("09:45");
      }
    }
    if (name === "trust") {
      RESULTS.h1.status = "filed";
      state.tray = state.tray.filter(function (id) { return id !== "h1"; });
      state.filed.unshift({ key: "h1-0", id: "h1", title: RESULTS.h1.title, workflow: "Review PR", outcome: "Review posted on #1294", stamp: "Review posted", at: "09:42", outward: true });
      countTrust(RESULTS.h1, true);
      state.trustOffered = true;
      state.tray.unshift("offer");
      state.open = "offer";
      OFFER.status = "seen";
      state.now = at("09:42");
    }
    if (name === "cleared") {
      ["h2", "h5", "h3", "h1", "offer"].forEach(function (id, i) {
        var r = RESULTS[id];
        var a = r.answers(r)[id === "h5" ? 2 : 0];
        r.status = "filed";
        if (id !== "h5") countTrust(r, true);
        state.filed.unshift({ key: id + "-" + i, id: id, title: r.title, workflow: r.workflow, outcome: a.outcome, stamp: a.stamp, at: ["09:41", "09:42", "09:42", "09:43", "09:43"][i], outward: a.act !== "letgo" });
      });
      state.trustOffered = true;
      state.trustAccepted = "09:43";
      state.tray = [];
      state.open = null;
      state.now = at("09:43");
    }
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    wireSidebar();
    $("[data-desk-icon]").outerHTML = deskIcon();
    $("[data-bell-icon]").innerHTML = bellIcon();
    var stateName = root.dataset.state || "";
    setUpState(stateName);
    var sel = $("[data-sim-state]");
    sel.value = stateName;
    sel.addEventListener("change", function () {
      var p = new URLSearchParams(location.search);
      if (sel.value) p.set("state", sel.value);
      else p.delete("state");
      p.set("theme", root.dataset.theme);
      location.search = p.toString();
    });
    if (state.open && result(state.open).status === "landed" && stateName) result(state.open).status = "seen";
    if (!stateName && state.open) result(state.open).status = "seen";
    if (state.open && result(state.open).members) result(state.open).unseen = false;
    render();
    document.addEventListener("keydown", onKey);
    // While ⌘ is held, the ledger marks the answer ⌘↩ would take.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Meta" || e.key === "Control") root.classList.add("dk-cmd");
    });
    document.addEventListener("keyup", function (e) {
      if (e.key === "Meta" || e.key === "Control") root.classList.remove("dk-cmd");
    });
    window.addEventListener("blur", function () {
      root.classList.remove("dk-cmd");
    });
    document.addEventListener("click", onClick);
    document.addEventListener("focusin", function (e) {
      state.bellFocus = !!(e.target.closest && e.target.closest("[data-bell-card]"));
    });
    var tray = $("[data-in]");
    tray.addEventListener("pointerenter", function () {
      trayHovered = true;
    });
    tray.addEventListener("pointerleave", function () {
      trayHovered = false;
      var held = state.held.splice(0);
      held.forEach(function (h) {
        arrive(h[0], h[1]);
      });
    });
    var host = $("[data-office]");
    new ResizeObserver(function () {
      requestAnimationFrame(drawFloorOverlay);
    }).observe(host);
    requestAnimationFrame(tick);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
