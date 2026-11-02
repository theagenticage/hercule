// PROTOTYPE - Control Tower's Office: the Aerodrome.
//
// Every Turn is a flight. A thread is a small 1930s monoplane in its colleague's hue with its bean
// in the open cockpit; where the plane is says when the thread will need Rogier:
//   holding    an open Request: the plane circles the control tower, oldest lowest, a marigold
//              beacon on its fin and the ask on its level of the stack
//   approach   predicted to need him within about 15 minutes: lined up on the glide path, placed
//              by its ETA (the path is a time axis: 5, 10 and 15 minute gates), its range drawn
//   cruising   working, needs him later: lazy loops over its project's hangar
//   on stand   a finished turn he has not read: at a numbered stand in front of the terminal
//   parked     idle, nothing unread: on its hangar's apron
//   hangar     Done: inside its project's hangar, doors open
// Runs are mail planes on small circuits with a stop per step. Assistants watch from the
// terminal's roof terrace. Rogier's desk is in the tower cab, under the "Now serving" sign.
//
// The module follows ../BUILDERS.md: window.OfficeModes["control-tower"].mount(container, api)
// returns { select, setState, resize, pause, resume, dispose }, plus three extras the window may
// call: clear(id) (Rogier answered: a touch-and-go, back in the air), land(id) (a turn ended: it
// lands and taxis to a stand) and frameZone(name) (the camera presets the shots use).
//
// It reads the shared world (world.js, world-plus.js) and Control Tower's own data
// (control-tower-data.js: call signs, urgency, slots, the conflict) so its counts and words
// agree with the strips and the radar. Every CSS class starts with ctof-.
(function () {
  "use strict";

  var FOLDER = "control-tower";
  var ROOT_CLASS = "ov-control-tower-office";

  /* ================================================================== the plan, in metres */
  // +x is east, -z is north, y is up. The camera opens from the south-south-east.

  var PLAN = {
    base: { x0: -56, x1: 64, z0: -44, z1: 37, corner: 12 },
    tower: { x: 0, z: 0 },
    terminal: { half: 15, depth: 8, height: 5 },
    apron: { x0: -25, x1: 25, z0: 4.6, z1: 19.6 },
    gates: { z: 11.4, x0: -22.4, step: 6.4, count: 8 },
    // The runway runs north-south on the field's east side; planes land southbound, so the
    // approach comes in from the north, out of the back of the picture.
    runway: { x: 51, z0: -40, z1: 27, width: 7.4 },
    taxiP: { x: 43, z0: -8, z1: 26.5, width: 3.6 },
    taxiN: { z: -8, x0: -48, x1: 51, width: 3.6 },
    taxiS: { z: 26.5, x0: -25, x1: 51, width: 3.6 },
    exitZ: 1.6,
    hangars: [
      { project: "webshop", tint: "webshop", name: "WEBSHOP", x: -40, z: -24, width: 16, depth: 13 },
      { project: "payments-api", tint: "payments", name: "PAYMENTS-API", x: -21, z: -24, width: 16, depth: 13 },
      { project: "ops", tint: "ops", name: "OPS", x: 5, z: -24, width: 16, depth: 13 },
      { project: null, tint: null, name: "AÉRO-CLUB", x: 23, z: -22.5, width: 11, depth: 10 },
    ],
    holding: { radius: 13, low: 28, step: 3 },
    // The runs' mail circuits, between the apron and the runway.
    mail: { cols: [30.6, 37.2], rows: [8.4, 15, 21.6], rx: 2.9, rz: 2.1 },
  };

  // The approach: minutes until a flight needs Rogier, laid out along the glide path from the
  // runway's east threshold. One control point every five minutes; 0-15 is the approach proper,
  // 15-30 the extension the conflict uses.
  var APPROACH = [
    [51, 1.1, -38],
    [51, 5.4, -52],
    [52, 9.2, -64.5],
    [55, 12.4, -75.5],
    [60, 15, -85],
    [66.5, 17, -92],
    [74, 18.6, -97],
  ];
  var APPROACH_MINUTES = 30;

  var PROJECT_ORDER = ["webshop", "payments-api", "ops", null];

  /* ================================================================== the world, read */

  var W = null;
  var H = null;
  var TOWER_DATA = null;

  function minutes(time) {
    return H.minutes(time);
  }
  function nowMinutes() {
    return minutes(W.now);
  }
  function clock(m) {
    m = ((Math.round(m) % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60);
    var mm = m % 60;
    return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
  }
  function ago(time) {
    var m = nowMinutes() - minutes(time);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    if (m < 1440) return Math.floor(m / 60) + "h";
    return Math.floor(m / 1440) + "d";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }
  function shorten(text, n) {
    return text.length <= n ? text : text.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";
  }

  // Call signs as the strips write them: the project's two letters and the title's most telling
  // word (control-tower-data.js), and a partner flies in its lead's formation with its number.
  var callCache = {};
  function callSign(t) {
    if (callCache[t.id]) return callCache[t.id];
    var codes = (TOWER_DATA && TOWER_DATA.projectCodes) || { webshop: "WS", "payments-api": "PA", ops: "OP" };
    var keywords = (TOWER_DATA && TOWER_DATA.keywords) || {};
    var lead = t.lead ? H.thread(t.lead) : null;
    var key = lead ? lead.id : t.id;
    var word = keywords[key] || longestWord(lead ? lead.title : t.title);
    var code = codes[t.project];
    var cs = code ? code + "·" + word : word;
    if (lead) {
      var wing = H.allLive({ swarm: true, spawn: true })
        .filter(function (x) {
          return x.lead === t.lead;
        })
        .sort(function (a, b) {
          return minutes(a.started) - minutes(b.started);
        })
        .map(function (x) {
          return x.id;
        });
      cs += " " + (wing.indexOf(t.id) + 2);
    }
    callCache[t.id] = cs;
    return cs;
  }
  function longestWord(title) {
    return title
      .split(/\s+/)
      .sort(function (a, b) {
        return b.length - a.length;
      })[0]
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 7)
      .toUpperCase();
  }

  // A colleague's look, as the window's faces draw it: cast by hand or hashed from the title.
  var HEADWEAR = { cloche: true, beret: true, headset: true };
  function lookFor(title, kind) {
    var K = window.OfficeKit;
    var look;
    if (window.Crew && window.Crew.lookFor) {
      var c = window.Crew.lookFor(title);
      var parts = String(c.acc || "none").split("+");
      var headwear = null;
      var accessories = [];
      parts.forEach(function (p) {
        if (HEADWEAR[p]) headwear = p;
        else if (p !== "none") accessories.push(p);
      });
      look = { hue: c.hue, shape: c.shape, accessories: accessories, headwear: headwear };
    } else {
      var b = K.buildLook(title);
      look = { hue: b.hue, shape: b.shape, accessories: b.accessories.slice(), headwear: b.headwear };
    }
    if (kind === "assistant" && !look.headwear) look.headwear = "cloche";
    if (kind === "run") {
      look.headwear = "visor";
      look.accessories = look.accessories.filter(function (a) {
        return a !== "homburg";
      });
    }
    return look;
  }

  /* ================================================================== flights */

  /**
   * Returns the flights a state shows: one per live thread (the window's list: the morning's 16,
   * plus the swarm's 19 in the swarm state), the run step that waits on Rogier, and the Done
   * threads in their hangars. Each flight has its phase and what its tag says.
   */
  function buildFlights(state, events) {
    var now = nowMinutes();
    var unread = state === "away" ? W.away.resultUnread : W.resultUnread;
    var threads = W.threads.slice();
    if (state === "swarm") threads = threads.concat(W.swarm.threads);
    var urgent = (TOWER_DATA && TOWER_DATA.urgent) || {};
    var slotsOn = state === "slots";
    var every = (TOWER_DATA && TOWER_DATA.slots && TOWER_DATA.slots.slots.every) || 30;
    var nextSlot = (Math.floor(now / every) + 1) * every;
    var lastSlot = Math.floor(now / every) * every;

    var flights = threads.map(function (t) {
      var e = W.eta[t.id] || {};
      var f = {
        id: t.id,
        kind: "thread",
        t: t,
        title: t.title,
        faceTitle: t.title,
        project: t.project,
        lead: t.lead || null,
        role: t.role || null,
        call: callSign(t),
        beanPose: "working",
      };
      if (events.cleared[t.id]) {
        f.phase = "cruising";
        f.cleared = events.cleared[t.id];
        f.beanPose = "working";
      } else if (events.landed[t.id]) {
        f.phase = "stand";
        f.landedAt = events.landed[t.id];
        f.beanPose = "idle";
      } else if (t.pose === "waiting") {
        f.phase = "holding";
        f.since = t.last;
        f.ask = t.askShort || t.ask;
        f.askKind = t.status;
        f.beanPose = "waiting";
      } else if (t.pose === "working" || t.status === "queued") {
        f.range = e.range ? [e.range[0], e.range[1]] : null;
        f.queued = t.status === "queued";
        f.busySince = e.busySince;
        f.next = e.next;
        f.phase = f.range && f.range[1] <= 15 ? "approach" : "cruising";
        f.beanPose = "working";
      } else {
        f.phase = unread[t.id] ? "stand" : "parked";
        f.beanPose = t.pose === "asleep" ? "asleep" : "idle";
      }
      f.urgent = !!urgent[t.id];
      if (slotsOn && f.phase === "holding" && !f.urgent && minutes(f.since) > lastSlot) f.slot = clock(nextSlot);
      if (slotsOn && (f.phase === "approach" || f.phase === "cruising") && f.range && !f.urgent) {
        f.slot = clock(Math.ceil((now + f.range[0]) / every) * every);
      }
      return f;
    });

    // The run step that waits on Rogier flies in the holding stack, as its strip sits in Holding.
    W.waitingRuns.forEach(function (r) {
      if (events.cleared[r.id]) return;
      var rs = W.runSessions[r.id];
      var run = W.runs.filter(function (x) {
        return x.id === rs.run;
      })[0];
      var codes = (TOWER_DATA && TOWER_DATA.projectCodes) || { "payments-api": "PA" };
      var word = (TOWER_DATA && TOWER_DATA.keywords && TOWER_DATA.keywords[r.id]) || "SHIP";
      var f = {
        id: r.id,
        kind: "run",
        title: r.title,
        faceTitle: run.title,
        project: r.project,
        call: codes[r.project] + "·" + word,
        phase: "holding",
        since: r.last,
        ask: r.ask,
        askKind: "approval",
        beanPose: "waiting",
        run: run,
        urgent: !!urgent[r.id],
      };
      if (slotsOn && !f.urgent && minutes(f.since) > lastSlot) f.slot = clock(nextSlot);
      flights.push(f);
    });

    // Done threads in the hangars: the shelf's first seven, as the strips' Hangar lists them.
    W.done.forEach(function (d) {
      flights.push({
        id: d.id,
        kind: "done",
        title: d.title,
        faceTitle: d.title,
        project: d.project,
        lead: d.lead || null,
        call: callSign({ id: d.id, title: d.title, project: d.project, lead: null }),
        phase: "hangar",
        doneAt: d.doneAt,
        beanPose: "done",
      });
    });

    flights.forEach(function (f) {
      f.look = lookFor(f.faceTitle, f.kind === "run" ? "run" : "thread");
    });
    return flights;
  }

  /* ================================================================== geometry helpers */

  var THREE = null;
  var K = null;

  function compose(x, y, z, ry, rx, rz, sx, sy, sz) {
    var m = new THREE.Matrix4();
    var q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0, "YXZ"));
    m.compose(new THREE.Vector3(x || 0, y || 0, z || 0), q, new THREE.Vector3(sx == null ? 1 : sx, sy == null ? (sx == null ? 1 : sx) : sy, sz == null ? (sx == null ? 1 : sx) : sz));
    return m;
  }

  /** Returns a geometry with only positions and normals, non-indexed, moved by `matrix`. */
  function bake(geometry, matrix) {
    var g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    geometry.dispose();
    if (!g.attributes.normal) g.computeVertexNormals();
    var out = new THREE.BufferGeometry();
    out.setAttribute("position", g.attributes.position.clone());
    out.setAttribute("normal", g.attributes.normal.clone());
    g.dispose();
    if (matrix) {
      out.applyMatrix4(matrix);
      // A mirror turns every triangle inside out: wind them back.
      if (matrix.determinant() < 0) {
        var a = out.attributes.position.array;
        var n = out.attributes.normal.array;
        for (var i = 0; i < a.length; i += 9) {
          for (var k = 0; k < 3; k++) {
            var t = a[i + 3 + k];
            a[i + 3 + k] = a[i + 6 + k];
            a[i + 6 + k] = t;
            t = n[i + 3 + k];
            n[i + 3 + k] = n[i + 6 + k];
            n[i + 6 + k] = t;
          }
        }
      }
    }
    return out;
  }

  /** Merges baked geometries into one. */
  function merge(list) {
    var count = 0;
    list.forEach(function (g) {
      count += g.attributes.position.count;
    });
    var pos = new Float32Array(count * 3);
    var nor = new Float32Array(count * 3);
    var o = 0;
    list.forEach(function (g) {
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      o += g.attributes.position.count;
      g.dispose();
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    out.computeBoundingSphere();
    return out;
  }

  /**
   * Collects parts by material and builds one mesh per material: the field has thousands of
   * small parts (lights, dashes, ribs), and one draw each would be too many.
   */
  function Batch() {
    this.groups = {};
  }
  Batch.prototype.add = function (material, geometry, matrix) {
    var key = material.uuid;
    if (!this.groups[key]) this.groups[key] = { material: material, parts: [] };
    this.groups[key].parts.push(bake(geometry, matrix));
    return this;
  };
  Batch.prototype.build = function (parent, opts) {
    opts = opts || {};
    var meshes = [];
    for (var key in this.groups) {
      var g = this.groups[key];
      var mesh = new THREE.Mesh(merge(g.parts), g.material);
      mesh.castShadow = opts.cast !== false;
      mesh.receiveShadow = opts.receive !== false;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.groups = {};
    return meshes;
  };

  function paint(token, finish, shift) {
    return K.paint(token, finish, shift);
  }

  function roundedRect(x0, y0, x1, y1, r) {
    var s = new THREE.Shape();
    s.moveTo(x0 + r, y0);
    s.lineTo(x1 - r, y0);
    s.quadraticCurveTo(x1, y0, x1, y0 + r);
    s.lineTo(x1, y1 - r);
    s.quadraticCurveTo(x1, y1, x1 - r, y1);
    s.lineTo(x0 + r, y1);
    s.quadraticCurveTo(x0, y1, x0, y1 - r);
    s.lineTo(x0, y0 + r);
    s.quadraticCurveTo(x0, y0, x0 + r, y0);
    return s;
  }

  /** A stadium: a rectangle with round ends along x, centred, `half` to the end of the round. */
  function stadium(half, r) {
    var s = new THREE.Shape();
    var a = half - r;
    s.moveTo(-a, -r);
    s.lineTo(a, -r);
    s.absarc(a, 0, r, -Math.PI / 2, Math.PI / 2, false);
    s.lineTo(-a, r);
    s.absarc(-a, 0, r, Math.PI / 2, (Math.PI * 3) / 2, false);
    return s;
  }

  /** Extrudes a floor plan upward from y0 to y0 + height. The plan's y is world -z. */
  function extrudeUp(shape, height, y0, curveSegments) {
    var g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: curveSegments || 24 });
    g.rotateX(-Math.PI / 2);
    g.translate(0, y0, 0);
    return g;
  }

  /* ================================================================== painted signs */

  var signs = [];

  function readCss(name) {
    return getComputedStyle(document.documentElement).getPropertyValue("--" + name).trim();
  }

  /**
   * Builds a flat sign: a plane of `w` by `h` metres whose canvas `draw(ctx, width, height)`
   * paints, redrawn whenever the theme or the fonts change.
   */
  function buildSign(w, h, pxPerMetre, draw, opts) {
    opts = opts || {};
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(w * pxPerMetre);
    canvas.height = Math.round(h * pxPerMetre);
    var texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    var material = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      roughness: 0.88,
      metalness: 0,
      depthWrite: opts.depthWrite !== false,
      polygonOffset: !!opts.decal,
      polygonOffsetFactor: opts.decal ? -2 : 0,
      polygonOffsetUnits: opts.decal ? -2 : 0,
    });
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.receiveShadow = true;
    function redraw() {
      var ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      draw(ctx, canvas.width, canvas.height);
      texture.needsUpdate = true;
    }
    redraw();
    signs.push({ redraw: redraw, texture: texture, material: material, geometry: mesh.geometry });
    return mesh;
  }

  function redrawSigns() {
    signs.forEach(function (s) {
      s.redraw();
    });
  }

  /** Lays a sign flat on the ground, its top toward -z (north), unless `yaw` turns it. */
  function layFlat(mesh, x, y, z, yaw) {
    mesh.rotation.order = "YXZ";
    mesh.rotation.set(-Math.PI / 2, yaw || 0, 0);
    mesh.position.set(x, y, z);
    return mesh;
  }

  /* ================================================================== the aerodrome */

  /**
   * Builds everything that holds still: the ground, the runway, the taxiways and the apron, the
   * terminal and its tower, the hangars, the mail circuits' posts, trees and lights. Returns the
   * group and the handles the module changes later (the Now serving sign, the beacon, the lights).
   */
  function buildAerodrome() {
    var root = new THREE.Group();
    root.name = "aerodrome";
    var batch = new Batch();
    var flat = new Batch(); // ground markings: receive shadows, cast none
    var lit = []; // { mesh, day, night }: swapped with the theme
    var handles = { lit: lit, hangarProxies: [], towerProxy: null };

    var lawn = paint("room-lawn", "matte");
    var lawnDark = paint("room-lawn", "matte", { dl: -0.035 });
    var plinth = paint("room-inlay-2", "lacquer");
    var brass = paint("brass", "brass");
    var concrete = paint("room-floor", "matte", { dl: -0.02 });
    var tarmac = paint("room-metal", "matte", { dl: -0.12, dc: -0.004 });
    var marking = paint("room-paper", "matte");
    var ivory = paint("room-wall", "satin");
    var lacquer = paint("room-inlay-2", "lacquer");
    var dayGlass = paint("room-screen", "gloss");
    var nightGlass = paint("room-sun", "glow", { dl: 0.18 });
    var dayLight = paint("room-metal", "satin", { dl: 0.06 });
    var nightLight = paint("room-sun", "glow", { dl: 0.42 });
    var nightGreen = paint("room-lamp", "glow", { dl: 0.2 });
    var wood = paint("room-wood", "satin");
    var leaf = paint("room-plant", "matte", { dl: -0.04 });
    var leafLight = paint("room-plant", "matte", { dl: 0.03 });

    var B = PLAN.base;

    // ---- the diorama's base: a lawn on a lacquered plinth with a brass rule
    var base = extrudeUp(roundedRect(B.x0, -B.z1, B.x1, -B.z0, B.corner), 2.2, -2.2);
    var baseMesh = new THREE.Mesh(base, [lawn, plinth]);
    baseMesh.receiveShadow = true;
    root.add(baseMesh);
    var rule = extrudeUp(roundedRect(B.x0 - 0.12, -B.z1 - 0.12, B.x1 + 0.12, -B.z0 - 0.12, B.corner + 0.12), 0.14, -0.62);
    batch.add(brass, rule);
    var foot = extrudeUp(roundedRect(B.x0 - 0.5, -B.z1 - 0.5, B.x1 + 0.5, -B.z0 - 0.5, B.corner + 0.5), 0.5, -2.7);
    batch.add(plinth, foot);

    // Mown stripes, the way an aerodrome's grass is cut: wide bands one shade darker.
    for (var sx = B.x0 + 14; sx < B.x1 - 10; sx += 16) {
      flat.add(lawnDark, new THREE.PlaneGeometry(8, B.z1 - B.z0 - 8).rotateX(-Math.PI / 2), compose(sx, 0.012, (B.z0 + B.z1) / 2));
    }

    // ---- the runway, 18/36, landing south from the north threshold
    var R = PLAN.runway;
    var rLen = R.z1 - R.z0;
    var rMid = (R.z0 + R.z1) / 2;
    batch.add(tarmac, new THREE.BoxGeometry(R.width, 0.08, rLen), compose(R.x, 0.04, rMid));
    [-1, 1].forEach(function (side) {
      flat.add(marking, new THREE.PlaneGeometry(0.16, rLen - 2).rotateX(-Math.PI / 2), compose(R.x + side * (R.width / 2 - 0.35), 0.085, rMid));
    });
    for (var cz = R.z0 + 14; cz < R.z1 - 14; cz += 5) {
      flat.add(marking, new THREE.PlaneGeometry(0.22, 2.6).rotateX(-Math.PI / 2), compose(R.x, 0.085, cz));
    }
    // Threshold piano keys and touchdown bars at both ends.
    [R.z0 + 2.2, R.z1 - 2.2].forEach(function (tz, end) {
      for (var k = 0; k < 8; k++) {
        var kx = R.x - R.width / 2 + 0.75 + k * ((R.width - 1.5) / 7);
        if (k === 3 || k === 4) continue;
        flat.add(marking, new THREE.PlaneGeometry(0.42, 3.4).rotateX(-Math.PI / 2), compose(kx, 0.086, tz));
      }
      var dir = end === 0 ? 1 : -1;
      [13, 17].forEach(function (d) {
        [-1, 1].forEach(function (side) {
          flat.add(marking, new THREE.PlaneGeometry(0.7, 3).rotateX(-Math.PI / 2), compose(R.x + side * 1.6, 0.086, tz + dir * d));
        });
      });
    });
    // The runway's numbers: 18 at the north end for planes landing south, 36 at the south end.
    [
      { text: "18", z: R.z0 + 8.4, yaw: Math.PI },
      { text: "36", z: R.z1 - 8.4, yaw: 0 },
    ].forEach(function (n) {
      var sign = buildSign(4.2, 3.2, 64, function (ctx, w, h) {
        ctx.fillStyle = readCss("room-paper");
        ctx.font = "700 " + Math.round(h * 0.92) + "px 'Bricolage Grotesque', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.text, w / 2, h * 0.54);
      }, { decal: true });
      layFlat(sign, R.x, 0.09, n.z, n.yaw);
      root.add(sign);
    });
    // Edge lights every 5 m, threshold lights at both ends.
    var edgeLights = new Batch();
    var greenLights = new Batch();
    for (var lz = R.z0 + 1; lz <= R.z1 - 1; lz += 5) {
      [-1, 1].forEach(function (side) {
        edgeLights.add(dayLight, new THREE.CylinderGeometry(0.11, 0.13, 0.32, 8), compose(R.x + side * (R.width / 2 + 0.55), 0.16, lz));
      });
    }
    [R.z0 - 0.4, R.z1 + 0.4].forEach(function (tz) {
      for (var g = 0; g < 9; g++) {
        greenLights.add(dayLight, new THREE.CylinderGeometry(0.11, 0.13, 0.28, 8), compose(R.x - R.width / 2 + 0.5 + g * ((R.width - 1) / 8), 0.14, tz));
      }
    });
    // Approach lights north of the threshold, under the final approach, to the field's edge.
    for (var az = R.z0 - 3; az >= PLAN.base.z0 + 1; az -= 2.2) {
      edgeLights.add(dayLight, new THREE.CylinderGeometry(0.07, 0.07, 0.9, 6), compose(R.x, 0.45, az));
      for (var b = -2; b <= 2; b++) {
        edgeLights.add(dayLight, new THREE.CylinderGeometry(0.11, 0.13, 0.22, 8), compose(R.x + b * 0.7, 0.98, az));
      }
      edgeLights.add(lacquer, new THREE.BoxGeometry(3.0, 0.08, 0.08), compose(R.x, 0.88, az));
    }
    edgeLights.build(root, { cast: false }).forEach(function (m) {
      if (m.material === dayLight) lit.push({ mesh: m, day: dayLight, night: nightLight });
    });
    greenLights.build(root, { cast: false }).forEach(function (m) {
      lit.push({ mesh: m, day: dayLight, night: nightGreen });
    });

    // ---- taxiways and the apron
    var TP = PLAN.taxiP;
    var TN = PLAN.taxiN;
    var TS = PLAN.taxiS;
    var AP = PLAN.apron;
    function taxiway(x0, z0, x1, z1, width) {
      var len = Math.hypot(x1 - x0, z1 - z0);
      var yaw = Math.atan2(x1 - x0, z1 - z0);
      batch.add(concrete, new THREE.BoxGeometry(width, 0.06, len + width), compose((x0 + x1) / 2, 0.03, (z0 + z1) / 2, yaw));
      // The centre line in brass, dashed.
      var n = Math.floor(len / 2.2);
      for (var i = 0; i < n; i++) {
        var t = (i + 0.5) / n;
        flat.add(brass, new THREE.PlaneGeometry(0.16, 1.2).rotateX(-Math.PI / 2), compose(x0 + (x1 - x0) * t, 0.066, z0 + (z1 - z0) * t, yaw));
      }
    }
    taxiway(TN.x0, TN.z, TN.x1 - R.width / 2, TN.z, TN.width); // in front of the hangars, to the runway
    taxiway(TS.x0, TS.z, TS.x1 - R.width / 2, TS.z, TS.width); // south of the apron, to the runway's end
    taxiway(TP.x, TP.z0, TP.x, TP.z1, TP.width); // parallel to the runway
    taxiway(AP.x1 - 3, PLAN.exitZ, R.x - R.width / 2, PLAN.exitZ, TP.width); // the exit the landings take
    taxiway(AP.x0 + 1.8, AP.z1, AP.x0 + 1.8, TS.z, TP.width); // the apron to the south taxiway
    // The apron in front of the terminal, with expansion joints.
    batch.add(concrete, new THREE.BoxGeometry(AP.x1 - AP.x0, 0.07, AP.z1 - AP.z0 + 4), compose(0, 0.035, (AP.z0 + AP.z1) / 2 + 2));
    for (var jx = AP.x0 + 5; jx < AP.x1; jx += 5) {
      flat.add(paint("room-floor", "matte", { dl: -0.075 }), new THREE.PlaneGeometry(0.05, AP.z1 - AP.z0 + 3.4).rotateX(-Math.PI / 2), compose(jx, 0.074, (AP.z0 + AP.z1) / 2 + 2));
    }
    // Hangar aprons.
    PLAN.hangars.forEach(function (hg) {
      var front = hg.z + hg.depth / 2;
      batch.add(concrete, new THREE.BoxGeometry(hg.width + 3, 0.065, TN.z - front + 1.8), compose(hg.x, 0.032, (front + TN.z) / 2));
    });
    // The gate stands: a brass lead-in line, a stop bar and the stand's number.
    var G = PLAN.gates;
    for (var gi = 0; gi < G.count; gi++) {
      var gx = G.x0 + gi * G.step;
      flat.add(brass, new THREE.PlaneGeometry(0.14, 4.6).rotateX(-Math.PI / 2), compose(gx, 0.08, G.z + 1.5));
      flat.add(brass, new THREE.PlaneGeometry(1.8, 0.16).rotateX(-Math.PI / 2), compose(gx, 0.08, G.z - 1.6));
      (function (number, x) {
        var sign = buildSign(1.6, 1.6, 96, function (ctx, w, h) {
          ctx.fillStyle = readCss("ink");
          ctx.globalAlpha = 0.62;
          ctx.font = Math.round(h * 0.78) + "px Limelight, serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(number), w / 2, h * 0.56);
        }, { decal: true });
        layFlat(sign, x, 0.082, G.z + 5.4);
        root.add(sign);
      })(gi + 1, gx);
    }

    // The aerodrome's name painted on the grass, as 1930s aerodromes wrote theirs for pilots.
    var nameSign = buildSign(34, 5.2, 44, function (ctx, w, h) {
      ctx.fillStyle = readCss("room-paper");
      ctx.globalAlpha = 0.9;
      ctx.font = Math.round(h * 0.86) + "px Limelight, serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if ("letterSpacing" in ctx) ctx.letterSpacing = Math.round(h * 0.18) + "px";
      ctx.fillText("HERCULE", w / 2, h * 0.55);
    }, { decal: true });
    layFlat(nameSign, -10, 0.03, 32.4);
    root.add(nameSign);

    // ---- the terminal: streamline moderne, a capsule with ribbon windows and speed lines
    var TM = PLAN.terminal;
    var r = TM.depth / 2;
    batch.add(lacquer, extrudeUp(stadium(TM.half + 0.25, r + 0.25), 0.45, 0));
    batch.add(ivory, extrudeUp(stadium(TM.half, r), TM.height - 0.45, 0.45));
    var bands = new Batch();
    bands.add(dayGlass, extrudeUp(stadium(TM.half + 0.04, r + 0.04), 1.25, 1.05));
    bands.add(dayGlass, extrudeUp(stadium(TM.half + 0.04, r + 0.04), 1.0, 3.0));
    bands.build(root).forEach(function (m) {
      lit.push({ mesh: m, day: dayGlass, night: nightGlass });
    });
    // Mullions along the ribbon windows' straight runs.
    for (var mx = -TM.half + r; mx <= TM.half - r + 0.01; mx += 1.5) {
      [-1, 1].forEach(function (side) {
        batch.add(ivory, new THREE.BoxGeometry(0.12, 1.25, 0.12), compose(mx, 1.675, side * (r + 0.06)));
        batch.add(ivory, new THREE.BoxGeometry(0.12, 1.0, 0.12), compose(mx, 3.5, side * (r + 0.06)));
      });
    }
    // Speed lines: three brass rules round the building under the cornice.
    [4.25, 4.5, 4.75].forEach(function (y) {
      batch.add(lacquer, extrudeUp(stadium(TM.half + 0.06, r + 0.06), 0.07, y));
    });
    // Parapet and roof.
    var parapet = stadium(TM.half + 0.1, r + 0.1);
    parapet.holes.push(stadium(TM.half - 0.25, r - 0.25));
    batch.add(ivory, extrudeUp(parapet, 0.55, TM.height));
    batch.add(brass, extrudeUp((function () {
      var s = stadium(TM.half + 0.14, r + 0.14);
      s.holes.push(stadium(TM.half - 0.05, r - 0.05));
      return s;
    })(), 0.06, TM.height + 0.55));
    batch.add(paint("room-floor", "matte", { dl: -0.04 }), extrudeUp(stadium(TM.half - 0.2, r - 0.2), 0.05, TM.height - 0.02));
    // The entrance canopy under the tower, on the apron side, with the aerodrome's name.
    var canopy = roundedRect(-5, -r - 2.4, 5, -r + 0.2, 1.2);
    batch.add(ivory, extrudeUp(canopy, 0.28, 2.65));
    var canopyEdge = roundedRect(-5.06, -r - 2.46, 5.06, -r + 0.2, 1.22);
    canopyEdge.holes.push(roundedRect(-4.9, -r - 2.3, 4.9, -r + 0.1, 1.08));
    batch.add(brass, extrudeUp(canopyEdge, 0.07, 2.93));
    [-4.2, 4.2].forEach(function (px) {
      batch.add(brass, new THREE.CylinderGeometry(0.08, 0.08, 2.65, 10), compose(px, 1.325, r + 2.0));
    });
    // Letters standing on the canopy, as on a 1930s terminal.
    var terminalSign = buildSign(9, 0.62, 128, function (ctx, w, h) {
      ctx.fillStyle = readCss(K.isDarkTheme() ? "room-paper" : "room-inlay-2");
      ctx.font = Math.round(h * 0.78) + "px Limelight, serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if ("letterSpacing" in ctx) ctx.letterSpacing = Math.round(h * 0.22) + "px";
      ctx.fillText("ARRIVALS · DEPARTURES", w / 2, h * 0.56);
    });
    terminalSign.position.set(0, 3.32, r + 2.25);
    root.add(terminalSign);

    // ---- the control tower: a drum with Deco fins, a gallery, the glass cab, the beacon
    var T = PLAN.tower;
    var shaftR = 2.5;
    var cabY = 17.16;
    var cabR = 3.3;
    batch.add(ivory, new THREE.CylinderGeometry(shaftR, shaftR + 0.15, cabY - 0.16, 40), compose(T.x, (cabY - 0.16) / 2, T.z));
    for (var fi = 0; fi < 5; fi++) {
      var fa = -0.9 + fi * 0.45 + 0.36;
      batch.add(ivory, new THREE.BoxGeometry(0.3, cabY - 5.6, 0.8), compose(T.x + Math.sin(fa) * shaftR, (cabY - 5.6) / 2 + 5.0, T.z + Math.cos(fa) * shaftR, fa));
    }
    var slits = new Batch();
    [-0.68, 0, 0.68].forEach(function (a) {
      var a2 = a + 0.36;
      slits.add(dayGlass, new THREE.BoxGeometry(0.42, cabY - 7.4, 0.12), compose(T.x + Math.sin(a2 + 0.22) * (shaftR + 0.01), (cabY - 7.4) / 2 + 6.0, T.z + Math.cos(a2 + 0.22) * (shaftR + 0.01), a2 + 0.22));
    });
    slits.build(root).forEach(function (m) {
      lit.push({ mesh: m, day: dayGlass, night: nightGlass });
    });
    // The gallery.
    batch.add(ivory, new THREE.CylinderGeometry(cabR + 0.75, cabR + 0.5, 0.32, 48), compose(T.x, cabY - 0.16, T.z));
    batch.add(brass, new THREE.TorusGeometry(cabR + 0.67, 0.045, 6, 64).rotateX(Math.PI / 2), compose(T.x, cabY + 0.79, T.z));
    for (var pa = 0; pa < 26; pa++) {
      var ang = (pa / 26) * Math.PI * 2;
      batch.add(brass, new THREE.CylinderGeometry(0.03, 0.03, 0.8, 5), compose(T.x + Math.cos(ang) * (cabR + 0.67), cabY + 0.39, T.z + Math.sin(ang) * (cabR + 0.67)));
    }
    // The cab: floor, glass, mullions, roof and its Deco crown.
    batch.add(paint("room-floor", "satin"), new THREE.CylinderGeometry(cabR, cabR, 0.1, 40), compose(T.x, cabY, T.z));
    var cabGlassDay = paint("room-sun", "glass");
    var cabGlassNight = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
    var cabGlass = new THREE.Mesh(new THREE.CylinderGeometry(cabR, cabR, 2.5, 48, 1, true), cabGlassDay);
    lit.push({ mesh: cabGlass, day: cabGlassDay, night: cabGlassNight });
    handles.cabGlassNight = cabGlassNight;
    cabGlass.position.set(T.x, cabY + 1.3, T.z);
    root.add(cabGlass);
    for (var mi = 0; mi < 14; mi++) {
      var ma = (mi / 14) * Math.PI * 2;
      batch.add(lacquer, new THREE.BoxGeometry(0.1, 2.5, 0.12), compose(T.x + Math.cos(ma) * cabR, cabY + 1.3, T.z + Math.sin(ma) * cabR, -ma + Math.PI / 2));
    }
    batch.add(lacquer, new THREE.TorusGeometry(cabR, 0.06, 6, 64).rotateX(Math.PI / 2), compose(T.x, cabY + 0.5, T.z));
    batch.add(ivory, new THREE.CylinderGeometry(cabR + 0.5, cabR + 0.25, 0.34, 48), compose(T.x, cabY + 2.72, T.z));
    batch.add(brass, new THREE.TorusGeometry(cabR + 0.47, 0.05, 6, 64).rotateX(Math.PI / 2), compose(T.x, cabY + 2.86, T.z));
    batch.add(ivory, new THREE.CylinderGeometry(cabR - 0.75, cabR - 0.45, 0.36, 40), compose(T.x, cabY + 3.06, T.z));
    batch.add(ivory, new THREE.CylinderGeometry(1.3, 1.6, 0.34, 32), compose(T.x, cabY + 3.4, T.z));
    batch.add(brass, new THREE.CylinderGeometry(0.1, 0.12, 1.9, 10), compose(T.x, cabY + 4.5, T.z));
    // The beacon's still housing; its lamp and beams turn (see buildBeacon).
    batch.add(lacquer, new THREE.CylinderGeometry(0.42, 0.5, 0.18, 20), compose(T.x, cabY + 5.45, T.z));

    // Rogier's desk in the cab, turned to the field, and the Now serving sign beside it.
    var desk = K.buildYourDesk();
    desk.object.rotation.y = 0.38;
    desk.object.position.set(T.x - 0.2, cabY + 0.05, T.z - 0.5);
    root.add(desk.object);
    handles.desk = desk;
    var serving = K.buildNowServing();
    serving.object.rotation.y = 0.38 - 0.5;
    serving.object.position.set(T.x + 1.55, cabY + 0.95, T.z + 1.75);
    root.add(serving.object);
    var servingStand = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.95, 8), brass);
    servingStand.position.set(T.x + 1.55, cabY + 0.5, T.z + 1.72);
    root.add(servingStand);
    handles.serving = serving;
    var cabin = new THREE.PointLight(0xffe2b0, 0, 9, 1.6);
    cabin.position.set(T.x, cabY + 2.2, T.z);
    root.add(cabin);
    handles.cabLight = cabin;

    // A proxy the pointer can hit: the tower flies the camera to the holding stack.
    var towerProxy = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 23, 12), new THREE.MeshBasicMaterial({ visible: false }));
    towerProxy.position.set(T.x, 11.5, T.z);
    towerProxy.userData.zone = "holding";
    root.add(towerProxy);
    handles.towerProxy = towerProxy;

    // ---- the hangars: an arched roof in the project's tint, the name painted over open doors
    PLAN.hangars.forEach(function (hg) {
      var arch = hg.width / 2;
      var tint = hg.tint ? paint("proj-" + hg.tint, "lacquer") : paint("room-metal", "lacquer", { dl: 0.02 });
      var tintRib = hg.tint ? paint("proj-" + hg.tint, "lacquer", { dl: -0.09, dc: 0.015 }) : paint("room-metal", "lacquer", { dl: -0.08 });
      var inside = paint("room-wall", "matte", { dl: -0.07 });
      inside.side = THREE.BackSide;
      var roof = new THREE.CylinderGeometry(arch, arch, hg.depth, 40, 1, true, Math.PI / 2, Math.PI);
      roof.rotateX(Math.PI / 2);
      batch.add(tint, roof.clone(), compose(hg.x, 0, hg.z));
      var innerMesh = new THREE.Mesh(roof, inside);
      innerMesh.position.set(hg.x, 0, hg.z);
      innerMesh.receiveShadow = true;
      root.add(innerMesh);
      // Ribs over the roof, every two metres.
      for (var rz = -hg.depth / 2 + 0.3; rz <= hg.depth / 2 - 0.2; rz += 2.1) {
        batch.add(tintRib, new THREE.TorusGeometry(arch + 0.06, 0.09, 6, 40, Math.PI), compose(hg.x, 0, hg.z + rz));
      }
      batch.add(brass, new THREE.TorusGeometry(arch + 0.08, 0.07, 6, 40, Math.PI), compose(hg.x, 0, hg.z + hg.depth / 2 + 0.02));
      // The back wall and the front wall with its door.
      var back = new THREE.Shape();
      back.absarc(0, 0, arch, 0, Math.PI, false);
      back.lineTo(arch, 0);
      batch.add(ivory, new THREE.ExtrudeGeometry(back, { depth: 0.3, bevelEnabled: false, curveSegments: 40 }), compose(hg.x, 0, hg.z - hg.depth / 2 - 0.15));
      var doorW = hg.width * 0.76;
      var doorH = arch * 0.6;
      // The front wall is one U-shaped outline round the open door: a hole that touches the
      // outline would be dropped when the shape is triangulated.
      var front = new THREE.Shape();
      front.moveTo(arch, 0);
      front.absarc(0, 0, arch, 0, Math.PI, false);
      front.lineTo(-doorW / 2, 0);
      front.lineTo(-doorW / 2, doorH);
      front.lineTo(doorW / 2, doorH);
      front.lineTo(doorW / 2, 0);
      front.lineTo(arch, 0);
      batch.add(ivory, new THREE.ExtrudeGeometry(front, { depth: 0.3, bevelEnabled: false, curveSegments: 40 }), compose(hg.x, 0, hg.z + hg.depth / 2 - 0.3));
      batch.add(lacquer, new THREE.BoxGeometry(doorW + 0.3, 0.22, 0.4), compose(hg.x, doorH + 0.08, hg.z + hg.depth / 2 - 0.1));
      // The doors, slid open to either side.
      [-1, 1].forEach(function (side) {
        var dw = (hg.width - doorW) / 2 + 1.5;
        var dx = hg.x + side * (doorW / 2 + dw / 2 - 1.2);
        batch.add(paint("room-panel", "satin"), new THREE.BoxGeometry(dw, doorH - 0.1, 0.18), compose(dx, (doorH - 0.1) / 2, hg.z + hg.depth / 2 + 0.1));
        for (var di = 1; di < 4; di++) {
          batch.add(brass, new THREE.BoxGeometry(0.05, doorH - 0.3, 0.05), compose(dx - dw / 2 + (di * dw) / 4, (doorH - 0.1) / 2, hg.z + hg.depth / 2 + 0.2));
        }
      });
      batch.add(paint("room-floor", "matte", { dl: -0.05 }), new THREE.BoxGeometry(hg.width - 0.4, 0.06, hg.depth - 0.4), compose(hg.x, 0.03, hg.z));
      // The name, painted over the door on a band of the tint.
      var signW = hg.width * 0.62;
      var signH = Math.min(1.7, (arch - doorH) * 0.6);
      var name = buildSign(signW, signH, 110, function (ctx, w, h) {
        ctx.fillStyle = readCss(hg.tint ? "proj-" + hg.tint : "room-metal");
        var rr = h * 0.18;
        ctx.beginPath();
        ctx.moveTo(rr, 0);
        ctx.arcTo(w, 0, w, h, rr);
        ctx.arcTo(w, h, 0, h, rr);
        ctx.arcTo(0, h, 0, 0, rr);
        ctx.arcTo(0, 0, w, 0, rr);
        ctx.fill();
        ctx.fillStyle = readCss(K.isDarkTheme() ? "room-paper" : "room-inlay-2");
        var size = Math.round(h * 0.62);
        ctx.font = size + "px Limelight, serif";
        if ("letterSpacing" in ctx) ctx.letterSpacing = Math.round(h * 0.1) + "px";
        while (ctx.measureText(hg.name).width > w * 0.9 && size > 10) {
          size -= 2;
          ctx.font = size + "px Limelight, serif";
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(hg.name, w / 2, h * 0.56);
      });
      name.position.set(hg.x, doorH + 0.35 + signH / 2, hg.z + hg.depth / 2 + 0.02);
      root.add(name);
      // Interior lamps, lit in the evening.
      var lamps = new Batch();
      [-hg.depth / 4, hg.depth / 4].forEach(function (lz) {
        lamps.add(dayLight, new THREE.CylinderGeometry(0.5, 0.2, 0.3, 16), compose(hg.x, arch - 1.1, hg.z + lz));
      });
      lamps.build(root, { cast: false }).forEach(function (m) {
        lit.push({ mesh: m, day: dayLight, night: nightLight });
      });
      var proxy = new THREE.Mesh(new THREE.BoxGeometry(hg.width, arch, hg.depth), new THREE.MeshBasicMaterial({ visible: false }));
      proxy.position.set(hg.x, arch / 2, hg.z);
      proxy.userData.zone = "hangar:" + (hg.project || "none");
      root.add(proxy);
      handles.hangarProxies.push(proxy);
    });

    // ---- the windsock, west of the runway
    var sock = new THREE.Group();
    batch.add(lacquer, new THREE.CylinderGeometry(0.07, 0.1, 6, 8), compose(40, 3, -34));
    batch.add(brass, new THREE.TorusGeometry(0.48, 0.04, 6, 20).rotateY(Math.PI / 2), compose(40, 5.9, -34));
    var stripeA = paint("room-paper", "fabric");
    var stripeB = paint("room-inlay-2", "fabric");
    for (var si = 0; si < 4; si++) {
      var r0 = 0.48 - si * 0.07;
      batch.add(si % 2 ? stripeB : stripeA, new THREE.CylinderGeometry(r0 - 0.07, r0, 0.62, 16, 1, true).rotateZ(Math.PI / 2), compose(40 - 0.31 - si * 0.62, 5.8 - si * 0.12, -34, 0, 0, -0.12));
    }
    root.add(sock);

    // ---- trees: tall Deco poplars along the field's back edge, and a few by the terminal
    function poplar(x, z, h) {
      batch.add(wood, new THREE.CylinderGeometry(0.12, 0.18, 1.2, 6), compose(x, 0.6, z));
      batch.add((Math.round(x * 7 + z) & 1) ? leaf : leafLight, new THREE.SphereGeometry(1, 12, 10), compose(x, 1.1 + h / 2, z, 0, 0, 0, 1.15, h / 2, 1.15));
    }
    for (var tx = B.x0 + 8; tx <= B.x1 - 8; tx += 5.2) {
      // No tree stands in the approach path.
      if (Math.abs(tx - PLAN.runway.x) < 9) continue;
      poplar(tx, B.z0 + 3.5, 6.5 + ((tx * 13) % 3));
    }
    [-22, -19.5, 19.5, 22].forEach(function (x, i) {
      poplar(x, -1.5 + (i % 2) * 2.4, 5.5);
    });

    // Lampposts along the terminal's front.
    [-13, -8, 8, 13].forEach(function (x) {
      var post = K.buildLamppost();
      post.position.set(x, 0, r + 1.4);
      root.add(post);
    });

    // ---- the mail circuits: one per run, a dashed oval with a post per step
    handles.mailPosts = buildMailCircuits(root, batch, flat);

    batch.build(root);
    flat.build(root, { cast: false });
    return { root: root, handles: handles };
  }

  /** Returns the runs still under way (running, waiting or paused): each flies a mail circuit. */
  function liveRuns() {
    return W.runs.filter(function (run) {
      return run.status === "running" || run.status === "paused";
    });
  }

  /** Returns the centre of a run's mail circuit, by its place among the live runs. */
  function mailCircuitCentre(index) {
    var M = PLAN.mail;
    return { x: M.cols[index % M.cols.length], z: M.rows[Math.floor(index / M.cols.length)] };
  }

  /** Returns where a run's step `i` of `n` stands on its circuit. */
  function mailStop(index, i, n) {
    var c = mailCircuitCentre(index);
    var a = Math.PI + (i / n) * Math.PI * 2;
    return { x: c.x + Math.cos(a) * PLAN.mail.rx, z: c.z - Math.sin(a) * PLAN.mail.rz, angle: a };
  }

  function buildMailCircuits(root, batch, flat) {
    var posts = {};
    var brass = paint("brass", "brass");
    var ivory = paint("room-wall", "satin");
    var lacquer = paint("room-inlay-2", "lacquer");
    var ok = paint("ok", "satin");
    var you = paint("you", "glow");
    var line = paint("brass", "matte");
    liveRuns().forEach(function (run, index) {
      var c = mailCircuitCentre(index);
      // The oval, dashed in the ground.
      for (var d = 0; d < 28; d++) {
        var a = (d / 28) * Math.PI * 2;
        var x = c.x + Math.cos(a) * PLAN.mail.rx;
        var z = c.z - Math.sin(a) * PLAN.mail.rz;
        var tangent = Math.atan2(-Math.sin(a) * PLAN.mail.rx, -Math.cos(a) * PLAN.mail.rz);
        flat.add(line, new THREE.PlaneGeometry(0.09, 0.32).rotateX(-Math.PI / 2), compose(x, 0.03, z, tangent));
      }
      var n = run.steps.length;
      run.steps.forEach(function (step, i) {
        var s = mailStop(index, i, n);
        // A Deco race pylon: a striped post; a completed step wears a green band, the step
        // waiting on Rogier a marigold lamp.
        batch.add(lacquer, new THREE.CylinderGeometry(0.18, 0.24, 0.22, 10), compose(s.x, 0.11, s.z));
        batch.add(ivory, new THREE.CylinderGeometry(0.08, 0.14, 1.2, 10), compose(s.x, 0.8, s.z));
        batch.add(step.state === "completed" ? ok : lacquer, new THREE.CylinderGeometry(0.1, 0.11, 0.18, 10), compose(s.x, 1.32, s.z));
        if (step.state === "waiting") batch.add(you, new THREE.SphereGeometry(0.17, 12, 10), compose(s.x, 1.58, s.z));
        else batch.add(brass, new THREE.SphereGeometry(0.09, 10, 8), compose(s.x, 1.5, s.z));
        posts[run.id + ":" + step.id] = s;
      });
    });
    return posts;
  }

  /**
   * Seats the assistants on the terminal's roof terrace, the aerodrome's controllers: Ada at a
   * writing desk, Milo and Juno in club armchairs on a rug, each with the app's name tag.
   */
  function seatAssistants(stage, motion) {
    var roofY = PLAN.terminal.height + 0.03;
    var people = [];
    var rug = K.buildRug(4.4, 2.6);
    rug.position.set(-9.6, roofY, 0.6);
    stage.add(rug);
    var places = [
      { a: W.assistants[0], kind: "desk", x: -5.6, z: 0.4, yaw: Math.PI - 0.25 },
      { a: W.assistants[1], kind: "chair", x: -8.4, z: 1.0, yaw: 0.5 },
      { a: W.assistants[2], kind: "chair", x: -10.9, z: 0.9, yaw: 0.2 },
    ];
    places.forEach(function (p) {
      if (!p.a) return;
      var seat = p.kind === "desk" ? K.buildWritingDesk() : K.buildArmchair();
      seat.object.rotation.y = p.yaw;
      seat.object.position.set(p.x, roofY, p.z);
      stage.add(seat.object);
      var look = lookFor(p.a.name, "assistant");
      var person = K.colleague({ id: p.a.name, kind: "assistant", pose: p.a.pose, look: look });
      person.sitAt(seat);
      // The app's doze asks for frames even with ambient motion off; under Reduce Motion an
      // asleep assistant sits still instead, its eyes still closed.
      if (!motion && p.a.pose === "asleep") person.play("sit");
      stage.add(person);
      var state = p.a.pose === "working" ? "working" : p.a.pose === "asleep" ? "asleep" : "idle";
      var tag = K.tag({ name: p.a.name, state: state, hue: look.hue });
      var label = stage.label(person, tag, { className: "ctof-l-crew" });
      people.push({ person: person, label: label });
    });
    return people;
  }

  /** The beacon's turning lamp and its two beams, which show in the evening. */
  function buildBeacon() {
    var group = new THREE.Group();
    group.position.set(PLAN.tower.x, 17.16 + 5.8, PLAN.tower.z);
    var lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 16), paint("brass", "brass"));
    group.add(lamp);
    var lens = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.52, 12).rotateZ(Math.PI / 2), paint("room-sun", "glow", { dl: 0.3 }));
    lens.position.set(0, 0, 0);
    group.add(lens);
    // The beam fades along its length: brightest at the lamp, gone at its far end.
    var fade = document.createElement("canvas");
    fade.width = 4;
    fade.height = 64;
    var fctx = fade.getContext("2d");
    // An alpha map reads the green channel; the canvas's top row lands at the cone's tip.
    var fg = fctx.createLinearGradient(0, 0, 0, 64);
    fg.addColorStop(0, "rgb(255,255,255)");
    fg.addColorStop(0.35, "rgb(110,110,110)");
    fg.addColorStop(1, "rgb(0,0,0)");
    fctx.fillStyle = fg;
    fctx.fillRect(0, 0, 4, 64);
    var fadeTexture = new THREE.CanvasTexture(fade);
    var beamMat = new THREE.MeshBasicMaterial({ color: 0xfff1c9, alphaMap: fadeTexture, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    var beamGeo = new THREE.ConeGeometry(1.6, 30, 24, 1, true);
    beamGeo.translate(0, -15, 0);
    beamGeo.rotateZ(Math.PI / 2);
    var beamA = new THREE.Mesh(beamGeo, beamMat);
    beamA.rotation.z = -0.08;
    var beamB = new THREE.Mesh(beamGeo, beamMat);
    beamB.rotation.y = Math.PI;
    beamB.rotation.z = -0.08;
    group.add(beamA, beamB);
    group.traverse(function (o) {
      o.castShadow = false;
    });
    return { group: group, beams: [beamA, beamB], beamMat: beamMat, geometry: beamGeo, texture: fadeTexture };
  }

  /* ================================================================== the planes */

  var planeParts = null;

  function superEllipse(span, le, te, exp, steps) {
    // Returns [x, front, back] samples of a half wing from the root (x = 0) to the tip.
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var x = (i / steps) * span;
      var f = Math.pow(Math.max(0, 1 - Math.pow(x / span, exp)), 1 / exp);
      out.push([x, le * f, -te * f]);
    }
    return out;
  }

  /** Builds a half wing's planform as an extruded shape: x outward, its y forward (world +z). */
  function halfWing(span, le, te, thickness) {
    var samples = superEllipse(span, le, te, 2.4, 18);
    var s = new THREE.Shape();
    s.moveTo(0, samples[0][1]);
    samples.forEach(function (p) {
      s.lineTo(p[0], p[1]);
    });
    for (var i = samples.length - 1; i >= 0; i--) s.lineTo(samples[i][0], samples[i][2]);
    s.lineTo(0, samples[0][1]);
    var g = new THREE.ExtrudeGeometry(s, { depth: thickness, bevelEnabled: true, bevelThickness: thickness * 0.45, bevelSize: Math.min(0.05, thickness * 0.5), bevelSegments: 2, curveSegments: 4 });
    g.rotateX(Math.PI / 2); // shape y -> world z, extrude -> world -y
    g.translate(0, thickness / 2, 0);
    return g;
  }

  /**
   * Builds the shared geometry of the plane, once: the parts grouped by what paints them, so
   * a plane is seven draws plus its pilot. Units are metres; the nose points +z.
   */
  function readPlaneParts() {
    if (planeParts) return planeParts;
    var hull = [];
    var body = [];
    var shade = [];
    var metal = [];
    var dark = [];
    var fin = [];
    // Fuselage: a lathe from the tail to the cowling.
    var profile = [
      [0.001, -2.12], [0.06, -2.08], [0.15, -1.75], [0.26, -1.25], [0.37, -0.7], [0.45, -0.15],
      [0.5, 0.45], [0.5, 1.0], [0.48, 1.28], [0.0, 1.3],
    ].map(function (p) {
      return new THREE.Vector2(p[0], p[1]);
    });
    var fuselage = new THREE.LatheGeometry(profile, 24);
    fuselage.rotateX(Math.PI / 2);
    hull.push(bake(fuselage));
    // A cheat line along each side, in the hue's shade.
    var stripe = new THREE.LatheGeometry([[0.505, 1.2], [0.508, 0.4], [0.46, -0.2], [0.33, -0.9], [0.2, -1.5]].map(function (p) {
      return new THREE.Vector2(p[0], p[1]);
    }), 24, -0.18, 0.36);
    stripe.rotateX(Math.PI / 2);
    shade.push(bake(stripe.clone(), compose(0, 0, 0, 0, 0, Math.PI / 2)));
    shade.push(bake(stripe, compose(0, 0, 0, 0, 0, -Math.PI / 2)));
    // A hue band round the fuselage behind the cockpit.
    body.push(bake(new THREE.CylinderGeometry(0.43, 0.39, 0.16, 24, 1, true).rotateX(Math.PI / 2), compose(0, 0, -0.95)));
    // The cowling: a Townend ring in brass, the engine's face and the spinner.
    metal.push(bake(new THREE.CylinderGeometry(0.47, 0.53, 0.36, 28, 1, true).rotateX(Math.PI / 2), compose(0, 0, 1.43)));
    metal.push(bake(new THREE.TorusGeometry(0.5, 0.035, 6, 28), compose(0, 0, 1.61)));
    dark.push(bake(new THREE.CircleGeometry(0.47, 24), compose(0, 0, 1.52)));
    metal.push(bake(new THREE.ConeGeometry(0.17, 0.42, 16).rotateX(Math.PI / 2), compose(0, 0, 1.8)));
    // Wings, low, with a little dihedral.
    [-1, 1].forEach(function (side) {
      var w = halfWing(2.55, 0.42, 0.62, 0.08);
      body.push(bake(w, compose(0, -0.27, 0.4, 0, 0, side * 0.07, side, 1, 1)));
    });
    // Tailplane and fin.
    [-1, 1].forEach(function (side) {
      body.push(bake(halfWing(0.95, 0.22, 0.3, 0.05), compose(0, 0.05, -1.82, 0, 0, 0, side, 1, 1)));
    });
    var finShape = new THREE.Shape();
    finShape.moveTo(-1.35, 0.12);
    finShape.lineTo(-1.62, 0.42);
    finShape.quadraticCurveTo(-1.86, 0.86, -2.08, 0.9);
    finShape.quadraticCurveTo(-2.26, 0.88, -2.24, 0.62);
    finShape.lineTo(-2.17, 0.1);
    finShape.lineTo(-1.35, 0.12);
    var finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1, curveSegments: 8 });
    finGeo.rotateY(-Math.PI / 2);
    fin.push(bake(finGeo, compose(0.03, 0, 0)));
    // Landing gear: brass struts and spats in the hue's shade.
    [-1, 1].forEach(function (side) {
      metal.push(bake(new THREE.CylinderGeometry(0.035, 0.035, 0.66, 6), compose(side * 0.98, -0.62, 0.48, 0, 0, side * 0.12)));
      shade.push(bake(new THREE.SphereGeometry(1, 16, 12), compose(side * 1.02, -0.95, 0.46, 0, 0, 0, 0.15, 0.24, 0.42)));
      dark.push(bake(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 14).rotateZ(Math.PI / 2), compose(side * 1.02, -0.99, 0.5)));
    });
    dark.push(bake(new THREE.CylinderGeometry(0.025, 0.05, 0.62, 6), compose(0, -0.46, -1.95, 0, 0.25, 0)));
    // The open cockpit: a leather rim and a small windscreen.
    dark.push(bake(new THREE.TorusGeometry(0.35, 0.042, 6, 24).rotateX(Math.PI / 2), compose(0, 0.43, -0.36, 0, 0, 0, 1, 1, 1.2)));
    var glass = bake(new THREE.CylinderGeometry(0.3, 0.3, 0.26, 12, 1, true, -0.9, 1.8).rotateX(-0.45), compose(0, 0.55, -0.3, 0, 0, 0, 1, 1, 0.6));
    // The propeller and its disc, which turn on their own.
    var blades = [];
    [0, Math.PI].forEach(function (a) {
      blades.push(bake(new THREE.BoxGeometry(0.11, 0.78, 0.035), compose(Math.sin(a) * 0.4, Math.cos(a) * 0.4, 0, 0, 0, -a, 1, 1, 1).multiply(compose(0, 0, 0, 0.35))));
    });
    var disc = new THREE.CircleGeometry(0.86, 32);
    planeParts = {
      hull: merge(hull),
      body: merge(body),
      shade: merge(shade),
      metal: merge(metal),
      dark: merge(dark),
      fin: merge(fin),
      glass: glass,
      blades: merge(blades),
      disc: disc,
      paper: new THREE.BoxGeometry(0.46, 0.012, 0.34),
      beacon: new THREE.SphereGeometry(0.1, 12, 8),
      shadow: new THREE.CircleGeometry(2.5, 28).rotateX(-Math.PI / 2),
      proxy: new THREE.BoxGeometry(5.8, 2.2, 4.8),
      ring: new THREE.TorusGeometry(3.1, 0.07, 8, 56).rotateX(Math.PI / 2),
    };
    return planeParts;
  }

  /**
   * Seats a pilot for its pose: sitting low in the cockpit, or standing up in it with the
   * marigold palm raised while it waits on Rogier.
   */
  function seatPilot(pilot, pose) {
    var waving = pose === "waiting";
    pilot.position.set(0, waving ? 0.04 : -0.15, -0.38);
    pilot.play(waving ? "raise-hand" : "sit");
  }

  // The plane's attitude on the ground: tail down on its skid, nose up.
  var GROUND_PITCH = -0.18;
  var GROUND_Y = 1.11;

  var shared = null; // materials the planes share that the palette does not own

  function readShared() {
    if (shared) return shared;
    var canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    var ctx = canvas.getContext("2d");
    var gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(0,0,0,1)");
    gradient.addColorStop(0.5, "rgba(0,0,0,0.6)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    var shadowTexture = new THREE.CanvasTexture(canvas);
    var halo = document.createElement("canvas");
    halo.width = halo.height = 64;
    var hctx = halo.getContext("2d");
    var hg = hctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    hg.addColorStop(0, "rgba(255,255,255,1)");
    hg.addColorStop(0.18, "rgba(255,255,255,0.8)");
    hg.addColorStop(0.42, "rgba(255,255,255,0.18)");
    hg.addColorStop(1, "rgba(255,255,255,0)");
    hctx.fillStyle = hg;
    hctx.fillRect(0, 0, 64, 64);
    var haloTexture = new THREE.CanvasTexture(halo);
    shared = {
      shadowTexture: shadowTexture,
      haloTexture: haloTexture,
      disc: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
      proxy: new THREE.MeshBasicMaterial({ visible: false }),
      halo: new THREE.SpriteMaterial({ map: haloTexture, color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }),
      haloQuiet: new THREE.SpriteMaterial({ map: haloTexture, color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }),
      ring: new THREE.MeshBasicMaterial({ color: 0x2f7a5c, transparent: true, opacity: 0.9 }),
      shadows: {},
    };
    repaintShared();
    return shared;
  }

  function repaintShared() {
    if (!shared) return;
    var dark = K.isDarkTheme();
    shared.disc.color.copy(K.readColor("ink"));
    shared.disc.opacity = dark ? 0.16 : 0.1;
    shared.halo.color.copy(K.readColor("you"));
    shared.haloQuiet.color.copy(K.readColor("you"));
    shared.halo.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    shared.ring.color.copy(K.readColor("accent"));
  }

  /** Returns the blob shadow material for an opacity step (0-9), shared across planes. */
  function shadowMaterial(step) {
    var s = readShared();
    if (!s.shadows[step]) {
      s.shadows[step] = new THREE.MeshBasicMaterial({ map: s.shadowTexture, transparent: true, opacity: 0.04 + step * 0.032, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, color: 0x000000 });
    }
    return s.shadows[step];
  }

  /**
   * Builds a plane in a colleague's look: the body in its hue, the fin in its project's tint,
   * brass at the nose, and its bean in the cockpit (none for a Done plane, whose pilot went home).
   */
  function buildPlane(stage, f) {
    var P = readPlaneParts();
    var S = readShared();
    var group = new THREE.Group();
    group.name = "plane:" + f.id;
    group.rotation.order = "YXZ";
    var tint = f.project ? { webshop: "webshop", "payments-api": "payments", ops: "ops" }[f.project] : null;
    var mats = {
      hull: paint("room-paper", "lacquer", { dl: -0.02 }),
      body: K.paintHue(f.look.hue, "body", "lacquer"),
      shade: K.paintHue(f.look.hue, "shade", "lacquer"),
      metal: paint("brass", "brass"),
      dark: paint("room-inlay-2", "satin"),
      fin: tint ? paint("proj-" + tint, "lacquer", { dl: -0.04, dc: 0.02 }) : paint("room-metal", "lacquer"),
      glass: paint("room-sun", "glass"),
      blades: paint("room-wood", "satin", { dl: -0.12 }),
    };
    ["hull", "body", "shade", "metal", "dark", "fin", "glass"].forEach(function (k) {
      var m = new THREE.Mesh(P[k], mats[k]);
      m.castShadow = false;
      m.receiveShadow = true;
      group.add(m);
    });
    var prop = new THREE.Group();
    prop.position.set(0, 0, 1.96);
    var blades = new THREE.Mesh(P.blades, mats.blades);
    var disc = new THREE.Mesh(P.disc, S.disc);
    disc.visible = false;
    prop.add(blades, disc);
    group.add(prop);
    var scale = f.kind === "run" ? 0.78 : 1;
    group.scale.setScalar(scale);

    var plane = { id: f.id, flight: f, group: group, prop: prop, disc: disc, scale: scale, spin: 0, pilot: null, beacon: null, halo: null, paper: null };

    // The pilot.
    if (f.kind !== "done") {
      var pilot = K.colleague({ id: f.id, kind: f.kind === "run" ? "run" : "thread", pose: f.beanPose, look: f.look });
      stage.add(pilot);
      group.add(pilot);
      pilot.scale.setScalar(0.95);
      seatPilot(pilot, f.beanPose);
      // The contact shadow is for a floor; a pilot sits in its cockpit.
      pilot.traverse(function (o) {
        if (o.isMesh && o.material && o.material.isMeshBasicMaterial && o.geometry.type === "CircleGeometry") o.visible = false;
      });
      plane.pilot = pilot;
    }

    // The holding beacon on the fin, and its halo.
    var beacon = new THREE.Mesh(P.beacon, paint("you", "glow"));
    beacon.position.set(0, 0.94, -2.06);
    beacon.visible = false;
    group.add(beacon);
    var halo = new THREE.Sprite(S.halo);
    halo.scale.setScalar(1.25);
    halo.position.copy(beacon.position);
    halo.visible = false;
    group.add(halo);
    plane.beacon = beacon;
    plane.halo = halo;

    // A paper on the wing: a result Rogier has not read.
    var paper = new THREE.Mesh(P.paper, paint("room-paper", "paper"));
    paper.position.set(-0.95, -0.12, 0.38);
    paper.rotation.set(0, 0.3, 0.07);
    paper.visible = false;
    group.add(paper);
    plane.paper = paper;

    // The pointer's target: a generous box around the plane.
    var proxy = new THREE.Mesh(P.proxy, S.proxy);
    proxy.userData.planeId = f.id;
    group.add(proxy);
    plane.proxy = proxy;

    // The blob shadow on the ground, which follows the plane.
    var shadow = new THREE.Mesh(P.shadow, shadowMaterial(8));
    shadow.renderOrder = 1;
    plane.shadow = shadow;

    return plane;
  }

  /* ================================================================== where each flight is */

  var approachCurve = null;
  function readApproachCurve() {
    if (approachCurve) return approachCurve;
    approachCurve = new THREE.CatmullRomCurve3(
      APPROACH.map(function (p) {
        return new THREE.Vector3(p[0], p[1], p[2]);
      }),
      false,
      "centripetal"
    );
    return approachCurve;
  }

  /** Returns the point of the approach `m` minutes out, moved sideways by `lane` and up by `rise` metres. */
  function approachPoint(m, lane, rise) {
    var curve = readApproachCurve();
    var u = Math.max(0, Math.min(1, m / APPROACH_MINUTES));
    var p = curve.getPoint(u);
    var tangent = curve.getTangent(u);
    if (lane) {
      var side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
      p.addScaledVector(side, lane);
    }
    if (rise) p.y += rise;
    return { pos: p, tangent: tangent };
  }

  /** Assigns lanes to overlapping ETA ranges, so overlapping ranges fly side by side. */
  function assignLanes(list) {
    var lanes = [];
    list
      .slice()
      .sort(function (a, b) {
        return a.range[0] - b.range[0] || a.range[1] - b.range[1];
      })
      .forEach(function (f) {
        var lane = 0;
        while (lanes[lane] != null && lanes[lane] > f.range[0]) lane++;
        lanes[lane] = f.range[1];
        f.lane = lane;
      });
    var n = lanes.length;
    list.forEach(function (f) {
      f.laneOffset = (f.lane - (n - 1) / 2) * 3.2;
    });
  }

  function hangarFor(project) {
    for (var i = 0; i < PLAN.hangars.length; i++) if (PLAN.hangars[i].project === (project || null)) return PLAN.hangars[i];
    return PLAN.hangars[3];
  }

  function projectRank(p) {
    var i = PROJECT_ORDER.indexOf(p || null);
    return i < 0 ? 9 : i;
  }

  /**
   * Places every flight for a state: a fixed spot on the ground, a point on the approach, a
   * level of the holding stack, or a loop over a hangar. Runs the conflict's pull onto the
   * extended approach.
   */
  function layOut(flights, state) {
    var byPhase = {};
    flights.forEach(function (f) {
      (byPhase[f.phase] = byPhase[f.phase] || []).push(f);
      f.place = null;
    });

    // Holding: oldest lowest.
    (byPhase.holding || [])
      .sort(function (a, b) {
        return minutes(a.since) - minutes(b.since);
      })
      .forEach(function (f, i) {
        f.place = { kind: "holding", level: i, phase0: i * 2.4 + 0.6 };
      });

    // Approach, and in the conflict state the three bunched arrivals on its extension.
    var conflictIds = state === "conflict" ? (TOWER_DATA && TOWER_DATA.conflict ? TOWER_DATA.conflict.ids : ["tPayout", "tCart", "tResult"]) : [];
    var onApproach = (byPhase.approach || []).slice();
    var bunched = (byPhase.cruising || []).filter(function (f) {
      return conflictIds.indexOf(f.id) >= 0 && f.range;
    });
    assignLanes(onApproach);
    onApproach.forEach(function (f) {
      f.place = { kind: "approach", m: (f.range[0] + f.range[1]) / 2, lane: f.laneOffset, rise: 0, bunched: false };
    });
    // The bunched arrivals fan out one above the other, so each one and its tag can be seen;
    // the earliest arrival flies lowest.
    bunched
      .sort(function (a, b) {
        return a.range[0] - b.range[0] || a.range[1] - b.range[1];
      })
      .forEach(function (f, i) {
        f.place = { kind: "approach", m: (f.range[0] + f.range[1]) / 2, lane: 0, rise: (i - (bunched.length - 1) / 2) * 3.4, bunched: true };
      });

    // Cruising: loops over the hangar, a layer each.
    var perHangar = {};
    (byPhase.cruising || []).forEach(function (f) {
      if (f.place) return;
      var hg = hangarFor(f.project);
      var key = hg.name;
      perHangar[key] = perHangar[key] || 0;
      var i = perHangar[key]++;
      if (f.queued) {
        f.place = { kind: "queued" };
        return;
      }
      f.place = { kind: "cruise", hangar: hg, layer: i, phase0: i * 2.1 + hg.x * 0.07 };
    });

    // On stand: the numbered stands, by project and then by lead.
    var stands = (byPhase.stand || []).slice().sort(function (a, b) {
      return projectRank(a.project) - projectRank(b.project) || String(a.lead || a.id).localeCompare(String(b.lead || b.id)) || a.id.localeCompare(b.id);
    });
    stands.forEach(function (f, i) {
      f.place = { kind: "gate", gate: i };
    });

    // Parked: on the hangar's apron, nose out at an angle.
    var parkedCount = {};
    (byPhase.parked || []).forEach(function (f) {
      var hg = hangarFor(f.project);
      var i = (parkedCount[hg.name] = (parkedCount[hg.name] || 0) + 1) - 1;
      f.place = { kind: "parked", hangar: hg, index: i };
    });

    // Done: inside the hangar.
    var doneCount = {};
    (byPhase.hangar || []).forEach(function (f) {
      var hg = hangarFor(f.project);
      var i = (doneCount[hg.name] = (doneCount[hg.name] || 0) + 1) - 1;
      f.place = { kind: "inside", hangar: hg, index: i };
    });
  }

  function gateSpot(i) {
    var G = PLAN.gates;
    var row = Math.floor(i / G.count);
    return { x: G.x0 + (i % G.count) * G.step, z: G.z + row * 0.0, yaw: 0.28 };
  }

  function parkedSpot(hg, i) {
    var cols = hg.width > 12 ? 3 : 2;
    var spacing = hg.width > 12 ? 5.6 : 5.3;
    var col = i % cols;
    var row = Math.floor(i / cols);
    return { x: hg.x + (col - (cols - 1) / 2) * spacing, z: hg.z + hg.depth / 2 + 4.6 + row * 4.6, yaw: 0.42 };
  }

  function insideSpot(hg, i) {
    var col = i % 2;
    var row = Math.floor(i / 2);
    return { x: hg.x + (col - 0.5) * 6.0, z: hg.z + hg.depth / 2 - 3.2 - row * 5.4, yaw: 0.05 };
  }

  /** Returns a ground pose for a spot: on its wheels and tail skid, nose up. */
  function groundPose(spot, scale) {
    return { x: spot.x, y: GROUND_Y * (scale || 1), z: spot.z, yaw: spot.yaw, pitch: GROUND_PITCH, roll: 0, ground: true };
  }

  /** Returns the pose of an airborne flight at time `t` (seconds). */
  function airPose(place, t, motion, holdingDrop) {
    var x;
    var y;
    var z;
    var vx;
    var vz;
    var turn = 0;
    if (place.kind === "holding") {
      var R = PLAN.holding.radius;
      var level = place.level + (holdingDrop || 0);
      var w = motion ? 0.2 : 0;
      var a = place.phase0 + w * t;
      x = PLAN.tower.x + Math.cos(a) * R;
      z = PLAN.tower.z + Math.sin(a) * R;
      y = PLAN.holding.low + level * PLAN.holding.step;
      vx = -Math.sin(a);
      vz = Math.cos(a);
      turn = 1;
    } else if (place.kind === "cruise") {
      var hg = place.hangar;
      var rx = 9.5 + place.layer * 1.6;
      var rz = 6.4 + place.layer * 1.2;
      var dir = place.layer % 2 ? -1 : 1;
      var w2 = (motion ? 0.17 : 0) * dir;
      var b = place.phase0 + w2 * t;
      x = hg.x + Math.cos(b) * rx;
      z = hg.z + 1 + Math.sin(b) * rz;
      y = 12.5 + place.layer * 2.6 + Math.sin(b * 2) * 0.5;
      vx = -Math.sin(b) * rx * dir;
      vz = Math.cos(b) * rz * dir;
      turn = dir;
    } else if (place.kind === "approach") {
      var ap = approachPoint(place.m, place.lane, place.rise);
      var bob = motion ? Math.sin(t * 1.3 + place.m) * 0.18 : 0;
      return { x: ap.pos.x, y: ap.pos.y + bob, z: ap.pos.z, yaw: Math.atan2(-ap.tangent.x, -ap.tangent.z), pitch: 0.06, roll: motion ? Math.sin(t * 0.9 + place.m) * 0.04 : 0, ground: false };
    }
    return { x: x, y: y, z: z, yaw: Math.atan2(vx, vz), pitch: 0, roll: -0.32 * turn, ground: false };
  }

  /* ================================================================== routes: landings and touch-and-goes */

  /**
   * A route is a list of legs; each leg is a curve flown at a speed that eases from `v0` to `v1`
   * (m/s), in the air or on the ground. `sample(t)` returns a pose; the route knows its length
   * in seconds.
   */
  function Route(legs) {
    var samples = [];
    var time = 0;
    legs.forEach(function (leg) {
      var n = Math.max(8, Math.ceil(leg.curve.getLength() / 0.5));
      var pts = leg.curve.getSpacedPoints(n);
      for (var i = 0; i < pts.length; i++) {
        if (i > 0) {
          var d = pts[i].distanceTo(pts[i - 1]);
          var u = i / (pts.length - 1);
          var v = leg.v0 + (leg.v1 - leg.v0) * u;
          time += d / Math.max(0.5, v);
        } else if (samples.length) {
          continue;
        }
        samples.push({ t: time, p: pts[i], ground: !!leg.ground, hold: 0 });
      }
      if (leg.pause) {
        time += leg.pause;
        var last = samples[samples.length - 1];
        samples.push({ t: time, p: last.p.clone(), ground: last.ground, hold: 1 });
      }
    });
    this.samples = samples;
    this.duration = time;
  }
  Route.prototype.sample = function (t) {
    var s = this.samples;
    if (t <= 0) t = 0;
    if (t >= this.duration) t = this.duration;
    var lo = 0;
    var hi = s.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (s[mid].t <= t) lo = mid;
      else hi = mid;
    }
    var a = s[lo];
    var b = s[hi];
    var u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    var p = a.p.clone().lerp(b.p, u);
    // Heading from a little ahead and behind, so turns look smooth.
    var ahead = this.pointAt(t + 0.25);
    var behind = this.pointAt(t - 0.25);
    var dx = ahead.x - behind.x;
    var dz = ahead.z - behind.z;
    var dy = ahead.y - behind.y;
    var flatLen = Math.hypot(dx, dz);
    var yaw = flatLen > 0.02 ? Math.atan2(dx, dz) : this.lastYaw || 0;
    this.lastYaw = yaw;
    var ahead2 = this.pointAt(t + 0.8);
    var turn = Math.atan2(ahead2.x - p.x, ahead2.z - p.z) - yaw;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    var ground = a.ground && b.ground;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: yaw,
      pitch: ground ? GROUND_PITCH * Math.max(0, 1 - flatLen * 1.6) + (flatLen > 0.6 ? -0.02 : 0) : -Math.atan2(dy, Math.max(0.01, flatLen)) * 0.8,
      roll: ground ? 0 : -Math.max(-0.5, Math.min(0.5, turn * 1.4)),
      ground: ground,
    };
  };
  Route.prototype.pointAt = function (t) {
    var s = this.samples;
    t = Math.max(0, Math.min(this.duration, t));
    var lo = 0;
    var hi = s.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (s[mid].t <= t) lo = mid;
      else hi = mid;
    }
    var a = s[lo];
    var b = s[hi];
    var u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    return a.p.clone().lerp(b.p, u);
  };

  function v3(x, y, z) {
    return new THREE.Vector3(x, y, z);
  }
  function curveThrough(points) {
    return new THREE.CatmullRomCurve3(points, false, "centripetal", 0.5);
  }
  function line(a, b) {
    return new THREE.LineCurve3(a, b);
  }

  /**
   * Builds the touch-and-go of a cleared Request: out of its holding level, down the approach,
   * wheels on the runway for a moment, and up again to its hangar's loop. Returns the route
   * and the loop it joins.
   */
  function buildTouchAndGo(fromPose, hg) {
    var R = PLAN.runway;
    var gy = GROUND_Y + 0.02;
    var a9 = approachPoint(9, 0).pos;
    var a5 = approachPoint(5, 0).pos;
    var a2 = approachPoint(2, 0).pos;
    var down = v3(R.x, gy, R.z0 + 5);
    var roll = v3(R.x, gy, R.z0 + 20);
    var lift = v3(R.x, 2.4, R.z0 + 33);
    var place = { kind: "cruise", hangar: hg, layer: 0, phase0: 0 };
    var join = airPose(place, 0, false);
    var entry = v3(join.x, join.y, join.z);
    var start = v3(fromPose.x, fromPose.y, fromPose.z);
    var legs = [
      { curve: curveThrough([start, v3((start.x + a9.x) / 2 + 4, (start.y + a9.y) / 2 + 1, (start.z + a9.z) / 2 - 6), a9, a5, a2]), v0: 14, v1: 11 },
      { curve: curveThrough([a2, v3(R.x, gy + 0.5, R.z0 - 1), down]), v0: 11, v1: 10 },
      { curve: line(down, roll), v0: 10, v1: 8, ground: true },
      { curve: curveThrough([roll, lift, v3(R.x - 4, 6.5, R.z0 + 44), v3(R.x - 18, 9.5, R.z0 + 46), v3(entry.x + 12, entry.y, entry.z + 14), entry]), v0: 9, v1: 14 },
    ];
    return { route: new Route(legs), place: place };
  }

  /**
   * Builds a landing at the end of a turn: down the rest of the approach, the roll-out, the
   * exit taxiway and the apron's taxiway to a free stand, then a turn to face the field.
   */
  function buildLanding(fromPose, gateIndex) {
    var R = PLAN.runway;
    var AP = PLAN.apron;
    var ez = PLAN.exitZ;
    var gy = GROUND_Y + 0.01;
    var spot = gateSpot(gateIndex);
    var x = spot.x;
    var z = spot.z;
    var lane = AP.z1 - 2.4; // the apron's taxi lane, south of the stands
    var start = v3(fromPose.x, fromPose.y, fromPose.z);
    var touch = v3(R.x, gy, R.z0 + 4);
    var slow = v3(R.x, gy, ez - 8);
    var legs = [
      { curve: curveThrough([start, approachPoint(1, 0).pos, v3(R.x, gy + 0.5, R.z0 - 2), touch]), v0: 11, v1: 10 },
      { curve: line(touch, slow), v0: 10, v1: 4.5, ground: true },
      { curve: curveThrough([slow, v3(R.x - 0.5, gy, ez - 2.4), v3(R.x - 4, gy, ez), v3(AP.x1 - 2, gy, ez), v3(AP.x1 - 5, gy, ez + 3.5), v3(AP.x1 - 6, gy, lane - 2), v3(AP.x1 - 9, gy, lane)]), v0: 4.5, v1: 4, ground: true },
      { curve: curveThrough([v3(AP.x1 - 9, gy, lane), v3(x + 6, gy, lane), v3(x + 2.4, gy, lane - 3), v3(x + 2.4, gy, z - 0.6)]), v0: 4, v1: 1.8, ground: true },
      { curve: curveThrough([v3(x + 2.4, gy, z - 0.6), v3(x + 1.2, gy, z - 1.9), v3(x, gy, z - 0.6), v3(x, gy, z)]), v0: 1.5, v1: 0.6, ground: true },
    ];
    return { route: new Route(legs), spot: spot };
  }

  /** Builds a dashed track along a route, for a still picture of where a plane went. */
  function buildTrack(route, material) {
    var parts = [];
    var dist = 0;
    var s = route.samples;
    for (var i = 1; i < s.length; i++) {
      var a = s[i - 1].p;
      var b = s[i].p;
      var d = a.distanceTo(b);
      dist += d;
      if (d < 0.01 || Math.floor(dist / 1.2) % 2) continue;
      var mid = a.clone().lerp(b, 0.5);
      var yaw = Math.atan2(b.x - a.x, b.z - a.z);
      var pitch = -Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z));
      var y = s[i].ground ? 0.1 : mid.y;
      parts.push(bake(new THREE.BoxGeometry(0.26, 0.06, d * 1.02), compose(mid.x, y, mid.z, yaw, s[i].ground ? 0 : pitch)));
    }
    if (!parts.length) return null;
    var mesh = new THREE.Mesh(merge(parts), material);
    mesh.castShadow = false;
    return mesh;
  }

  /* ================================================================== labels */

  function hueStyle(f) {
    return "--hue:var(--hue-" + f.look.hue + ")";
  }

  /** Returns what a flight's tag says after its call sign: its ETA, its ask, or its rest. */
  function describeMeta(f, state) {
    if (f.phase === "holding") return f.slot ? "lands " + f.slot : ago(f.since);
    if (f.cleared) return "cleared " + f.cleared + " · back in the air";
    if (f.landedAt) return "landed " + f.landedAt + " · result to read";
    if (f.phase === "approach" || f.phase === "cruising") {
      if (f.queued) return "queued for take-off";
      if (!f.range) return "airborne " + ago(f.busySince || W.now);
      var r = "~" + f.range[0] + "-" + f.range[1] + "m";
      return f.slot ? r + " · lands " + f.slot : r;
    }
    if (f.phase === "stand") {
      var turns = W.turns[f.id] || [];
      var ended = turns.filter(function (s) {
        return s.end === "idle" || s.end === "failed";
      });
      var last = ended[ended.length - 1];
      return "landed " + (last ? last.to.replace(/^yesterday /, "yday ") : f.t.last) + " · unread";
    }
    if (f.phase === "parked") return f.t.pose === "asleep" ? "asleep" : "idle " + ago(f.t.last);
    if (f.phase === "hangar") return "done " + String(f.doneAt).replace(/^yesterday /, "yday ");
    return "";
  }

  /** Returns how much a tag matters when two collide: lower wins. */
  function labelPriority(f) {
    if (f.phase === "holding") return 0.5;
    if (f.phase === "approach") return 2 + (f.range ? f.range[0] / 100 : 0);
    if (f.place && f.place.bunched) return 2.5;
    if (f.phase === "stand") return 3;
    if (f.phase === "cruising") return 5 + (f.range ? f.range[0] / 100 : 0.9);
    if (f.phase === "parked") return 7;
    return 8;
  }

  function tagHtml(f, state) {
    var cls = "ctof-tag ctof-tag--" + f.phase + (f.slot && f.phase === "holding" ? " is-quiet" : "") + (f.urgent && state === "slots" && f.phase === "holding" ? " is-urgent" : "");
    var title = f.kind === "run" ? f.title : f.title;
    var lead = f.role ? f.role + " · " : "";
    return (
      '<div class="' + cls + '" style="' + hueStyle(f) + '" data-id="' + esc(f.id) + '">' +
      '<i class="ctof-tag__dot"></i><b class="ctof-tag__call">' + esc(f.call) + "</b>" +
      '<span class="ctof-tag__title">' + esc(lead + shorten(title, 30)) + "</span>" +
      '<span class="ctof-tag__meta">' + esc(describeMeta(f, state)) + "</span>" +
      (f.phase === "stand" && !f.landedAt ? '<i class="ctof-tag__ink" aria-label="unread"></i>' : "") +
      "</div>"
    );
  }

  function holdHtml(f, state) {
    var quiet = !!f.slot;
    var ask = f.ask || "";
    var urgent = f.urgent && state === "slots";
    return (
      '<div class="ctof-hold' + (quiet ? " is-quiet" : "") + (urgent ? " is-urgent" : "") + '" style="' + hueStyle(f) + '" data-id="' + esc(f.id) + '">' +
      '<span class="ctof-hold__level">' + (f.place.level + 1) + "</span>" +
      '<i class="ctof-tag__dot"></i><b class="ctof-tag__call">' + esc(f.call) + "</b>" +
      '<span class="ctof-hold__ask">' + esc(ask) + "</span>" +
      '<span class="ctof-hold__meta">' + (urgent ? "urgent · " : "") + esc(quiet ? "lands " + f.slot : ago(f.since)) + "</span>" +
      "</div>"
    );
  }

  /* ================================================================== mount */

  /**
   * Draws the Aerodrome into `container` and returns its handle (BUILDERS.md). The first view
   * is the establishing shot, unless `api.selected` names a flight, which the camera then follows.
   */
  function mount(container, api) {
    THREE = window.THREE;
    K = window.OfficeKit;
    W = api.world || window.WORLD;
    H = W.helpers;
    TOWER_DATA = W.tower || null;
    if (!THREE || !K) throw new Error("control-tower-office.js: load ../vendor/office-kit.js first");

    var motion = !api.reducedMotion;
    K.setAmbientMotion(motion);
    container.classList.add(ROOT_CLASS);
    var stage = K.stage.create(container, { view: { target: [6, 9, -14], distance: 156, azimuth: 16, elevation: 26 } });
    stage.controls.maxDistance = 320;
    stage.controls.minDistance = 6;

    var aerodrome = buildAerodrome();
    stage.add(aerodrome.root);
    var beacon = buildBeacon();
    stage.scene.add(beacon.group);
    var crew = seatAssistants(stage, motion);

    var state = api.state || "everyday";
    var events = { cleared: {}, landed: {} };
    var flights = [];
    var planes = {};
    var planeList = [];
    var labels = [];
    var overlays = []; // meshes a state adds to the scene: tracks, rings, gates
    var choreo = {}; // id -> { route, t, then }
    var selectedId = null;
    var hoverId = null;
    var paused = false;
    var disposed = false;
    var lod = "";
    var holdingDrop = { value: 0, target: 0, from: 0 };
    var clockT = 0;

    // ---- the HUD: the phase legend, which is also how you fly to each zone
    var hud = document.createElement("div");
    hud.className = "ctof-hud";
    container.appendChild(hud);
    var note = document.createElement("div");
    note.className = "ctof-note";
    note.hidden = true;
    container.appendChild(note);

    // The HUD is where the camera can go. The counts live in the window's top bar, so the
    // HUD does not repeat them.
    var STOPS = [
      { zone: "field", label: "Aerodrome" },
      { zone: "holding", label: "Holding stack" },
      { zone: "approach", label: "Approach" },
      { zone: "stand", label: "Stands" },
      { zone: "hangar", label: "Hangars" },
      { zone: "mail", label: "Air mail" },
    ];
    function drawHud() {
      hud.innerHTML =
        '<span class="ctof-stops" role="toolbar" aria-label="Fly the camera to">' +
        STOPS.map(function (stop) {
          return '<button type="button" class="ctof-stop ctof-stop--' + stop.zone + '" data-zone="' + stop.zone + '">' + (stop.zone === "holding" ? '<i class="ctof-stop__you"></i>' : "") + stop.label + "</button>";
        }).join("") +
        "</span>";
      if (state === "away") {
        var left = minutes(W.away.left);
        var back = minutes(W.away.back);
        var took = 0;
        var landed = 0;
        var asked = 0;
        flights.forEach(function (f) {
          (W.turns[f.id] || []).forEach(function (s) {
            if (f.kind === "done") return;
            var from = minutes(s.from);
            if (from > left && from <= back) took++;
            if (s.to && minutes(s.to) > left && minutes(s.to) <= back) {
              if (s.end === "request") asked++;
              else landed++;
            }
          });
        });
        note.hidden = false;
        note.innerHTML =
          '<b class="ctof-note__h">While you were away <span>' + W.away.left + "-" + W.away.back + "</span></b>" +
          '<span class="ctof-note__row"><b>' + took + "</b> take-offs: a turn started</span>" +
          '<span class="ctof-note__row"><b>' + landed + "</b> landed with a result</span>" +
          '<span class="ctof-note__row ctof-note__row--you"><b>' + asked + "</b> joined the holding stack</span>" +
          '<span class="ctof-note__foot">Dashed tracks show the landings.</span>';
      } else if (state === "conflict") {
        note.hidden = false;
        var cd = (TOWER_DATA && TOWER_DATA.conflict) || { from: "10:02", to: "10:06" };
        note.innerHTML =
          '<b class="ctof-note__h ctof-note__h--you">3 arrivals ' + cd.from + "-" + cd.to + "</b>" +
          '<span class="ctof-note__text">The cart refactor, the payout report and the Result migration are predicted to need you within four minutes of each other. They wait on the approach, past the 20 minute gate.</span>';
      } else if (state === "slots") {
        note.hidden = false;
        note.innerHTML =
          '<b class="ctof-note__h">Landing slots · next 10:00</b>' +
          '<span class="ctof-note__text">Requests circle quietly until the slot. The urgent push still comes through.</span>';
      } else if (state === "landing") {
        note.hidden = false;
        note.innerHTML = '<b class="ctof-note__h">Cleared WS·3DS</b><span class="ctof-note__text">Allow once. It touches down, and is back in the air.</span>';
      } else {
        note.hidden = true;
      }
    }

    hud.addEventListener("click", function (e) {
      var b = e.target.closest("[data-zone]");
      if (!b) return;
      frameZone(b.dataset.zone);
    });

    // ---- labels that are not a plane's: hangars, the stack, the approach's gates, the tower
    var fixedLabels = [];
    function addFixedLabel(point, html, cls, priority) {
      var l = stage.label(point, html, { className: cls });
      l.point = new THREE.Vector3(point[0], point[1], point[2]);
      l.priority = priority == null ? 1 : priority;
      l.place = cls === "ctof-l-gate" ? "gate" : cls === "ctof-l-hangar" ? "centre" : "centre";
      fixedLabels.push(l);
      return l;
    }

    function drawFixedLabels() {
      fixedLabels.forEach(function (l) {
        l.remove();
      });
      fixedLabels = [];
      PLAN.hangars.forEach(function (hg, hi) {
        var live = flights.filter(function (f) {
          return f.phase !== "hangar" && (f.project || null) === hg.project && f.kind === "thread";
        });
        var holding = live.filter(function (f) {
          return f.phase === "holding";
        }).length;
        var more = state === "swarm" && hg.project && W.swarm.more[hg.project] ? '<span class="ctof-hangar__more">+' + W.swarm.more[hg.project] + " older</span>" : "";
        var name = hg.project || "No project";
        // Neighbouring hangars' labels sit at two heights, over the crest and over the door,
        // so they never touch.
        addFixedLabel(
          [hg.x, hi % 2 ? hg.width * 0.3 : hg.width / 2 + 0.9, hg.z + hg.depth / 2 - 0.6],
          '<div class="ctof-hangar" style="--tint:var(--proj-' + (hg.tint || "none") + ')"><i class="ctof-hangar__tab"></i><b>' + esc(name) + "</b><span class=\"ctof-hangar__n\">" + live.length + "</span>" + (holding ? '<span class="ctof-hangar__you" title="' + holding + ' holding">' + holding + '<span class="ctof-hangar__word"> holding</span></span>' : "") + more + "</div>",
          "ctof-l-hangar",
          1.5
        );
      });
      // The stack's summary, for far away.
      var holdingList = flights.filter(function (f) {
        return f.phase === "holding";
      });
      var top = PLAN.holding.low + Math.max(0, holdingList.length - 1) * PLAN.holding.step + 3.4;
      addFixedLabel([PLAN.tower.x, top, PLAN.tower.z], '<div class="ctof-stack"><b>' + holdingList.length + "</b> holding" + (state === "slots" ? " · next slot 10:00" : "") + "</div>", "ctof-l-stack");
      // The approach's gates: 5, 10 and 15 minutes (and 20-30 in the conflict).
      // In the conflict the bunch flies just past the 20 minute gate, so that gate goes unlabelled;
      // 15 and 25 bracket it.
      var gates = state === "conflict" ? [5, 10, 15, 25] : [5, 10, 15];
      // Each gate's label sits at its left rim, as the default view sees it, clear of the planes' tags.
      gates.forEach(function (m) {
        var p = approachPoint(m, 0).pos;
        var rim = m > 15 ? 3.2 : 2.4;
        addFixedLabel([p.x + 0.96 * (rim + 0.4), p.y, p.z - 0.28 * (rim + 0.4)], '<span class="ctof-gate">' + m + " min</span>", "ctof-l-gate", 6);
      });
      var approachCount = flights.filter(function (f) {
        return f.phase === "approach";
      });
      var nextArrival = approachCount.slice().sort(function (a, b) {
        return a.range[0] - b.range[0];
      })[0];
      var ap = approachPoint(8, 0).pos;
      addFixedLabel([ap.x, ap.y + 4.6, ap.z], '<div class="ctof-stack ctof-stack--approach"><b>' + approachCount.length + "</b> on approach" + (nextArrival ? " · next ~" + nextArrival.range[0] + "-" + nextArrival.range[1] + "m" : "") + "</div>", "ctof-l-stack");
      // The runs' mail circuits.
      var mc = mailCircuitCentre(0);
      addFixedLabel([(PLAN.mail.cols[0] + PLAN.mail.cols[1]) / 2, 5.5, mc.z - 3.4], '<div class="ctof-hangar ctof-hangar--mail"><b>Air mail</b><span class="ctof-hangar__n">' + liveRuns().length + "</span><span class=\"ctof-hangar__sub\">runs</span></div>", "ctof-l-hangar");
      // The conflict's warning.
      if (state === "conflict") {
        var bunch = flights.filter(function (f) {
          return f.place && f.place.bunched;
        });
        if (bunch.length) {
          var mid = bunch.reduce(function (s, f) {
            return s + f.place.m;
          }, 0) / bunch.length;
          var cp = approachPoint(mid, 0).pos;
          var cd = (TOWER_DATA && TOWER_DATA.conflict) || { from: "10:02", to: "10:06" };
          addFixedLabel([cp.x, cp.y + 7.4, cp.z], '<div class="ctof-alert"><b>' + bunch.length + " arrivals " + cd.from + "-" + cd.to + "</b><span>all three would need you at once</span></div>", "ctof-l-alert", 0.1);
        }
      }
    }

    // ---- planes
    function syncPlanes() {
      var keep = {};
      flights.forEach(function (f) {
        keep[f.id] = true;
        var p = planes[f.id];
        if (!p) {
          p = buildPlane(stage, f);
          planes[f.id] = p;
          stage.scene.add(p.group);
          stage.scene.add(p.shadow);
        }
        p.flight = f;
        if (p.pilot) {
          if (p.pilot.pose !== f.beanPose) p.pilot.setPose(f.beanPose);
          seatPilot(p.pilot, f.beanPose);
        }
      });
      Object.keys(planes).forEach(function (id) {
        if (keep[id]) return;
        var p = planes[id];
        stage.remove(p.group);
        if (p.pilot) stage.remove(p.pilot);
        stage.scene.remove(p.shadow);
        delete planes[id];
      });
      planeList = Object.keys(planes).map(function (id) {
        return planes[id];
      });
    }

    function drawPlaneLabels() {
      labels.forEach(function (l) {
        l.label.remove();
      });
      labels = [];
      planeList.forEach(function (p) {
        var f = p.flight;
        if (f.phase === "hangar") return;
        if (f.phase === "holding" && !choreo[f.id]) {
          var anchor = new THREE.Object3D();
          stage.scene.add(anchor);
          var l = stage.label(anchor, holdHtml(f, state), { className: "ctof-l-hold" });
          labels.push({ id: f.id, label: l, anchor: anchor, kind: "hold", place: "right", priority: 0 + f.place.level * 0.01, offset: null });
          return;
        }
        // Neighbouring stands' tags hang at two heights, so they never touch.
        var lift = 1.7 * p.scale + (f.place && f.place.kind === "gate" ? (f.place.gate % 2) * 3.4 : 0);
        var onApproach = f.place && f.place.kind === "approach";
        var offset = onApproach ? [0, 0.3, 0] : [0, lift, 0];
        var tag = stage.label(p.group, tagHtml(f, state), {
          offset: offset,
          className: "ctof-l-plane ctof-l-plane--" + f.phase + (onApproach ? " ctof-l-plane--inbound" : ""),
        });
        labels.push({ id: f.id, label: tag, kind: "plane", anchor: p.group, offset: offset, place: onApproach ? "left" : "above", priority: choreo[f.id] ? 0.3 : labelPriority(f) });
      });
      // Mail planes of the runs that do not wait on Rogier.
      mailPlanes.forEach(function (m) {
        var tag = stage.label(m.plane.group, m.html, { offset: [0, 1.4, 0], className: "ctof-l-plane ctof-l-plane--mail" });
        labels.push({ id: m.id, label: tag, kind: "plane", anchor: m.plane.group, offset: [0, 1.4, 0], place: "above", priority: 9 });
      });
      markSelection();
    }

    // The runs' mail planes: one per run, except the one whose step waits on Rogier, which flies
    // in the holding stack as a flight.
    var mailPlanes = [];
    function syncMail() {
      mailPlanes.forEach(function (m) {
        stage.remove(m.plane.group);
        if (m.plane.pilot) stage.remove(m.plane.pilot);
        stage.scene.remove(m.plane.shadow);
      });
      mailPlanes = [];
      liveRuns().forEach(function (run, index) {
        var current = -1;
        run.steps.forEach(function (s, i) {
          if (s.state === "running" || s.state === "waiting" || s.state === "paused") current = i;
        });
        var waitingStep = run.steps.filter(function (s) {
          return s.state === "waiting";
        })[0];
        if (waitingStep && !events.cleared[waitingStep.sessionId]) return;
        var step = current >= 0 ? run.steps[current] : run.steps[run.steps.length - 1];
        var stepIndex = current >= 0 ? current : run.steps.length - 1;
        var id = step.sessionId || run.id;
        var f = {
          id: id,
          kind: "run",
          title: run.title,
          faceTitle: run.title,
          project: run.project,
          phase: "mail",
          beanPose: run.status === "running" ? "working" : run.status === "paused" ? "asleep" : "done",
          look: lookFor(run.title, "run"),
        };
        var plane = buildPlane(stage, f);
        stage.scene.add(plane.group);
        stage.scene.add(plane.shadow);
        var stop = mailStop(index, stepIndex, run.steps.length);
        var meta = run.status === "running" ? "step " + (stepIndex + 1) + " of " + run.steps.length + " · " + step.label.toLowerCase() : run.status === "paused" ? "paused · Spawn Bound" : "done " + run.ended;
        var html =
          '<div class="ctof-tag ctof-tag--mail' + (run.status !== "running" ? " is-still" : "") + '" style="' + hueStyle(f) + '" data-id="' + esc(id) + '">' +
          '<i class="ctof-tag__dot"></i><b class="ctof-tag__call">' + esc(shorten(run.title, 26)) + "</b>" +
          '<span class="ctof-tag__meta">' + esc(meta) + "</span></div>";
        mailPlanes.push({ id: id, run: run, plane: plane, stop: stop, flying: run.status === "running", html: html, index: index });
      });
    }

    // ---- overlays a state draws: the holding rings, the approach's gates and ranges, tracks
    function clearOverlays() {
      overlays.forEach(function (o) {
        stage.scene.remove(o);
        if (o.geometry && o.userData.own) o.geometry.dispose();
      });
      overlays = [];
    }
    function addOverlay(o) {
      o.userData.own = true;
      o.castShadow = false;
      stage.scene.add(o);
      overlays.push(o);
      return o;
    }

    var overlayMats = null;
    function readOverlayMats() {
      if (overlayMats) return overlayMats;
      overlayMats = {
        ring: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }),
        ringQuiet: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
        path: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false }),
        pathFaint: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }),
        gate: paint("brass", "brass"),
        track: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }),
        warn: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }),
        warnEdge: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false }),
        ranges: {},
      };
      repaintOverlays();
      return overlayMats;
    }
    function repaintOverlays() {
      if (!overlayMats) return;
      overlayMats.ring.color.copy(K.readColor("you"));
      overlayMats.ringQuiet.color.copy(K.readColor("ink"));
      overlayMats.path.color.copy(K.readColor("ink"));
      overlayMats.pathFaint.color.copy(K.readColor("ink"));
      overlayMats.track.color.copy(K.readColor("ink"));
      overlayMats.warn.color.copy(K.readColor("you"));
      overlayMats.warnEdge.color.copy(K.readColor("you"));
      for (var hue in overlayMats.ranges) {
        var c = new THREE.Color();
        var tok = K.readHue(hue, "body");
        K.writeOklch(c, tok);
        overlayMats.ranges[hue].color.copy(c);
      }
    }
    function rangeMat(hue) {
      var M = readOverlayMats();
      if (!M.ranges[hue]) {
        M.ranges[hue] = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5, depthWrite: false });
        var c = new THREE.Color();
        K.writeOklch(c, K.readHue(hue, "body"));
        M.ranges[hue].color.copy(c);
      }
      return M.ranges[hue];
    }

    /** Builds a dashed ring at a height: one level of the holding stack. */
    function dashedRing(radius, y, material, dashes) {
      var parts = [];
      var n = dashes || 72;
      for (var i = 0; i < n; i += 2) {
        var a = ((i + 0.5) / n) * Math.PI * 2;
        parts.push(bake(new THREE.BoxGeometry(0.1, 0.06, ((Math.PI * 2 * radius) / n) * 0.95), compose(PLAN.tower.x + Math.cos(a) * radius, y, PLAN.tower.z + Math.sin(a) * radius, -a)));
      }
      return new THREE.Mesh(merge(parts), material);
    }

    /** Builds a tube along the approach from minute `m0` to `m1`, in a lane. */
    function approachTube(m0, m1, lane, radius, material, rise) {
      var pts = [];
      var steps = Math.max(2, Math.ceil((m1 - m0) * 3));
      for (var i = 0; i <= steps; i++) pts.push(approachPoint(m0 + ((m1 - m0) * i) / steps, lane, rise).pos);
      var curve = new THREE.CatmullRomCurve3(pts);
      return new THREE.Mesh(new THREE.TubeGeometry(curve, steps * 2, radius, 8, false), material);
    }

    function drawOverlays() {
      clearOverlays();
      var M = readOverlayMats();
      var holding = flights.filter(function (f) {
        return f.phase === "holding";
      });
      // The stack: a dashed ring per level, and a brass spine from the beacon.
      holding.forEach(function (f, i) {
        var y = PLAN.holding.low + i * PLAN.holding.step;
        addOverlay(dashedRing(PLAN.holding.radius, y, f.slot ? M.ringQuiet : M.ring));
      });
      if (holding.length) {
        var spineTop = PLAN.holding.low + (holding.length - 1) * PLAN.holding.step;
        addOverlay(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, spineTop - 17.2, 6), M.pathFaint)).position.set(PLAN.tower.x, (spineTop + 17.2) / 2, PLAN.tower.z);
      }
      // The glide path: the 0-15 minute approach, solid; its extension, faint, in the conflict.
      var reach = state === "conflict" ? 27 : 15;
      addOverlay(approachTube(0, 15, 0, 0.06, M.path));
      if (state === "conflict") addOverlay(approachTube(15, reach, 0, 0.05, M.pathFaint));
      // Brass gates every five minutes, standing across the path.
      for (var m = 5; m <= reach; m += 5) {
        var ap = approachPoint(m, 0);
        var gate = new THREE.Mesh(new THREE.TorusGeometry(m > 15 ? 3.2 : 2.4, 0.07, 6, 40), M.gate);
        gate.position.copy(ap.pos);
        gate.lookAt(ap.pos.clone().add(ap.tangent));
        addOverlay(gate);
      }
      // Each inbound flight's range: a tube in its hue along its lane, from its lo to its hi.
      flights.forEach(function (f) {
        if (!f.place || f.place.kind !== "approach") return;
        addOverlay(approachTube(f.range[0], f.range[1], f.place.lane, 0.2, rangeMat(f.look.hue), f.place.rise));
      });
      // The conflict's soft warning ring around the bunch.
      if (state === "conflict") {
        var bunch = flights.filter(function (f) {
          return f.place && f.place.bunched;
        });
        if (bunch.length) {
          var mid = bunch.reduce(function (s, f) {
            return s + f.place.m;
          }, 0) / bunch.length;
          var cp = approachPoint(mid, 0);
          var disc = new THREE.Mesh(new THREE.CircleGeometry(6.6, 48), M.warn);
          disc.position.copy(cp.pos);
          disc.lookAt(cp.pos.clone().add(cp.tangent));
          addOverlay(disc);
          var edge = new THREE.Mesh(new THREE.TorusGeometry(6.6, 0.1, 8, 64), M.warnEdge);
          edge.position.copy(cp.pos);
          edge.lookAt(cp.pos.clone().add(cp.tangent));
          addOverlay(edge);
        }
      }
      // Away: the tracks of the landings while Rogier was out, from the runway to the stand.
      if (state === "away") {
        var left = minutes(W.away.left);
        flights.forEach(function (f) {
          if (f.phase !== "stand" || !f.place) return;
          var ended = (W.turns[f.id] || []).filter(function (s) {
            return s.end === "idle" && s.to && minutes(s.to) > left;
          });
          if (!ended.length) return;
          var built = buildLanding(airPose({ kind: "approach", m: 3, lane: 0 }, 0, false), f.place.gate);
          var track = buildTrack(built.route, M.track);
          if (track) addOverlay(track);
        });
      }
    }

    // ---- placing everything for a state
    function applyState(next, keepCamera) {
      state = next;
      container.setAttribute("data-ctof-state", state);
      flights = buildFlights(state, events);
      layOut(flights, state);
      syncPlanes();
      syncMail();
      drawOverlays();
      drawPlaneLabels();
      drawFixedLabels();
      drawHud();
      var holdingCount = flights.filter(function (f) {
        return f.phase === "holding";
      }).length;
      aerodrome.handles.serving.setNumber(holdingCount);
      aerodrome.handles.desk.setNote(holdingCount > 0);
      placeAll(clockT);
      stage.requestRender();
      if (!keepCamera) {
        if (api.selected && planes[api.selected] && !selectedId) select(api.selected, true);
        else frameZone(defaultZone(state), true);
      }
    }

    function defaultZone(s) {
      if (s === "conflict") return "conflict";
      if (s === "landing") return "field";
      if (s === "moving") return "approach";
      if (s === "slots") return "holding";
      return "field";
    }

    /** Puts every plane where its flight is at time `t`. */
    function placeAll(t) {
      planeList.forEach(function (p) {
        var f = p.flight;
        var pose;
        var c = choreo[f.id];
        if (c) {
          pose = c.route.sample(c.t);
        } else if (!f.place) {
          pose = null;
        } else if (f.place.kind === "holding" || f.place.kind === "cruise" || f.place.kind === "approach") {
          pose = airPose(f.place, t, motion, f.place.kind === "holding" && f.place.level >= holdingDrop.from ? holdingDrop.value : 0);
        } else if (f.place.kind === "gate") {
          pose = groundPose(gateSpot(f.place.gate), p.scale);
        } else if (f.place.kind === "parked") {
          pose = groundPose(parkedSpot(f.place.hangar, f.place.index), p.scale);
        } else if (f.place.kind === "inside") {
          pose = groundPose(insideSpot(f.place.hangar, f.place.index), p.scale);
        } else if (f.place.kind === "queued") {
          pose = groundPose({ x: PLAN.runway.x - PLAN.runway.width / 2 - 6, z: PLAN.taxiN.z, yaw: Math.PI / 2 }, p.scale);
        }
        if (!pose) {
          p.group.visible = false;
          p.shadow.visible = false;
          return;
        }
        p.group.visible = true;
        setPose(p, pose);
        var airborne = !pose.ground || (f.place && f.place.kind === "queued");
        var holdingNow = f.phase === "holding" && !c;
        p.beacon.visible = holdingNow;
        p.halo.visible = holdingNow;
        p.halo.material = f.slot ? readShared().haloQuiet : readShared().halo;
        p.paper.visible = f.phase === "stand";
        p.airborne = airborne;
        p.disc.visible = airborne && !pose.ground;
      });
      mailPlanes.forEach(function (m) {
        var pose;
        if (m.flying) {
          var a = (motion ? t * 0.42 : 0) + m.index * 1.3;
          var rr = 2.8;
          pose = { x: m.stop.x + Math.cos(a) * rr, y: 4.2 + (motion ? Math.sin(t * 0.8 + m.index) * 0.2 : 0), z: m.stop.z + Math.sin(a) * rr, yaw: Math.atan2(-Math.sin(a), Math.cos(a)), pitch: 0, roll: -0.38, ground: false };
          m.plane.disc.visible = true;
        } else {
          pose = groundPose({ x: m.stop.x + 2.2, z: m.stop.z + 1.6, yaw: 0.4 }, m.plane.scale);
          m.plane.disc.visible = false;
        }
        setPose(m.plane, pose);
        m.plane.airborne = m.flying;
      });
    }

    function setPose(p, pose) {
      p.group.position.set(pose.x, pose.y, pose.z);
      p.group.rotation.set(pose.pitch, pose.yaw, pose.roll);
      var h = Math.max(0, pose.y - GROUND_Y * p.scale);
      var groundY = groundHeight(pose.x, pose.z);
      p.shadow.position.set(pose.x, groundY + 0.06, pose.z);
      var k = Math.min(1, h / 22);
      p.shadow.scale.setScalar(p.scale * (1 + k * 0.6));
      var step = Math.max(0, Math.min(8, Math.round(8 - k * 7)));
      p.shadow.material = shadowMaterial(step);
      p.shadow.visible = groundY >= 0 || pose.ground;
    }

    /** Returns the height of what lies under a point: the ground, or a hangar's or terminal's roof. */
    function groundHeight(x, z) {
      var B = PLAN.base;
      // Past the plinth there is no ground to fall on.
      if (x < B.x0 + 0.5 || x > B.x1 - 0.5 || z < B.z0 + 0.5 || z > B.z1 - 0.5) return -1;
      var T = PLAN.terminal;
      if (Math.abs(x - PLAN.tower.x) < T.half && Math.abs(z - PLAN.tower.z) < T.depth / 2) return -1;
      for (var i = 0; i < PLAN.hangars.length; i++) {
        var hg = PLAN.hangars[i];
        if (Math.abs(x - hg.x) < hg.width / 2 && Math.abs(z - hg.z) < hg.depth / 2) return -1;
      }
      return 0.02;
    }

    // ---- the frame
    var stopFrames = stage.onFrame(function (frame) {
      if (paused || disposed) return false;
      var moving = false;
      if (motion) {
        clockT += frame.dt;
        moving = true;
        beacon.group.rotation.y += frame.dt * 0.9;
        var pulse = 0.55 + 0.45 * Math.sin(clockT * 3.2);
        readShared().halo.opacity = 0.35 + 0.55 * pulse;
      }
      // Choreographies.
      Object.keys(choreo).forEach(function (id) {
        var c = choreo[id];
        if (!motion) {
          c.t = c.route.duration;
        } else {
          c.t += frame.dt;
          moving = true;
        }
        if (c.t >= c.route.duration) {
          delete choreo[id];
          if (c.then) c.then();
        }
      });
      if (holdingDrop.value !== holdingDrop.target) {
        var dv = holdingDrop.target - holdingDrop.value;
        holdingDrop.value = Math.abs(dv) < 0.01 || !motion ? holdingDrop.target : holdingDrop.value + dv * Math.min(1, frame.dt * 1.2);
        moving = true;
      }
      if (motion || moving) placeAll(clockT);
      // Propellers.
      planeList.concat(mailPlanes.map(function (m) {
        return m.plane;
      })).forEach(function (p) {
        if (p.airborne && motion) p.prop.rotation.z += frame.dt * 9;
      });
      // Holding labels: pinned beside the stack, on the camera's right, at their level.
      pinHoldLabels();
      moving = stepCamera(frame.dt) || moving;
      updateLod();
      declutter();
      return moving;
    });

    var right = null;
    function pinHoldLabels() {
      if (!right) right = new THREE.Vector3();
      var cam = stage.camera;
      right.set(1, 0, 0).applyQuaternion(cam.quaternion);
      right.y = 0;
      right.normalize();
      labels.forEach(function (l) {
        if (l.kind !== "hold") return;
        var p = planes[l.id];
        if (!p || !p.flight.place) return;
        var level = p.flight.place.level + (p.flight.place.level >= holdingDrop.from ? holdingDrop.value : 0);
        var y = PLAN.holding.low + level * PLAN.holding.step;
        l.anchor.position.set(PLAN.tower.x + right.x * (PLAN.holding.radius + 2.2), y, PLAN.tower.z + right.z * (PLAN.holding.radius + 2.2));
      });
    }

    /**
     * Hides the less urgent of two tags that overlap on screen, every frame: the stack's levels
     * first, then what lands soonest, then the rest; the selected and hovered tags always show.
     * Each tag's size is measured once, when it is first seen.
     */
    var projected = null;
    function declutter() {
      if (!projected) projected = new THREE.Vector3();
      var cam = stage.camera;
      cam.updateMatrixWorld();
      var W2 = container.clientWidth;
      var H2 = container.clientHeight;
      var items = [];
      function consider(el, point, place, priority) {
        if (!el.isConnected || hiddenAtZoom(el)) return;
        projected.copy(point).project(cam);
        if (projected.z > 1 || projected.z < -1) return;
        var x = ((projected.x + 1) / 2) * W2;
        var y = ((1 - projected.y) / 2) * H2;
        if (!el._ctofSize) el._ctofSize = { w: el.offsetWidth, h: el.offsetHeight };
        var w = el._ctofSize.w;
        var h = el._ctofSize.h;
        var r;
        if (place === "right") r = [x, y - h / 2, x + w, y + h / 2];
        else if (place === "left") r = [x - w - 16, y - h / 2, x - 16, y + h / 2];
        else if (place === "gate") r = [x + 4, y - h / 2, x + 4 + w, y + h / 2];
        else if (place === "centre") r = [x - w / 2, y - h, x + w / 2, y];
        else r = [x - 0.38 * w, y - h - 2, x + 0.62 * w, y - 2];
        items.push({ el: el, r: r, priority: priority });
      }
      labels.forEach(function (l) {
        var pt = l.kind === "hold" ? l.anchor.position.clone() : l.anchor.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(l.offset[0], l.offset[1], l.offset[2]));
        var pr = l.id === selectedId ? -2 : l.id === hoverId ? -1 : l.priority;
        consider(l.label.element, pt, l.place, pr);
      });
      fixedLabels.forEach(function (l) {
        consider(l.element, l.point, l.place, l.priority);
      });
      items.sort(function (a, b) {
        return a.priority - b.priority;
      });
      var kept = [];
      items.forEach(function (it) {
        // A tag the window's edge would cut steps back too.
        var cut = it.r[0] < 4 || it.r[2] > W2 - 4 || it.r[1] < 4 || it.r[3] > H2 - 4;
        var clash = cut || kept.some(function (k) {
          return it.r[0] < k.r[2] + 3 && it.r[2] > k.r[0] - 3 && it.r[1] < k.r[3] + 2 && it.r[3] > k.r[1] - 2;
        });
        it.el.classList.toggle("is-hushed", clash);
        if (!clash) kept.push(it);
      });
    }

    /**
     * Checks whether the zoom level hides a tag, by the same rules as control-tower-office.css,
     * so the declutter reads no style while it runs every frame.
     */
    function hiddenAtZoom(el) {
      var c = el.classList;
      if (lod === "far") return c.contains("ctof-l-plane") || c.contains("ctof-l-hold") || c.contains("ctof-l-gate") || c.contains("ctof-l-crew");
      if (lod === "mid") return c.contains("ctof-l-stack") || c.contains("ctof-l-plane--mail") || c.contains("ctof-l-plane--parked") || c.contains("ctof-l-crew");
      return c.contains("ctof-l-stack");
    }

    function updateLod() {
      var d = stage.camera.position.distanceTo(stage.controls.target);
      var next = d > 205 ? "far" : d > 78 ? "mid" : "near";
      if (next === lod) return;
      lod = next;
      // Tags change size with the zoom level, so they are measured again.
      container.querySelectorAll(".office-kit-label").forEach(function (el) {
        el._ctofSize = null;
      });
      container.classList.toggle("is-far", lod === "far");
      container.classList.toggle("is-mid", lod === "mid");
      container.classList.toggle("is-near", lod === "near");
      // Far away, the pilots are a pixel: leave them out.
      planeList.forEach(function (p) {
        if (p.pilot) p.pilot.visible = lod !== "far";
      });
      mailPlanes.forEach(function (m) {
        if (m.plane.pilot) m.plane.pilot.visible = lod !== "far";
      });
    }

    // ---- the camera: glides, following a plane, zones
    var cam = { glide: null, follow: null };
    var sph = new THREE.Spherical();

    function currentView() {
      var off = new THREE.Vector3().subVectors(stage.camera.position, stage.controls.target);
      sph.setFromVector3(off);
      return { target: stage.controls.target.clone(), radius: sph.radius, phi: sph.phi, theta: sph.theta };
    }

    /** Glides the camera to look at `target` (a point, or a function of time for a moving plane). */
    function glideTo(target, distance, azimuth, elevation, follow, instant) {
      var from = currentView();
      var toPhi = elevation == null ? from.phi : ((90 - elevation) * Math.PI) / 180;
      var toTheta = azimuth == null ? from.theta : (azimuth * Math.PI) / 180;
      var dTheta = Math.atan2(Math.sin(toTheta - from.theta), Math.cos(toTheta - from.theta));
      cam.glide = { from: from, target: target, radius: distance || from.radius, phi: toPhi, theta: from.theta + dTheta, t: 0, seconds: instant || !motion ? 0 : 1.1 };
      cam.follow = follow ? target : null;
      stage.requestRender();
    }

    function resolveTarget(target) {
      return typeof target === "function" ? target() : target;
    }

    function stepCamera(dt) {
      var c = stage.controls;
      var camera = stage.camera;
      if (cam.glide) {
        var g = cam.glide;
        g.t = g.seconds > 0 ? Math.min(1, g.t + dt / g.seconds) : 1;
        var e = g.t * g.t * (3 - 2 * g.t);
        var to = resolveTarget(g.target);
        c.target.copy(g.from.target).lerp(to, e);
        sph.set(g.from.radius + (g.radius - g.from.radius) * e, g.from.phi + (g.phi - g.from.phi) * e, g.from.theta + (g.theta - g.from.theta) * e);
        camera.position.setFromSpherical(sph).add(c.target);
        camera.lookAt(c.target);
        if (g.t >= 1) cam.glide = null;
        return true;
      }
      if (cam.follow) {
        var next = resolveTarget(cam.follow);
        var delta = next.clone().sub(c.target);
        if (delta.lengthSq() > 1e-6) {
          c.target.add(delta);
          camera.position.add(delta);
          return true;
        }
      }
      return false;
    }

    stage.controls.addEventListener("start", function () {
      cam.glide = null;
      cam.follow = null;
    });

    var ZONES = {
      field: function () {
        // A taller holding stack lifts the view, so its top level stays in the picture.
        var extra = Math.max(0, flights.filter(function (f) {
          return f.phase === "holding";
        }).length - 4);
        return { target: v3(6, 9 + extra * 2.4, -14), distance: 156 + extra * 5, azimuth: 16, elevation: 26 };
      },
      holding: function () {
        var n = flights.filter(function (f) {
          return f.phase === "holding";
        }).length;
        return { target: v3(PLAN.tower.x + 10, PLAN.holding.low + Math.max(0, n - 1) * PLAN.holding.step * 0.5 - 8, PLAN.tower.z), distance: 78 + n * 3, azimuth: 18, elevation: 18 };
      },
      approach: function () {
        return { target: v3(44, 7, -52), distance: 88, azimuth: 28, elevation: 22 };
      },
      conflict: function () {
        // The whole approach, its low end clear of the window's selection card (bottom left).
        var p = approachPoint(15, 0).pos;
        return { target: v3(p.x - 11, p.y - 5, p.z + 6), distance: 116, azimuth: 30, elevation: 22 };
      },
      cruising: function () {
        return { target: v3(-16, 9, -20), distance: 96, azimuth: 18, elevation: 24 };
      },
      stand: function () {
        return { target: v3(0, 2, 12), distance: 62, azimuth: 16, elevation: 30 };
      },
      parked: function () {
        return { target: v3(-14, 2, -14), distance: 86, azimuth: 16, elevation: 30 };
      },
      hangar: function () {
        return { target: v3(-14, 3, -20), distance: 92, azimuth: 14, elevation: 22 };
      },
      mail: function () {
        return { target: v3(34, 2, 15), distance: 52, azimuth: 20, elevation: 34 };
      },
    };

    /** Flies the camera to a named zone: field, holding, approach, conflict, cruising, stand, parked, hangar, mail, or hangar:<project>. */
    function frameZone(name, instant) {
      var z;
      if (String(name).indexOf("hangar:") === 0) {
        var proj = name.slice(7);
        var hg = hangarFor(proj === "none" ? null : proj);
        z = { target: v3(hg.x, 3.2, hg.z + 8), distance: 50, azimuth: 16, elevation: 24 };
      } else {
        z = (ZONES[name] || ZONES.field)();
      }
      glideTo(z.target, z.distance, z.azimuth, z.elevation, false, instant);
    }

    // ---- selection
    function planeById(id) {
      if (planes[id]) return planes[id];
      for (var i = 0; i < mailPlanes.length; i++) if (mailPlanes[i].id === id) return mailPlanes[i].plane;
      return null;
    }

    var selRing = null;
    function markSelection() {
      labels.forEach(function (l) {
        l.label.element.classList.toggle("is-selected", l.id === selectedId);
        l.label.element.classList.toggle("is-hovered", l.id === hoverId && l.id !== selectedId);
      });
      if (!selRing) {
        selRing = new THREE.Mesh(readPlaneParts().ring, readShared().ring);
        selRing.visible = false;
        stage.scene.add(selRing);
      }
      var p = selectedId ? planeById(selectedId) : null;
      if (p) {
        if (selRing.parent !== p.group) p.group.add(selRing);
        selRing.position.set(0, -0.2, 0.1);
        selRing.visible = true;
      } else {
        selRing.visible = false;
      }
      stage.requestRender();
    }

    /** Highlights a flight and glides to it; the camera follows a moving plane. Null flies home. */
    function select(id, instant) {
      selectedId = id || null;
      markSelection();
      var p = id ? planeById(id) : null;
      if (!p) {
        if (!id) frameZone(defaultZone(state), instant);
        return;
      }
      var lookAt = function () {
        var pos = p.group.position.clone();
        // Leave the window's selection card (bottom left) clear: aim a little left of and below the plane.
        var r = new THREE.Vector3(1, 0, 0).applyQuaternion(stage.camera.quaternion);
        r.y = 0;
        r.normalize();
        return pos.addScaledVector(r, 3.2).add(new THREE.Vector3(0, -1.6, 0));
      };
      var f = p.flight;
      var moving = motion && (f.place && (f.place.kind === "holding" || f.place.kind === "cruise") || choreo[id] || (mailPlanes.some(function (m) {
        return m.id === id && m.flying;
      })));
      glideTo(moving ? lookAt : lookAt(), 30, null, f.place && f.place.kind === "holding" ? 22 : 28, !!moving, instant);
    }

    // ---- picking: click selects, double-click opens; hover lights the tag
    var pickables = function () {
      return planeList.map(function (p) {
        return p.proxy;
      }).concat(mailPlanes.map(function (m) {
        return m.plane.proxy;
      }));
    };
    var raycaster = new THREE.Raycaster();
    var ndc = new THREE.Vector2();
    function pickAt(clientX, clientY) {
      var rect = stage.renderer.domElement.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      stage.camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, stage.camera);
      var hits = raycaster.intersectObjects(pickables().filter(function (o) {
        return o.parent && o.parent.visible;
      }), false);
      if (hits.length) return { plane: hits[0].object.userData.planeId };
      var zones = raycaster.intersectObjects(aerodrome.handles.hangarProxies.concat([aerodrome.handles.towerProxy]), false);
      if (zones.length) return { zone: zones[0].object.userData.zone };
      return null;
    }

    var canvas = stage.renderer.domElement;
    var down = null;
    function onDown(e) {
      down = { x: e.clientX, y: e.clientY, id: e.pointerId };
    }
    function onUp(e) {
      if (!down || down.id !== e.pointerId) return;
      var moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      var hit = pickAt(e.clientX, e.clientY);
      if (!hit) return;
      if (hit.plane) {
        if (hit.plane !== selectedId) {
          select(hit.plane);
          if (api.onSelect) api.onSelect(hit.plane);
        }
      } else if (hit.zone) {
        frameZone(hit.zone);
      }
    }
    function onDbl(e) {
      var hit = pickAt(e.clientX, e.clientY);
      if (hit && hit.plane && api.onOpen) api.onOpen(hit.plane);
    }
    var hoverFrame = 0;
    var hoverAt = null;
    function onMove(e) {
      if (e.buttons !== 0 || e.pointerType !== "mouse") return;
      hoverAt = { x: e.clientX, y: e.clientY };
      if (!hoverFrame) hoverFrame = requestAnimationFrame(decideHover);
    }
    function decideHover() {
      hoverFrame = 0;
      if (!hoverAt) return;
      var hit = pickAt(hoverAt.x, hoverAt.y);
      var id = hit && hit.plane ? hit.plane : null;
      canvas.style.cursor = hit ? "pointer" : "";
      if (id !== hoverId) {
        hoverId = id;
        markSelection();
      }
    }
    function onLeave() {
      hoverAt = null;
      if (hoverId) {
        hoverId = null;
        markSelection();
      }
    }
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("dblclick", onDbl);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    // A tag is a target too: a click selects, a double-click opens.
    function onLabelClick(e) {
      var el = e.target.closest("[data-id]");
      if (!el || !container.contains(el)) return;
      var id = el.dataset.id;
      if (e.type === "dblclick") {
        if (api.onOpen) api.onOpen(id);
        return;
      }
      select(id);
      if (api.onSelect) api.onSelect(id);
    }
    container.addEventListener("click", function (e) {
      if (e.target.closest(".ctof-hud")) return;
      onLabelClick(e);
    });
    container.addEventListener("dblclick", function (e) {
      if (e.target.closest(".ctof-hud")) return;
      onLabelClick(e);
    });

    // ---- the theme: lit windows and lights in the evening, signs repainted
    function applyTheme() {
      var dark = K.isDarkTheme();
      aerodrome.handles.lit.forEach(function (l) {
        l.mesh.material = dark ? l.night : l.day;
      });
      beacon.beams.forEach(function (b) {
        b.visible = dark;
      });
      aerodrome.handles.cabLight.intensity = dark ? 14 : 0;
      aerodrome.handles.desk.setLamp(dark);
      repaintShared();
      repaintOverlays();
      redrawSigns();
      stage.requestRender();
    }
    var unsubscribe = K.subscribePalette(applyTheme);
    applyTheme();
    if (document.fonts && document.fonts.load) {
      Promise.all([document.fonts.load("64px Limelight"), document.fonts.load("700 64px 'Bricolage Grotesque'")]).then(function () {
        if (!disposed) {
          redrawSigns();
          stage.requestRender();
        }
      });
    }

    // ---- the choreographies: a cleared Request, and a turn that ends
    /** Starts a plane on a route, with a faint dashed track that shows where it goes. */
    function fly(id, route) {
      var track = buildTrack(route, readOverlayMats().track);
      if (track) addOverlay(track);
      choreo[id] = {
        route: route,
        t: 0,
        then: function () {
          if (!track) return;
          stage.scene.remove(track);
          track.geometry.dispose();
          overlays = overlays.filter(function (o) {
            return o !== track;
          });
        },
      };
      drawPlaneLabels();
    }

    /** Plays a cleared Request: a touch-and-go, then back in the air over its hangar. */
    function clear(id) {
      var p = planes[id];
      if (!p || p.flight.phase !== "holding") {
        events.cleared[id] = clock(nowMinutes());
        applyState(state, true);
        return;
      }
      var from = { x: p.group.position.x, y: p.group.position.y, z: p.group.position.z };
      var wasLevel = p.flight.place.level;
      events.cleared[id] = clock(nowMinutes());
      applyState(state, true);
      var f = planes[id] && planes[id].flight;
      if (!f || f.phase !== "cruising") return;
      var hg = hangarFor(f.project);
      var built = buildTouchAndGo(from, hg);
      // The loop it joins starts where the route ends.
      f.place = { kind: "cruise", hangar: hg, layer: f.place && f.place.layer || 0, phase0: 0 };
      var endPose = built.route.sample(built.route.duration);
      f.place.phase0 = Math.atan2((endPose.z - hg.z - 1) / (6.4 + f.place.layer * 1.2), (endPose.x - hg.x) / (9.5 + f.place.layer * 1.6)) - (motion ? 0.17 * (f.place.layer % 2 ? -1 : 1) * (clockT + built.route.duration) : 0);
      fly(id, built.route);
      // The planes above it in the stack step down a level.
      holdingDrop.from = wasLevel;
      holdingDrop.value = 1;
      holdingDrop.target = 0;
      if (selectedId === id) select(id);
    }

    /** Plays a turn's end: the plane lands, rolls out and taxis to a free stand. */
    function land(id) {
      var p = planes[id];
      var from = p ? { x: p.group.position.x, y: p.group.position.y, z: p.group.position.z } : null;
      events.landed[id] = clock(nowMinutes() + 1);
      applyState(state, true);
      var f = planes[id] && planes[id].flight;
      if (!f || !from || !f.place || f.place.kind !== "gate") return;
      var built = buildLanding(from, f.place.gate);
      fly(id, built.route);
      if (selectedId === id) select(id);
    }

    /** Jumps every choreography to `seconds` in, for still pictures. */
    function seek(seconds) {
      Object.keys(choreo).forEach(function (id) {
        choreo[id].t = Math.min(choreo[id].route.duration - 0.001, seconds);
      });
      clockT = seconds;
      placeAll(clockT);
      stage.requestRender();
    }

    // ---- first draw
    applyState(state, false);
    if (state === "landing") {
      setTimeout(function () {
        if (!disposed) clear("t3ds");
      }, motion ? 900 : 0);
    } else if (state === "moving") {
      setTimeout(function () {
        if (!disposed) land("tCartTests");
      }, motion ? 900 : 0);
    }

    var handle = {
      select: function (id) {
        if (id === selectedId) return;
        select(id);
      },
      setState: function (next) {
        events = { cleared: {}, landed: {} };
        choreo = {};
        holdingDrop.value = holdingDrop.target = 0;
        applyState(next || "everyday", true);
        if (next === "landing") clear("t3ds");
        if (next === "moving") land("tCartTests");
        if (!selectedId) frameZone(defaultZone(next));
      },
      resize: function () {
        stage.requestRender();
      },
      pause: function () {
        paused = true;
        stage.pause();
      },
      resume: function () {
        paused = false;
        stage.resume();
      },
      dispose: function () {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        stopFrames();
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("dblclick", onDbl);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerleave", onLeave);
        cancelAnimationFrame(hoverFrame);
        clearOverlays();
        signs.forEach(function (s) {
          s.texture.dispose();
          s.material.dispose();
          s.geometry.dispose();
        });
        signs = [];
        beacon.geometry.dispose();
        beacon.beamMat.dispose();
        beacon.texture.dispose();
        aerodrome.handles.cabGlassNight.dispose();
        hud.remove();
        note.remove();
        stage.dispose();
        container.classList.remove(ROOT_CLASS, "is-far", "is-mid", "is-near");
        container.removeAttribute("data-ctof-state");
        planeParts = null;
        shared = null;
        approachCurve = null;
      },
      // Extras the window may call (see office-notes.md).
      clear: clear,
      land: land,
      frameZone: frameZone,
      seek: seek,
    };
    return handle;
  }

  window.OfficeModes = window.OfficeModes || {};
  window.OfficeModes[FOLDER] = { mount: mount };
})();
