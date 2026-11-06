// The other places a card leads to. Work belongs to the Overview design; here it is a stand-in, so the way through can be walked.
window.Pages = (function () {
  var current = 'inbox';
  function goToWork() {}
  return { current: function () { return current; }, goToWork: goToWork };
})();
