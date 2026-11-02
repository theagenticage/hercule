// PROTOTYPE - the small behaviours of the book's cover page (index.html). ES5, no build.
// shared/book.js switches the theme and keeps it in localStorage; this file adds:
//   - the theme in the address and on the live-window links, so a reload, a shared link or a
//     live window keeps the theme you chose
//   - the section you are reading, marked in the top bar, which scrolls to keep it in view
//   - the dots under the swipeable role cards
//   - the button that unfolds the whole sidebar screenshot
(function () {
  "use strict";

  /**
   * Carries the theme everywhere the book goes: into ?theme= (without reloading), into the
   * localStorage key the story pages read, and onto the live-window links, which read only ?theme=.
   */
  function spreadTheme(theme) {
    var url = new URL(location.href);
    url.searchParams.set("theme", theme);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    localStorage.setItem("sbd-theme", theme);
    document.querySelectorAll('a[href*="desktop.html"]').forEach(function (a) {
      a.href = a.getAttribute("href").split("?")[0] + "?theme=" + encodeURIComponent(theme);
    });
  }

  /** Marks the top bar's link to the section under the bar, and scrolls the bar to show it. */
  function watchSections() {
    var nav = document.querySelector(".ix-nav");
    var links = Array.prototype.slice.call(nav.querySelectorAll("a"));
    var sections = Array.prototype.slice.call(document.querySelectorAll("[data-spy]"));
    var current = null;
    var queued = false;

    function update() {
      queued = false;
      var line = window.innerHeight * 0.35;
      var active = null;
      sections.forEach(function (sec) {
        if (sec.getBoundingClientRect().top <= line) active = sec.id;
      });
      if (active === current) return;
      current = active;
      links.forEach(function (a) {
        var on = a.getAttribute("href") === "#" + active;
        if (on) {
          a.setAttribute("aria-current", "true");
          // Scroll the bar itself, never the page: scrollIntoView would move the page too.
          var left = a.offsetLeft - nav.clientWidth / 2 + a.offsetWidth / 2;
          nav.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
        } else {
          a.removeAttribute("aria-current");
        }
      });
    }
    window.addEventListener(
      "scroll",
      function () {
        if (!queued) {
          queued = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true },
    );
    update();
  }

  /** Keeps the dots under the role cards in step with the card in view, and lets a dot pick a card. */
  function wireRoleDots() {
    var row = document.getElementById("ix-team");
    var cards = row.querySelectorAll(".ix-role");
    var dots = document.querySelectorAll(".ix-dots button");

    function cardLeft(i) {
      return cards[i].offsetLeft - cards[0].offsetLeft;
    }
    function update() {
      var best = 0;
      for (var i = 1; i < cards.length; i++) {
        if (Math.abs(cardLeft(i) - row.scrollLeft) < Math.abs(cardLeft(best) - row.scrollLeft)) best = i;
      }
      for (var j = 0; j < dots.length; j++) {
        if (j === best) dots[j].setAttribute("aria-current", "true");
        else dots[j].removeAttribute("aria-current");
      }
    }
    row.addEventListener("scroll", update, { passive: true });
    Array.prototype.forEach.call(dots, function (dot, i) {
      dot.addEventListener("click", function () {
        row.scrollTo({ left: cardLeft(i), behavior: "smooth" });
      });
    });
  }

  /** Unfolds the sidebar screenshot to its full height, and folds it again. */
  function wireScreenshot() {
    var shot = document.querySelector(".ix-shot");
    var button = shot.querySelector(".ix-shot-more");
    var label = button.querySelector("span");
    button.addEventListener("click", function () {
      var open = !shot.classList.contains("is-open");
      shot.classList.toggle("is-open", open);
      button.setAttribute("aria-expanded", String(open));
      label.textContent = open ? "Fold the sidebar again" : "Show the whole sidebar";
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("[data-theme-option]").forEach(function (b) {
      b.addEventListener("click", function () {
        spreadTheme(b.dataset.themeOption);
      });
    });
    spreadTheme(document.documentElement.dataset.theme);
    watchSections();
    wireRoleDots();
    wireScreenshot();
  });
})();
