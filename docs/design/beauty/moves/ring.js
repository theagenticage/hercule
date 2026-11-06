// PROTOTYPE - One ring: focus is one thing that travels, not a ring that blinks off here and on
// there. At rest the card draws its own ring (moves/ring.css), so nothing here follows a card or
// knows about redraws. This file exists only for the journey between two cards.
(function () {
  "use strict";

  var ring = null;
  var body = null;
  var watcher = null;
  // What shows the ring now, and where the ring last stood on screen, in case its card has gone.
  var target = null;
  var lastSpot = null;
  var scroller = null;
  var lastScroll = 0;
  var travelling = false;
  var walkTimer = 0;

  /** Checks whether this page is Work. Its rings sit outside the card, and the Inbox's inside. */
  function isWork() { return !!document.getElementById("lanes"); }

  /** Returns what wears the ring right now, or null. A card under an open sheet wears none. */
  function readTarget() {
    var el;
    if (isWork()) {
      var lanes = document.getElementById("lanes");
      el = lanes.querySelector(".card.is-focus, .lane-btn.is-focus, .plan-head.is-focus");
      var active = document.activeElement;
      if (!el && active && lanes.contains(active) && active.matches(".card, .lane-btn, .plan-head") && active.matches(":focus-visible")) el = active;
    } else {
      el = document.querySelector("#page .card.is-focus, #page .part.is-focus, #page .plaque.is-focus, #page .b-open.is-focus");
    }
    if (!el || el.classList.contains("is-away") || el.classList.contains("is-source") || !el.getClientRects().length) return null;
    return el;
  }

  /** Returns where a thing's ring stands: its box on screen, its corner and its width. */
  function readSpot(el) {
    var r = el.getBoundingClientRect();
    // On Work a ring stands 2px off the sheet, and so does a place's name on the Inbox. Anything else
    // on the Inbox wears its ring inside its edge.
    var out = isWork() || el.classList.contains("b-open") ? 4 : 0;
    var width = out ? 2 : 1.5;
    var corner = parseFloat(getComputedStyle(el.querySelector(":scope > .card-stock") || el).borderTopLeftRadius) + out;
    return { x: r.left - out, y: r.top - out, s: r.width + out * 2, r: r.height + out * 2, l: corner, width: width };
  }

  /** Draws one frame of the ring. The kernel's scale and tilt channels carry its width and height. */
  function writeRing() {
    var v = this.value;
    ring.style.transform = "translate3d(" + v.x.toFixed(2) + "px," + v.y.toFixed(2) + "px,0)";
    ring.style.width = v.s.toFixed(2) + "px";
    ring.style.height = v.r.toFixed(2) + "px";
    ring.style.borderRadius = v.l.toFixed(2) + "px";
    ring.style.opacity = v.o.toFixed(3);
  }

  function arrive() {
    travelling = false;
    ring.hidden = true;
    if (target) {
      target.classList.remove("b-ring-wait");
      lastSpot = readSpot(target);
    }
  }

  /** Fades the ring where it stands, opening a little, as a hand lets go. */
  function letGo(spot) {
    if (!spot) return;
    if (!travelling) body.set({ x: spot.x, y: spot.y, s: spot.s, r: spot.r, l: spot.l, o: 1 });
    ring.hidden = false;
    travelling = true;
    body.to({ x: body.value.x - 3, y: body.value.y - 3, s: body.value.s + 6, r: body.value.r + 6, o: 0 }, "hand", { done: arrive });
  }

  /** Looks at who wears the ring now, and sends the ring there when that has changed. */
  function followFocus() {
    if (!ring) return;
    // A page that scrolled to bring the next card into view carried the old spot with it.
    var scrolled = scroller.scrollTop - lastScroll;
    lastScroll = scroller.scrollTop;
    if (scrolled) {
      if (lastSpot) lastSpot.y -= scrolled;
      if (travelling) body.value.y -= scrolled;
    }
    var next = readTarget();
    if (next === target) return;
    if (target) target.classList.remove("b-ring-wait");
    var from = target && target.isConnected && target.getClientRects().length ? readSpot(target) : lastSpot;
    target = next;
    if (Beauty.isCalm() || document.querySelector(".is-merge-picking")) {
      if (travelling) arrive();
      lastSpot = next ? readSpot(next) : null;
      return;
    }
    if (!next) {
      letGo(from);
      lastSpot = null;
      return;
    }
    var to = readSpot(next);
    next.classList.add("b-ring-wait");
    ring.style.setProperty("--b-ring-w", to.width + "px");
    if (!travelling) {
      // From nowhere, it closes in on the card from a little further out.
      if (from) body.set({ x: from.x, y: from.y, s: from.s, r: from.r, l: from.l, o: 1 });
      else body.set({ x: to.x - 8, y: to.y - 8, s: to.s + 16, r: to.r + 16, l: to.l + 8, o: 0 });
    }
    ring.hidden = false;
    travelling = true;
    lastSpot = to;
    body.to({ x: to.x, y: to.y, s: to.s, r: to.r, l: to.l, o: 1 }, "hand", { done: arrive });
  }

  /** Presses one key the way a person does, so the walk runs the page's own key handling. */
  function pressKey(key) {
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: key, code: key, bubbles: true, cancelable: true }));
  }

  /** Walks the focus across a few cards, for someone who wants to see the ring without reaching for the keys. */
  function walkCards() {
    clearTimeout(walkTimer);
    var keys = isWork() ? ["ArrowDown", "ArrowRight", "ArrowRight", "ArrowDown", "ArrowLeft"] : ["ArrowDown", "ArrowDown", "ArrowRight", "ArrowDown", "ArrowLeft"];
    var step = function () {
      pressKey(keys.shift());
      if (keys.length) walkTimer = setTimeout(step, 350);
    };
    step();
  }

  Beauty.move("ring", {
    on: function () {
      var work = isWork();
      scroller = document.getElementById(work ? "scroll" : "page");
      lastScroll = scroller.scrollTop;
      ring = document.createElement("i");
      ring.className = "b-ring";
      ring.hidden = true;
      document.getElementById(work ? "work" : "main").appendChild(ring);
      body = Motion.body(ring);
      body.tolerance = { x: 0.08, y: 0.08, s: 0.08, r: 0.08, o: 0.01, l: 0.08 };
      body.write = writeRing;
      target = readTarget();
      lastSpot = target ? readSpot(target) : null;
      watcher = new MutationObserver(followFocus);
      watcher.observe(document.getElementById(work ? "lanes" : "page"), { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
      document.addEventListener("focusin", followFocus);
      document.addEventListener("focusout", followFocus);
    },
    off: function () {
      clearTimeout(walkTimer);
      watcher.disconnect();
      document.removeEventListener("focusin", followFocus);
      document.removeEventListener("focusout", followFocus);
      if (target) target.classList.remove("b-ring-wait");
      document.querySelectorAll(".b-ring-wait").forEach(function (el) { el.classList.remove("b-ring-wait"); });
      body.clear();
      ring.remove();
      ring = null;
      body = null;
      target = null;
      lastSpot = null;
      travelling = false;
    },
    play: function (name) {
      if (name === "walk") walkCards();
    },
  });
})();
