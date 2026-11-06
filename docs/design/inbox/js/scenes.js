// The states of the Inbox, each reachable by ?scene=. They exist so every state can be opened and photographed.
window.Scenes = (function () {
  var W = World;
  var defs = {
    morning: function () { return { name: 'morning', entities: W.buildEntities(), clusters: W.CLUSTERS.slice() }; },
  };
  function play(name) { App.load((defs[name] || defs.morning)()); }
  return { play: play, defs: defs };
})();
