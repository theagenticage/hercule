// PROTOTYPE - the glass composer. While the transcript scrolls away from the bottom, the composer
// shrinks to one line and its glass thins, so the conversation stays visible through it. It
// restores at the bottom or when it takes focus. ?state=scrolled forces the shrunken state for
// screenshots and scrolls the transcript up so text passes behind the glass.
(function () {
  function start() {
    var scroller = document.querySelector("[data-transcript]");
    var composer = document.querySelector(".composer");
    if (!scroller || !composer) return;
    var forced = /\bscrolled\b/.test(document.documentElement.dataset.state || "");
    scroller.scrollTop = scroller.scrollHeight;
    if (forced) {
      scroller.scrollTop -= Number(scroller.dataset.scrolledBy || 260);
      return;
    }
    scroller.addEventListener("scroll", function () {
      if (composer.contains(document.activeElement)) return;
      var atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
      composer.classList.toggle("is-scrolled", !atBottom);
    });
    composer.addEventListener("focusin", function () {
      composer.classList.remove("is-scrolled");
    });
  }
  // Wait for fonts and layout, so the transcript's height is final before it is scrolled.
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start);
})();
