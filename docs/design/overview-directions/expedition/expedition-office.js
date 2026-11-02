// PROTOTYPE - Expedition's Office: the Range.
//
// Every project is a mountain massif in its tint, and every lead's goal is a route up it: a
// trail that zigzags from the valley to a summit, with a tent at each camp. Altitude is
// progress: every summit stands at the same height, so the range is a bar chart with scenery on
// it. A lead and its partners climb as a rope team. A team that waits on Rogier plants a
// marigold flag and raises a hand; a stuck one sits under a grey cloud; a landed one sits by a
// gold flag on its summit. Base camp, a small lodge from the real Office kit, holds Your desk,
// the assistants and the questions that were answered. Runs are a mule caravan on the road.
//
// It registers window.OfficeModes.expedition with the contract of ../BUILDERS.md. It needs
// THREE and OfficeKit (../vendor/office-kit.js), window.WORLD (world.js and world-plus.js), and
// uses window.Crew.lookFor when it is there, so a bean wears the hue its face wears elsewhere.
//
// Coordinates: the range is built in the island's own frame (x east along the row of massifs,
// z toward the viewer, y up, metres) and the island is turned ISLAND_YAW degrees in the world,
// so the app's morning sun, which comes from the north-east, lights the route faces from the
// front right. Colleagues live in world space; `toWorld` converts.
(function () {
  "use strict";

  /* ------------------------------------------------------------------ the range's measures */

  var SUMMIT = 8; // every summit's altitude in metres: altitude is progress
  var LANE = 3.4; // the widest a route's spur gets
  var MASSIF_SPAN = 16.5; // a massif with many routes narrows its spurs to stay this wide
  var RUN = 9; // horizontal distance from a route's foot to its summit
  var CREST_POWER = 1.45; // a spur steepens toward its summit
  var MASSIF_GAP = 2.4; // valley floor between two massifs
  var MAX_RISE = 1.0; // the most a single traverse of a trail climbs before it switches back
  var GRID = 0.36; // terrain cell
  var BASE = -2.6; // the underside of the island
  var ISLAND_YAW = 80; // degrees the island is turned in the world
  var VIEW_AZIMUTH = -16; // the establishing shot looks from a little left of straight on
  var ROPE_STEP = 0.95; // metres of trail between two climbers on one rope
  var LOD_FAR = 62; // camera distances where the labels change their level of detail
  var LOD_NEAR = 24;
  var HUES = ["iris", "teal", "orchid", "lime", "sky", "peach", "mint", "grape"];

  var THREE_ = null;
  var K = null;

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function smoothstep(e0, e1, x) {
    var t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function radians(d) {
    return (d * Math.PI) / 180;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
    });
  }

  /** Returns a seeded random generator: the same seed always draws the same numbers. */
  function makeRandom(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Returns a value between 0 and 1 hashed from two integers. */
  function hash2(ix, iz) {
    var h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** Returns smooth value noise in [0, 1] at a point. */
  function noise2(x, z) {
    var ix = Math.floor(x);
    var iz = Math.floor(z);
    var fx = x - ix;
    var fz = z - iz;
    var ux = fx * fx * (3 - 2 * fx);
    var uz = fz * fz * (3 - 2 * fz);
    var a = hash2(ix, iz);
    var b = hash2(ix + 1, iz);
    var c = hash2(ix, iz + 1);
    var d = hash2(ix + 1, iz + 1);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
  }

  /** Returns two octaves of noise in [0, 1]. */
  function fbm(x, z) {
    return noise2(x, z) * 0.65 + noise2(x * 2.13 + 7.1, z * 2.13 - 3.7) * 0.35;
  }

  /* ------------------------------------------------------------------ the morning, read as routes */

  /** Returns the 3D look of a thread: the hue, shape and accessories its face wears in the window. */
  function readLook(name, kind) {
    var crew = window.Crew && window.Crew.lookFor ? window.Crew.lookFor(name) : null;
    if (!crew) return null;
    var acc = crew.acc === "none" ? [] : String(crew.acc).split("+");
    var headwear = null;
    var accessories = [];
    acc.forEach(function (a) {
      if (a === "cloche" || a === "beret" || a === "headset") headwear = a;
      else accessories.push(a);
    });
    if (kind === "run") {
      headwear = "visor";
      accessories = accessories.filter(function (a) {
        return a !== "homburg";
      });
    }
    return { hue: crew.hue, shape: crew.shape, accessories: accessories, headwear: headwear };
  }

  /** Returns the crew hue of a title, as the window's faces pick it. */
  function readHue(title) {
    if (window.Crew && window.Crew.lookFor) return window.Crew.lookFor(title).hue;
    return K.buildLook(title).hue;
  }

  /** Shortens a title for a name tag, at a word boundary. */
  function shorten(title, max) {
    if (title.length <= max) return title;
    var cut = title.slice(0, max);
    var space = cut.lastIndexOf(" ");
    return (space > max * 0.6 ? cut.slice(0, space) : cut) + "…";
  }

  /*
   * Reads the morning into massifs and routes for one state. The rules match the window's route
   * line (expedition-route.js): the head stands at the last camp reached, 45% of the way to the
   * next while the lead works (or as far as a counted camp says), a route is stuck after 30
   * minutes without a camp while its thread is not idle, and the away reading counts the camps
   * reached by 09:01.
   */
  function readModel(W, state) {
    var H = W.helpers;
    var swarm = state === "swarm";
    var opts = { swarm: swarm };
    var nowMin = H.minutes(W.now);
    var leftMin = H.minutes(W.away.left);
    var byAssistant = {};
    W.assistantThreads.forEach(function (t) {
      byAssistant[t.id] = true;
    });
    var live = H.allLive(opts);
    var leads = live.filter(function (t) {
      return !t.lead && t.project && W.goals[t.id] && !byAssistant[t.id];
    });

    function readRoute(lead) {
      var goal = W.goals[lead.id];
      var camps = goal.camps;
      var n = camps.length;
      var done = camps.filter(function (c) {
        return c.state === "done";
      }).length;
      var next = done < n ? camps[done] : null;
      var progress = done;
      if (next && next.of) progress += next.of[0] / next.of[1];
      else if (next && lead.pose === "working" && next.state !== "waiting") progress += 0.45;
      var team = H.teamOf(lead.id, opts);
      var quiet = goal.lastProgress ? nowMin - H.minutes(goal.lastProgress) : 0;
      var stuck = done < n && lead.pose !== "idle" && lead.pose !== "asleep" && quiet >= 30;
      var doneThen = 0;
      var started = H.minutes(lead.started);
      if (started <= leftMin) {
        camps.forEach(function (c) {
          if (c.state === "done" && c.at && H.minutes(c.at) <= leftMin) doneThen++;
        });
      }
      var waitingCamp = -1;
      camps.forEach(function (c, i) {
        if (c.state === "waiting" && waitingCamp < 0) waitingCamp = i;
      });
      return {
        id: lead.id,
        lead: lead,
        goal: goal,
        camps: camps,
        n: n,
        done: done,
        next: next,
        progress: progress,
        team: team,
        waiting: team.filter(function (t) {
          return t.pose === "waiting";
        }),
        stuck: stuck,
        quiet: quiet,
        grew: goal.grew || 0,
        landed: done === n,
        isNew: started > leftMin,
        doneThen: doneThen,
        movedCamps: done - doneThen,
        waitingCamp: waitingCamp,
        hue: readHue(lead.title),
      };
    }

    var massifs = W.projects.map(function (p, index) {
      var routes = leads
        .filter(function (t) {
          return t.project === p.id;
        })
        .sort(function (a, b) {
          return H.minutes(a.started) - H.minutes(b.started);
        })
        .map(readRoute);
      return { index: index, project: p, tint: p.tint, routes: routes, more: swarm ? W.swarm.more[p.id] || 0 : 0 };
    });

    // Base camp's terrace: answered questions with no project and the assistants' own threads.
    var terrace = live.filter(function (t) {
      return !t.lead && (!t.project || byAssistant[t.id] || !W.goals[t.id]);
    });
    var runs = W.runs
      .filter(function (r) {
        return r.status === "running";
      })
      .map(function (r) {
        var step = null;
        var index = 0;
        r.steps.forEach(function (s, i) {
          if (!step && s.state !== "completed") {
            step = s;
            index = i;
          }
        });
        var session = step && step.sessionId ? W.runSessions[step.sessionId] : null;
        return { run: r, step: step, stepIndex: index, sessionId: step ? step.sessionId : null, session: session };
      })
      .filter(function (r) {
        return r.session;
      });
    var waitingCount = live.filter(function (t) {
      return t.pose === "waiting";
    }).length;
    runs.forEach(function (r) {
      if (r.session.pose === "waiting") waitingCount++;
    });
    return { state: state, swarm: swarm, massifs: massifs, terrace: terrace, runs: runs, assistants: W.assistants, waitingCount: waitingCount };
  }

  /* ------------------------------------------------------------------ the layout of the range */

  /** Returns the depth fraction along a spur at which its crest reaches `alpha` of the summit. */
  function depthForAltitude(alpha) {
    return Math.pow(clamp(alpha, 0, 1), 1 / CREST_POWER);
  }

  /** Returns the island point of a spur at depth fraction `delta` and `u` metres across it. */
  function lanePoint(lane, delta, u) {
    return {
      x: lane.fx + lane.dx * delta * lane.run + lane.ax * u,
      z: lane.fz + lane.dz * delta * lane.run + lane.az * u,
    };
  }

  /**
   * Builds the trail of one route: from its foot, up switchbacks, through one corner per camp, to
   * the summit. Camp k stands at altitude (k + 1) / n of the summit, so altitude reads as
   * progress. Returns the dense polyline ({ x, y, z, s } with s the metres walked) and the arc
   * length at each camp.
   */
  function buildTrail(lane, n) {
    var w = lane.width;
    var amp = function (delta) {
      return w * (0.25 - 0.15 * delta);
    };
    var corners = [{ delta: 0, u: 0, alt: 0, camp: -1 }];
    for (var k = 0; k < n; k++) {
      var prev = corners[corners.length - 1];
      var alt = (SUMMIT * (k + 1)) / n;
      var summit = k === n - 1;
      var target = summit ? 0 : k % 2 === 0 ? 1 : -1;
      var from = prev.u === 0 ? -target || 1 : prev.u > 0 ? 1 : -1;
      var to = target === 0 ? -from : target;
      var legs = 1;
      while ((alt - prev.alt) / legs > MAX_RISE) legs += 2;
      for (var j = 1; j < legs; j++) {
        var a = prev.alt + ((alt - prev.alt) * j) / legs;
        var d = depthForAltitude(a / SUMMIT);
        corners.push({ delta: d, u: (j % 2 === 1 ? to : from) * amp(d), alt: a, camp: -1 });
      }
      var dc = depthForAltitude(alt / SUMMIT);
      corners.push({ delta: dc, u: target * amp(dc), alt: alt, camp: k });
    }
    var points = [];
    var campS = [];
    var s = 0;
    var last = null;
    for (var c = 0; c < corners.length; c++) {
      var p = corners[c];
      if (c > 0) {
        var q = corners[c - 1];
        var steps = Math.max(2, Math.ceil(Math.hypot((p.delta - q.delta) * lane.run, p.u - q.u, p.alt - q.alt) / 0.14));
        for (var i = 1; i <= steps; i++) {
          var t = i / steps;
          var xz = lanePoint(lane, lerp(q.delta, p.delta, t), lerp(q.u, p.u, t));
          var y = lerp(q.alt, p.alt, t);
          s += Math.hypot(xz.x - last.x, y - last.y, xz.z - last.z);
          last = { x: xz.x, y: y, z: xz.z, s: s };
          points.push(last);
        }
      } else {
        var foot = lanePoint(lane, 0, 0);
        last = { x: foot.x, y: 0, z: foot.z, s: 0 };
        points.push(last);
      }
      if (p.camp >= 0) campS[p.camp] = s;
    }
    return { points: points, campS: campS, corners: corners, length: s };
  }

  /** Returns the trail point at arc length `s`, with its uphill direction. */
  function sampleTrail(trail, s) {
    var pts = trail.points;
    s = clamp(s, 0, trail.length);
    var lo = 0;
    var hi = pts.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (pts[mid].s < s) lo = mid;
      else hi = mid;
    }
    var a = pts[lo];
    var b = pts[hi];
    var t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    var dx = b.x - a.x;
    var dz = b.z - a.z;
    var len = Math.hypot(dx, dz) || 1;
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t), tx: dx / len, tz: dz / len };
  }

  /** Returns the arc length at `progress` camps up a route (0 at the foot, n at the summit). */
  function progressToS(route, progress) {
    var whole = Math.floor(progress);
    var frac = progress - whole;
    var at = function (k) {
      return k <= 0 ? 0 : route.trail.campS[Math.min(k, route.n) - 1];
    };
    if (whole >= route.n) return at(route.n);
    return lerp(at(whole), at(whole + 1), frac);
  }

  /**
   * Lays the massifs out in a shallow arc, left to right in the projects' order, and gives each
   * route a spur, a trail and its camps. The lodge sits in the valley in front.
   */
  function layoutRange(model) {
    var massifs = model.massifs.filter(function (m) {
      return m.routes.length > 0;
    });
    var widths = massifs.map(function (m) {
      var lane = Math.min(LANE, MASSIF_SPAN / m.routes.length);
      return { lane: lane, span: lane * m.routes.length + 1.6 };
    });
    var total = widths.reduce(function (sum, w) {
      return sum + w.span;
    }, 0) + MASSIF_GAP * (massifs.length - 1);
    var x = -total / 2;
    var lanes = [];
    massifs.forEach(function (m, mi) {
      var w = widths[mi];
      var centre = x + w.span / 2;
      x += w.span + MASSIF_GAP;
      var side = massifs.length === 1 ? 0 : (mi / (massifs.length - 1)) * 2 - 1; // -1 left .. 1 right
      var angle = radians(-11 * side); // outer massifs turn toward the middle
      var oz = 1.0 * Math.abs(side);
      m.layout = { cx: centre, cz: oz, angle: angle, lane: w.lane, span: w.span, lanes: [] };
      var n = m.routes.length;
      m.routes.forEach(function (route, i) {
        var off = i - (n - 1) / 2;
        var lx = off * w.lane;
        var ca = Math.cos(angle);
        var sa = Math.sin(angle);
        var phi = angle + off * 0.035;
        var lane = {
          massif: mi,
          fx: centre + lx * ca,
          fz: oz - lx * sa,
          dx: -Math.sin(phi),
          dz: -Math.cos(phi),
          ax: Math.cos(phi),
          az: -Math.sin(phi),
          width: w.lane,
          run: RUN * (1 + 0.05 * Math.sin(i * 2.3 + mi * 1.7)),
        };
        route.lane = lane;
        route.trail = buildTrail(lane, route.n);
        route.massif = m;
        m.layout.lanes.push(lane);
        lanes.push(lane);
      });
    });
    var minX = Infinity;
    var maxX = -Infinity;
    var minZ = Infinity;
    lanes.forEach(function (lane) {
      [0, 1.15].forEach(function (d) {
        [-lane.width, lane.width].forEach(function (u) {
          var p = lanePoint(lane, d, u);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.z);
        });
      });
    });
    var lodge = { x: 1.0, z: 5.6, width: 7.2, depth: 5.2, door: -0.6 };
    return {
      massifs: massifs,
      lanes: lanes,
      lodge: lodge,
      x0: Math.floor((minX - 2.0) / GRID) * GRID,
      x1: Math.ceil((maxX + 2.0) / GRID) * GRID,
      z0: Math.floor((minZ - 0.8) / GRID) * GRID,
      z1: Math.ceil((lodge.z + lodge.depth / 2 + 3.0) / GRID) * GRID,
    };
  }

  /* ------------------------------------------------------------------ paths in the valley */

  /** Returns points along a Catmull-Rom curve through `control` (island x, z), about `step` apart. */
  function sampleCurve(control, step) {
    var curve = new THREE_.CatmullRomCurve3(
      control.map(function (p) {
        return new THREE_.Vector3(p.x, 0, p.z);
      }),
      false,
      "centripetal",
    );
    var count = Math.max(4, Math.ceil(curve.getLength() / step));
    return curve.getSpacedPoints(count).map(function (v) {
      return { x: v.x, z: v.z };
    });
  }

  /** Lays the valley's paths: from the lodge's door to each massif, then to each route's foot. */
  function layoutPaths(layout) {
    var L = layout.lodge;
    var door = { x: L.x + L.door, z: L.z - L.depth / 2 - 0.2 };
    var out = { x: door.x, z: door.z - 1.1 };
    var paths = [];
    layout.massifs.forEach(function (m) {
      var feet = m.routes.map(function (r) {
        return lanePoint(r.lane, 0, 0);
      });
      var mx = feet.reduce(function (s, p) {
        return s + p.x;
      }, 0) / feet.length;
      var mz = feet.reduce(function (s, p) {
        return s + p.z;
      }, 0) / feet.length;
      var head = { x: mx, z: mz + 1.5 };
      var mid = { x: lerp(out.x, head.x, 0.5), z: lerp(out.z, head.z, 0.55) + 0.5 };
      paths.push({ width: 0.62, points: sampleCurve([door, out, mid, head], 0.22) });
      feet.forEach(function (f) {
        var bend = { x: lerp(head.x, f.x, 0.5), z: lerp(head.z, f.z, 0.5) + 0.15 };
        paths.push({ width: 0.42, points: sampleCurve([head, bend, f], 0.2) });
      });
    });
    // The road the run caravans walk, from the island's west edge to the lodge's west side.
    var roadEnd = { x: L.x - L.width / 2 - 0.8, z: L.z + 0.8 };
    var road = sampleCurve(
      [
        { x: layout.x0 + 0.2, z: L.z + 1.6 },
        { x: lerp(layout.x0, roadEnd.x, 0.35), z: L.z + 2.3 },
        { x: lerp(layout.x0, roadEnd.x, 0.7), z: L.z + 1.9 },
        roadEnd,
      ],
      0.2,
    );
    paths.push({ width: 0.8, points: road, road: true });
    // The terrace path from the lodge's east side.
    paths.push({
      width: 0.5,
      points: sampleCurve(
        [
          { x: L.x + L.width / 2 + 0.2, z: L.z + 0.4 },
          { x: L.x + L.width / 2 + 1.6, z: L.z + 0.3 },
          { x: L.x + L.width / 2 + 2.8, z: L.z - 0.2 },
        ],
        0.2,
      ),
    });
    layout.paths = paths;
    layout.road = road;
  }

  /* ------------------------------------------------------------------ the terrain */

  /** Returns the natural height of a spur at an island point, before carving. */
  function spurHeight(lane, x, z) {
    var rx = x - lane.fx;
    var rz = z - lane.fz;
    var along = rx * lane.dx + rz * lane.dz;
    var across = rx * lane.ax + rz * lane.az;
    var delta = along / lane.run;
    var crest;
    if (delta <= 0) crest = delta * lane.run * 0.9;
    else if (delta <= 1) crest = SUMMIT * Math.pow(delta, CREST_POWER);
    else crest = SUMMIT - (delta - 1) * lane.run * 1.3;
    var dd = clamp(delta, 0, 1);
    var plateau = lane.width * (0.4 - 0.33 * dd);
    var side = Math.max(0, Math.abs(across) - plateau);
    return crest - side * (1.25 + 1.0 * dd);
  }

  /**
   * Builds the island: a heightfield of the valley and the massifs, carved where trails, camps,
   * paths and the lodge need flat ground, drawn flat-shaded in low-poly facets with one colour per
   * facet, and its cut sides showing the strata. Returns the mesh, a repaint function, and
   * `heightAt`, the exact height of the drawn surface at an island point.
   */
  function buildTerrain(layout, routes) {
    var x0 = layout.x0;
    var z0 = layout.z0;
    var nx = Math.round((layout.x1 - x0) / GRID);
    var nz = Math.round((layout.z1 - z0) / GRID);
    var heights = new Float32Array((nx + 1) * (nz + 1));
    var owner = new Int8Array((nx + 1) * (nz + 1));
    var L = layout.lodge;

    // What the carving holds flat: trail benches, camp ledges, summits, paths, the lodge.
    var trailPoints = [];
    var ledges = [];
    routes.forEach(function (route) {
      route.trail.points.forEach(function (p, i) {
        if (i % 2 === 0) trailPoints.push(p);
      });
      route.trail.corners.forEach(function (c) {
        if (c.camp < 0) return;
        var summit = c.camp === route.n - 1;
        var side = c.u > 0 ? 1 : -1;
        var at = lanePoint(route.lane, c.delta, summit ? 0 : c.u + side * 0.32);
        ledges.push({ x: at.x, z: at.z, y: c.alt, r: summit ? 0.5 : 0.82 });
      });
    });
    var pathPoints = [];
    layout.paths.forEach(function (path) {
      path.points.forEach(function (p) {
        pathPoints.push({ x: p.x, z: p.z, r: path.width / 2 + 0.35 });
      });
    });

    // Each massif's body: a ridge through its summits, so its spurs read as one mountain.
    var ridges = layout.massifs.map(function (m) {
      var lanes = m.layout.lanes;
      var a = lanePoint(lanes[0], 1, 0);
      var b = lanePoint(lanes[lanes.length - 1], 1, 0);
      return { a: a, b: b, massif: lanes[0].massif };
    });
    function bodyHeight(r, x, z) {
      var vx = r.b.x - r.a.x;
      var vz = r.b.z - r.a.z;
      var len2 = vx * vx + vz * vz;
      var t = len2 > 0 ? clamp(((x - r.a.x) * vx + (z - r.a.z) * vz) / len2, 0, 1) : 0;
      var d = Math.hypot(x - (r.a.x + vx * t), z - (r.a.z + vz * t));
      return SUMMIT * 0.62 - d * 1.18;
    }
    function naturalHeight(x, z, cell) {
      var h = -1;
      var best = -1;
      for (var i = 0; i < layout.lanes.length; i++) {
        var v = spurHeight(layout.lanes[i], x, z);
        if (v > h) {
          h = v;
          best = layout.lanes[i].massif;
        }
      }
      for (var r = 0; r < ridges.length; r++) {
        var bh = bodyHeight(ridges[r], x, z);
        if (bh > h) {
          h = bh;
          best = ridges[r].massif;
        }
      }
      // The valley floor, with soft knolls.
      var knoll = (fbm(x * 0.16 + 3.1, z * 0.16 - 1.3) - 0.45) * 0.9;
      var valley = Math.max(0, knoll);
      if (h < valley) {
        h = valley;
        best = h > 0.6 ? best : -1;
      } else {
        // Crags and facets on the rock, fading out on the valley floor.
        var rock = smoothstep(0.1, 1.6, h);
        h += (fbm(x * 0.36, z * 0.36) - 0.5) * 0.5 * rock + (noise2(x * 1.1, z * 1.1) - 0.5) * 0.06 * rock;
      }
      if (cell) cell.owner = h > 0.25 ? best : -1;
      return h;
    }

    function carve(x, z, h) {
      // Trails: a bench at the trail's altitude.
      var bestD = Infinity;
      var bestY = 0;
      for (var i = 0; i < trailPoints.length; i++) {
        var p = trailPoints[i];
        var dx = x - p.x;
        if (dx > 0.6 || dx < -0.6) continue;
        var dz = z - p.z;
        if (dz > 0.6 || dz < -0.6) continue;
        var d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          bestY = p.y;
        }
      }
      if (bestD < 0.36) {
        var w = 1 - smoothstep(0.2, 0.55, Math.sqrt(bestD));
        h = lerp(h, bestY - 0.02, w);
      }
      for (var j = 0; j < ledges.length; j++) {
        var l = ledges[j];
        var d2 = Math.hypot(x - l.x, z - l.z);
        if (d2 < l.r + 0.4) h = lerp(h, l.y - 0.02, 1 - smoothstep(l.r - 0.25, l.r + 0.4, d2));
      }
      // The valley's paths and the lodge stand on level ground.
      var flat = 0;
      for (var k = 0; k < pathPoints.length; k++) {
        var q = pathPoints[k];
        var ex = x - q.x;
        if (ex > 1.2 || ex < -1.2) continue;
        var ez = z - q.z;
        if (ez > 1.2 || ez < -1.2) continue;
        var e = Math.hypot(ex, ez);
        if (e < q.r + 0.5) flat = Math.max(flat, 1 - smoothstep(q.r - 0.2, q.r + 0.5, e));
      }
      var lx = Math.abs(x - (L.x + 1.4)) - (L.width / 2 + 3.2);
      var lz = Math.abs(z - L.z) - (L.depth / 2 + 1.2);
      var inLodge = Math.max(lx, lz);
      if (inLodge < 0.8) flat = Math.max(flat, 1 - smoothstep(-0.4, 0.8, inLodge));
      if (flat > 0 && h < 1.2) h = lerp(h, -0.03, flat);
      return h;
    }

    var cell = { owner: -1 };
    for (var j = 0; j <= nz; j++) {
      for (var i = 0; i <= nx; i++) {
        var x = x0 + i * GRID;
        var z = z0 + j * GRID;
        var h = naturalHeight(x, z, cell);
        h = carve(x, z, h);
        heights[j * (nx + 1) + i] = h;
        owner[j * (nx + 1) + i] = cell.owner;
      }
    }

    function heightAt(x, z) {
      var fx = (x - x0) / GRID;
      var fz = (z - z0) / GRID;
      var i = clamp(Math.floor(fx), 0, nx - 1);
      var j = clamp(Math.floor(fz), 0, nz - 1);
      var u = clamp(fx - i, 0, 1);
      var v = clamp(fz - j, 0, 1);
      var h00 = heights[j * (nx + 1) + i];
      var h10 = heights[j * (nx + 1) + i + 1];
      var h01 = heights[(j + 1) * (nx + 1) + i];
      var h11 = heights[(j + 1) * (nx + 1) + i + 1];
      if ((i + j) % 2 === 0) {
        // Split from (0,0) to (1,1).
        return u >= v ? h00 + (h10 - h00) * u + (h11 - h10) * v : h00 + (h01 - h00) * v + (h11 - h01) * u;
      }
      // Split from (1,0) to (0,1).
      return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
    }

    // Faces: two triangles per cell, then the island's four cut sides.
    var positions = [];
    var faces = []; // per face: kind, massif, altitude, slope, noise
    function pushFace(a, b, c, info) {
      positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      faces.push(info);
    }
    function vertex(i, j) {
      return [x0 + i * GRID, heights[j * (nx + 1) + i], z0 + j * GRID];
    }
    function classify(a, b, c, i, j) {
      var y = (a[1] + b[1] + c[1]) / 3;
      var ux = b[0] - a[0];
      var uy = b[1] - a[1];
      var uz = b[2] - a[2];
      var vx = c[0] - a[0];
      var vy = c[1] - a[1];
      var vz = c[2] - a[2];
      var nxx = uy * vz - uz * vy;
      var nyy = uz * vx - ux * vz;
      var nzz = ux * vy - uy * vx;
      var ny = Math.abs(nyy) / (Math.hypot(nxx, nyy, nzz) || 1);
      var o = Math.max(owner[j * (nx + 1) + i], owner[j * (nx + 1) + i + 1], owner[(j + 1) * (nx + 1) + i]);
      var cx = (a[0] + b[0] + c[0]) / 3;
      var cz = (a[2] + b[2] + c[2]) / 3;
      var grain = hash2(faces.length, 977);
      var snowLine = SUMMIT * 0.75 + (fbm(cx * 0.4, cz * 0.4) - 0.5) * 0.6;
      var kind;
      if (o < 0 || y < 0.32) kind = "grass";
      else if ((y > snowLine && ny > 0.36) || y > SUMMIT * 0.9) kind = "snow";
      else kind = "rock";
      if (kind === "grass" && y > 0.5 && ny < 0.7) kind = "rock";
      return { kind: kind, massif: o, y: y, ny: ny, grain: grain };
    }
    for (var cj = 0; cj < nz; cj++) {
      for (var ci = 0; ci < nx; ci++) {
        var p00 = vertex(ci, cj);
        var p10 = vertex(ci + 1, cj);
        var p01 = vertex(ci, cj + 1);
        var p11 = vertex(ci + 1, cj + 1);
        // Counter-clockwise seen from above (+y): (x, z) with z toward the viewer.
        if ((ci + cj) % 2 === 0) {
          pushFace(p00, p11, p10, classify(p00, p11, p10, ci, cj));
          pushFace(p00, p01, p11, classify(p00, p01, p11, ci, cj));
        } else {
          pushFace(p00, p01, p10, classify(p00, p01, p10, ci, cj));
          pushFace(p10, p01, p11, classify(p10, p01, p11, ci, cj));
        }
      }
    }
    // Contour lines at a quarter, a half and three quarters of the climb: the chart's gridlines.
    // Each facet that crosses a level gives one short segment; it is drawn as a thin ribbon
    // lying on the facet, a hair above it.
    var contours = {};
    var topFaces = faces.length;
    for (var fi = 0; fi < topFaces; fi++) {
      var info = faces[fi];
      if (info.massif < 0 || info.kind === "grass") continue;
      var o9 = fi * 9;
      var P = [
        [positions[o9], positions[o9 + 1], positions[o9 + 2]],
        [positions[o9 + 3], positions[o9 + 4], positions[o9 + 5]],
        [positions[o9 + 6], positions[o9 + 7], positions[o9 + 8]],
      ];
      for (var lv = 1; lv <= 3; lv++) {
        var level = (SUMMIT * lv) / 4;
        var cross = [];
        for (var e = 0; e < 3; e++) {
          var A = P[e];
          var B = P[(e + 1) % 3];
          if ((A[1] - level) * (B[1] - level) < 0) {
            var t = (level - A[1]) / (B[1] - A[1]);
            cross.push([lerp(A[0], B[0], t), level, lerp(A[2], B[2], t)]);
          }
        }
        if (cross.length !== 2) continue;
        var ux = P[1][0] - P[0][0], uy = P[1][1] - P[0][1], uz = P[1][2] - P[0][2];
        var vx = P[2][0] - P[0][0], vy = P[2][1] - P[0][1], vz = P[2][2] - P[0][2];
        var nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx;
        var nl = Math.hypot(nX, nY, nZ) || 1;
        nX /= nl;
        nY /= nl;
        nZ /= nl;
        var dX = cross[1][0] - cross[0][0], dZ = cross[1][2] - cross[0][2];
        // Sideways on the facet: the normal crossed with the segment, which is level (no y).
        var sX = nY * dZ;
        var sY = nZ * dX - nX * dZ;
        var sZ = -nY * dX;
        var sl = Math.hypot(sX, sY, sZ) || 1;
        var half = 0.028;
        sX = (sX / sl) * half;
        sY = (sY / sl) * half;
        sZ = (sZ / sl) * half;
        var lift = 0.018;
        var p0 = [cross[0][0] + nX * lift, cross[0][1] + nY * lift, cross[0][2] + nZ * lift];
        var p1 = [cross[1][0] + nX * lift, cross[1][1] + nY * lift, cross[1][2] + nZ * lift];
        var key = info.massif;
        var list = contours[key] || (contours[key] = []);
        var q0 = [p0[0] - sX, p0[1] - sY, p0[2] - sZ], q1 = [p0[0] + sX, p0[1] + sY, p0[2] + sZ];
        var q2 = [p1[0] + sX, p1[1] + sY, p1[2] + sZ], q3 = [p1[0] - sX, p1[1] - sY, p1[2] - sZ];
        list.push(q0[0], q0[1], q0[2], q1[0], q1[1], q1[2], q2[0], q2[1], q2[2]);
        list.push(q0[0], q0[1], q0[2], q2[0], q2[1], q2[2], q3[0], q3[1], q3[2]);
      }
    }

    // The cut sides: the rock or soil above the valley floor, then strata down to the base.
    var STRATA = [0, -0.55, -1.15, -1.8, BASE];
    function side(ax, az, ah, bx, bz, bh, outward) {
      var top = Math.max(ah, bh);
      if (top > 0.05) {
        pushFace([ax, 0, az], [bx, 0, bz], [bx, bh, bz], { kind: "cut", massif: -1, y: top, ny: 0, grain: 0.5, outward: outward });
        pushFace([ax, 0, az], [bx, bh, bz], [ax, ah, az], { kind: "cut", massif: -1, y: top, ny: 0, grain: 0.5, outward: outward });
      }
      for (var s = 0; s < STRATA.length - 1; s++) {
        var y0 = STRATA[s];
        var y1 = STRATA[s + 1];
        var ya = s === 0 ? Math.min(ah, 0) : y0;
        var yb = s === 0 ? Math.min(bh, 0) : y0;
        pushFace([ax, y1, az], [bx, y1, bz], [bx, yb, bz], { kind: "strata", band: s, y: y1, ny: 0, grain: 0.5 });
        pushFace([ax, y1, az], [bx, yb, bz], [ax, ya, az], { kind: "strata", band: s, y: y1, ny: 0, grain: 0.5 });
      }
    }
    for (var si = 0; si < nx; si++) {
      var a0 = vertex(si, nz);
      var b0 = vertex(si + 1, nz);
      side(a0[0], a0[2], a0[1], b0[0], b0[2], b0[1]); // south (toward the viewer)
      var a1 = vertex(si + 1, 0);
      var b1 = vertex(si, 0);
      side(a1[0], a1[2], a1[1], b1[0], b1[2], b1[1]); // north
    }
    for (var sj = 0; sj < nz; sj++) {
      var a2 = vertex(0, sj);
      var b2 = vertex(0, sj + 1);
      side(a2[0], a2[2], a2[1], b2[0], b2[2], b2[1]); // west
      var a3 = vertex(nx, sj + 1);
      var b3 = vertex(nx, sj);
      side(a3[0], a3[2], a3[1], b3[0], b3[2], b3[1]); // east
    }
    // The underside.
    var X0 = x0;
    var X1 = x0 + nx * GRID;
    var Z0 = z0;
    var Z1 = z0 + nz * GRID;
    pushFace([X0, BASE, Z0], [X1, BASE, Z0], [X1, BASE, Z1], { kind: "strata", band: 4, y: BASE, ny: 1, grain: 0.5 });
    pushFace([X0, BASE, Z0], [X1, BASE, Z1], [X0, BASE, Z1], { kind: "strata", band: 4, y: BASE, ny: 1, grain: 0.5 });

    var geometry = new THREE_.BufferGeometry();
    geometry.setAttribute("position", new THREE_.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    var colours = new Float32Array(positions.length);
    geometry.setAttribute("color", new THREE_.BufferAttribute(colours, 3));
    var mesh = new THREE_.Mesh(geometry, K.paintVertexColors("matte"));
    mesh.name = "range-terrain";
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    function repaint(palette) {
      var c = new THREE_.Color();
      for (var f = 0; f < faces.length; f++) {
        var info = faces[f];
        palette.terrain(info, c);
        for (var v = 0; v < 3; v++) {
          colours[f * 9 + v * 3] = c.r;
          colours[f * 9 + v * 3 + 1] = c.g;
          colours[f * 9 + v * 3 + 2] = c.b;
        }
      }
      geometry.attributes.color.needsUpdate = true;
    }

    return { mesh: mesh, repaint: repaint, heightAt: heightAt, contours: contours, bounds: { x0: X0, x1: X1, z0: Z0, z1: Z1 } };
  }

  /* ------------------------------------------------------------------ colours from the tokens */

  /**
   * Builds the palette the range paints with. Every colour is read from the theme's tokens
   * (OfficeKit.readToken), so the range follows the theme as the app's Office does. Reads are
   * cached until `reset`, which the range calls on every repaint.
   */
  function makePalette() {
    var cache = {};
    var dark = false;
    function oklch(l, c, h) {
      return K.writeOklch(new THREE_.Color(), { l: l, c: c, h: h });
    }
    function token(name) {
      if (!cache[name]) cache[name] = K.readToken(name);
      return cache[name];
    }
    var palette = {
      reset: function () {
        cache = {};
        dark = K.isDarkTheme();
        palette.dark = dark;
      },
      dark: false,
      /** Returns a token's colour with its lightness, chroma and hue shifted. */
      token: function (name, dl, dc, dh) {
        var t = token(name);
        return oklch(t.l + (dl || 0), Math.max(0, t.c + (dc || 0)), t.h + (dh || 0));
      },
      /** Returns a crew hue's colour, as a bean's body (`body`), rim (`shade`) or text (`ink`). */
      hue: function (hue, part, dl) {
        var o = K.readHue(hue, part || "body");
        return oklch(o.l + (dl || 0), o.c, o.h);
      },
      /** Returns a project's rock in band 0..3 of the altitude scale. */
      rock: function (tint, band, grain) {
        var t = token("proj-" + tint);
        // The strata alternate so every quarter of the climb reads as its own band.
        var steps = dark ? [-0.03, 0.07, 0.0, 0.1] : [-0.22, -0.08, -0.17, -0.04];
        var l = t.l + steps[band] + (grain - 0.5) * 0.035;
        return oklch(l, t.c * (dark ? 0.95 : 1.25), t.h);
      },
      snow: function (grain) {
        var p = token("room-paper");
        return dark ? oklch(0.74 + grain * 0.03, 0.018, 250) : oklch(Math.min(0.995, p.l - 0.015 + grain * 0.02), 0.012, 240);
      },
      grass: function (grain) {
        var g = token("room-lawn");
        return oklch(g.l + (grain - 0.5) * 0.035 + (dark ? -0.02 : 0.04), g.c * (dark ? 0.8 : 1.05), g.h + (dark ? 18 : -22));
      },
      terrain: function (info, out) {
        var col;
        if (info.kind === "grass") col = palette.grass(info.grain);
        else if (info.kind === "snow") col = palette.snow(info.grain);
        else if (info.kind === "rock") {
          var band = clamp(Math.floor(info.y / (SUMMIT / 4)), 0, 3);
          var tint = palette.tints[info.massif] || "webshop";
          col = palette.rock(tint, band, info.grain);
        } else if (info.kind === "cut") {
          col = palette.token("room-wood", dark ? -0.06 : -0.08, -0.02);
        } else {
          var bands = dark ? [-0.02, -0.08, -0.04, -0.11, -0.2] : [0.0, -0.1, -0.05, -0.15, -0.3];
          col = palette.token("room-panel", bands[info.band], -0.01);
        }
        out.copy(col);
      },
      tints: [],
    };
    palette.reset();
    return palette;
  }

  /* ------------------------------------------------------------------ batches of small pieces */

  /**
   * Collects many small pieces (tents, flags, trees, mules) into one mesh with a colour per
   * piece, so the whole range draws in a handful of draw calls. Each piece keeps a function that
   * returns its colour, called again on every repaint, so a theme change rebuilds nothing.
   */
  function Batch(name, finish) {
    this.name = name;
    this.finish = finish || "matte";
    this.items = [];
    this.count = 0;
  }
  Batch.prototype.add = function (geometry, colour, matrix) {
    var g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    g.deleteAttribute("uv");
    g.deleteAttribute("normal");
    this.items.push({ geometry: g, colour: colour, start: this.count, size: g.attributes.position.count });
    this.count += g.attributes.position.count;
  };
  Batch.prototype.build = function (palette) {
    var positions = new Float32Array(this.count * 3);
    this.items.forEach(function (item) {
      positions.set(item.geometry.attributes.position.array, item.start * 3);
      item.geometry.dispose();
    });
    var geometry = new THREE_.BufferGeometry();
    geometry.setAttribute("position", new THREE_.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    this.colours = new Float32Array(this.count * 3);
    geometry.setAttribute("color", new THREE_.BufferAttribute(this.colours, 3));
    this.mesh = new THREE_.Mesh(geometry, K.paintVertexColors(this.finish));
    this.mesh.name = this.name;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.repaint(palette);
    return this.mesh;
  };
  Batch.prototype.repaint = function (palette) {
    var colours = this.colours;
    this.items.forEach(function (item) {
      var c = item.colour(palette);
      for (var v = 0; v < item.size; v++) {
        colours[(item.start + v) * 3] = c.r;
        colours[(item.start + v) * 3 + 1] = c.g;
        colours[(item.start + v) * 3 + 2] = c.b;
      }
    });
    this.mesh.geometry.attributes.color.needsUpdate = true;
  };

  /** Returns a matrix that places a piece at an island point, turned `yaw` radians, scaled `s`. */
  function place(x, y, z, yaw, s) {
    var m = new THREE_.Matrix4();
    m.compose(new THREE_.Vector3(x, y, z), new THREE_.Quaternion().setFromAxisAngle(new THREE_.Vector3(0, 1, 0), yaw || 0), new THREE_.Vector3(s || 1, s || 1, s || 1));
    return m;
  }

  /** Builds a geometry from a flat list of triangles, both sides when `twoSided`. */
  function triangles(list, twoSided) {
    var out = list.slice();
    if (twoSided) {
      for (var i = 0; i < list.length; i += 9) {
        out.push(list[i], list[i + 1], list[i + 2], list[i + 6], list[i + 7], list[i + 8], list[i + 3], list[i + 4], list[i + 5]);
      }
    }
    var g = new THREE_.BufferGeometry();
    g.setAttribute("position", new THREE_.Float32BufferAttribute(out, 3));
    return g;
  }

  var shapes = null;
  /** Builds the shared shapes once per mount: a tent, flags, a rock seat, a pine, a mule's parts. */
  function buildShapes() {
    var T = THREE_;
    // A ridge tent, its door facing +z: two sloped panels, a back wall, and a door flap.
    var W2 = 0.27;
    var Hh = 0.4;
    var L2 = 0.3;
    var panels = triangles([
      -W2, 0, -L2, -W2, 0, L2, 0, Hh, L2, -W2, 0, -L2, 0, Hh, L2, 0, Hh, -L2,
      W2, 0, L2, W2, 0, -L2, 0, Hh, -L2, W2, 0, L2, 0, Hh, -L2, 0, Hh, L2,
      W2, 0, -L2, -W2, 0, -L2, 0, Hh, -L2,
    ]);
    var door = triangles([-W2 * 0.92, 0.005, L2 + 0.002, W2 * 0.92, 0.005, L2 + 0.002, 0, Hh * 0.92, L2 + 0.002]);
    var pole = new T.CylinderGeometry(0.014, 0.014, 1, 5);
    pole.translate(0, 0.5, 0);
    var knob = new T.SphereGeometry(0.03, 6, 4);
    var pennant = triangles([0, 0, 0, 0.24, -0.06, 0, 0, -0.13, 0], true);
    var banner = triangles([0, 0, 0, 0.36, -0.015, 0, 0.36, -0.235, 0, 0, 0, 0, 0.36, -0.235, 0, 0, -0.25, 0], true);
    // The summit's flag: a swallowtail, the notch cut into its fly.
    var swallowtail = triangles([
      0, 0, 0, 0.42, -0.01, 0, 0.3, -0.13, 0,
      0, 0, 0, 0.3, -0.13, 0, 0, -0.13, 0,
      0, -0.13, 0, 0.3, -0.13, 0, 0.42, -0.26, 0,
      0, -0.13, 0, 0.42, -0.26, 0, 0, -0.27, 0,
    ], true);
    var seat = new T.DodecahedronGeometry(0.24, 0);
    seat.scale(1.15, 0.9, 1.0);
    seat.translate(0, 0.2, 0);
    var stone = new T.DodecahedronGeometry(0.14, 0);
    stone.scale(1.2, 0.7, 1);
    var trunk = new T.CylinderGeometry(0.05, 0.07, 0.34, 5);
    trunk.translate(0, 0.17, 0);
    var cones = [new T.ConeGeometry(0.42, 0.62, 7), new T.ConeGeometry(0.33, 0.52, 7), new T.ConeGeometry(0.22, 0.44, 7)];
    cones[0].translate(0, 0.56, 0);
    cones[1].translate(0, 0.86, 0);
    cones[2].translate(0, 1.13, 0);
    var boulder = new T.IcosahedronGeometry(0.5, 0);
    var cloud = [];
    [[0, 0.02, 0, 0.34], [0.3, -0.05, 0.06, 0.26], [-0.3, -0.06, -0.02, 0.25], [0.12, 0.2, -0.05, 0.22], [-0.15, 0.16, 0.08, 0.2], [0.52, -0.11, -0.02, 0.17], [-0.5, -0.12, 0.05, 0.16], [0.05, -0.12, 0.14, 0.22]].forEach(function (b) {
      var g = new T.IcosahedronGeometry(b[3], 3);
      g.scale(1, 0.82, 0.9);
      g.translate(b[0], b[1], b[2]);
      cloud.push(g);
    });
    shapes = { panels: panels, door: door, swallowtail: swallowtail, pole: pole, knob: knob, pennant: pennant, banner: banner, seat: seat, stone: stone, trunk: trunk, cones: cones, boulder: boulder, cloud: cloud };
  }

  /* ------------------------------------------------------------------ the module */

  function mount(container, api) {
    THREE_ = window.THREE;
    K = window.OfficeKit;
    var W = (api && api.world) || window.WORLD;
    api = api || {};
    container.classList.add("ov-expedition-office");
    K.setAmbientMotion(!api.reducedMotion);
    buildShapes();

    var yaw = radians(ISLAND_YAW);
    var cosY = Math.cos(yaw);
    var sinY = Math.sin(yaw);
    /** Converts an island point to world space. */
    function toWorld(x, y, z) {
      return new THREE_.Vector3(x * cosY + z * sinY, y, -x * sinY + z * cosY);
    }
    /** Converts a world point to the island's frame. */
    function toIsland(v) {
      return { x: v.x * cosY - v.z * sinY, y: v.y, z: v.x * sinY + v.z * cosY };
    }

    var stage = K.stage.create(container, { view: { target: [0, 2, 0], distance: 60, azimuth: ISLAND_YAW + VIEW_AZIMUTH, elevation: 32 } });
    var palette = makePalette();

    var hud = document.createElement("div");
    hud.className = "exo-hud";
    container.appendChild(hud);
    // A narrow container (a phone, a split window) has no room for the legend beside the card.
    var widthWatch = new ResizeObserver(function () {
      container.classList.toggle("exo-narrow", container.clientWidth < 1000);
      scheduleDeclutter();
    });
    widthWatch.observe(container);

    var built = null; // everything one state drew, so another state can take it away
    var selectedId = null;
    var lod = "";
    var lastPick = { id: null, at: 0 };

    /* ---------------------------------------------------------------- build one state */

    /** Builds one state of the range: the island, its routes, its climbers and their labels. Returns what it built. */
    function build(state) {
      var model = readModel(W, state);
      var routes = [];
      model.massifs.forEach(function (m) {
        m.routes.forEach(function (r) {
          routes.push(r);
        });
      });
      var layout = layoutRange(model);
      layoutPaths(layout);
      palette.tints = layout.massifs.map(function (m) {
        return m.tint;
      });
      var geometries = [];
      var island = new THREE_.Group();
      island.name = "range";
      island.rotation.y = yaw;

      var terrain = buildTerrain(layout, routes);
      terrain.repaint(palette);
      island.add(terrain.mesh);
      geometries.push(terrain.mesh.geometry);
      var heightAt = terrain.heightAt;

      var pieces = new Batch("range-pieces", "matte");
      var cloth = new Batch("range-cloth", "fabric");
      var metal = new Batch("range-metal", "brass");
      var record = {
        model: model,
        layout: layout,
        island: island,
        terrain: terrain,
        batches: [pieces, cloth, metal],
        beans: [],
        beanById: {},
        idByBean: new Map(),
        labels: [],
        tags: {},
        scene: [],
        geometries: geometries,
        animators: [],
        routes: routes,
        lamps: [],
        glows: [],
        selectables: {},
        repaints: [],
      };

      /* ------------------------------------------------ paths */
      layout.paths.forEach(function (path) {
        var pts = path.points;
        var list = [];
        var half = path.width / 2;
        for (var i = 0; i < pts.length - 1; i++) {
          var a = pts[i];
          var b = pts[i + 1];
          var dx = b.x - a.x;
          var dz = b.z - a.z;
          var len = Math.hypot(dx, dz) || 1;
          var nx = (-dz / len) * half;
          var nz = (dx / len) * half;
          var ya = Math.max(heightAt(a.x + nx, a.z + nz), heightAt(a.x - nx, a.z - nz), heightAt(a.x, a.z)) + 0.025;
          var yb = Math.max(heightAt(b.x + nx, b.z + nz), heightAt(b.x - nx, b.z - nz), heightAt(b.x, b.z)) + 0.025;
          list.push(a.x - nx, ya, a.z - nz, a.x + nx, ya, a.z + nz, b.x + nx, yb, b.z + nz);
          list.push(a.x - nx, ya, a.z - nz, b.x + nx, yb, b.z + nz, b.x - nx, yb, b.z - nz);
        }
        // Counter-clockwise from above depends on the normal's side; draw both to be safe.
        pieces.add(triangles(list, true), function (p) {
          return path.road ? p.token("room-inlay", p.dark ? 0.04 : -0.04, -0.012) : p.token("room-inlay", p.dark ? 0.1 : 0.04, -0.015);
        });
      });

      Object.keys(terrain.contours).forEach(function (key) {
        var tint = layout.massifs[key] ? layout.massifs[key].tint : "webshop";
        var ribbon = triangles(terrain.contours[key], true);
        pieces.add(ribbon, function (p) {
          var t = K.readToken("proj-" + tint);
          return K.writeOklch(new THREE_.Color(), p.dark ? { l: t.l + 0.17, c: t.c * 0.9, h: t.h } : { l: t.l - 0.31, c: t.c * 1.3, h: t.h });
        });
        ribbon.dispose();
      });

      /* ------------------------------------------------ trees and boulders */
      var random = makeRandom(model.swarm ? 0x5eed2 : 0x5eed1);
      var trailPts = [];
      routes.forEach(function (r) {
        r.trail.points.forEach(function (p, i) {
          if (i % 3 === 0) trailPts.push(p);
        });
      });
      function clearOf(x, z) {
        var L = layout.lodge;
        if (Math.abs(x - (L.x + 1.4)) < L.width / 2 + 3.6 && Math.abs(z - L.z) < L.depth / 2 + 1.6) return false;
        for (var p = 0; p < layout.paths.length; p++) {
          var pts = layout.paths[p].points;
          for (var q = 0; q < pts.length; q += 2) {
            if (Math.hypot(x - pts[q].x, z - pts[q].z) < layout.paths[p].width / 2 + 0.7) return false;
          }
        }
        for (var t = 0; t < trailPts.length; t++) {
          if (Math.hypot(x - trailPts[t].x, z - trailPts[t].z) < 0.95) return false;
        }
        return true;
      }
      var b = terrain.bounds;
      var planted = 0;
      for (var attempt = 0; attempt < 900 && planted < (model.swarm ? 40 : 52); attempt++) {
        var tx = lerp(b.x0 + 0.5, b.x1 - 0.5, random());
        var tz = lerp(b.z0 + 0.5, b.z1 - 0.5, random());
        var th = heightAt(tx, tz);
        if (th > SUMMIT * 0.3 || th < -0.01) continue;
        var slope = Math.abs(heightAt(tx + 0.3, tz) - heightAt(tx - 0.3, tz)) + Math.abs(heightAt(tx, tz + 0.3) - heightAt(tx, tz - 0.3));
        if (slope > 0.75) continue;
        if (!clearOf(tx, tz)) continue;
        // Trees grow in groves: keep a seed only where the grove noise says so.
        if (fbm(tx * 0.22 + 11, tz * 0.22 - 4) < 0.5) continue;
        var scale = 0.75 + random() * 0.65;
        var turn = random() * Math.PI;
        var shade = random();
        pieces.add(shapes.trunk, function (p) {
          return p.token("room-wood", -0.12);
        }, place(tx, th - 0.03, tz, turn, scale));
        shapes.cones.forEach(function (cone, ci) {
          pieces.add(cone, function (p) {
            return p.token("room-plant", (p.dark ? -0.06 : -0.1) + ci * 0.03 + shade * 0.04, -0.03, 10);
          }, place(tx, th - 0.03, tz, turn, scale));
        });
        planted++;
      }
      for (var stoneCount = 0, tries = 0; tries < 300 && stoneCount < 14; tries++) {
        var sx = lerp(b.x0 + 0.6, b.x1 - 0.6, random());
        var sz = lerp(b.z0 + 0.6, b.z1 - 0.6, random());
        var sh = heightAt(sx, sz);
        if (sh > 1.2 || !clearOf(sx, sz)) continue;
        var ss = 0.35 + random() * 0.5;
        pieces.add(shapes.boulder, function (p) {
          return p.token("room-metal", p.dark ? -0.12 : -0.16, -0.004);
        }, place(sx, sh + 0.05, sz, random() * 3, ss));
        stoneCount++;
      }

      /* ------------------------------------------------ the routes: dots, tents, flags */
      var dots = [];
      routes.forEach(function (route) {
        var trail = route.trail;
        var headS = progressToS(route, route.progress);
        var thenS = route.movedCamps > 0 && route.doneThen > 0 ? progressToS(route, route.doneThen) : -1;
        route.headS = headS;
        for (var s = 0.16; s < trail.length - 0.15; s += 0.2) {
          var p = sampleTrail(trail, s);
          var y = Math.max(heightAt(p.x, p.z), p.y - 0.02) + 0.03;
          var climbed = s <= headS;
          dots.push({ x: p.x, y: y, z: p.z, route: route, climbed: climbed, news: state === "away" && climbed && s > thenS && route.doneThen > 0 && route.movedCamps > 0 });
        }
        trail.corners.forEach(function (c) {
          if (c.camp < 0) return;
          var k = c.camp;
          var camp = route.camps[k];
          var summit = k === route.n - 1;
          var lane = route.lane;
          if (summit) {
            var top = lanePoint(lane, c.delta, 0);
            var ty = heightAt(top.x, top.z);
            var flagYaw = radians(VIEW_AZIMUTH) + 0.25;
            metal.add(shapes.pole, function (p) {
              return p.token("brass", p.dark ? 0 : -0.06);
            }, new THREE_.Matrix4().multiplyMatrices(place(top.x, ty, top.z, flagYaw), new THREE_.Matrix4().makeScale(1.6, 1.45, 1.6)));
            metal.add(shapes.knob, function (p) {
              return p.token("brass");
            }, new THREE_.Matrix4().multiplyMatrices(place(top.x, ty + 1.47, top.z, 0), new THREE_.Matrix4().makeScale(1.5, 1.5, 1.5)));
            cloth.add(shapes.swallowtail, function (p) {
              return route.landed ? p.token("brass", p.dark ? 0.06 : 0.04, 0.03) : p.token("room-paper", p.dark ? -0.08 : -0.03, 0.004);
            }, new THREE_.Matrix4().multiplyMatrices(place(top.x, ty + 1.42, top.z, flagYaw), new THREE_.Matrix4().makeScale(1.6, 1.6, 1.6)));
            route.summitPoint = { x: top.x, y: ty, z: top.z };
            return;
          }
          var side = c.u > 0 ? 1 : -1;
          var at = lanePoint(lane, c.delta, c.u + side * 0.58);
          var y0 = heightAt(at.x, at.z);
          var tentYaw = radians(VIEW_AZIMUTH) + side * 0.35;
          var doneCamp = camp.state === "done";
          var here = !route.landed && k === route.done;
          var added = !!camp.added;
          var tentColour = function (p) {
            if (doneCamp) return p.hue(route.hue, "body", p.dark ? -0.05 : 0);
            if (here) return p.hue(route.hue, "body", p.dark ? 0.05 : 0.04);
            return p.token("room-paper", p.dark ? -0.2 : -0.05, 0.004);
          };
          cloth.add(shapes.panels, tentColour, place(at.x, y0 - 0.01, at.z, tentYaw));
          cloth.add(shapes.door, function (p) {
            if (doneCamp || here) return p.hue(route.hue, "shade", p.dark ? -0.04 : -0.02);
            return p.token("room-paper", p.dark ? -0.28 : -0.13, 0.006);
          }, place(at.x, y0 - 0.01, at.z, tentYaw));
          route.tents = route.tents || [];
          route.tents.push({ camp: k, x: at.x, y: y0, z: at.z, yaw: tentYaw, done: doneCamp, here: here, added: added });
          if (doneCamp) {
            // A pennant planted beside every camp reached.
            var px = at.x + lane.ax * side * 0.36;
            var pz = at.z + lane.az * side * 0.36;
            var py = heightAt(px, pz);
            pieces.add(shapes.pole, function (p) {
              return p.token("room-wood", -0.05);
            }, new THREE_.Matrix4().multiplyMatrices(place(px, py, pz, 0), new THREE_.Matrix4().makeScale(1, 0.62, 1)));
            cloth.add(shapes.pennant, function (p) {
              return p.hue(route.hue, "shade");
            }, place(px, py + 0.6, pz, radians(VIEW_AZIMUTH) + 0.25));
          }
        });
      });
      // The trail's dots, one instanced mesh: the climbed part in the lead's hue, the rest faint.
      // A flat disc lying on the trail: the camera always looks down on it.
      var dotGeometry = new THREE_.CircleGeometry(1, 10);
      dotGeometry.rotateX(-Math.PI / 2);
      record.dotMaterial = new THREE_.MeshStandardMaterial({ roughness: 0.7, metalness: 0 });
      var dotMesh = new THREE_.InstancedMesh(dotGeometry, record.dotMaterial, dots.length);
      dotMesh.name = "range-trail-dots";
      dotMesh.receiveShadow = true;
      var dm = new THREE_.Matrix4();
      var upAxis = new THREE_.Vector3(0, 1, 0);
      dots.forEach(function (d, i) {
        var r = d.news ? 0.078 : d.climbed ? 0.06 : 0.04;
        // Each dot lies on the slope under it, like paint on the rock, so it reads from any angle.
        var e = 0.12;
        var normal = new THREE_.Vector3(heightAt(d.x - e, d.z) - heightAt(d.x + e, d.z), 2 * e, heightAt(d.x, d.z - e) - heightAt(d.x, d.z + e)).normalize();
        var y = Math.max(heightAt(d.x, d.z), d.y - 0.05) + 0.02;
        var at = new THREE_.Vector3(d.x, y, d.z).addScaledVector(normal, 0.02);
        dm.compose(at, new THREE_.Quaternion().setFromUnitVectors(upAxis, normal), new THREE_.Vector3(r, 1, r));
        dotMesh.setMatrixAt(i, dm);
      });
      geometries.push(dotGeometry);
      function repaintDots() {
        dots.forEach(function (d, i) {
          var c = d.news ? palette.hue(d.route.hue, "body", palette.dark ? 0.08 : -0.02) : d.climbed ? palette.hue(d.route.hue, "shade") : palette.token("muted", palette.dark ? -0.16 : 0.2, -0.004);
          dotMesh.setColorAt(i, c);
        });
        if (dotMesh.instanceColor) dotMesh.instanceColor.needsUpdate = true;
      }
      repaintDots();
      record.repaints.push(repaintDots);
      island.add(dotMesh);

      /* ------------------------------------------------ the lodge: base camp */
      buildLodge(record, island, layout, model, heightAt);

      /* ------------------------------------------------ the climbers */
      var cameraYaw = radians(VIEW_AZIMUTH);
      routes.forEach(function (route) {
        var members = route.team;
        route.beans = [];
        var prevS = route.headS;
        var prevAt = null;
        members.forEach(function (t, j) {
          var s = route.headS;
          if (j > 0) {
            // A step down the rope, and further while the trail doubles back so close that two
            // climbers would stand on top of each other.
            s = prevS - ROPE_STEP;
            while (s > 0.3 && prevAt && Math.hypot(sampleTrail(route.trail, s).x - prevAt.x, sampleTrail(route.trail, s).z - prevAt.z) < 0.85) s -= 0.08;
            s = Math.max(0.3, s);
          }
          prevS = s;
          prevAt = sampleTrail(route.trail, s);
          var atSummit = route.landed && j === 0;
          var p = atSummit ? { x: route.summitPoint.x + Math.sin(cameraYaw) * 0.45, z: route.summitPoint.z + Math.cos(cameraYaw) * 0.45, tx: 0, tz: -1 } : sampleTrail(route.trail, s);
          var y = heightAt(p.x, p.z);
          var climbYaw = Math.atan2(p.tx, p.tz);
          var bean = K.colleague({ id: t.title, pose: t.pose === "away" ? "idle" : t.pose, look: readLook(t.title) || undefined });
          bean.position.y = y;
          var w = toWorld(p.x, y, p.z);
          if (t.pose === "idle" || t.pose === "asleep") {
            // Resting on a rock at the camp, looking out over the valley.
            var seatYaw = cameraYaw + (j % 2 ? 0.4 : -0.3);
            pieces.add(shapes.seat, function (pp) {
              return pp.token("room-metal", pp.dark ? -0.14 : -0.2, -0.004);
            }, place(p.x, y - 0.02, p.z, seatYaw));
            var marker = new THREE_.Object3D();
            marker.position.set(p.x, y, p.z);
            marker.rotation.y = seatYaw;
            island.add(marker);
            island.updateMatrixWorld(true);
            bean.sitAt(marker);
          } else if (t.pose === "waiting") {
            bean.standAt(w.x, w.z, yaw + cameraYaw + 0.25);
            // The marigold flag, planted beside the climber who waits on you.
            // On the climber's left as you look at it, a step back, clear of the rope behind it.
            var fx = p.x - Math.cos(cameraYaw) * 0.42 - Math.sin(cameraYaw) * 0.1;
            var fz = p.z + Math.sin(cameraYaw) * 0.42 - Math.cos(cameraYaw) * 0.1;
            var fy = heightAt(fx, fz);
            pieces.add(shapes.pole, function (pp) {
              return pp.token("room-wood", -0.08);
            }, new THREE_.Matrix4().multiplyMatrices(place(fx, fy, fz, 0), new THREE_.Matrix4().makeScale(1, 1.05, 1)));
            cloth.add(shapes.banner, function (pp) {
              return pp.token("you");
            }, place(fx, fy + 1.03, fz, cameraYaw + Math.PI - 0.25));
          } else {
            bean.standAt(w.x, w.z, yaw + climbYaw);
            bean.play(api.reducedMotion ? "stand" : "walk");
          }
          stage.add(bean);
          record.beans.push(bean);
          record.beanById[t.id] = bean;
          record.idByBean.set(bean, t.id);
          record.selectables[t.id] = { bean: bean, route: route, thread: t };
          route.beans.push({ bean: bean, thread: t, x: p.x, y: y, z: p.z });
        });
        // The rope between climbers: a sagging curve from waist to waist.
        for (var j = 1; j < route.beans.length; j++) {
          var a = route.beans[j - 1];
          var c = route.beans[j];
          var from = new THREE_.Vector3(a.x, a.y + 0.42, a.z);
          var to = new THREE_.Vector3(c.x, c.y + 0.42, c.z);
          var midV = from.clone().lerp(to, 0.5);
          midV.y -= 0.18 + from.distanceTo(to) * 0.08;
          var curve = new THREE_.QuadraticBezierCurve3(from, midV, to);
          var tube = new THREE_.TubeGeometry(curve, 16, 0.024, 5, false);
          pieces.add(tube, function (pp) {
            return pp.token("room-panel", pp.dark ? 0.18 : -0.08, 0.02);
          });
          tube.dispose();
        }
        // The grey cloud over a stuck team.
        if (route.stuck) {
          var lead = route.beans[0];
          var cloudGroup = new THREE_.Group();
          var cloudMaterial = new THREE_.MeshStandardMaterial({ roughness: 1, metalness: 0 });
          shapes.cloud.forEach(function (g) {
            cloudGroup.add(new THREE_.Mesh(g, cloudMaterial));
          });
          var cw = toWorld(lerp(lead.x, route.beans[route.beans.length - 1].x, 0.4), lead.y + 1.95, lerp(lead.z, route.beans[route.beans.length - 1].z, 0.4));
          cloudGroup.position.copy(cw);
          cloudGroup.rotation.y = yaw + cameraYaw;
          cloudGroup.scale.setScalar(1.45);
          stage.scene.add(cloudGroup);
          record.scene.push(cloudGroup);
          var paintCloud = function () {
            var metal = K.readToken("room-metal");
            cloudMaterial.color.copy(K.writeOklch(new THREE_.Color(), { l: palette.dark ? metal.l + 0.14 : metal.l - 0.07, c: 0.014, h: 250 }));
          };
          paintCloud();
          record.repaints.push(paintCloud);
          var baseY = cw.y;
          record.animators.push(function (time) {
            cloudGroup.position.y = baseY + Math.sin(time * 0.9) * 0.06;
            cloudGroup.rotation.y = yaw + cameraYaw + Math.sin(time * 0.35) * 0.08;
            return true;
          });
          route.cloud = cloudGroup;
        }
        // The camps a route grew glow, so a summit that moved says so.
        if (route.grew && route.tents) {
          route.tents.forEach(function (tent) {
            if (!tent.added) return;
            var ring = new THREE_.Mesh(new THREE_.RingGeometry(0.42, 0.62, 28), new THREE_.MeshBasicMaterial({ transparent: true, opacity: 0.8, depthWrite: false }));
            ring.rotation.x = -Math.PI / 2;
            var rw = toWorld(tent.x, tent.y + 0.04, tent.z);
            ring.position.copy(rw);
            stage.scene.add(ring);
            record.scene.push(ring);
            geometries.push(ring.geometry);
            var paintRing = function () {
              ring.material.color.copy(palette.hue(route.hue, "body", palette.dark ? 0.08 : -0.02));
            };
            paintRing();
            record.repaints.push(paintRing);
            record.animators.push(function (time) {
              ring.material.opacity = 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(time * 2.4));
              return true;
            });
            record.glows.push(ring);
          });
        }
        // Away: a ghost marker where the route stood at 09:01.
        if (state === "away" && route.movedCamps > 0 && route.doneThen > 0) {
          var gs = progressToS(route, route.doneThen);
          var gp = sampleTrail(route.trail, gs);
          var gy = heightAt(gp.x, gp.z);
          var ghost = new THREE_.Mesh(new THREE_.RingGeometry(0.3, 0.42, 24), new THREE_.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false }));
          ghost.rotation.x = -Math.PI / 2;
          ghost.position.copy(toWorld(gp.x, gy + 0.05, gp.z));
          stage.scene.add(ghost);
          record.scene.push(ghost);
          geometries.push(ghost.geometry);
          var paintGhost = function () {
            ghost.material.color.copy(palette.token("ink", palette.dark ? -0.1 : 0.25));
          };
          paintGhost();
          record.repaints.push(paintGhost);
          var ghostLabel = stage.label(toWorld(gp.x, gy + 0.5, gp.z).toArray(), '<span class="exo-ghost">09:01</span>');
          record.labels.push(ghostLabel);
        }
      });

      /* ------------------------------------------------ lanterns at the camps teams head for */
      routes.forEach(function (route) {
        (route.tents || []).forEach(function (tent) {
          if (!tent.here) return;
          var lantern = new THREE_.Sprite(new THREE_.SpriteMaterial({ map: readGlowTexture(), transparent: true, depthWrite: false, blending: THREE_.AdditiveBlending }));
          lantern.position.copy(toWorld(tent.x, tent.y + 0.22, tent.z));
          lantern.scale.setScalar(0.85);
          lantern.renderOrder = 2;
          stage.scene.add(lantern);
          record.scene.push(lantern);
          record.lanterns = record.lanterns || [];
          record.lanterns.push(lantern);
        });
      });

      /* ------------------------------------------------ the island's shadow on the void below */
      var shade = document.createElement("canvas");
      shade.width = shade.height = 128;
      var sg = shade.getContext("2d");
      var grad = sg.createRadialGradient(64, 64, 8, 64, 64, 64);
      grad.addColorStop(0, "rgba(0,0,0,1)");
      grad.addColorStop(0.55, "rgba(0,0,0,0.55)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      sg.fillStyle = grad;
      sg.fillRect(0, 0, 128, 128);
      var shadeTexture = new THREE_.CanvasTexture(shade);
      var bb = terrain.bounds;
      var floorShadow = new THREE_.Mesh(new THREE_.PlaneGeometry((bb.x1 - bb.x0) * 1.25, (bb.z1 - bb.z0) * 1.45), new THREE_.MeshBasicMaterial({ map: shadeTexture, transparent: true, depthWrite: false }));
      floorShadow.rotation.x = -Math.PI / 2;
      floorShadow.position.copy(toWorld((bb.x0 + bb.x1) / 2 + 0.8, BASE - 2.2, (bb.z0 + bb.z1) / 2 + 1.2));
      floorShadow.rotation.z = yaw;
      floorShadow.renderOrder = -1;
      stage.scene.add(floorShadow);
      record.scene.push(floorShadow);
      geometries.push(floorShadow.geometry);
      record.textures = [shadeTexture];
      var paintShadow = function () {
        floorShadow.material.color.copy(palette.token("ink"));
        floorShadow.material.opacity = palette.dark ? 0.5 : 0.13;
      };
      paintShadow();
      record.repaints.push(paintShadow);

      /* ------------------------------------------------ build the batches */
      [pieces, cloth, metal].forEach(function (batch) {
        if (batch.count === 0) return;
        island.add(batch.build(palette));
        geometries.push(batch.mesh.geometry);
      });

      stage.add(island);
      record.heightAt = heightAt;
      record.toWorld = toWorld;

      /* ------------------------------------------------ headlamps for the evening */
      record.beans.forEach(function (bean) {
        addHeadlamp(record, bean);
      });

      /* ------------------------------------------------ labels */
      buildLabels(record);
      return record;
    }

    /* ---------------------------------------------------------------- base camp */

    /** Builds base camp from the Office kit, seats the assistants and the answered questions, and lines up the caravans. */
    function buildLodge(record, island, layout, model, heightAt) {
      var L = layout.lodge;
      var lodge = new THREE_.Group();
      lodge.name = "base-camp";
      lodge.position.set(L.x, 0, L.z);
      var WT = K.WALL_THICKNESS;
      lodge.add(K.buildRoom({ width: L.width, depth: L.depth, tint: null, door: { wall: "north", at: L.door, width: 1.1 } }));
      var halfW = L.width / 2;
      var halfD = L.depth / 2;

      // Your desk, the user facing the room, and the "Now serving" sign beside it.
      var desk = K.buildYourDesk();
      desk.object.position.set(1.5, 0, -0.95);
      lodge.add(desk.object);
      var sign = K.buildNowServing();
      sign.object.position.set(1.5, 1.66, -halfD + WT / 2 + 0.002);
      sign.setNumber(model.waitingCount);
      lodge.add(sign.object);
      var plaque = K.buildPlaque("Base camp");
      plaque.rotation.y = -Math.PI / 2;
      plaque.position.set(halfW - WT / 2 - 0.002, 1.42, 1.15);
      lodge.add(plaque);
      var clock = K.buildWallClock();
      clock.rotation.y = -Math.PI / 2;
      clock.position.set(halfW - WT / 2 - 0.002, 1.85, -1.0);
      lodge.add(clock);

      // The assistants' corner: Ada writes, Milo sips, Juno dozes.
      var writing = K.buildWritingDesk();
      writing.object.rotation.y = Math.PI;
      writing.object.position.set(-2.45, 0, -1.25);
      lodge.add(writing.object);
      var rug = K.buildRug(2.6, 1.8, { medallion: true });
      rug.position.set(-1.75, 0, 1.15);
      lodge.add(rug);
      var chairA = K.buildArmchair();
      chairA.object.rotation.y = 0.55;
      chairA.object.position.set(-2.55, 0, 0.95);
      lodge.add(chairA.object);
      var chairB = K.buildArmchair();
      chairB.object.rotation.y = -0.2;
      chairB.object.position.set(-1.2, 0, 1.55);
      lodge.add(chairB.object);
      var lamp = K.buildFloorLamp();
      lamp.object.position.set(-3.2, 0, 1.95);
      lodge.add(lamp.object);
      var lampB = K.buildFloorLamp();
      lampB.object.position.set(3.15, 0, -2.05);
      lodge.add(lampB.object);
      var palm = K.buildPlant("tall");
      palm.position.set(2.85, 0, 1.75);
      lodge.add(palm);
      var aspidistra = K.buildPlant("small");
      aspidistra.position.set(-3.15, 0, -2.05);
      lodge.add(aspidistra);
      var coats = K.buildCoatStand();
      coats.position.set(L.door - 1.0, 0, -halfD + 0.35);
      lodge.add(coats);
      var cabinet = K.buildCabinet();
      cabinet.position.set(L.door + 1.15, 0, -halfD + 0.4);
      lodge.add(cabinet);

      // The terrace east of the lodge: questions answered, over a cup.
      var terraceX = halfW + 1.9;
      var tables = [];
      [[terraceX, -1.7], [terraceX + 0.45, -0.25], [terraceX - 0.05, 1.2], [terraceX + 1.35, 1.95]].forEach(function (spot, i) {
        var table = K.buildRoundTable(false);
        table.object.rotation.y = Math.PI + (i - 1) * 0.25;
        table.object.position.set(spot[0], 0, spot[1]);
        lodge.add(table.object);
        tables.push(table);
      });
      var post = K.buildLamppost();
      post.position.set(terraceX + 1.4, 0, -2.4);
      lodge.add(post);
      var postB = K.buildLamppost();
      postB.position.set(-halfW - 1.0, 0, halfD + 1.2);
      lodge.add(postB);
      var board = K.buildChalkboard();
      board.rotation.y = 0.3;
      board.position.set(L.door + 0.95, 0, -halfD - 0.75);
      lodge.add(board);

      island.add(lodge);
      island.updateMatrixWorld(true);
      record.lodge = lodge;

      // The assistants.
      var seats = { Ada: writing, Milo: chairA, Juno: chairB };
      model.assistants.forEach(function (a) {
        var bean = K.colleague({ id: a.name, kind: "assistant", pose: a.pose, look: readLook(a.name) || undefined });
        if (seats[a.name]) bean.sitAt(seats[a.name]);
        stage.add(bean);
        var id = "assistant:" + a.name;
        record.beans.push(bean);
        record.beanById[id] = bean;
        record.beanById[a.name.toLowerCase()] = bean;
        record.idByBean.set(bean, id);
        record.selectables[id] = { bean: bean, assistant: a };
      });
      // The terrace's threads.
      model.terrace.forEach(function (t, i) {
        if (!tables[i]) return;
        var bean = K.colleague({ id: t.title, pose: t.pose === "away" ? "idle" : t.pose, look: readLook(t.title) || undefined });
        bean.sitAt(tables[i], 0);
        stage.add(bean);
        record.beans.push(bean);
        record.beanById[t.id] = bean;
        record.idByBean.set(bean, t.id);
        record.selectables[t.id] = { bean: bean, thread: t, terrace: true };
      });

      // The run caravans on the road: a driver in a clerk's visor leads a pack mule to base camp.
      var road = layout.road;
      var roadLength = 0;
      var acc = [0];
      for (var i = 1; i < road.length; i++) {
        roadLength += Math.hypot(road[i].x - road[i - 1].x, road[i].z - road[i - 1].z);
        acc.push(roadLength);
      }
      function roadAt(s) {
        for (var k = 1; k < road.length; k++) {
          if (acc[k] >= s) {
            var t = (s - acc[k - 1]) / (acc[k] - acc[k - 1] || 1);
            var dx = road[k].x - road[k - 1].x;
            var dz = road[k].z - road[k - 1].z;
            return { x: lerp(road[k - 1].x, road[k].x, t), z: lerp(road[k - 1].z, road[k].z, t), yaw: Math.atan2(dx, dz) };
          }
        }
        return { x: road[road.length - 1].x, z: road[road.length - 1].z, yaw: 0 };
      }
      var pieces = record.batches[0];
      var cloth = record.batches[1];
      model.runs.forEach(function (r, i) {
        var s = roadLength - 1.2 - i * 2.05;
        if (s < 0.8) return;
        var at = roadAt(s);
        var y = heightAt(at.x, at.z);
        var w = toWorld(at.x, y, at.z);
        var waiting = r.session.pose === "waiting";
        var bean = K.colleague({ id: r.run.title, kind: "run", pose: r.session.pose, look: readLook(r.run.title, "run") || undefined });
        bean.position.y = y;
        if (waiting) {
          bean.standAt(w.x, w.z, yaw + radians(VIEW_AZIMUTH) + 0.3);
          var fx = at.x + 0.38;
          var fz = at.z - 0.2;
          var fy = heightAt(fx, fz);
          pieces.add(shapes.pole, function (pp) {
            return pp.token("room-wood", -0.08);
          }, place(fx, fy, fz, 0));
          cloth.add(shapes.banner, function (pp) {
            return pp.token("you");
          }, place(fx, fy + 0.98, fz, radians(VIEW_AZIMUTH) + 0.25));
        } else {
          bean.standAt(w.x, w.z, yaw + at.yaw);
          bean.play(api.reducedMotion ? "stand" : "walk");
        }
        stage.add(bean);
        record.beans.push(bean);
        record.beanById[r.sessionId] = bean;
        record.beanById[r.run.id] = bean;
        record.idByBean.set(bean, r.sessionId);
        record.selectables[r.sessionId] = { bean: bean, run: r };
        // The window may name a run by the run's id or by its step's session: both find it.
        record.selectables[r.run.id] = record.selectables[r.sessionId];
        // The mule, behind its driver.
        var behind = roadAt(s - 0.85);
        addMule(pieces, cloth, behind.x, heightAt(behind.x, behind.z), behind.z, behind.yaw);
      });
    }

    /** Adds a pack mule built from boxes: dun body, dark mane, two crates on its back. */
    function addMule(pieces, cloth, x, y, z, yawM) {
      var T = THREE_;
      function box(w, h, d, px, py, pz, colour, batch) {
        var g = new T.BoxGeometry(w, h, d);
        g.translate(px, py, pz);
        (batch || pieces).add(g, colour, place(x, y, z, yawM));
        g.dispose();
      }
      var dun = function (p) {
        return p.token("room-wood", p.dark ? 0.06 : 0.1, -0.03, 8);
      };
      var darkHair = function (p) {
        return p.token("room-wood", -0.2, -0.02);
      };
      box(0.26, 0.24, 0.56, 0, 0.5, 0, dun);
      [[-0.09, 0.2], [0.09, 0.2], [-0.09, -0.2], [0.09, -0.2]].forEach(function (leg) {
        box(0.065, 0.4, 0.065, leg[0], 0.2, leg[1], darkHair);
      });
      box(0.13, 0.26, 0.13, 0, 0.7, 0.3, dun);
      box(0.12, 0.13, 0.24, 0, 0.82, 0.42, dun);
      box(0.035, 0.12, 0.035, -0.04, 0.92, 0.33, darkHair);
      box(0.035, 0.12, 0.035, 0.04, 0.92, 0.33, darkHair);
      box(0.03, 0.2, 0.03, 0, 0.5, -0.3, darkHair);
      box(0.13, 0.18, 0.3, -0.19, 0.58, -0.02, function (p) {
        return p.token("room-cork", p.dark ? 0.04 : -0.06);
      });
      box(0.13, 0.18, 0.3, 0.19, 0.58, -0.02, function (p) {
        return p.token("room-cork", p.dark ? 0.04 : -0.06);
      });
      box(0.5, 0.04, 0.06, 0, 0.66, -0.02, function (p) {
        return p.token("room-fabric");
      }, cloth);
    }

    /* ---------------------------------------------------------------- headlamps */

    var glowTexture = null;
    /** Returns the soft round glow the headlamps and lanterns share, drawn once. */
    function readGlowTexture() {
      if (glowTexture) return glowTexture;
      var c = document.createElement("canvas");
      c.width = c.height = 64;
      var g = c.getContext("2d");
      var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      glowTexture = new THREE_.CanvasTexture(c);
      glowTexture.colorSpace = THREE_.SRGBColorSpace;
      return glowTexture;
    }

    /** Gives a climber a headlamp on its forehead: a lit bead and a soft glow, shown in the evening. */
    function addHeadlamp(record, bean) {
      var head = null;
      var eyes = [];
      bean.traverse(function (o) {
        if (o.isSkinnedMesh && !head) {
          head = o.skeleton.bones[2];
          eyes = [o.skeleton.bones[15], o.skeleton.bones[16]];
        }
      });
      if (!head) return;
      var front = eyes[0].position.clone().add(eyes[1].position).multiplyScalar(0.5);
      var lampGroup = new THREE_.Group();
      lampGroup.position.set(front.x, front.y + 0.13, front.z + 0.015);
      var bead = new THREE_.Mesh(new THREE_.SphereGeometry(0.03, 8, 6), new THREE_.MeshBasicMaterial());
      var glow = new THREE_.Sprite(new THREE_.SpriteMaterial({ map: readGlowTexture(), transparent: true, depthWrite: false, blending: THREE_.AdditiveBlending }));
      glow.scale.setScalar(0.36);
      glow.position.set(0, 0.02, 0.1);
      lampGroup.add(bead, glow);
      head.add(lampGroup);
      record.geometries.push(bead.geometry);
      record.lamps.push({ group: lampGroup, bead: bead, glow: glow });
    }

    /** Lights the headlamps and the camp lanterns in the evening, and puts them out in the morning. */
    function paintLamps(record) {
      var on = palette.dark;
      var warm = palette.token("room-sun", 0.42, 0.02);
      (record.lanterns || []).forEach(function (lantern) {
        lantern.visible = on;
        lantern.material.color.copy(warm).multiplyScalar(0.55);
      });
      record.lamps.forEach(function (lamp) {
        lamp.group.visible = on;
        lamp.bead.material.color.copy(warm);
        lamp.glow.material.color.copy(warm).multiplyScalar(0.7);
      });
    }

    /* ---------------------------------------------------------------- labels */

    /** Builds every HTML label: a tag per rope team, a label per massif, and the lodge's and road's tags. */
    function buildLabels(record) {
      var model = record.model;
      // A tag over each rope team's lead.
      record.routes.forEach(function (route) {
        var lead = route.beans[0].bean;
        var el = document.createElement("div");
        var waiting = route.waiting[0] || null;
        var cls = "exo-tag";
        if (waiting) cls += " exo-tag--waiting";
        if (route.stuck) cls += " exo-tag--stuck";
        if (route.landed) cls += " exo-tag--landed";
        var news = "";
        if (model.state === "away") news = route.isNew ? "new since 09:01" : route.movedCamps > 0 ? "+" + route.movedCamps + " camp" + (route.movedCamps > 1 ? "s" : "") + " since 09:01" : "";
        if (news) cls += " exo-tag--news";
        el.className = cls;
        el.style.setProperty("--hue", "var(--hue-" + route.hue + ")");
        var crew = route.team
          .slice(1)
          .map(function (t) {
            return '<i class="exo-tag__mate' + (t.pose === "waiting" ? " is-waiting" : "") + '" style="--hue:var(--hue-' + readHue(t.title) + ')"></i>';
          })
          .join("");
        var where;
        if (route.landed) where = "landed " + (route.goal.lastProgress || "");
        else where = "camp " + route.done + " of " + route.n;
        var next = route.landed ? route.goal.summit : route.next ? route.next.label : "";
        if (route.next && route.next.of) next = route.next.of[0] + " of " + route.next.of[1] + " · " + route.next.label;
        var notes = [];
        if (route.stuck) notes.push('<span class="exo-tag__note exo-tag__note--stuck">' + CLOUD_ICON + "no progress in " + route.quiet + "m</span>");
        if (route.grew && (model.state === "grew" || model.state === "everyday" || model.state === "open")) notes.push('<span class="exo-tag__note exo-tag__note--grew">+' + route.grew + " camps</span>");
        if (news) notes.push('<span class="exo-tag__note exo-tag__note--news">' + esc(news) + "</span>");
        var ask = "";
        if (waiting) {
          var who = waiting.id === route.id ? "" : '<span class="exo-tag__who">' + esc(waiting.role || "partner") + "</span>";
          ask = '<span class="exo-tag__ask">' + FLAG_ICON + who + esc(waiting.askShort || waiting.ask) + "</span>";
        }
        el.innerHTML =
          '<span class="exo-tag__head"><i class="exo-tag__dot"></i><b class="exo-tag__name">' + esc(shorten(route.lead.title, 40)) + "</b>" + (crew ? '<span class="exo-tag__crew">' + crew + "</span>" : "") + "</span>" +
          '<span class="exo-tag__where"><b>' + esc(where) + "</b>" + (next ? '<span class="exo-tag__next"> · ' + esc(next) + "</span>" : "") + "</span>" +
          (notes.length ? '<span class="exo-tag__notes">' + notes.join("") + "</span>" : "") +
          ask +
          '<span class="exo-tag__chip">' + (waiting ? FLAG_ICON + esc(waiting.askShort || waiting.ask) : '<i class="exo-tag__dot"></i>' + esc(news || (route.landed ? "landed" : route.done + " of " + route.n))) + "</span>";
        wireLabel(el, route.id);
        var label = stage.label(lead, el, { offset: route.stuck ? 1.75 : 0.08 });
        record.labels.push(label);
        record.tags[route.id] = el;
        route.beans.forEach(function (b) {
          record.tags[b.thread.id] = record.tags[b.thread.id] || el;
        });
      });

      // A label per massif, over its row of summits: its name and what it holds.
      record.layout.massifs.forEach(function (m) {
        var lanes = m.layout.lanes;
        var mid = lanes[Math.floor((lanes.length - 1) / 2)];
        var midB = lanes[Math.ceil((lanes.length - 1) / 2)];
        var top = lanePoint(mid, 1, 0);
        var topB = lanePoint(midB, 1, 0);
        var need = 0;
        m.routes.forEach(function (r) {
          need += r.waiting.length;
        });
        var stuck = m.routes.filter(function (r) {
          return r.stuck;
        }).length;
        var landed = m.routes.filter(function (r) {
          return r.landed;
        }).length;
        var html =
          '<i class="exo-massif__mark"></i><b class="exo-massif__name">' + esc(m.project.name) + "</b>" +
          '<span class="exo-massif__count">' + m.routes.length + " route" + (m.routes.length === 1 ? "" : "s") + "</span>" +
          (need ? '<span class="exo-massif__you">' + need + " need" + (need === 1 ? "s" : "") + " you</span>" : "") +
          (stuck ? '<span class="exo-massif__count">' + stuck + " stuck</span>" : "") +
          (landed ? '<span class="exo-massif__count">' + landed + " landed</span>" : "") +
          (m.more ? '<span class="exo-massif__count">+' + m.more + " more</span>" : "");
        // Over the summits, in the far view only: up close the massif is plain from its tint,
        // and its teams' tags say the rest.
        var el = document.createElement("div");
        el.className = "exo-massif exo-massif--top";
        el.style.setProperty("--proj", "var(--proj-" + m.tint + ")");
        el.innerHTML = html;
        el.addEventListener("click", function (event) {
          event.stopPropagation();
          flyToMassif(m);
        });
        record.labels.push(stage.label(record.toWorld((top.x + topB.x) / 2, SUMMIT + 2.0, (top.z + topB.z) / 2).toArray(), el));
      });

      // Base camp's label, and small tags for the lodge's people and the caravans.
      var L = record.layout.lodge;
      var lodgeEl = document.createElement("div");
      lodgeEl.className = "exo-massif exo-massif--lodge";
      lodgeEl.innerHTML = '<b class="exo-massif__name">Base camp</b><span class="exo-massif__count">' + model.assistants.length + " assistants · " + model.runs.length + " runs</span>";
      lodgeEl.addEventListener("click", function () {
        flyToLodge();
      });
      record.labels.push(stage.label(record.toWorld(L.x, 3.1, L.z).toArray(), lodgeEl));

      var tagged = [];
      Object.keys(record.selectables).forEach(function (id) {
        var it = record.selectables[id];
        if (it.route) return;
        // A run is listed under two ids; it gets one tag, found by either.
        var seen = tagged.indexOf(it);
        if (seen >= 0) {
          record.tags[id] = record.tags[tagged[seen].tagId];
          return;
        }
        it.tagId = id;
        tagged.push(it);
        var name;
        var state;
        var hue;
        var waiting = false;
        if (it.assistant) {
          name = it.assistant.name;
          state = it.assistant.pose === "asleep" ? "asleep" : it.assistant.pose;
          hue = it.bean.look.hue;
        } else if (it.run) {
          name = it.run.run.title;
          waiting = it.run.session.pose === "waiting";
          state = waiting ? it.run.session.ask || it.run.run.waitingAsk : "step " + (it.run.stepIndex + 1) + " of " + it.run.run.steps.length + " · " + it.run.step.label.toLowerCase();
          if (waiting) state = W.waitingRuns[0] && W.waitingRuns[0].ask ? W.waitingRuns[0].ask : state;
          hue = it.bean.look.hue;
        } else {
          name = shorten(it.thread.title, 26);
          state = "answered";
          hue = it.bean.look.hue;
        }
        var tag = K.tag({ name: name, state: state, hue: hue, waiting: waiting });
        tag.classList.add("exo-small");
        if (waiting) tag.classList.add("exo-small--waiting");
        if (it.run) tag.classList.add("exo-small--run");
        wireLabel(tag, id);
        record.labels.push(stage.label(it.bean, tag));
        record.tags[id] = tag;
      });
    }

    /** Makes a tag clickable: a click selects its thread, a second quick click opens it. */
    function wireLabel(el, id) {
      el.style.pointerEvents = "auto";
      el.addEventListener("click", function (event) {
        event.stopPropagation();
        choose(id);
      });
    }

    /* ---------------------------------------------------------------- the HUD */

    /** Draws the HUD once: the legend that says how to read the range, and "Whole range". */
    function drawHud() {
      hud.innerHTML =
        '<div class="exo-legend" aria-label="How to read the range">' +
        '<b class="exo-legend__title">Altitude is progress</b>' +
        '<span class="exo-legend__item">' + CONTOUR_ICON + "a quarter of the way</span>" +
        '<span class="exo-legend__item">' + TENT_ICON + "a camp</span>" +
        '<span class="exo-legend__item">' + FLAG_ICON + "needs you</span>" +
        '<span class="exo-legend__item">' + CLOUD_ICON + "no progress in 30m</span>" +
        '<span class="exo-legend__item">' + SUMMIT_ICON + "landed</span>" +
        "</div>" +
        '<button type="button" class="exo-hud__whole" data-exo-whole>' + RANGE_ICON + "Whole range</button>";
      hud.querySelector("[data-exo-whole]").addEventListener("click", function () {
        select(null);
        if (api.onSelect) api.onSelect(null);
      });
    }

    /* ---------------------------------------------------------------- camera */

    /**
     * Returns the view that fits an island box ({ x0, x1, y0, y1, z0, z1 }) in the canvas, seen
     * from an azimuth relative to the island and an elevation, in degrees. `margin` scales the
     * distance: above 1 leaves air around the box, below 1 crops into it.
     */
    function fitView(box, azimuth, elevation, margin) {
      var cam = stage.camera;
      var az = radians(ISLAND_YAW + azimuth);
      var el = radians(elevation);
      var back = new THREE_.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      var right = new THREE_.Vector3(0, 1, 0).cross(back).normalize();
      var up = back.clone().cross(right).normalize();
      var centre = toWorld((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2);
      var tanY = Math.tan(radians(cam.fov / 2));
      var tanX = tanY * cam.aspect;
      var distance = 0;
      for (var i = 0; i < 8; i++) {
        var corner = toWorld(i & 1 ? box.x1 : box.x0, i & 2 ? box.y1 : box.y0, i & 4 ? box.z1 : box.z0).sub(centre);
        var toward = corner.dot(back);
        distance = Math.max(distance, toward + Math.abs(corner.dot(right)) / tanX, toward + Math.abs(corner.dot(up)) / tanY);
      }
      return { target: centre.toArray(), distance: distance * (margin || 1.04), azimuth: ISLAND_YAW + azimuth, elevation: elevation };
    }

    /** Returns the establishing shot: the whole island, from a little left of straight on. */
    function wholeView() {
      var b = built.terrain.bounds;
      var v = fitView({ x0: b.x0, x1: b.x1, y0: BASE, y1: SUMMIT + 2.4, z0: b.z0, z1: b.z1 }, VIEW_AZIMUTH, 27, 0.97);
      // The far side looks smaller, so the fit leaves air above the range: lower the target a little.
      v.target[1] -= v.distance * 0.045;
      return v;
    }

    /** Returns the view of one massif: its routes from foot to summit. */
    function massifView(m) {
      var lanes = m.layout.lanes;
      var x0 = Infinity;
      var x1 = -Infinity;
      var z0 = Infinity;
      var z1 = -Infinity;
      lanes.forEach(function (lane) {
        [0, 1].forEach(function (d) {
          [-lane.width * 0.6, lane.width * 0.6].forEach(function (u) {
            var p = lanePoint(lane, d, u);
            x0 = Math.min(x0, p.x);
            x1 = Math.max(x1, p.x);
            z0 = Math.min(z0, p.z);
            z1 = Math.max(z1, p.z);
          });
        });
      });
      return fitView({ x0: x0, x1: x1, y0: 0, y1: SUMMIT + 1.2, z0: z0, z1: z1 + 1.0 }, VIEW_AZIMUTH + 4, 28, 0.9);
    }

    /** Returns the view of a climber and its stretch of route, or null for an unknown id. */
    function teamView(id) {
      var it = built.selectables[id];
      if (!it) return null;
      var p = it.bean.getWorldPosition(new THREE_.Vector3());
      var distance = (it.route ? 17 : 11) * clamp(1.3 / stage.camera.aspect, 1, 1.5);
      var az = radians(ISLAND_YAW + VIEW_AZIMUTH + 6);
      var right = new THREE_.Vector3(Math.cos(az), 0, -Math.sin(az));
      // In a wide window the bean sits a little right of centre, so the selection card at the
      // bottom left never covers it. A narrow one has no room for both side by side.
      if (container.clientWidth >= 1000) p.addScaledVector(right, -distance * 0.07);
      p.y += 0.55;
      return { target: p.toArray(), distance: distance, azimuth: ISLAND_YAW + VIEW_AZIMUTH + 6, elevation: it.route ? 26 : 32 };
    }

    /** Returns the view of base camp: the lodge, its terrace and the end of the road. */
    function lodgeView() {
      var L = built.layout.lodge;
      return fitView({ x0: L.x - L.width / 2 - 1.5, x1: L.x + L.width / 2 + 3.4, y0: 0, y1: 2.4, z0: L.z - L.depth / 2 - 1, z1: L.z + L.depth / 2 + 1 }, VIEW_AZIMUTH, 42, 1.0);
    }

    /** Moves the camera to a view: at once when `instant`, else in a short glide. */
    function go(view, instant) {
      if (!view) return;
      if (instant) stage.view(view);
      else stage.flyTo(view.target, view.distance, { azimuth: view.azimuth, elevation: view.elevation, seconds: 0.9 });
    }

    function flyToMassif(m) {
      go(massifView(m));
    }
    function flyToLodge() {
      go(lodgeView());
    }

    /* ---------------------------------------------------------------- selection */

    /** Shows which climber is selected: its ring on the ground and its tag outlined. */
    function highlight(id) {
      Object.keys(built.tags).forEach(function (key) {
        built.tags[key].classList.remove("is-selected");
      });
      built.beans.forEach(function (bean) {
        bean.rig.setSelected(false);
      });
      if (id && built.selectables[id]) {
        built.selectables[id].bean.rig.setSelected(true);
        if (built.tags[id]) built.tags[id].classList.add("is-selected");
      }
      container.classList.toggle("exo-has-selection", !!(id && built.selectables[id]));
    }

    /** Selects a thread by id and glides to it; null (or an id not on the range) shows the whole range. */
    function select(id, instant) {
      var known = id && built.selectables[id];
      selectedId = known ? id : null;
      highlight(selectedId);
      if (selectedId) go(teamView(selectedId), instant);
      else go(wholeView(), instant);
    }

    /** A click or tap on a climber or its tag: select it, or open it on a second click. */
    function choose(id) {
      var now = performance.now();
      if (lastPick.id === id && now - lastPick.at < 450) {
        lastPick = { id: null, at: 0 };
        if (api.onOpen) api.onOpen(id);
        return;
      }
      lastPick = { id: id, at: now };
      if (selectedId !== id) {
        select(id);
        if (api.onSelect) api.onSelect(id);
      }
    }

    /* ---------------------------------------------------------------- frames */

    var declutterTimer = 0;
    var cameraSeen = new Float64Array(32);
    var lateDeclutterTimer = 0;
    function scheduleDeclutter() {
      clearTimeout(declutterTimer);
      clearTimeout(lateDeclutterTimer);
      declutterTimer = setTimeout(declutter, 160);
      // Once more a little later: the window may still be fading or scaling the mode in, which
      // moves the tags on screen without moving the camera.
      lateDeclutterTimer = setTimeout(declutter, 900);
    }
    /**
     * Lifts the tags that would cover one another, lowest on screen first, so every tag in view
     * can be read. A lifted tag keeps a thin leader line to its climber. Runs once the camera
     * rests, never per frame: it reads the tags' sizes, which costs a layout.
     */
    function declutter() {
      if (!built) return;
      var items = [];
      Object.keys(built.tags).forEach(function (key) {
        var el = built.tags[key];
        if (items.some(function (it) {
          return it.el === el;
        })) return;
        el.style.setProperty("--exo-lift", "0px");
        el.style.setProperty("--exo-dx", "0px");
        el.classList.remove("is-pip", "is-lifted", "is-offstage");
      });
      Object.keys(built.tags).forEach(function (key) {
        var el = built.tags[key];
        if (items.some(function (it) {
          return it.el === el;
        })) return;
        var label = el.closest(".office-kit-label") || el;
        if (!label.classList.contains("is-shown") || getComputedStyle(el).opacity === "0") return;
        var r = el.getBoundingClientRect();
        if (r.width === 0) return;
        items.push({ el: el, left: r.left - 3, right: r.right + 3, top: r.top - 3, bottom: r.bottom + 3 });
      });
      items.sort(function (a, b) {
        return b.bottom - a.bottom;
      });
      var bounds = container.getBoundingClientRect();
      // The massif labels stay where they are; the tags make room around them.
      var placed = [];
      var massifs = [];
      container.querySelectorAll(".exo-massif").forEach(function (el) {
        el.style.setProperty("--exo-dx", "0px");
        if (getComputedStyle(el).opacity === "0") return;
        var r = el.getBoundingClientRect();
        if (r.width === 0) return;
        // A massif label stays whole inside the canvas too.
        var dx = r.left < bounds.left + 8 ? bounds.left + 8 - r.left : r.right > bounds.right - 8 ? bounds.right - 8 - r.right : 0;
        el.style.setProperty("--exo-dx", Math.round(dx) + "px");
        var box = { left: r.left + dx - 3, right: r.right + dx + 3, top: r.top - 3, bottom: r.bottom + 3 };
        placed.push(box);
        massifs.push(box);
      });
      var MAX_LIFT = lod === "far" ? 64 : 180;
      items.forEach(function (it) {
        var lift = 0;
        var free = false;
        for (var guard = 0; guard < 12; guard++) {
          var hit = null;
          for (var i = 0; i < placed.length; i++) {
            var p = placed[i];
            if (it.left < p.right && it.right > p.left && it.top - lift < p.bottom && it.bottom - lift > p.top) {
              hit = p;
              break;
            }
          }
          if (!hit) {
            free = true;
            break;
          }
          lift = it.bottom - hit.top;
          if (lift > MAX_LIFT) break;
        }
        // No room within reach: a crowded far chip folds to a marigold pip over its climber.
        var pip = !free && lod === "far";
        it.el.classList.toggle("is-pip", pip);
        if (pip || !free) lift = 0;
        if (pip) {
          // A pip never hides under a massif's label: it steps down below it, toward its climber.
          massifs.forEach(function (m) {
            if (it.left < m.right && it.right > m.left && it.top < m.bottom && it.bottom > m.top) lift = Math.min(lift, it.top - m.bottom - 2);
          });
        }
        it.el.style.setProperty("--exo-lift", Math.round(lift) + "px");
        it.el.classList.toggle("is-lifted", lift > 0);
        // Keep every tag inside the canvas, as the app's overlay does: slide it in from a side
        // edge; one that would leave the top is hidden rather than cut in half.
        var dx = 0;
        if (it.left < bounds.left + 8) dx = bounds.left + 8 - it.left;
        else if (it.right > bounds.right - 8) dx = bounds.right - 8 - it.right;
        it.el.style.setProperty("--exo-dx", Math.round(dx) + "px");
        var offstage = it.top - lift < bounds.top + 4;
        it.el.classList.toggle("is-offstage", offstage);
        if (!pip && !offstage) placed.push({ left: it.left + dx, right: it.right + dx, top: it.top - lift, bottom: it.bottom - lift });
      });
    }

    var reduced = !!api.reducedMotion;
    stage.onFrame(function (frame) {
      if (!built) return false;
      // The tags move when the camera moves or the canvas changes shape: watch both matrices.
      var m = stage.camera.matrixWorld.elements;
      var pm = stage.camera.projectionMatrix.elements;
      var moved = false;
      for (var e = 0; e < 16; e++) {
        if (cameraSeen[e] !== m[e] || cameraSeen[16 + e] !== pm[e]) {
          cameraSeen[e] = m[e];
          cameraSeen[16 + e] = pm[e];
          moved = true;
        }
      }
      if (moved) scheduleDeclutter();
      var d = stage.camera.position.distanceTo(stage.controls.target);
      var next = d > LOD_FAR ? "far" : d > LOD_NEAR ? "mid" : "near";
      if (next !== lod) {
        container.classList.remove("exo-lod-" + lod);
        container.classList.add("exo-lod-" + next);
        lod = next;
        scheduleDeclutter();
      }
      if (reduced) return false;
      var moving = false;
      for (var i = 0; i < built.animators.length; i++) moving = built.animators[i](frame.time) || moving;
      return moving;
    });

    /** Repaints everything the range colours itself after the theme changed. */
    function repaintAll() {
      if (!built) return;
      palette.reset();
      built.terrain.repaint(palette);
      built.batches.forEach(function (batch) {
        if (batch.mesh) batch.repaint(palette);
      });
      built.repaints.forEach(function (fn) {
        fn();
      });
      paintLamps(built);
      stage.requestRender();
    }
    var unsubscribe = K.subscribePalette(repaintAll);

    /* ---------------------------------------------------------------- picking */

    var stopPick = null;
    function onPick(object, hit) {
      if (!built) return;
      // Walk up from the mesh that was hit to a climber, or read where on the range it landed.
      for (var node = hit.object; node; node = node.parent) {
        if (built.idByBean.has(node)) {
          choose(built.idByBean.get(node));
          return;
        }
      }
      var p = toIsland(hit.point);
      if (hit.object === built.terrain.mesh && p.y > 0.6) {
        var best = null;
        var bestD = Infinity;
        built.layout.massifs.forEach(function (m) {
          m.layout.lanes.forEach(function (lane) {
            var foot = lanePoint(lane, 0.5, 0);
            var dd = Math.hypot(p.x - foot.x, p.z - foot.z);
            if (dd < bestD) {
              bestD = dd;
              best = m;
            }
          });
        });
        if (best) flyToMassif(best);
        return;
      }
      for (var n2 = hit.object; n2; n2 = n2.parent) {
        if (n2.name === "base-camp") {
          flyToLodge();
          return;
        }
      }
    }

    /* ---------------------------------------------------------------- states */

    /** Takes away everything one state drew: climbers, labels, the island, and their GPU memory. */
    function clear() {
      if (!built) return;
      built.labels.forEach(function (l) {
        l.remove();
      });
      built.beans.forEach(function (bean) {
        stage.remove(bean);
        bean.rig.dispose();
      });
      built.scene.forEach(function (o) {
        stage.scene.remove(o);
        o.traverse(function (child) {
          if (child.material) child.material.dispose();
        });
      });
      if (built.dotMaterial) built.dotMaterial.dispose();
      (built.textures || []).forEach(function (t) {
        t.dispose();
      });
      stage.remove(built.island);
      built.geometries.forEach(function (g) {
        g.dispose();
      });
      built.lamps.forEach(function (l) {
        l.bead.material.dispose();
        l.glow.material.dispose();
      });
      built = null;
    }

    var STATE_FOCUS = { open: "t3ds", stuck: "tDash", grew: "tResult", move: "tCart" };

    /** Draws a state, then frames its signature moment (or `preselect`, when the window names one). */
    function show(state, instant, preselect) {
      clear();
      built = build(state);
      paintLamps(built);
      if (stopPick) stopPick();
      stopPick = stage.onPick(built.beans.concat([built.terrain.mesh, built.lodge]), onPick);
      container.dataset.exoState = state;
      var id = preselect !== undefined ? preselect : STATE_FOCUS[state] || null;
      select(id, instant);
      stage.requestRender();
    }

    drawHud();
    show(api.state || "everyday", true, api.selected != null ? api.selected : undefined);

    return {
      select: function (id) {
        if (!built) return;
        if ((id || null) === selectedId) return;
        select(id || null);
      },
      setState: function (state) {
        show(state || "everyday", false, selectedId && state === built.model.state ? selectedId : undefined);
      },
      resize: function () {
        stage.requestRender();
        scheduleDeclutter();
      },
      pause: function () {
        stage.pause();
      },
      resume: function () {
        stage.resume();
      },
      dispose: function () {
        clear();
        unsubscribe();
        widthWatch.disconnect();
        clearTimeout(declutterTimer);
        clearTimeout(lateDeclutterTimer);
        if (stopPick) stopPick();
        hud.remove();
        if (glowTexture) glowTexture.dispose();
        glowTexture = null;
        stage.dispose();
        container.classList.remove("ov-expedition-office", "exo-lod-far", "exo-lod-mid", "exo-lod-near", "exo-has-selection", "exo-narrow");
      },
      // For scripted checks and the browser console.
      debug: function () {
        return { stage: stage, built: built, declutter: declutter, lod: lod };
      },
    };
  }

  /* ------------------------------------------------------------------ icons for the HTML labels */

  var FLAG_ICON = '<svg class="exo-i exo-i--flag" viewBox="0 0 10 12" width="10" height="12" aria-hidden="true"><path d="M1.6 1v10.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path class="exo-i__fill" d="M2.2 1.3h6.2v4.4H2.2z"/></svg>';
  var CLOUD_ICON = '<svg class="exo-i exo-i--cloud" viewBox="0 0 14 9" width="14" height="9" aria-hidden="true"><path class="exo-i__fill" d="M3.9 8.3h6.6a2.5 2.5 0 0 0 .3-5A3.3 3.3 0 0 0 4.5 2.6 2.9 2.9 0 0 0 3.9 8.3z"/></svg>';
  var TENT_ICON = '<svg class="exo-i exo-i--tent" viewBox="0 0 14 11" width="14" height="11" aria-hidden="true"><path class="exo-i__fill" d="M7 1.2 13 10H1z"/><path d="M7 4.4 9.1 10H4.9z" fill="var(--raised)"/><path d="M6.4.4 7.6 2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';
  var CONTOUR_ICON = '<svg class="exo-i exo-i--contour" viewBox="0 0 16 11" width="16" height="11" aria-hidden="true"><path d="M1 10.2 8 1l7 9.2z" fill="var(--sunken)"/><path d="M3.4 7.1c1.6.5 3.1-.4 4.6 0s3 .5 4.6 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  var SUMMIT_ICON = '<svg class="exo-i exo-i--summit" viewBox="0 0 14 12" width="14" height="12" aria-hidden="true"><path d="M1 11.4 7 3.6l6 7.8z" fill="var(--faint)"/><path d="M7 4V.6" stroke="currentColor" stroke-width="1.1"/><path class="exo-i__fill" d="M7.4.7h3.6v2.4H7.4z"/></svg>';
  var RANGE_ICON = '<svg class="exo-i" viewBox="0 0 16 12" width="16" height="12" aria-hidden="true"><path d="M.8 11.2 5.2 3.6l2.6 4.2 2.4-3.6 5 7z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  window.OfficeModes = window.OfficeModes || {};
  window.OfficeModes.expedition = { mount: mount };
})();
