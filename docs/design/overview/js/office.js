// PROTOTYPE - the Office beside Work. The real 3D Office from the app, through the kit in vendor/.
// It stays what it is: a view of sessions. The one thing this file adds is that it knows where each
// colleague stands on screen, so a colleague can walk off a card and into the room, and back.
window.Office = (function () {
  "use strict";

  var stage = null;
  var beans = {};
  var K = null;

  /** Builds the room the first time it is shown. Returns false when the page has no WebGL. */
  function ensure(container) {
    if (stage) return true;
    K = window.OfficeKit;
    if (!K) return false;
    try {
      stage = K.stage.create(container);
    } catch (e) {
      return false;
    }
    var W = 12;
    var D = 7.2;
    stage.add(K.buildRoom({ width: W, depth: D, tint: "webshop", door: { wall: "south", at: 2.8 } }));
    var plaque = K.buildPlaque("Bureau");
    plaque.rotation.y = Math.PI / 2;
    plaque.position.set(-W / 2 + K.WALL_THICKNESS / 2 + 0.002, 1.42, -1.6);
    stage.add(plaque);

    var working = Store.state.tasks.filter(function (t) { return t.agent && t.kind !== "review"; }).slice(0, 8);
    var deskX = [-2.4, -1.12, 0.16, 1.44];
    working.forEach(function (t, i) {
      var desk = K.buildDesk();
      desk.object.rotation.y = Math.PI;
      var row = i < 4 ? 0 : 1;
      desk.object.position.set(deskX[i % 4], 0, row ? 1.5 : -1.5);
      stage.add(desk.object);
      var look = Crew.lookFor(t.agent);
      var bean = K.colleague({ id: t.agent, pose: t.move === "you" ? "waiting" : "working", look: { hue: look.hue } });
      bean.sitAt(desk);
      stage.add(bean);
      stage.label(bean, K.tag({ name: t.name.length > 26 ? t.name.slice(0, 25) + "…" : t.name, state: t.move === "you" ? "Asks you" : "", hue: bean.look.hue, waiting: t.move === "you" }));
      beans[t.id] = bean;
    });
    var rug = K.buildRug(2.6, 1.9);
    rug.position.set(-4.3, 0, 2.2);
    stage.add(rug);
    var chair = K.buildArmchair();
    chair.object.rotation.y = Math.PI / 3;
    chair.object.position.set(-4.5, 0, 2);
    stage.add(chair.object);
    var palm = K.buildPlant("tall");
    palm.position.set(W / 2 - 0.6, 0, -D / 2 + 0.6);
    stage.add(palm);
    var lamp = K.buildFloorLamp();
    lamp.object.position.set(W / 2 - 0.5, 0, D / 2 - 0.9);
    stage.add(lamp.object);
    var cab = K.buildCabinet();
    cab.rotation.y = Math.PI / 2;
    cab.position.set(-W / 2 + 0.4, 0, -0.1);
    stage.add(cab);
    return true;
  }

  /** Returns where a Task's colleague stands on screen, or null when it has no desk here. */
  function locate(taskId, container) {
    var bean = beans[taskId];
    if (!bean || !stage) return null;
    var v = new THREE.Vector3();
    bean.getWorldPosition(v);
    v.y += bean.headHeight || 1;
    v.project(stage.camera);
    var r = container.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }

  return {
    ensure: ensure,
    locate: locate,
    pause: function () { if (stage) stage.pause(); },
    resume: function () { if (stage) stage.resume(); },
    hasBean: function (id) { return !!beans[id]; },
  };
})();
