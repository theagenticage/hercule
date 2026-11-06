// PROTOTYPE - loads each move's script in order, then starts the moves that are on. Each file only
// registers itself with Beauty.move(), so with every move off none of them does anything.
(function () {
  "use strict";
  var FILES = ["ring", "colleagues", "sheet", "landing", "clear"];
  var left = FILES.length;
  FILES.forEach(function (name) {
    var s = document.createElement("script");
    s.src = "../moves/" + name + ".js";
    s.async = false;
    s.onload = s.onerror = function () { if (--left === 0) Beauty.start(); };
    document.body.appendChild(s);
  });
})();
