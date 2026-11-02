// PROTOTYPE - The Firm's Office: the Dollhouse.
//
// The Bureau as a tall Art Deco building cut open at the front, like a doll's house, on its own
// little plinth of street. Every team (a lead and everyone it started) gets its own room, sized by
// its headcount, on its project's floor. Your office is the penthouse; a brass lift carries the
// sessions that wait on you up to it. The assistants have the mezzanine, the runs work a line of
// benches on the ground floor, and threads with no project sit in the café in the basement.
//
// One global, as ../BUILDERS.md asks: window.OfficeModes["the-firm"].mount(container, api).
// It draws with the app's own Office kit (../vendor/office-kit.js): the stage, its light, the
// beans, the props. Everything the kit has no piece for (the shell of the building, the lift,
// the run benches, the whiteboards) is built here from the kit's palette, so it repaints with the
// theme like the rest.
//
// Units are metres. The building is laid out in its own frame: x runs left to right along the
// front, y is up, and the front cut is the plane z = 0, with the rooms behind it (z < 0). The whole
// building is then turned to face the morning sun, so the open front is lit; the camera always
// looks at it from the front.
(function () {
  "use strict";

  /* ------------------------------------------------------------------ dimensions */

  var DEPTH = 2.9; // a room, from the front cut to the face of its back wall
  var CLEAR = 2.6; // floor to ceiling
  var PITCH = 3.1; // floor to floor
  var SLAB = PITCH - CLEAR;
  var WALL = 0.12;
  var PIER = 0.36; // the building's outer walls, cut
  var LIFT_W = 1.9; // the lift shaft, wall to wall
  var SHAFT_WALL = 0.12;
  var DESK_PITCH = 1.3; // a desk and its gap
  var DOOR_X = 0.62; // a room's back door, from the room's left wall
  var LANDING_MIN = 2.1; // the lift landing at the right end of every floor
  var ROOF = 0.55; // the roof slab
  var BASE = 0.55; // the plinth under the basement
  var STREET = 5.2; // how far the plinth reaches past the building on each side

  // The building faces this way in the world. The kit's morning sun comes from azimuth 120 in the
  // camera's terms, so the open front takes the sun a little from the right.
  var FACING_DEG = 108;
  var FACING = (FACING_DEG * Math.PI) / 180;
  var ELEVATION = 10; // the establishing shot: frontal, slightly from above
  var LOOK_RANGE = 34; // how far the camera may swing to either side of the front

  var STATES = ["everyday", "open", "swarm", "away", "spawn", "exchange", "standup"];

  // Short names for plaques and tags. The app would write them with the title (a Text Generation
  // already titles a thread); see office-notes.md.
  var SHORT = {
    t3ds: "3-D Secure", tStripe: "Stripe v14", t3dsReview: "3-D Secure review", tCart: "Cart totals",
    tCartTests: "Cart property tests", tCss: "Checkout CSS", tA11y: "Screen readers",
    tPayout: "Payout report", tPayoutCheck: "Payout check", tResult: "Result types",
    tResultReview: "Result review", tIdeal: "iDEAL research", tDash: "Ops dashboards",
    tDashAlerts: "Alert check", tSecrets: "Staging secrets", tSecretsVerify: "Verify secrets",
    tBun: "Bun 1.4", aRust: "Rust newsletter", aTables: "ops-db tables",
    sImg: "Product images", sImgLcp: "LCP", sApple: "Apple Pay", sAppleReview: "Domain review",
    sAppleE2e: "Apple Pay tests", sCoupon: "Coupon stacking", sDe: "German checkout",
    sDeTone: "Tone check", sSig: "Signing secret", sSigReview: "Rotation review",
    sRefunds: "August refunds", sRate: "Payout rate limit", sRateLoad: "Load test",
    sPg: "Postgres 18", sPgRollback: "Rollback plan", sPgExt: "Extensions", sBackups: "Backup bucket",
    sDisk: "Disk alerts", sTalk: "Agent swarms talk", xLead: "Result error shape",
    runShip: "Ship v2.15", runWebhook: "Webhook backoff", runRounding: "Cart rounding",
    runBackup: "Backup timeouts", runLabel: "Label issues", runJonas: "Reply to Jonas",
  };

  /* ------------------------------------------------------------------ small helpers */

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /** Returns the short name of a session or run: the hand-kept one, or its title cut at a word. */
  function readShort(id, title) {
    if (SHORT[id]) return SHORT[id];
    var words = String(title || id).split(" ");
    return words.slice(0, 3).join(" ");
  }

  /** Returns `value` clamped to [lo, hi]. */
  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  /** Returns a smooth ease from 0 to 1. */
  function ease(t) {
    var x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  /* ------------------------------------------------------------------ the plan: who goes where */

  /**
   * Builds the plan of the building for a state: its storeys from the basement up, the teams on
   * each, the runs, the assistants and the queue at your desk. Reads only the world.
   */
  function buildPlan(W, state) {
    var H = W.helpers;
    var swarm = state === "swarm";
    var spawn = state === "spawn";
    var threads = H.allLive({ swarm: swarm, spawn: spawn });
    if (swarm) threads = threads.concat(W.stress.threads);
    var byId = {};
    threads.forEach(function (t) {
      byId[t.id] = t;
    });

    // A team is a lead and everyone it started (or Rogier added to it), wherever they work.
    var teams = [];
    var teamOf = {};
    threads.forEach(function (t) {
      if (t.lead && byId[t.lead]) return;
      var team = { id: t.id, lead: t, members: [t], project: t.project };
      teams.push(team);
      teamOf[t.id] = team;
    });
    threads.forEach(function (t) {
      if (t.lead && byId[t.lead]) teamOf[t.lead].members.push(t);
    });
    teams.forEach(function (team) {
      team.status = decideStatus(team.members);
      team.size = team.members.length;
    });

    // Everything waiting on you rides the lift to your desk, oldest first.
    var queue = threads
      .filter(function (t) {
        return t.pose === "waiting";
      })
      .map(function (t) {
        return { id: t.id, kind: "thread", record: t, since: t.last };
      });
    Object.keys(W.runSessions).forEach(function (id) {
      var s = W.runSessions[id];
      if (s.pose === "waiting") queue.push({ id: id, kind: "run", record: s, since: s.last });
    });
    queue.sort(function (a, b) {
      return H.minutes(a.since) - H.minutes(b.since);
    });

    var projects = W.projects.map(function (p) {
      return {
        project: p,
        teams: teams.filter(function (team) {
          return team.project === p.id;
        }),
        more: swarm && W.swarm.more ? W.swarm.more[p.id] || 0 : 0,
      };
    });
    var cafe = teams.filter(function (team) {
      return !team.project;
    });
    var runs = W.runs.filter(function (run) {
      return run.status !== "completed";
    });
    return {
      state: state,
      swarm: swarm,
      threads: threads,
      byId: byId,
      teams: teams,
      teamOf: teamOf,
      queue: queue,
      projects: projects,
      cafe: cafe,
      runs: runs,
      assistants: W.assistants,
    };
  }

  /** Returns a team's status as its door light shows it: waiting if anyone waits on you, then working, then quiet. */
  function decideStatus(members) {
    if (members.some(function (m) { return m.pose === "waiting"; })) return "waiting";
    if (members.some(function (m) { return m.pose === "working"; })) return "working";
    return "quiet";
  }

  /** Returns the width of a team's room: a desk per member, plus room for the door and the walls. */
  function measureRoom(size, swarm) {
    var pitch = size > 6 ? 1.24 : DESK_PITCH;
    return size * pitch + (swarm ? 1.05 : 2.3);
  }

  /** Splits rooms into rows no wider than `limit`, keeping their order and evening out the rows. */
  function packRows(rooms, limit) {
    var total = rooms.reduce(function (sum, r) {
      return sum + r.width;
    }, 0);
    var count = Math.max(1, Math.ceil(total / limit));
    var rows = [];
    var row = [];
    var width = 0;
    var target = total / count;
    rooms.forEach(function (room, index) {
      var left = rooms.length - index;
      var rowsLeft = count - rows.length;
      if (row.length > 0 && rowsLeft > 1 && (width + room.width > limit || width + room.width / 2 > target) && left >= rowsLeft - 1) {
        rows.push(row);
        row = [];
        width = 0;
      }
      row.push(room);
      width += room.width;
    });
    if (row.length) rows.push(row);
    return rows;
  }

  /**
   * Lays the plan out as storeys, bottom to top: the café, the runs, the mezzanine, one or more
   * storeys per project, the penthouse. Each storey gets its y, its kind and its rooms with their
   * x and width, and the tower's inner width is the widest storey's.
   */
  function layOut(plan) {
    var swarm = plan.swarm;
    var storeys = [];
    function storey(kind, extra) {
      var s = { kind: kind, rooms: [], content: 0 };
      for (var k in extra) s[k] = extra[k];
      storeys.push(s);
      return s;
    }

    storey("cafe", { content: 8.2, name: "Café des Égarés", number: "B" });
    var steps = plan.runs.reduce(function (sum, run) {
      return sum + run.steps.length;
    }, 0);
    var runs = storey("runs", { content: steps * STATION_MIN + plan.runs.length * (BENCH_ENDS + BENCH_GAP), name: "Runs", number: "G" });
    storey("secretariat", { content: 9.2, name: "Secretariat", number: "M" });

    // A project wraps onto a second storey only when its rooms would make the building too wide
    // to read: in the swarm, not on an ordinary morning.
    var limit = swarm ? 18 : 24;
    var floorNumber = 0;
    plan.projects.forEach(function (entry) {
      var rooms = entry.teams.map(function (team) {
        var room = { team: team, width: measureRoom(team.size, swarm) };
        // The spawn state's partner joins during the moment: the room is drawn a desk smaller and grows.
        if (plan.state === "spawn" && team.id === W_SPAWN_LEAD) room.grows = room.width - measureRoom(team.size - 1, swarm);
        return room;
      });
      var rows = packRows(rooms, limit);
      rows.forEach(function (row, index) {
        floorNumber++;
        storey("project", {
          project: entry.project,
          tint: entry.project.tint,
          rooms: row,
          content: row.reduce(function (sum, r) {
            return sum + r.width;
          }, 0),
          name: entry.project.name,
          number: String(floorNumber),
          part: rows.length > 1 ? index + 1 + " of " + rows.length : null,
          teams: entry.teams,
          more: index === rows.length - 1 ? entry.more : 0,
        });
      });
    });
    storey("penthouse", { content: 11.2 + Math.max(0, plan.queue.length - 4) * 0.82, name: "Your office", number: "P" });

    var inner = 0;
    storeys.forEach(function (s) {
      inner = Math.max(inner, s.content + LANDING_MIN);
    });
    inner = Math.ceil(inner * 10) / 10;
    var y = -PITCH;
    storeys.forEach(function (s) {
      s.y = y;
      y += PITCH;
      // A quieter floor gives its teams roomier offices, up to half as wide again, so no floor
      // is a row of empty landing. The order of size within a floor still follows the headcount.
      if (s.kind === "project") {
        var f = Math.min(1.45, (inner - LANDING_MIN) / s.content);
        s.rooms.forEach(function (room) {
          room.width *= f;
          if (room.grows) room.grows *= f;
        });
        s.content *= f;
      }
      if (s.kind === "runs") {
        s.stationPitch = Math.min(0.92, (inner - LANDING_MIN - plan.runs.length * (BENCH_ENDS + BENCH_GAP)) / steps);
        s.content = steps * s.stationPitch + plan.runs.length * (BENCH_ENDS + BENCH_GAP);
      }
      if (s.kind === "cafe" || s.kind === "secretariat" || s.kind === "penthouse") s.content = inner - LANDING_MIN;
      s.landing = inner - s.content;
      var x = 0;
      s.rooms.forEach(function (room) {
        room.x0 = x;
        x += room.width;
      });
    });
    return { storeys: storeys, inner: inner, top: y - PITCH + CLEAR + ROOF };
  }

  var STATION_MIN = 0.62;
  var BENCH_ENDS = 0.3;
  var BENCH_GAP = 0.36;
  var W_SPAWN_LEAD = "tSecrets";

  /** Returns the width of a run's bench: a station per step at `pitch`. */
  function measureBench(steps, pitch) {
    return steps * pitch + BENCH_ENDS;
  }

  /* ------------------------------------------------------------------ the module */

  window.OfficeModes = window.OfficeModes || {};
  window.OfficeModes["the-firm"] = { mount: mount };

  /**
   * Draws the Dollhouse into `container` and returns its handle (see ../BUILDERS.md). The state,
   * selection and callbacks come from `api`.
   */
  function mount(container, api) {
    var K = window.OfficeKit;
    var T = window.THREE;
    if (!K || !T) throw new Error("the-firm-office.js: load ../vendor/office-kit.js first");
    var W = api.world || window.WORLD;
    if (!W || !W.helpers) throw new Error("the-firm-office.js: load world.js and world-plus.js first");
    var H = W.helpers;
    var FIRM = window.FIRM || null;
    var reduced = !!api.reducedMotion;
    K.setAmbientMotion(!reduced);

    container.classList.add("ov-the-firm-office");
    container.innerHTML = "";
    container.tabIndex = 0;
    var host = document.createElement("div");
    host.className = "tfo-stage";
    container.appendChild(host);
    var hud = document.createElement("div");
    hud.className = "tfo-hud";
    container.appendChild(hud);

    var stage = K.stage.create(host, {
      camera: "iso",
      view: { target: [0, 8, 0], distance: 200, azimuth: FACING_DEG, elevation: ELEVATION },
    });
    var camera = stage.camera;
    var controls = stage.controls;
    camera.far = 900;
    camera.updateProjectionMatrix();
    controls.screenSpacePanning = true; // a vertical drag rides up and down the building
    controls.minPolarAngle = ((90 - 38) * Math.PI) / 180;
    controls.maxPolarAngle = ((90 - 4) * Math.PI) / 180;
    controls.minAzimuthAngle = ((FACING_DEG - LOOK_RANGE) * Math.PI) / 180;
    controls.maxAzimuthAngle = ((FACING_DEG + LOOK_RANGE) * Math.PI) / 180;
    controls.maxDistance = 520;
    var anisotropy = Math.min(8, stage.renderer.capabilities.getMaxAnisotropy());

    // Everything this mount draws for one state; rebuilt by setState.
    var scene = null;
    var selectedId = null;
    var overview = null;
    var disposed = false;
    var canvases = []; // { redraw } for every canvas texture, redrawn on theme and font changes

    /* -------------------------------------------------------------- materials */

    /** Returns the kit's shared material for a token, finish and shift. */
    function paint(token, finish, shift) {
      return K.paint(token, finish || "satin", shift || {});
    }

    var geometryCache = {};
    /** Returns a box geometry, shared by size. */
    function boxGeometry(w, h, d) {
      var key = w.toFixed(3) + "|" + h.toFixed(3) + "|" + d.toFixed(3);
      if (!geometryCache[key]) geometryCache[key] = new T.BoxGeometry(w, h, d);
      return geometryCache[key];
    }

    /**
     * Adds a box to `parent`, from x0 to x1, y0 to y1, z0 to z1 in the parent's frame. Returns
     * the mesh. Boxes cast and take the sun's shadow unless `opts` says otherwise.
     */
    function box(parent, x0, x1, y0, y1, z0, z1, material, opts) {
      var mesh = new T.Mesh(boxGeometry(x1 - x0, y1 - y0, z1 - z0), material);
      mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      mesh.castShadow = !(opts && opts.cast === false);
      mesh.receiveShadow = !(opts && opts.receive === false);
      mesh.userData.mergeable = true;
      parent.add(mesh);
      return mesh;
    }

    function cylinder(parent, radius, height, x, y, z, material, segments) {
      var mesh = new T.Mesh(new T.CylinderGeometry(radius, radius, height, segments || 14), material);
      mesh.position.set(x, y + height / 2, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.mergeable = true;
      parent.add(mesh);
      return mesh;
    }

    /**
     * Merges the plain boxes and cylinders this file built, per parent and per material, into
     * one mesh each: the building has hundreds of them, and every mesh is a draw call. Kit props
     * and anything that moves on its own are left alone; a group that moves (a room in the spawn
     * state, the lift's cabin) moves with its merged parts.
     */
    function mergeStatic(rootObject) {
      var batches = [];
      rootObject.traverse(function (parent) {
        var buckets = {};
        parent.children.forEach(function (child) {
          if (!child.isMesh || !child.userData.mergeable || child.children.length) return;
          var key = child.material.uuid + "|" + child.castShadow + "|" + child.receiveShadow;
          (buckets[key] = buckets[key] || []).push(child);
        });
        Object.keys(buckets).forEach(function (key) {
          if (buckets[key].length > 1) batches.push({ parent: parent, meshes: buckets[key] });
        });
      });
      batches.forEach(function (batch) {
        var parts = batch.meshes.map(function (m) {
          m.updateMatrix();
          return m.geometry.clone().applyMatrix4(m.matrix);
        });
        var mesh = new T.Mesh(joinGeometries(parts), batch.meshes[0].material);
        parts.forEach(function (g) {
          g.dispose();
        });
        mesh.castShadow = batch.meshes[0].castShadow;
        mesh.receiveShadow = batch.meshes[0].receiveShadow;
        batch.meshes.forEach(function (m) {
          batch.parent.remove(m);
        });
        batch.parent.add(mesh);
      });
    }

    /** Returns one indexed geometry holding every geometry of `list` (each with a position, normal and uv). */
    function joinGeometries(list) {
      var vertices = 0;
      var indices = 0;
      list.forEach(function (g) {
        vertices += g.attributes.position.count;
        indices += g.index.count;
      });
      var position = new Float32Array(vertices * 3);
      var normal = new Float32Array(vertices * 3);
      var uv = new Float32Array(vertices * 2);
      var index = new Uint32Array(indices);
      var v = 0;
      var i = 0;
      list.forEach(function (g) {
        position.set(g.attributes.position.array, v * 3);
        normal.set(g.attributes.normal.array, v * 3);
        uv.set(g.attributes.uv.array, v * 2);
        var source = g.index.array;
        for (var k = 0; k < source.length; k++) index[i + k] = source[k] + v;
        v += g.attributes.position.count;
        i += source.length;
      });
      var out = new T.BufferGeometry();
      out.setAttribute("position", new T.BufferAttribute(position, 3));
      out.setAttribute("normal", new T.BufferAttribute(normal, 3));
      out.setAttribute("uv", new T.BufferAttribute(uv, 2));
      out.setIndex(new T.BufferAttribute(index, 1));
      out.computeBoundingSphere();
      out.computeBoundingBox();
      return out;
    }

    /* -------------------------------------------------------------- canvas textures */

    /**
     * Returns a texture drawn on a canvas `w` by `h` pixels by `draw(context, w, h)`, redrawn
     * when the theme or the fonts change.
     */
    function canvasTexture(w, h, draw) {
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var context = canvas.getContext("2d");
      var texture = new T.CanvasTexture(canvas);
      texture.colorSpace = T.SRGBColorSpace;
      texture.anisotropy = anisotropy;
      var entry = {
        texture: texture,
        draw: draw,
        redraw: function () {
          context.clearRect(0, 0, w, h);
          entry.draw(context, w, h);
          texture.needsUpdate = true;
        },
      };
      entry.redraw();
      canvases.push(entry);
      return entry;
    }

    function cssToken(name) {
      return getComputedStyle(document.documentElement).getPropertyValue("--" + name).trim();
    }

    var FONT = '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif';
    var DECO = '"Limelight", "Bricolage Grotesque", serif';

    /* -------------------------------------------------------------- frames of reference */

    var centreX = 0;
    var cosF = Math.cos(FACING);
    var sinF = Math.sin(FACING);

    /** Converts a point of the building's frame to the world. */
    function toWorld(x, y, z) {
      var lx = x - centreX;
      return new T.Vector3(lx * cosF + z * sinF, y, -lx * sinF + z * cosF);
    }

    /** Converts a facing in the building's frame (0 faces the front) to the world. */
    function toWorldFacing(facing) {
      return facing + FACING;
    }

    /** Puts a colleague standing at a point of the building's frame, facing `facing`. */
    function standAt(bean, x, y, z, facing) {
      var p = toWorld(x, y, z);
      bean.position.y = y;
      bean.standAt(p.x, p.z, toWorldFacing(facing || 0));
    }

    /** Walks a colleague to a point of the building's frame, on its storey. */
    function walkTo(bean, x, z, facing) {
      var p = toWorld(x, bean.position.y, z);
      return bean.walkTo(p.x, p.z, facing == null ? undefined : toWorldFacing(facing));
    }

    /* -------------------------------------------------------------- the building */

    /**
     * Builds the whole scene for a state: the plan, the shell, the rooms and their people, the
     * labels, and the pick targets. Returns what setState and select need to find again.
     */
    function buildScene(state) {
      var plan = buildPlan(W, state);
      var layout = layOut(plan);
      var inner = layout.inner;
      var shaftX0 = inner + SHAFT_WALL;
      var shaftX1 = shaftX0 + LIFT_W;
      var x0 = -PIER;
      var x1 = shaftX1 + PIER;
      centreX = (x0 + x1) / 2;

      // The still building: everything that never moves on its own. A child group carries the
      // building's own frame, so its pieces are placed in building coordinates.
      var root = new T.Group();
      root.name = "the-firm";
      root.rotation.y = FACING;
      var body = new T.Group();
      body.position.x = -centreX;
      root.add(body);
      // What moves (the lift car, the door lights' halos, pick targets) lives beside it, in the scene.
      var live = new T.Group();
      live.rotation.y = FACING;
      var liveBody = new T.Group();
      liveBody.position.x = -centreX;
      live.add(liveBody);

      var s = {
        state: state,
        plan: plan,
        layout: layout,
        root: root,
        body: body,
        live: live,
        liveBody: liveBody,
        beans: {}, // id -> { bean, tag, label, home, record, room }
        rooms: [], // team rooms with their hit targets
        storeyLabels: [],
        plaques: [],
        bubbles: [],
        halos: [],
        pendants: [],
        glassDoors: [],
        animations: [],
        frameStops: [],
        x0: x0,
        x1: x1,
        shaftX0: shaftX0,
        shaftX1: shaftX1,
        bottom: layout.storeys[0].y - SLAB - BASE,
        top: layout.top,
      };
      scene = s;

      buildShell(s);
      layout.storeys.forEach(function (st) {
        if (st.kind === "project") buildProjectStorey(s, st);
        else if (st.kind === "cafe") buildCafe(s, st);
        else if (st.kind === "runs") buildRuns(s, st);
        else if (st.kind === "secretariat") buildSecretariat(s, st);
        else if (st.kind === "penthouse") buildPenthouse(s, st);
        buildLanding(s, st);
        labelStorey(s, st);
      });
      buildLift(s);
      buildCrown(s);
      buildStreet(s);
      buildSkyline(s);

      root.updateMatrixWorld(true);
      live.updateMatrixWorld(true);
      seatEveryone(s);
      mergeStatic(root);
      mergeStatic(live);
      stage.add(root);
      stage.scene.add(live);
      root.updateMatrixWorld(true);
      // The longcase clocks' hands live outside their cases (OFFICE-KIT.md): set to 09:41.
      s.clockHands = [];
      layout.storeys.forEach(function (st) {
        [st.clock, st.lobbyClock].forEach(function (clock) {
          if (!clock) return;
          clock.object.updateWorldMatrix(true, false);
          clock.hands.applyMatrix4(clock.object.matrixWorld);
          stage.scene.add(clock.hands);
          clock.setTime(new Date(2026, 8, 29, 9, 41));
          s.clockHands.push(clock.hands);
        });
      });
      applyTheme();
      return s;
    }

    /** Removes everything the last buildScene added. */
    function clearScene() {
      if (!scene) return;
      scene.frameStops.forEach(function (stop) {
        stop();
      });
      Object.keys(scene.beans).forEach(function (id) {
        var entry = scene.beans[id];
        if (entry.label) entry.label.remove();
        stage.remove(entry.bean);
        entry.bean.rig.dispose();
      });
      scene.plaques.concat(scene.storeyLabels, scene.bubbles).forEach(function (label) {
        label.remove();
      });
      stage.remove(scene.root);
      scene.live.removeFromParent();
      (scene.clockHands || []).concat(scene.floorAnchors || []).forEach(function (object) {
        object.removeFromParent();
      });
      canvases.forEach(function (entry) {
        entry.texture.dispose();
      });
      canvases = [];
      scene = null;
    }

    /* -- the shell: floors, back walls, slabs, piers */

    function buildShell(s) {
      var b = s.body;
      var lacquer = paint("room-inlay-2", "lacquer");
      var brass = paint("brass", "brass");
      var stone = paint("room-wall", "matte", { dl: -0.035, dc: 0.006 });
      var shaftDark = paint("room-wall", "matte", { dl: -0.16, dc: 0.012 });
      var bottom = s.layout.storeys[0].y - SLAB;
      var top = s.layout.top;

      s.layout.storeys.forEach(function (st) {
        var tint = st.tint || null;
        var y = st.y;
        // The floor: the kit's parquet with its Deco border, inlaid in the project's tint.
        var floor = K.buildFloor(s.layout.inner, DEPTH, st.kind === "cafe" ? { tiles: true } : tint ? { inlay: "proj-" + tint } : {});
        floor.position.set(s.layout.inner / 2, y, -DEPTH / 2);
        b.add(floor);
        // The back wall: tinted plaster over a panelled dado with a brass bead.
        var plaster = wallPaint(st);
        box(b, 0, s.layout.inner, y, y + CLEAR, -DEPTH - WALL, -DEPTH, plaster);
        box(b, 0, s.layout.inner, y, y + 0.55, -DEPTH, -DEPTH + 0.018, paint("room-panel", "satin"));
        box(b, 0, s.layout.inner, y + 0.55, y + 0.6, -DEPTH, -DEPTH + 0.04, paint("room-panel", "satin", { dl: -0.06 }));
        box(b, 0, s.layout.inner, y + 0.6, y + 0.612, -DEPTH, -DEPTH + 0.046, brass, { cast: false });
        // The slab over the storey: cut at the front and faced in lacquer with brass rules. It
        // casts no sun shadow, so the open front lets the morning in as a doll's house would.
        var slabTop = y + PITCH - 0.1;
        var slabTopFinal = st.kind === "penthouse" ? y + CLEAR + ROOF : slabTop;
        box(b, -PIER, s.shaftX1 + PIER, y + CLEAR, slabTopFinal, -DEPTH - WALL, -0.04, stone, { cast: false });
        box(b, -PIER, s.shaftX1 + PIER, y + CLEAR, slabTopFinal + (st.kind === "penthouse" ? 0 : 0.1), -0.04, 0, lacquer, { cast: false });
        box(b, -PIER, s.shaftX1 + PIER, y + CLEAR + 0.035, y + CLEAR + 0.05, 0, 0.012, brass, { cast: false });
        box(b, -PIER, s.shaftX1 + PIER, slabTopFinal + (st.kind === "penthouse" ? 0 : 0.1) - 0.05, slabTopFinal + (st.kind === "penthouse" ? 0 : 0.1) - 0.035, 0, 0.012, brass, { cast: false });
        // The pendant light at the middle of the storey's front is per room; see furnishTeamRoom.
      });

      // The slab under the basement, the piers at both ends, and the lift shaft's walls.
      box(b, -PIER, s.shaftX1 + PIER, bottom - 0.1, bottom, -DEPTH - WALL, 0, lacquer, { cast: false });
      box(b, -PIER, 0, bottom, top, -DEPTH - WALL, 0, stone, { cast: false });
      box(b, s.shaftX1, s.shaftX1 + PIER, bottom, top, -DEPTH - WALL, 0, stone, { cast: false });
      fluting(b, -PIER, 0, bottom, top, lacquer, brass);
      fluting(b, s.shaftX1, s.shaftX1 + PIER, bottom, top, lacquer, brass);
      // The shaft: a dark well with brass guide rails, open at the front.
      box(b, s.shaftX0, s.shaftX1, bottom, top, -DEPTH - WALL, -DEPTH + 0.05, shaftDark, { cast: false });
      box(b, s.shaftX0 + 0.1, s.shaftX0 + 0.14, bottom, top - ROOF, -DEPTH + 0.05, -DEPTH + 0.12, brass, { cast: false });
      box(b, s.shaftX1 - 0.14, s.shaftX1 - 0.1, bottom, top - ROOF, -DEPTH + 0.05, -DEPTH + 0.12, brass, { cast: false });
      s.layout.storeys.forEach(function (st) {
        // The wall between the landing and the shaft, with the landing's gate opening.
        var gate0 = -DEPTH + 0.55;
        var gate1 = -DEPTH + 1.75;
        var wallMat = wallPaint(st);
        box(b, s.layout.inner, s.shaftX0, st.y, st.y + CLEAR, -DEPTH, gate0, wallMat);
        box(b, s.layout.inner, s.shaftX0, st.y, st.y + CLEAR, gate1, 0, wallMat);
        box(b, s.layout.inner, s.shaftX0, st.y + 2.1, st.y + CLEAR, gate0, gate1, wallMat);
        box(b, s.layout.inner - 0.01, s.shaftX0 + 0.01, st.y + 2.1, st.y + 2.14, gate0 - 0.04, gate1 + 0.04, brass, { cast: false });
        box(b, s.layout.inner, s.shaftX0, st.y, st.y + CLEAR, -0.03, 0, lacquer, { cast: false });
        // The shaft's sill at each storey.
        box(b, s.shaftX0, s.shaftX1, st.y - 0.06, st.y, -DEPTH, 0, paint("room-inlay-2", "satin"), { cast: false });
        box(b, s.shaftX0, s.shaftX1, st.y - 0.012, st.y, -0.02, 0.006, brass, { cast: false });
      });
    }

    /** Adds the Deco fluting to a pier's cut face: three lacquer reeds with brass caps. */
    function fluting(b, x0, x1, y0, y1, lacquer, brass) {
      var w = x1 - x0;
      box(b, x0, x1, y0, y1, -0.002, 0.03, paint("room-wall", "matte", { dl: -0.06, dc: 0.008 }), { cast: false });
      for (var i = 0; i < 2; i++) {
        var cx = x0 + w * (0.3 + i * 0.4);
        box(b, cx - 0.035, cx + 0.035, y0, y1, 0.03, 0.06, lacquer, { cast: false });
      }
      box(b, x0 - 0.02, x1 + 0.02, y1 - 0.05, y1, -0.002, 0.07, brass, { cast: false });
    }

    /** Returns the plaster of a storey's walls: its project's tint, or the Bureau's plaster. */
    function wallPaint(st) {
      if (st.tint) return paint("proj-" + st.tint, "matte", { dl: 0.045, dc: -0.006 });
      if (st.kind === "cafe") return paint("room-cork", "matte", { dl: 0.04 });
      if (st.kind === "secretariat") return paint("room-wall", "matte", { dl: -0.02, dc: 0.012 });
      if (st.kind === "penthouse") return paint("room-wall", "matte", { dl: 0.01, dc: 0.01 });
      return paint("room-wall", "matte");
    }

    /** Adds a partition wall at `x` on a storey, with a doorway near the front so people can pass. */
    function partition(parent, st, x, opts) {
      var mat = wallPaint(st);
      var group = new T.Group();
      group.position.x = x;
      parent.add(group);
      var t = WALL / 2;
      var door0 = -1.12;
      var door1 = -0.22;
      var doorTop = 2.02;
      box(group, -t, t, st.y, st.y + CLEAR, -DEPTH, door0, mat);
      box(group, -t, t, st.y, st.y + CLEAR, door1, 0, mat);
      box(group, -t, t, st.y + doorTop, st.y + CLEAR, door0, door1, mat);
      box(group, -t - 0.006, t + 0.006, st.y + doorTop, st.y + doorTop + 0.035, door0 - 0.04, door1 + 0.04, paint("room-panel", "satin"), { cast: false });
      // The cut end of the wall, in lacquer, as a section drawing shows it.
      box(group, -t, t, st.y, st.y + CLEAR, -0.025, 0.004, paint("room-inlay-2", "lacquer"), { cast: false });
      if (opts && opts.dado !== false) {
        box(group, -t - 0.012, t + 0.012, st.y, st.y + 0.55, -DEPTH, door0, paint("room-panel", "satin"));
        box(group, -t - 0.012, t + 0.012, st.y, st.y + 0.55, door1, -0.03, paint("room-panel", "satin"));
      }
      return group;
    }

    /* -- project storeys and team rooms */

    function buildProjectStorey(s, st) {
      st.rooms.forEach(function (room, index) {
        var group = new T.Group();
        group.position.x = room.x0;
        s.body.add(group);
        room.group = group;
        room.storey = st;
        var width = room.width - (room.grows || 0);
        room.drawnWidth = width;
        furnishTeamRoom(s, st, room, group, width);
        // The wall on the room's right; the last room's right wall is the landing's left.
        room.rightWall = partition(s.body, st, room.x0 + width);
        if (room.grows) room.rightWallTo = room.x0 + room.width;
        s.rooms.push(room);
      });
      // Rooms after a growing room start shifted left by its growth, so the gap is the landing's.
      var shift = 0;
      st.rooms.forEach(function (room) {
        if (shift) {
          room.group.position.x -= shift;
          room.rightWall.position.x -= shift;
          room.shifted = shift;
        }
        if (room.grows) shift += room.grows;
      });
    }

    /**
     * Furnishes a team's room in its own frame (x from 0 at its left wall): the back door with the
     * kit's plaque and the door light over it, the whiteboard with the team's plan, a desk per
     * member with the lead at the head desk, and the room's pendant.
     */
    function furnishTeamRoom(s, st, room, group, width) {
      var team = room.team;
      var y = st.y;
      var lead = team.lead;
      var members = team.members.slice();
      var deskCount = members.length - (room.grows ? 1 : 0);
      var zoneX0 = DOOR_X + 0.52;
      var zoneX1 = width - 0.18;
      var pitch = team.size > 6 ? 1.24 : DESK_PITCH;
      // The desks sit toward the door; the room's dressing takes the rest of the width.
      var extra = Math.max(0, zoneX1 - zoneX0 - deskCount * pitch);
      var centre = zoneX0 + (deskCount * pitch) / 2 + extra * 0.32;
      // Slots from the middle out: the lead takes the middle one, partners fill outward.
      var slots = [];
      for (var i = 0; i < deskCount; i++) slots.push(centre + (i - (deskCount - 1) / 2) * pitch);
      var order = slots
        .map(function (x, i) {
          return { x: x, i: i, d: Math.abs(i - (deskCount - 1) / 2) - (i < (deskCount - 1) / 2 ? 0.01 : 0) };
        })
        .sort(function (a, b) {
          return a.d - b.d;
        });
      room.desks = {};
      var seated = members.slice(0, deskCount);
      seated.forEach(function (member, index) {
        var slot = order[index];
        var desk = K.buildDesk();
        var isLead = member === lead;
        var forward = isLead && deskCount > 1 ? 0.22 : 0;
        var turn = isLead || deskCount === 1 ? 0 : slot.x < centre ? -0.16 : 0.16;
        desk.object.rotation.y = Math.PI + turn;
        desk.object.position.set(slot.x, y, -DEPTH + 1.18 + forward);
        group.add(desk.object);
        room.desks[member.id] = { desk: desk, x: slot.x, z: -DEPTH + 1.18 + forward, lead: isLead };
      });
      room.newDeskX = slots[slots.length - 1] + pitch;

      // The back door: a frosted-glass office door with the kit's brass plaque on it.
      buildDoor(s, group, DOOR_X, y, room);
      // The whiteboard, centred over the desks.
      var boardWidth = Math.min(2.5, Math.max(1.05, zoneX1 - zoneX0 - 0.2));
      room.board = buildWhiteboard(s, group, centre, y, boardWidth, team, room);
      // The pendant over the room's middle, lit at night.
      buildPendant(s, group, width / 2, y);
      // The room's dressing, in the space the desks leave on the right: a plant, then a filing
      // cabinet, then a coat stand, as the room allows.
      var slack = width - (slots[slots.length - 1] + 0.6) - (room.grows ? 0 : 0);
      if (room.grows) slack = 0;
      if (slack > 0.62 && deskCount < 6) {
        var plant = K.buildPlant("small");
        plant.position.set(width - 0.4, y, -DEPTH + 0.42);
        group.add(plant);
      }
      if (slack > 1.25 && deskCount < 6) {
        var cabinet = K.buildCabinet();
        cabinet.position.set(width - 0.98, y, -DEPTH + 0.33);
        group.add(cabinet);
      }
      if (slack > 1.9 && deskCount < 6) {
        var stand = K.buildCoatStand();
        stand.position.set(width - 0.45, y, -0.62);
        group.add(stand);
      }
      room.centre = centre;
      room.width0 = width;
    }

    /** Builds a room's back door at `x`: wood, a frosted pane, a brass knob, the plaque and the door light. */
    function buildDoor(s, group, x, y, room) {
      var wood = paint("room-wood", "satin");
      var z = -DEPTH;
      var w = 0.84;
      var h = 1.86;
      box(group, x - w / 2 - 0.06, x + w / 2 + 0.06, y, y + h + 0.07, z, z + 0.035, paint("room-panel", "satin", { dl: -0.08 }));
      box(group, x - w / 2, x + w / 2, y, y + h, z + 0.035, z + 0.06, wood);
      // The frosted pane, lit from the corridor behind at night.
      var glass = new T.MeshStandardMaterial({ roughness: 0.35, metalness: 0, emissiveIntensity: 0 });
      s.glassDoors.push(glass);
      var pane = box(group, x - w / 2 + 0.1, x + w / 2 - 0.1, y + 0.95, y + h - 0.1, z + 0.06, z + 0.066, glass, { cast: false });
      pane.receiveShadow = true;
      box(group, x + w / 2 - 0.12, x + w / 2 - 0.07, y + 0.92, y + 0.97, z + 0.06, z + 0.11, paint("brass", "brass"), { cast: false });
      var plaque = K.buildPlaque(readShort(room.team.id, room.team.lead.title));
      var scale = Math.min(1, (w - 0.16) / measurePlaque(readShort(room.team.id, room.team.lead.title)));
      plaque.scale.setScalar(scale);
      plaque.position.set(x, y + 1.3, z + 0.07);
      group.add(plaque);
      // The door light: a small globe in the team's status, over the door.
      var cap = box(group, x - 0.07, x + 0.07, y + h + 0.08, y + h + 0.1, z, z + 0.06, paint("brass", "brass"), { cast: false });
      cap.castShadow = false;
      var globe = new T.Mesh(new T.SphereGeometry(0.058, 18, 12), doorLightPaint(room.team.status));
      globe.position.set(x, y + h + 0.14, z + 0.07);
      group.add(globe);
      room.doorLight = globe;
      var halo = buildHalo(room.team.status);
      halo.position.set(room.x0 + x - (room.shifted || 0), y + h + 0.14, z + 0.12);
      s.liveBody.add(halo);
      s.halos.push(halo);
      room.halo = halo;
      room.doorX = x;
    }

    /** Returns roughly how wide the kit's plaque for `text` is, in metres. */
    function measurePlaque(text) {
      return String(text).length * 0.046 + 0.15;
    }

    /** Returns the door light's material for a status: marigold when waiting, green when working, dark when quiet. */
    function doorLightPaint(status) {
      if (status === "waiting") return paint("you", "glow", { dl: 0.04 });
      if (status === "working") return paint("ok", "glow", { dl: 0.12 });
      return paint("room-paper", "satin", { dl: -0.3, dc: 0.01 });
    }

    var haloTexture = null;
    /** Returns a soft additive halo for a door light, shown only at night. */
    function buildHalo(status) {
      if (!haloTexture) {
        var c = document.createElement("canvas");
        c.width = c.height = 64;
        var g = c.getContext("2d");
        var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.25, "rgba(255,255,255,0.45)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
        haloTexture = new T.CanvasTexture(c);
        haloTexture.colorSpace = T.SRGBColorSpace;
      }
      var material = new T.SpriteMaterial({ map: haloTexture, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0 });
      var sprite = new T.Sprite(material);
      sprite.scale.set(0.62, 0.62, 1);
      sprite.userData.status = status;
      sprite.castShadow = false;
      return sprite;
    }

    /** Hangs a pendant globe from the ceiling, near the front so the slab does not hide it. */
    function buildPendant(s, group, x, y) {
      var brass = paint("brass", "brass");
      cylinder(group, 0.008, 0.26, x, y + CLEAR - 0.26, -0.75, brass, 6).castShadow = false;
      var shade = new T.Mesh(new T.SphereGeometry(0.11, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), paint("room-paper", "satin"));
      shade.position.set(x, y + CLEAR - 0.27, -0.75);
      shade.rotation.x = Math.PI;
      shade.castShadow = false;
      group.add(shade);
      s.pendants.push(shade);
    }

    /* -- the whiteboard */

    /**
     * Builds a whiteboard on the room's back wall: the team's plan (the lead's camps with ticks,
     * where it stands, what waits on you) and a line per partner with its own progress.
     */
    function buildWhiteboard(s, group, cx, y, width, team, room) {
      var height = 0.8;
      var bottom = 1.24;
      var pxPerM = 720;
      var cw = Math.round(width * pxPerM);
      var ch = Math.round(height * pxPerM);
      var entry = canvasTexture(cw, ch, function (g, w, h) {
        drawPlan(g, w, h, team, room);
      });
      var material = new T.MeshStandardMaterial({ map: entry.texture, roughness: 0.55, metalness: 0, emissive: 0xffffff, emissiveMap: entry.texture, emissiveIntensity: 0.16 });
      var frame = paint("room-metal", "metal");
      box(group, cx - width / 2 - 0.03, cx + width / 2 + 0.03, y + bottom - 0.03, y + bottom + height + 0.03, -DEPTH, -DEPTH + 0.025, frame, { cast: false });
      var face = new T.Mesh(new T.PlaneGeometry(width, height), material);
      face.position.set(cx, y + bottom + height / 2, -DEPTH + 0.027);
      face.receiveShadow = true;
      group.add(face);
      // The marker tray.
      box(group, cx - width / 2 + 0.1, cx + width / 2 - 0.1, y + bottom - 0.05, y + bottom - 0.03, -DEPTH, -DEPTH + 0.06, frame, { cast: false });
      return { entry: entry, face: face, width: width };
    }

    /**
     * Draws a team's plan on a whiteboard canvas: the goal and how far along it is, the lead's
     * camps in one or two columns (a tick when done, an arrow where it stands, marigold where it
     * waits on you), and a line per partner with its own camps as dots.
     */
    function drawPlan(g, w, h, team, room) {
      var goal = W.goals[team.lead.id];
      g.fillStyle = "oklch(0.985 0.004 95)";
      g.fillRect(0, 0, w, h);
      var ink = "oklch(0.24 0.035 255)";
      var faint = "oklch(0.56 0.02 255)";
      var green = "oklch(0.52 0.14 150)";
      var marigold = "oklch(0.6 0.15 68)";
      var pad = Math.round(h * 0.07);
      var unit = h / 7.2;
      g.textBaseline = "alphabetic";
      if (!goal) {
        g.font = "640 " + Math.round(unit * 0.8) + "px " + FONT;
        g.fillStyle = faint;
        g.fillText("No plan yet", pad, pad + unit);
        return;
      }
      var done = goal.camps.filter(function (c) {
        return c.state === "done";
      }).length;
      // The header: the summit, and how many camps are done.
      var headSize = Math.round(unit * 0.62);
      g.font = "700 " + Math.round(unit * 0.7) + "px " + FONT;
      g.textAlign = "right";
      g.fillStyle = ink;
      var count = done + " of " + goal.camps.length;
      g.fillText(count, w - pad, pad + headSize);
      var countW = g.measureText(count).width;
      g.textAlign = "left";
      g.font = "640 " + headSize + "px " + FONT;
      g.fillStyle = faint;
      g.fillText(fitText(g, "GOAL  " + goal.summit.toUpperCase(), w - pad * 2 - countW - unit), pad, pad + headSize);
      g.strokeStyle = faint;
      g.lineWidth = Math.max(1.5, unit * 0.04);
      g.beginPath();
      g.moveTo(pad, pad + unit * 0.95);
      g.lineTo(w - pad, pad + unit * 0.95);
      g.stroke();

      var partners = team.members.filter(function (m) {
        return m !== team.lead && !(room.grows && m.id === W.spawn.thread.id && !room.grown);
      });
      var partnerLines = partners.length ? 1 : 0;
      var areaTop = pad + unit * 1.1;
      var areaBottom = h - pad - partnerLines * unit * 0.95;
      var columns = goal.camps.length > 5 && w / h > 2.1 ? 2 : 1;
      var perColumn = Math.ceil(goal.camps.length / columns);
      var lineH = (areaBottom - areaTop) / perColumn;
      var size = Math.min(unit * 0.9, lineH * 0.8);
      var colW = (w - pad * 2) / columns;
      // Shrink the writing until the longest camp fits its column, down to a floor; past that it is cut.
      g.font = "700 100px " + FONT;
      var longest = goal.camps.reduce(function (most, c) {
        return Math.max(most, g.measureText(c.label + (c.of ? " · " + c.of[0] + " of " + c.of[1] : "")).width / 100);
      }, 0);
      size = Math.round(Math.max(unit * 0.56, Math.min(size, (colW - size * 1.7) / Math.max(1, longest))));
      goal.camps.forEach(function (c, index) {
        var col = Math.floor(index / perColumn);
        var row = index % perColumn;
        var x = pad + col * colW;
        var yy = areaTop + row * lineH + lineH * 0.5 + size * 0.36;
        var mark = size * 0.8;
        var by = yy - size * 0.36 - mark / 2;
        g.lineWidth = Math.max(2, size * 0.12);
        g.lineCap = "round";
        g.lineJoin = "round";
        if (c.state === "done") {
          g.strokeStyle = green;
          g.beginPath();
          g.moveTo(x + mark * 0.1, by + mark * 0.55);
          g.lineTo(x + mark * 0.4, by + mark * 0.88);
          g.lineTo(x + mark * 0.95, by + mark * 0.12);
          g.stroke();
        } else if (c.state === "waiting") {
          g.fillStyle = marigold;
          g.beginPath();
          g.arc(x + mark / 2, by + mark / 2, mark * 0.4, 0, Math.PI * 2);
          g.fill();
        } else if (c.state === "current") {
          g.fillStyle = ink;
          g.beginPath();
          g.moveTo(x + mark * 0.14, by + mark * 0.06);
          g.lineTo(x + mark * 0.94, by + mark * 0.5);
          g.lineTo(x + mark * 0.14, by + mark * 0.94);
          g.closePath();
          g.fill();
        } else {
          g.strokeStyle = faint;
          g.lineWidth = Math.max(1.5, size * 0.08);
          g.beginPath();
          g.arc(x + mark / 2, by + mark / 2, mark * 0.34, 0, Math.PI * 2);
          g.stroke();
        }
        var label = c.label + (c.of ? " · " + c.of[0] + " of " + c.of[1] : "");
        var tx = x + mark + size * 0.4;
        var strong = c.state === "current" || c.state === "waiting";
        g.font = (strong ? "700 " : "520 ") + size + "px " + FONT;
        g.fillStyle = c.state === "done" ? faint : c.state === "waiting" ? marigold : ink;
        var room_ = colW - (tx - x) - size * 0.5;
        var text = fitText(g, label, room_);
        g.fillText(text, tx, yy);
      });
      // One line for the partners: each one's role in its hue, a dot per camp, and where it stands.
      if (!partnerLines) return;
      g.strokeStyle = faint;
      g.lineWidth = Math.max(1.5, unit * 0.035);
      g.setLineDash([unit * 0.16, unit * 0.12]);
      g.beginPath();
      g.moveTo(pad, areaBottom + unit * 0.06);
      g.lineTo(w - pad, areaBottom + unit * 0.06);
      g.stroke();
      g.setLineDash([]);
      var psize = Math.round(unit * 0.64);
      var py = h - pad - unit * 0.16;
      var px = pad;
      partners.forEach(function (p) {
        if (px > w - pad - psize * 4) return;
        var pg = W.goals[p.id];
        var hue = K.buildSessionLook(p.id, "thread").hue;
        g.fillStyle = "oklch(0.66 0.14 " + (cssToken("hue-" + hue) || 280) + ")";
        g.beginPath();
        g.arc(px + psize * 0.36, py - psize * 0.34, psize * 0.32, 0, Math.PI * 2);
        g.fill();
        g.font = "700 " + psize + "px " + FONT;
        g.fillStyle = ink;
        var role = p.role || readShort(p.id, p.title);
        g.fillText(role, px + psize * 0.95, py);
        px += psize * 0.95 + g.measureText(role).width + psize * 0.45;
        if (pg) {
          pg.camps.forEach(function (c) {
            g.fillStyle = c.state === "done" ? green : c.state === "waiting" ? marigold : ink;
            g.strokeStyle = faint;
            g.lineWidth = Math.max(1.5, psize * 0.1);
            g.beginPath();
            g.arc(px + psize * 0.28, py - psize * 0.34, psize * 0.24, 0, Math.PI * 2);
            if (c.state === "todo") g.stroke();
            else g.fill();
            px += psize * 0.66;
          });
        }
        if (p.pose === "waiting") {
          g.font = "700 " + psize + "px " + FONT;
          g.fillStyle = marigold;
          g.fillText("waits on you", px + psize * 0.2, py);
          px += g.measureText("waits on you").width + psize * 0.2;
        }
        px += psize * 1.1;
      });
    }

    /** Returns `text`, cut with an ellipsis to fit `max` pixels in the context's font. */
    function fitText(g, text, max) {
      if (g.measureText(text).width <= max) return text;
      var cut = text;
      while (cut.length > 1 && g.measureText(cut + "…").width > max) cut = cut.slice(0, -1);
      return cut.replace(/\s+$/, "") + "…";
    }

    /* -- the café, the runs, the mezzanine, the penthouse */

    function buildCafe(s, st) {
      var b = s.body;
      var y = st.y;
      var counter = K.buildCounter(2.6);
      counter.position.set(1.85, y, -DEPTH + 1.05);
      b.add(counter);
      var back = K.buildBackBar(2.6);
      back.position.set(1.85, y, -DEPTH + 0.22);
      b.add(back);
      [0, 1].forEach(function (i) {
        var poster = K.buildPoster(i);
        poster.position.set(4.0 + i * 2.4, y + 1.45, -DEPTH + 0.002);
        b.add(poster);
      });
      st.tables = [];
      var seatsX = [3.9, 5.2, 6.5, 7.8, 9.1, 10.4, 11.7, 13.0];
      seatsX.forEach(function (x, i) {
        if (x > s.layout.inner - LANDING_MIN - 0.4) return;
        var table = K.buildRoundTable(false);
        table.object.position.set(x, y, -1.15 - (i % 2) * 0.35);
        b.add(table.object);
        st.tables.push(table);
      });
      var palm = K.buildPlant("tall");
      palm.position.set(0.7, y, -0.6);
      b.add(palm);
      buildPendant(s, b, 2.4, y);
      buildPendant(s, b, 6.4, y);
      buildPendant(s, b, 10.4, y);
    }

    function buildRuns(s, st) {
      var b = s.body;
      var y = st.y;
      var x = BENCH_GAP / 2;
      st.benches = [];
      s.plan.runs.forEach(function (run) {
        var width = measureBench(run.steps.length, st.stationPitch);
        var bench = buildBench(s, b, run, x, y, width, st.stationPitch);
        st.benches.push(bench);
        x += width + BENCH_GAP;
      });
      buildPendant(s, b, s.layout.inner * 0.25, y);
      buildPendant(s, b, s.layout.inner * 0.6, y);
    }

    /**
     * Builds a run's bench: a long clerk's bench with a station per step, a stool behind each, and
     * a mark on each station for its step's state. The step's session sits at the station it is
     * on. Returns the bench with a seat per step.
     */
    function buildBench(s, parent, run, x, y, width, pitch) {
      var group = new T.Group();
      group.position.set(x, y, 0);
      parent.add(group);
      var wood = paint("room-wood", "satin");
      var panel = paint("room-panel", "satin", { dl: -0.03 });
      var brass = paint("brass", "brass");
      var zc = -DEPTH + 1.05;
      var tint = runTint(run);
      box(group, 0, width, 0.72, 0.76, zc - 0.32, zc + 0.32, wood);
      box(group, 0.02, width - 0.02, 0.06, 0.72, zc + 0.26, zc + 0.3, panel);
      box(group, 0.02, width - 0.02, 0.62, 0.66, zc + 0.3, zc + 0.315, paint("proj-" + tint, "matte", { dl: -0.06, dc: 0.02 }), { cast: false });
      box(group, 0.02, width - 0.02, 0.66, 0.672, zc + 0.3, zc + 0.32, brass, { cast: false });
      box(group, 0.02, 0.08, 0, 0.72, zc - 0.3, zc + 0.26, panel);
      box(group, width - 0.08, width - 0.02, 0, 0.72, zc - 0.3, zc + 0.26, panel);
      var seats = [];
      run.steps.forEach(function (step, i) {
        var sx = BENCH_ENDS / 2 + pitch / 2 + i * pitch;
        // The stool.
        cylinder(group, 0.17, 0.04, sx, 0.38, zc - 0.62, paint("room-fabric", "fabric"), 18);
        cylinder(group, 0.025, 0.38, sx, 0, zc - 0.62, brass, 8);
        // The station's card, standing on the bench's front edge so it reads from the street:
        // green when the step is done, marigold when it waits on you, paper while it runs, grey ahead.
        var markPaint = step.state === "completed" ? paint("ok", "satin", { dl: 0.06 }) : step.state === "waiting" ? paint("you", "satin") : step.state === "running" ? paint("room-paper", "paper") : paint("room-paper", "paper", { dl: -0.2, dc: 0.01 });
        var cardW = Math.min(0.22, pitch * 0.42);
        box(group, sx - cardW / 2, sx + cardW / 2, 0.76, 0.9, zc + 0.2, zc + 0.215, markPaint, { cast: false });
        box(group, sx - cardW / 2 - 0.01, sx + cardW / 2 + 0.01, 0.76, 0.768, zc + 0.16, zc + 0.24, brass, { cast: false });
        var marker = new T.Object3D();
        marker.position.set(sx, 0, zc - 0.66);
        group.add(marker);
        var lamp = null;
        var seat = {
          seatMarker: marker,
          setLamp: function () {},
          setNote: function () {},
          setCup: function () {},
        };
        seats.push({ step: step, seat: seat, x: x + sx });
      });
      // A small brass lamp at the bench's left end, lit while the run works.
      cylinder(group, 0.05, 0.02, 0.2, 0.76, zc + 0.15, brass, 12);
      cylinder(group, 0.008, 0.28, 0.2, 0.78, zc + 0.15, brass, 6);
      return { run: run, group: group, seats: seats, x: x, width: width, tint: tint };
    }

    /** Returns a run's project tint. */
    function runTint(run) {
      var p = W.projects.filter(function (p) { return p.id === run.project; })[0];
      return p ? p.tint : "ops";
    }

    function buildSecretariat(s, st) {
      var b = s.body;
      var y = st.y;
      var span = s.layout.inner - st.landing;
      // Bookcases along the back wall in bays, with palms and filing cabinets between, left and
      // right of the assistants' corner.
      var bay = 0;
      for (var x = 0.55; x < span - 0.5; x += 0.88) {
        if (x > 2.3 && x < 4.9) continue;
        bay++;
        var piece = bay % 4 === 0 ? K.buildPlant("tall") : bay % 7 === 3 ? K.buildCabinet() : K.buildBookcase();
        piece.position.set(x, y, -DEPTH + (bay % 4 === 0 ? 0.55 : 0.22));
        b.add(piece);
      }
      if (span > 10.5) {
        var reading = K.buildRug(2.6, 1.4);
        reading.position.set(span - 2.6, y, -1.3);
        b.add(reading);
        var reader = K.buildArmchair();
        reader.object.position.set(span - 3.0, y, -1.45);
        reader.object.rotation.y = 0.3;
        b.add(reader.object);
        var readLamp = K.buildFloorLamp();
        readLamp.object.position.set(span - 2.2, y, -1.75);
        b.add(readLamp.object);
      }
      var rug = K.buildRug(4.2, 1.7, { medallion: true });
      rug.position.set(5.5, y, -1.3);
      b.add(rug);
      st.ada = K.buildWritingDesk();
      st.ada.object.rotation.y = Math.PI;
      st.ada.object.position.set(3.6, y, -DEPTH + 1.12);
      b.add(st.ada.object);
      st.ada.setLamp(true);
      st.milo = K.buildArmchair();
      st.milo.object.position.set(5.15, y, -1.5);
      st.milo.object.rotation.y = 0.3;
      b.add(st.milo.object);
      st.juno = K.buildArmchair();
      st.juno.object.position.set(6.75, y, -1.5);
      st.juno.object.rotation.y = -0.3;
      b.add(st.juno.object);
      var lamp = K.buildFloorLamp();
      lamp.object.position.set(5.95, y, -DEPTH + 0.55);
      b.add(lamp.object);
      var trolley = K.buildTeaTrolley();
      trolley.position.set(8.3, y, -1.75);
      b.add(trolley);
      var clock = K.buildWallClock();
      clock.position.set(3.6, y + 1.72, -DEPTH + 0.004);
      b.add(clock);
      buildPendant(s, b, 3.0, y);
      buildPendant(s, b, Math.min(span - 2, 8.0), y);
    }

    function buildPenthouse(s, st) {
      var b = s.body;
      var y = st.y;
      var span = s.layout.inner - st.landing;
      var brass = paint("brass", "brass");
      var deskX = Math.max(5.2, span * 0.36);
      st.deskX = deskX;
      // The window over the city: a wide Deco window in brass behind your desk, the skyline on its glass.
      var winX0 = Math.max(1.4, deskX - 4.2);
      var winX1 = Math.min(span - 1.6, deskX + 4.2);
      var view = canvasTexture(Math.round((winX1 - winX0) * 150), Math.round(1.24 * 150), function (g, w, h) {
        drawCity(g, w, h, true);
      });
      var pane = new T.Mesh(new T.PlaneGeometry(winX1 - winX0, 1.24), new T.MeshBasicMaterial({ map: view.texture }));
      pane.position.set((winX0 + winX1) / 2, y + 0.78 + 0.62, -DEPTH + 0.004);
      b.add(pane);
      box(b, winX0 - 0.06, winX1 + 0.06, y + 0.74, y + 0.78, -DEPTH, -DEPTH + 0.09, brass, { cast: false });
      box(b, winX0 - 0.06, winX1 + 0.06, y + 2.02, y + 2.06, -DEPTH, -DEPTH + 0.05, brass, { cast: false });
      var panes = Math.max(4, Math.round((winX1 - winX0) / 1.25));
      for (var i = 0; i <= panes; i++) {
        var mx = winX0 + (i * (winX1 - winX0)) / panes;
        box(b, mx - 0.025, mx + 0.025, y + 0.78, y + 2.02, -DEPTH, -DEPTH + 0.05, brass, { cast: false });
      }
      box(b, winX0, winX1, y + 1.66, y + 1.68, -DEPTH, -DEPTH + 0.04, brass, { cast: false });
      // Your desk on its rug, its lamp lit, and the Now serving sign on a brass post beside it.
      var rug = K.buildRug(3.2, 2.0, { medallion: true });
      rug.position.set(deskX, y, -1.45);
      b.add(rug);
      st.desk = K.buildYourDesk();
      st.desk.object.position.set(deskX, y, -DEPTH + 1.35);
      b.add(st.desk.object);
      st.desk.setLamp(true);
      var sign = K.buildNowServing();
      sign.object.position.set(deskX + 1.62, y + 1.14, -1.02);
      cylinder(b, 0.02, 1.14, deskX + 1.62, y, -1.04, brass, 8);
      cylinder(b, 0.14, 0.02, deskX + 1.62, y, -1.04, brass, 16);
      b.add(sign.object);
      sign.setNumber(s.plan.queue.length);
      st.sign = sign;
      // A sitting corner on the left: bookcases, two club chairs and a standard lamp.
      [0.55, 1.43].forEach(function (x) {
        var bookcase = K.buildBookcase();
        bookcase.position.set(x, y, -DEPTH + 0.2);
        b.add(bookcase);
      });
      var corner = Math.min(deskX - 2.6, 3.2);
      var lounge = K.buildRug(2.4, 1.5);
      lounge.position.set(corner, y, -1.25);
      b.add(lounge);
      [-0.62, 0.62].forEach(function (dx, i) {
        var chair = K.buildArmchair();
        chair.object.position.set(corner + dx, y, -1.45);
        chair.object.rotation.y = i ? -0.35 : 0.35;
        b.add(chair.object);
      });
      var lamp = K.buildFloorLamp();
      lamp.object.position.set(corner + 1.35, y, -DEPTH + 0.5);
      b.add(lamp.object);
      // The queue runs from your desk toward the lift, behind a short rope on brass posts.
      var q0 = deskX + 2.3;
      var q1 = Math.min(span - 0.6, q0 + Math.max(4, s.plan.queue.length) * 0.82 + 0.3);
      st.queueLine = { x0: q0, x1: q1, z: -1.1 };
      var posts = Math.max(2, Math.round((q1 - q0) / 1.3));
      for (var p = 0; p <= posts; p++) {
        var px = q0 + (p * (q1 - q0)) / posts;
        cylinder(b, 0.02, 0.86, px, y, -1.72, brass, 8);
        cylinder(b, 0.085, 0.022, px, y, -1.72, brass, 14);
        var knob = new T.Mesh(new T.SphereGeometry(0.032, 10, 8), brass);
        knob.position.set(px, y + 0.88, -1.72);
        b.add(knob);
      }
      box(b, q0, q1, y + 0.78, y + 0.81, -1.735, -1.705, paint("fail", "fabric", { dl: -0.2, dc: -0.04 }), { cast: false });
      // By the landing: the longcase clock at 09:41 and a palm.
      var clock = K.buildLongcaseClock();
      clock.object.position.set(span - 0.5, y, -DEPTH + 0.3);
      b.add(clock.object);
      st.clock = clock;
      var palm = K.buildPlant("tall");
      palm.position.set(winX1 + 0.8, y, -DEPTH + 0.6);
      if (winX1 + 0.8 < span - 1.2) b.add(palm);
      buildPendant(s, b, corner, y);
      buildPendant(s, b, deskX, y);
      buildPendant(s, b, (q0 + q1) / 2, y);
    }

    /** Draws the city seen from the penthouse, or behind the building: Deco towers, lit at night. */
    function drawCity(g, w, h, near) {
      var dark = K.isDarkTheme();
      var sky = g.createLinearGradient(0, 0, 0, h);
      if (dark) {
        sky.addColorStop(0, "oklch(0.22 0.04 265)");
        sky.addColorStop(1, "oklch(0.34 0.05 40)");
      } else {
        sky.addColorStop(0, "oklch(0.9 0.04 225)");
        sky.addColorStop(1, "oklch(0.96 0.03 85)");
      }
      g.fillStyle = sky;
      g.fillRect(0, 0, w, h);
      var seed = near ? 7 : 3;
      function rand() {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      }
      [0.55, 0.8, 1].forEach(function (depth, layer) {
        var x = -rand() * 40;
        while (x < w) {
          var bw = (0.05 + rand() * 0.08) * w * (near ? 1.2 : 0.5) * (0.6 + layer * 0.25);
          var bh = h * (0.25 + rand() * 0.55) * depth;
          var top = h - bh;
          g.fillStyle = dark
            ? "oklch(" + (0.2 + layer * 0.03) + " 0.02 260)"
            : "oklch(" + (0.86 - layer * 0.07) + " 0.02 " + (layer === 2 ? 70 : 230) + ")";
          g.fillRect(x, top, bw, bh);
          // A stepped Deco crown on the tallest.
          if (bh > h * 0.45) {
            g.fillRect(x + bw * 0.2, top - bh * 0.06, bw * 0.6, bh * 0.06);
            g.fillRect(x + bw * 0.4, top - bh * 0.14, bw * 0.2, bh * 0.08);
          }
          // Windows: lit at night, faint glints by day.
          var cols = Math.max(2, Math.floor(bw / (near ? 9 : 6)));
          var rows = Math.floor(bh / (near ? 11 : 7));
          for (var r = 1; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
              if (rand() < (dark ? 0.55 : 0.75)) continue;
              g.fillStyle = dark ? "oklch(0.85 0.11 80 / " + (0.55 + layer * 0.15) + ")" : "oklch(0.98 0.01 230 / 0.6)";
              g.fillRect(x + (c + 0.3) * (bw / cols), top + r * (near ? 11 : 7), Math.max(1.5, bw / cols * 0.35), near ? 4 : 2.5);
            }
          }
          x += bw + rand() * w * 0.02;
        }
      });
    }

    /* -- the landing at the right end of every floor */

    function buildLanding(s, st) {
      var b = s.body;
      var inner = s.layout.inner;
      var x0 = inner - st.landing;
      st.landingX0 = x0;
      if (st.kind !== "penthouse") partitionIfNeeded(s, st, x0);
      // The floor's number on a lacquer panel framed in brass, as a Deco lift lobby shows it.
      var numberW = 0.78;
      var nx = inner - 0.62;
      var tex = canvasTexture(256, 320, function (g, w, h) {
        g.fillStyle = cssToken("room-inlay-2") || "#233";
        g.fillRect(0, 0, w, h);
        g.strokeStyle = cssToken("brass") || "#b8a26a";
        g.lineWidth = 7;
        g.strokeRect(9, 9, w - 18, h - 18);
        g.lineWidth = 2;
        g.strokeRect(20, 20, w - 40, h - 40);
        g.textAlign = "center";
        g.fillStyle = cssToken("brass") || "#b8a26a";
        g.font = "190px " + DECO;
        g.fillText(st.number, w / 2, 214);
        g.font = "640 30px " + FONT;
        g.fillStyle = "oklch(0.9 0.03 85)";
        var name = st.kind === "penthouse" ? "YOUR OFFICE" : st.kind === "cafe" ? "CAFÉ" : st.name.toUpperCase();
        var px = 30;
        while (px > 18 && g.measureText(name).width > w - 50) {
          px -= 1;
          g.font = "640 " + px + "px " + FONT;
        }
        g.fillText(fitText(g, name, w - 48), w / 2, 272);
      });
      var mat = new T.MeshStandardMaterial({ map: tex.texture, roughness: 0.42, metalness: 0.15, emissive: 0xffffff, emissiveMap: tex.texture, emissiveIntensity: 0.12 });
      var plate = new T.Mesh(new T.PlaneGeometry(numberW, numberW * (320 / 256)), mat);
      plate.position.set(nx, st.y + 1.38, -DEPTH + 0.006);
      b.add(plate);
      // The lift's floor dial over the gate: a brass half-round.
      var dial = new T.Mesh(new T.CircleGeometry(0.2, 24, 0, Math.PI), paint("brass", "brass"));
      dial.position.set(inner + 0.07, st.y + 2.24, -DEPTH + 1.15);
      dial.rotation.y = Math.PI / 2;
      b.add(dial);
      if (st.kind === "project" || st.kind === "secretariat" || st.kind === "cafe") {
        var bench = K.buildBench(2);
        bench.object.position.set(x0 + Math.min(1.0, st.landing / 2), st.y, -DEPTH + 0.42);
        if (st.landing > 2.6) b.add(bench.object);
      }
      if (st.kind === "runs") {
        // The lobby: the longcase clock, at 09:41.
        var clock = K.buildLongcaseClock();
        clock.object.position.set(x0 + 0.5, st.y, -DEPTH + 0.3);
        b.add(clock.object);
        st.lobbyClock = clock;
      }
    }

    function partitionIfNeeded(s, st, x) {
      if (st.kind === "project" && st.rooms.length) return; // the last room's right wall is the landing's left
      partition(s.body, st, x);
    }

    /* -- the lift */

    function buildLift(s) {
      var car = new T.Group();
      var brass = paint("brass", "brass");
      var w = LIFT_W - 0.34;
      var d = 1.5;
      var h = 2.2;
      var lift = { car: car, w: w, d: d, h: h };
      // A lit cabin: its floor, a warm back panel, thick brass corner posts, and a canopy with a crest.
      box(car, -w / 2, w / 2, -0.06, 0, -d / 2, d / 2, paint("room-inlay-2", "lacquer"), { cast: false });
      box(car, -w / 2, w / 2, 0, h, -d / 2, -d / 2 + 0.03, paint("room-sun", "glow", { dl: -0.06, dc: 0.02 }), { cast: false });
      box(car, -w / 2, w / 2, 0, 0.95, -d / 2 + 0.03, -d / 2 + 0.05, paint("room-wood", "satin"), { cast: false });
      box(car, -w / 2, w / 2, 0.95, 0.99, -d / 2 + 0.03, -d / 2 + 0.07, brass, { cast: false });
      [-1, 1].forEach(function (sx) {
        [-1, 1].forEach(function (sz) {
          box(car, sx * w / 2 - 0.045, sx * w / 2 + 0.045, 0, h, sz * d / 2 - 0.045, sz * d / 2 + 0.045, brass, { cast: false });
        });
      });
      box(car, -w / 2 - 0.06, w / 2 + 0.06, h, h + 0.1, -d / 2 - 0.06, d / 2 + 0.06, brass, { cast: false });
      box(car, -w / 2 - 0.06, w / 2 + 0.06, -0.12, -0.06, -d / 2 - 0.06, d / 2 + 0.06, brass, { cast: false });
      var crest = new T.Mesh(new T.CircleGeometry(0.3, 28, 0, Math.PI), brass);
      crest.position.set(0, h + 0.1, d / 2 + 0.05);
      car.add(crest);
      // A lattice of thin brass bars across the open front: you see in, and it reads as a lift.
      for (var i = 1; i < 8; i++) {
        var bx = -w / 2 + (i * w) / 8;
        box(car, bx - 0.008, bx + 0.008, 0.02, h, d / 2 + 0.02, d / 2 + 0.035, brass, { cast: false });
      }
      box(car, -w / 2, w / 2, h - 0.34, h - 0.32, d / 2 + 0.02, d / 2 + 0.035, brass, { cast: false });
      box(car, -w / 2, w / 2, 0.3, 0.32, d / 2 + 0.02, d / 2 + 0.035, brass, { cast: false });
      // The scissor gate on the cabin's left side, toward the landing, folded open or shut.
      var gate = new T.Group();
      for (var g = 0; g <= 8; g++) {
        box(gate, -0.012, 0.012, 0.02, h - 0.04, -d / 2 + (g * d) / 8 - 0.008, -d / 2 + (g * d) / 8 + 0.008, brass, { cast: false });
      }
      gate.position.x = -w / 2;
      car.add(gate);
      lift.gate = gate;
      var lamp = new T.Mesh(new T.SphereGeometry(0.08, 14, 10), paint("room-paper", "glow", { dl: 0.02 }));
      lamp.position.set(0, h - 0.12, 0);
      car.add(lamp);
      car.traverse(function (o) {
        o.castShadow = false;
      });
      var cx = (s.shaftX0 + s.shaftX1) / 2;
      car.position.set(cx, 0, -DEPTH + 1.15);
      s.liveBody.add(car);
      // The cables, from the cabin's roof to the top of the shaft.
      var cable = new T.Mesh(new T.CylinderGeometry(0.014, 0.014, 1, 6), paint("room-metal", "metal", { dl: -0.3 }));
      cable.castShadow = false;
      s.liveBody.add(cable);
      lift.cable = cable;
      lift.x = cx;
      lift.top = s.top - ROOF;
      s.lift = lift;
      var pent = s.layout.storeys[s.layout.storeys.length - 1];
      placeCar(s, pent.y);
      setGate(s, 1);
    }

    /** Moves the lift car to floor height `y`, with its cables. */
    function placeCar(s, y) {
      var lift = s.lift;
      lift.car.position.y = y;
      lift.y = y;
      var from = y + lift.h + 0.1;
      var len = Math.max(0.05, lift.top - from);
      lift.cable.scale.y = len;
      lift.cable.position.set(lift.x, from + len / 2, -DEPTH + 1.15);
    }

    /** Folds the car's gate: 1 is open (folded against the back), 0 shut. */
    function setGate(s, open) {
      var gate = s.lift.gate;
      gate.scale.z = Math.max(0.12, 1 - open * 0.88);
      gate.position.z = -s.lift.d / 2 * (1 - gate.scale.z);
    }

    /* -- the crown, the street, the skyline */

    function buildCrown(s) {
      var b = s.body;
      var lacquer = paint("room-inlay-2", "lacquer");
      var brass = paint("brass", "brass");
      var stone = paint("room-wall", "matte", { dl: -0.035, dc: 0.006 });
      var x0 = s.x0;
      var x1 = s.x1;
      var w = x1 - x0;
      var cx = (x0 + x1) / 2;
      var y = s.top;
      // A parapet with a zigzag frieze, then two setbacks and a needle, as the towers of 1930 had.
      box(b, x0, x1, y, y + 0.6, -DEPTH - WALL, 0, stone);
      box(b, x0, x1, y + 0.56, y + 0.6, -DEPTH - WALL, 0.03, brass, { cast: false });
      var friezeTex = canvasTexture(1024, 64, function (g, cw, ch) {
        g.fillStyle = cssToken("room-inlay-2") || "#233";
        g.fillRect(0, 0, cw, ch);
        g.strokeStyle = cssToken("brass") || "#b8a26a";
        g.lineWidth = 5;
        g.beginPath();
        for (var i = 0; i <= 32; i++) g.lineTo((i * cw) / 32, i % 2 ? 10 : ch - 10);
        g.stroke();
      });
      friezeTex.texture.wrapS = T.RepeatWrapping;
      friezeTex.texture.repeat.set(Math.max(1, Math.round(w / 6)), 1);
      var frieze = new T.Mesh(new T.PlaneGeometry(w, 0.32), new T.MeshStandardMaterial({ map: friezeTex.texture, roughness: 0.5, metalness: 0.3 }));
      frieze.position.set(cx, y + 0.3, 0.004);
      b.add(frieze);
      var t1w = w * 0.6;
      var t1h = 1.45;
      var y1 = y + 0.6;
      box(b, cx - t1w / 2, cx + t1w / 2, y1, y1 + t1h, -DEPTH + 0.3, -0.5, stone);
      for (var i = 0; i < 9; i++) {
        if (i === 4) continue;
        var fx = cx - t1w / 2 + 0.3 + (i * (t1w - 0.6)) / 8;
        if (Math.abs(fx - cx) < 3.6) continue;
        box(b, fx - 0.06, fx + 0.06, y1, y1 + t1h, -0.5, -0.42, lacquer, { cast: false });
      }
      // The firm's name in the display face, brass on lacquer, as the window's letterhead has it.
      var signW = Math.min(t1w * 0.62, 6.4);
      var sign = canvasTexture(1024, 192, function (g, cw, ch) {
        var brassInk = cssToken("brass") || "#b8a26a";
        g.fillStyle = cssToken("room-inlay-2") || "#233";
        g.fillRect(0, 0, cw, ch);
        g.strokeStyle = brassInk;
        g.lineWidth = 6;
        g.strokeRect(10, 10, cw - 20, ch - 20);
        g.lineWidth = 2;
        g.strokeRect(22, 22, cw - 44, ch - 44);
        g.fillStyle = brassInk;
        g.textAlign = "center";
        g.font = "104px " + DECO;
        g.fillText("ROGIER & CO.", cw / 2, 118);
        g.font = "600 24px " + FONT;
        if ("letterSpacing" in g) g.letterSpacing = "8px";
        g.fillText("EST. 2026", cw / 2 + 4, 158);
        if ("letterSpacing" in g) g.letterSpacing = "0px";
        g.fillRect(cw / 2 - 210, 150, 110, 2);
        g.fillRect(cw / 2 + 100, 150, 110, 2);
      });
      var signMesh = new T.Mesh(new T.PlaneGeometry(signW, signW * (192 / 1024)), new T.MeshStandardMaterial({ map: sign.texture, roughness: 0.45, metalness: 0.25, emissive: 0xffffff, emissiveMap: sign.texture, emissiveIntensity: 0.15 }));
      signMesh.position.set(cx, y1 + t1h / 2, -0.405);
      b.add(signMesh);
      s.crownSign = signMesh;
      var t2w = w * 0.26;
      var t2h = 1.05;
      var y2 = y1 + t1h;
      box(b, cx - t2w / 2, cx + t2w / 2, y2, y2 + t2h, -DEPTH + 0.8, -0.9, stone);
      box(b, cx - t2w / 2 - 0.04, cx + t2w / 2 + 0.04, y2 + t2h - 0.05, y2 + t2h, -DEPTH + 0.76, -0.86, brass, { cast: false });
      // A sunburst on the top tier.
      var sun = new T.Mesh(new T.CircleGeometry(0.5, 32, 0, Math.PI), brass);
      sun.position.set(cx, y2 + 0.12, -0.895);
      b.add(sun);
      for (var r = 0; r < 9; r++) {
        var ang = (r / 8) * Math.PI;
        var ray = box(b, -0.016, 0.016, 0, 0.4, -0.01, 0.01, lacquer, { cast: false });
        ray.position.set(cx + Math.cos(ang) * 0.3, y2 + 0.12 + Math.sin(ang) * 0.3, -0.88);
        ray.rotation.z = ang - Math.PI / 2;
      }
      var needleY = y2 + t2h;
      var needle = new T.Mesh(new T.ConeGeometry(0.08, 1.8, 10), brass);
      needle.position.set(cx, needleY + 0.9, -DEPTH / 2 - 0.2);
      needle.castShadow = true;
      b.add(needle);
      s.crownTop = needleY + 1.8;
    }

    function buildStreet(s) {
      var b = s.body;
      var bottom = s.layout.storeys[0].y - SLAB;
      var x0 = s.x0 - STREET;
      var x1 = s.x1 + STREET;
      var earth = paint("room-wood", "matte", { dl: -0.3, dc: -0.035 });
      var pavement = paint("room-wall", "matte", { dl: -0.06, dc: 0.004 });
      var lacquer = paint("room-inlay-2", "lacquer");
      var brass = paint("brass", "brass");
      var back = -DEPTH - 7;
      // The plinth's earth, cut at the front, on both sides of the basement.
      box(b, x0, s.x0, bottom - BASE, -0.08, back, 0, earth, { cast: false });
      box(b, s.x1, x1, bottom - BASE, -0.08, back, 0, earth, { cast: false });
      box(b, s.x0, s.x1, bottom - BASE, bottom - 0.1, back, 0, earth, { cast: false });
      box(b, s.x0, s.x1, bottom - BASE, 0, back, -DEPTH - WALL - 0.01, earth, { cast: false });
      // The pavement on top, its brass ground line along the cut, and the model's lacquer stand.
      box(b, x0, s.x0, -0.08, 0, back, 0.0, pavement);
      box(b, s.x1, x1, -0.08, 0, back, 0.0, pavement);
      box(b, x0, x1, -0.02, 0.0, -0.015, 0.01, brass, { cast: false });
      box(b, x0 - 0.1, x1 + 0.1, bottom - BASE - 0.32, bottom - BASE, back - 0.1, 0.12, lacquer, { cast: false });
      box(b, x0 - 0.1, x1 + 0.1, bottom - BASE - 0.02, bottom - BASE, 0.12, 0.13, brass, { cast: false });
      // The street's furniture: a lamppost at each corner, palms in planters, benches.
      [s.x0 - 1.3, s.x1 + 1.3].forEach(function (x) {
        var post = K.buildLamppost();
        post.position.set(x, 0, -0.5);
        b.add(post);
      });
      [s.x0 - 3.9, s.x1 + 3.9].forEach(function (x) {
        var palm = K.buildPlant("tall");
        palm.position.set(x, 0, -1.2);
        b.add(palm);
      });
      var bench = K.buildBench(2);
      bench.object.position.set(s.x1 + 2.55, 0, -1.25);
      b.add(bench.object);
      var bench2 = K.buildBench(2);
      bench2.object.position.set(s.x0 - 2.55, 0, -1.25);
      b.add(bench2.object);
    }

    function buildSkyline(s) {
      var w = (s.x1 - s.x0) + STREET * 2 + 30;
      var h = 26;
      var tex = canvasTexture(2048, 512, function (g, cw, ch) {
        g.clearRect(0, 0, cw, ch);
        drawSkylineBack(g, cw, ch);
      });
      var mat = new T.MeshBasicMaterial({ map: tex.texture, transparent: true, depthWrite: false });
      var plane = new T.Mesh(new T.PlaneGeometry(w, h), mat);
      plane.position.set((s.x0 + s.x1) / 2, h / 2 - 0.5, -DEPTH - 14);
      plane.renderOrder = -1;
      s.liveBody.add(plane);
    }

    /** Draws the far city behind the building: low-contrast Deco towers, with lit windows at night. */
    function drawSkylineBack(g, w, h) {
      var dark = K.isDarkTheme();
      var seed = 11;
      function rand() {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      }
      var x = 0;
      while (x < w) {
        var bw = 50 + rand() * 120;
        var bh = h * (0.18 + rand() * 0.5);
        if (Math.abs(x + bw / 2 - w / 2) < w * 0.16) bh *= 0.7;
        var top = h - bh;
        g.fillStyle = dark ? "oklch(0.255 0.012 60 / 0.95)" : "oklch(0.93 0.01 95 / 0.95)";
        g.fillRect(x, top, bw, bh);
        if (bh > h * 0.4) {
          g.fillRect(x + bw * 0.18, top - 10, bw * 0.64, 10);
          g.fillRect(x + bw * 0.38, top - 24, bw * 0.24, 14);
          g.fillRect(x + bw * 0.48, top - 50, bw * 0.04, 26);
        }
        if (dark) {
          for (var r = top + 10; r < h - 6; r += 12) {
            for (var c = x + 6; c < x + bw - 8; c += 11) {
              if (rand() < 0.84) continue;
              g.fillStyle = "oklch(0.78 0.09 80 / 0.38)";
              g.fillRect(c, r, 4, 5);
            }
          }
        }
        x += bw + 6 + rand() * 30;
      }
    }

    /* -------------------------------------------------------------- people */

    /** Returns the record of a session for tags: its short name, role word and provider. */
    function describe(record) {
      var provider = record.provider && W.providers[record.provider] ? W.providers[record.provider].name : "";
      return { provider: provider };
    }

    /**
     * Adds a bean for a session to the scene and remembers it, with its tag. `kind` is the kit's
     * kind (thread, run or assistant).
     */
    function addBean(s, id, kind, pose, tagInfo) {
      var bean = K.colleague(tagInfo.look ? { id: id, kind: kind, pose: pose, look: tagInfo.look } : { id: id, kind: kind, pose: pose });
      // A generous pick target: a column the size of the bean, never drawn.
      var hit = new T.Mesh(new T.CylinderGeometry(0.36, 0.36, 1.3, 8), pickMaterial);
      hit.position.y = 0.65;
      bean.add(hit);
      stage.add(bean);
      var tag = K.tag({ name: tagInfo.name, state: tagInfo.state, hue: bean.look.hue, waiting: pose === "waiting" });
      tag.classList.add("tfo-tag");
      if (tagInfo.always) tag.classList.add("tfo-tag--always");
      if (tagInfo.anchor) tag.classList.add("tfo-tag--desk");
      var label = stage.label(tagInfo.anchor || bean, tag, tagInfo.offset ? { offset: tagInfo.offset } : {});
      var entry = { id: id, bean: bean, tag: tag, label: label, kind: kind };
      s.beans[id] = entry;
      return entry;
    }

    var pickMaterial = new T.MeshBasicMaterial({ visible: false });

    /**
     * Returns a point on a desk's front edge, where a seated bean's name tag hangs like a brass
     * nameplate, so tags never cover the whiteboard behind the heads.
     */
    function deskAnchor(desk) {
      var anchor = new T.Object3D();
      anchor.position.set(0, 0.74, -0.4);
      desk.object.add(anchor);
      return anchor;
    }

    /** Moves a bean's tag from its desk to over its head, for a bean that gets up and walks. */
    function tagOverHead(entry) {
      if (!entry.tag.classList.contains("tfo-tag--desk")) return;
      entry.label.remove();
      entry.tag.classList.remove("tfo-tag--desk");
      entry.label = stage.label(entry.bean, entry.tag);
    }

    /** Seats every session of the plan: the team rooms, the queue, the runs, the assistants, the café. */
    function seatEveryone(s) {
      var plan = s.plan;
      var queued = {};
      plan.queue.forEach(function (q) {
        queued[q.id] = true;
      });

      // Team rooms.
      s.rooms.forEach(function (room) {
        var team = room.team;
        team.members.forEach(function (m) {
          var spot = room.desks[m.id];
          var role = m === team.lead ? "lead" : m.role || "partner";
          var provider = describe(m).provider;
          var stateWord = provider + (m.pose === "idle" ? " · idle " + H.ago(m.last) : m.pose === "asleep" ? " · asleep" : "");
          if (queued[m.id]) {
            if (spot) {
              spot.desk.setNote(true);
              spot.desk.setLamp(false);
              // The empty chair says where its sitter went: upstairs, waiting on you.
              var away = K.tag({ name: role, state: "upstairs, waits on you", hue: K.buildSessionLook(m.id, "thread").hue, waiting: true });
              away.classList.add("tfo-tag", "tfo-tag--desk", "tfo-tag--upstairs");
              spot.upstairs = stage.label(deskAnchor(spot.desk), away);
              s.plaques.push(spot.upstairs);
            }
            return;
          }
          if (!spot) return; // the spawn state's partner arrives later
          var entry = addBean(s, m.id, "thread", m.pose === "away" ? "away" : m.pose, { name: role, state: stateWord, anchor: deskAnchor(spot.desk) });
          entry.bean.sitAt(spot.desk);
          entry.room = room;
          entry.home = spot;
          entry.record = m;
        });
      });

      // The queue at your desk, oldest first, nearest the desk.
      var pent = s.layout.storeys[s.layout.storeys.length - 1];
      plan.queue.forEach(function (q, index) {
        var rec = q.record;
        var name = q.kind === "run" ? readShort(rec.run, rec.title) : rec.lead ? readShort(rec.lead, "") + " · " + rec.role : readShort(q.id, rec.title);
        var shortAsk = q.kind === "run" ? (W.waitingRuns.filter(function (w) { return w.id === q.id; })[0] || {}).ask : rec.askShort;
        var entry = addBean(s, q.id, q.kind === "run" ? "run" : "thread", "waiting", { name: name, state: shortAsk || rec.ask || "waiting", always: true, offset: index % 2 ? 0.34 : 0 });
        // Past the first in line, a waiting tag folds to a marigold pip when the camera is not close.
        if (index > 0) entry.tag.classList.add("tfo-tag--queue");
        var x = pent.queueLine.x0 + 0.2 + index * 0.82;
        // Turned toward the desk but mostly to the street, so the raised marigold palm shows.
        standAt(entry.bean, x, pent.y, pent.queueLine.z, -0.42);
        entry.queue = index;
        entry.record = rec;
      });

      // The runs: each step's session at its station.
      var runs = s.layout.storeys[1];
      runs.benches.forEach(function (bench) {
        bench.seats.forEach(function (seat) {
          var id = seat.step.sessionId;
          if (!id || queued[id]) return;
          var rs = W.runSessions[id];
          if (!rs) return;
          var entry = addBean(s, id, "run", rs.pose, { name: readShort(bench.run.id, bench.run.title) + " · " + seat.step.id, state: describe(rs).provider });
          entry.bean.sitAt(seat.seat);
          entry.record = rs;
          entry.bench = bench;
        });
      });

      // The assistants on the mezzanine.
      var sec = s.layout.storeys[2];
      var seats = { Ada: sec.ada, Milo: sec.milo, Juno: sec.juno };
      plan.assistants.forEach(function (a) {
        var started = plan.threads.filter(function (t) {
          return W.startedBy[t.id] === "assistant:" + a.name;
        }).length;
        var word = a.pose === "working" ? "working" : a.pose === "asleep" ? "asleep" : "idle";
        var entry = addBean(s, a.name, "assistant", a.pose, { name: a.name, state: word + (started ? " · started " + started : "") });
        if (seats[a.name]) entry.bean.sitAt(seats[a.name]);
        entry.record = { id: a.name, title: a.name, pose: a.pose };
      });

      // The café's threads with no project, one to a table.
      var cafe = s.layout.storeys[0];
      plan.cafe.forEach(function (team, index) {
        var t = team.lead;
        if (queued[t.id]) return;
        var table = cafe.tables[index];
        if (!table) return;
        var entry = addBean(s, t.id, "thread", t.pose, { name: readShort(t.id, t.title), state: describe(t).provider + (t.pose === "idle" ? " · idle " + H.ago(t.last) : t.pose === "asleep" ? " · asleep" : "") });
        var chair = buildCafeChair(s, table, cafe.y);
        entry.bean.sitAt(chair);
        entry.record = t;
        entry.cafe = true;
      });
    }

    /** Returns a seat marker in front of a café table, facing the front, for a sitter with no chair of its own. */
    function buildCafeChair(s, table, y) {
      var marker = new T.Object3D();
      var p = table.object.position;
      marker.position.set(p.x + 0.0, y, p.z - 0.62);
      s.body.add(marker);
      // A bentwood chair under the sitter.
      cylinder(s.body, 0.19, 0.035, p.x, y + 0.4, p.z - 0.62, paint("room-wood", "satin", { dl: -0.08 }), 16);
      [-1, 1].forEach(function (sx) {
        cylinder(s.body, 0.014, 0.4, p.x + sx * 0.13, y, p.z - 0.62, paint("room-wood", "satin", { dl: -0.08 }), 6);
      });
      box(s.body, p.x - 0.18, p.x + 0.18, y + 0.42, y + 0.86, p.z - 0.84, p.z - 0.81, paint("room-wood", "satin", { dl: -0.08 }));
      marker.updateMatrixWorld(true);
      return marker;
    }

    /* -------------------------------------------------------------- labels */

    function labelStorey(s, st) {
      var meta;
      if (st.kind === "project") {
        var sessions = st.rooms.reduce(function (sum, r) {
          return sum + r.team.size;
        }, 0);
        meta = st.rooms.length + (st.rooms.length === 1 ? " team" : " teams") + " · " + sessions + (sessions === 1 ? " session" : " sessions");
        if (st.part) meta += " · " + st.part;
        if (st.more) meta += " · +" + st.more + " more behind";
      } else if (st.kind === "cafe") meta = s.plan.cafe.length + " with no project";
      else if (st.kind === "runs") meta = s.plan.runs.length + " runs";
      else if (st.kind === "secretariat") meta = s.plan.assistants.length + " assistants";
      else meta = s.plan.queue.length + " waiting on you";
      var kindName = { cafe: "Basement", runs: "Ground floor", secretariat: "Mezzanine", penthouse: "Penthouse" }[st.kind];
      var html =
        '<div class="tfo-floor' + (st.kind === "penthouse" && s.plan.queue.length ? " is-you" : "") + '">' +
        '<span class="tfo-floor__num">' + escapeHtml(st.number) + "</span>" +
        '<span class="tfo-floor__text">' +
        '<b class="tfo-floor__name">' + (st.tint ? '<i class="tfo-floor__tint proj--' + st.tint + '"></i>' : "") + escapeHtml(st.kind === "project" ? st.name : kindName + " · " + st.name) + "</b>" +
        '<span class="tfo-floor__meta">' + escapeHtml(meta) + "</span>" +
        "</span></div>";
      var anchor = new T.Object3D();
      anchor.position.copy(toWorld(s.x0 - 0.5, st.y + CLEAR * 0.55, 0));
      anchor.userData.home = anchor.position.clone();
      stage.scene.add(anchor);
      s.floorAnchors = s.floorAnchors || [];
      s.floorAnchors.push(anchor);
      var label = stage.label(anchor, html, { className: "tfo-floor-label" });
      label.storey = st;
      s.storeyLabels.push(label);

      // A plaque under each team room, on the slab's lacquer: the team's status light and name.
      if (st.kind === "project") {
        st.rooms.forEach(function (room) {
          var anchor = new T.Object3D();
          anchor.position.set((room.width - (room.grows || 0)) / 2, st.y - SLAB / 2 + 0.06, 0.05);
          room.group.add(anchor);
          room.plaqueAnchor = anchor;
          var plaque = stage.label(anchor, drawPlaque(s, room), { className: "tfo-plaque-label" });
          plaque.room = room;
          room.plaque = plaque;
          s.plaques.push(plaque);
        });
      }
      if (st.kind === "runs") {
        st.benches.forEach(function (bench) {
          var anchor = new T.Object3D();
          anchor.position.set(bench.x + bench.width / 2, st.y - SLAB / 2 + 0.06, 0.05);
          s.body.add(anchor);
          var run = bench.run;
          var at = run.steps.filter(function (x) { return x.state === "completed"; }).length;
          var status = run.status === "paused" ? "paused" : run.steps.some(function (x) { return x.state === "waiting"; }) ? "waiting" : "working";
          var html = '<div class="tfo-plaque tfo-plaque--run is-' + status + '" style="--w:' + bench.width.toFixed(2) + '" title="' + escapeHtml(run.title) + '">' + '<i class="tfo-plaque__light"></i><b class="tfo-plaque__name">' + escapeHtml(readShort(run.id, run.title)) + '</b><b class="tfo-plaque__title">' + escapeHtml(run.title) + '</b><span class="tfo-plaque__count">' + (run.status === "paused" ? '<span class="tfo-long">paused</span>' + (heldCount(run) ? '<span class="tfo-long"> · ' + heldCount(run) + " events held</span>" : "") : '<span class="tfo-long">step </span>' + Math.min(at + 1, run.steps.length) + '<span class="tfo-long"> of </span><span class="tfo-short">/</span>' + run.steps.length) + "</span></div>";
          var plaque = stage.label(anchor, html, { className: "tfo-plaque-label" });
          s.plaques.push(plaque);
          bench.plaque = plaque;
        });
      }
    }

    /** Returns how many events a paused run holds, read from its reason, or null. */
    function heldCount(run) {
      var m = /(\d+) events are held/.exec(run.pausedReason || "");
      return m ? m[1] : null;
    }

    /** Returns the HTML of a team room's plaque: its status light, its name and its headcount. */
    function drawPlaque(s, room) {
      var team = room.team;
      var size = team.size - (room.grows && !room.grown ? 1 : 0);
      var away = s.state === "away";
      var news = "";
      if (away) {
        var started = H.minutes(team.lead.started) > H.minutes(W.away.left);
        var unread = team.members.some(function (m) { return W.away.resultUnread[m.id]; });
        var joined = team.members.some(function (m) { return m !== team.lead && H.minutes(m.started) > H.minutes(W.away.left); });
        if (started) news = '<span class="tfo-plaque__news">new</span>';
        else if (joined) news = '<span class="tfo-plaque__news">+' + team.members.filter(function (m) { return m !== team.lead && H.minutes(m.started) > H.minutes(W.away.left); }).length + "</span>";
        else if (unread) news = '<span class="tfo-plaque__news is-quiet">news</span>';
      }
      return (
        '<div class="tfo-plaque is-' + team.status + '" style="--w:' + (room.width - (room.grows && !room.grown ? room.grows : 0)).toFixed(2) + '" title="' + escapeHtml(team.lead.title) + '">' +
        '<i class="tfo-plaque__light"></i>' +
        '<b class="tfo-plaque__name">' + escapeHtml(readShort(team.id, team.lead.title)) + "</b>" +
        '<b class="tfo-plaque__title">' + escapeHtml(team.lead.title) + "</b>" +
        (size > 1 ? '<span class="tfo-plaque__count">' + size + "</span>" : "") +
        news +
        "</div>"
      );
    }

    /** Shows a speech bubble over a bean. Returns the label. */
    function speak(s, id, html, opts) {
      var entry = s.beans[id];
      if (!entry) return null;
      var el = document.createElement("div");
      el.className = "tfo-bubble" + (opts && opts.cls ? " " + opts.cls : "");
      el.innerHTML = html;
      var label = stage.label(entry.bean, el, { offset: 0.34, className: "tfo-bubble-label" });
      s.bubbles.push(label);
      entry.tag.classList.add("is-speaking");
      return label;
    }

    /* -------------------------------------------------------------- the camera */

    /**
     * Returns the view that fits a box of the building's frame in the canvas, from the front at
     * `elevation`, leaving `pad` pixels free on each side ({ top, right, bottom, left }).
     */
    function fitBox(bx0, bx1, by0, by1, bz0, bz1, elevation, pad) {
      var rect = host.getBoundingClientRect();
      var cw = Math.max(1, rect.width);
      var ch = Math.max(1, rect.height);
      pad = pad || { top: 24, right: 24, bottom: 24, left: 24 };
      var az = FACING;
      var el = (elevation * Math.PI) / 180;
      var back = new T.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      var right = new T.Vector3(0, 1, 0).cross(back).normalize();
      var up = back.clone().cross(right).normalize();
      var centre = toWorld((bx0 + bx1) / 2, (by0 + by1) / 2, (bz0 + bz1) / 2);
      var tanY = Math.tan((camera.fov * Math.PI) / 360);
      var tanX = tanY * (cw / ch);
      var usableX = (cw - pad.left - pad.right) / cw;
      var usableY = (ch - pad.top - pad.bottom) / ch;
      var distance = 0;
      for (var i = 0; i < 8; i++) {
        var c = toWorld(i & 1 ? bx1 : bx0, i & 2 ? by1 : by0, i & 4 ? bz1 : bz0).sub(centre);
        var toward = c.dot(back);
        distance = Math.max(distance, toward + Math.abs(c.dot(right)) / (tanX * usableX), toward + Math.abs(c.dot(up)) / (tanY * usableY));
      }
      // Shift the target so the padding's centre, not the canvas's, holds the box.
      var metresPerPx = (2 * distance * tanY) / ch;
      var shiftX = ((pad.right - pad.left) / 2) * metresPerPx;
      var shiftY = ((pad.top - pad.bottom) / 2) * metresPerPx;
      var target = centre.clone().addScaledVector(right, shiftX).addScaledVector(up, shiftY);
      return { target: [target.x, target.y, target.z], distance: distance, azimuth: FACING_DEG, elevation: elevation };
    }

    /** Returns the establishing shot: the whole building, from the street to the needle. */
    function frameBuilding() {
      var s = scene;
      var portrait = host.clientHeight > host.clientWidth * 1.1;
      container.classList.toggle("is-portrait", portrait);
      var pad = portrait ? { top: 236, right: 10, bottom: 70, left: 10 } : { top: 28, right: 92, bottom: 28, left: 92 };
      return fitBox(s.x0 - (portrait ? 0.3 : 1.2), s.x1 + (portrait ? 0.3 : 1.2), s.bottom - 0.3, s.crownTop, -DEPTH, 0, ELEVATION, pad);
    }

    /** Returns the view of one storey, filling the width. */
    function frameStorey(st) {
      var s = scene;
      return fitBox(s.x0, s.x1, st.y - SLAB, st.y + CLEAR + 0.2, -DEPTH, 0, 9, { top: 70, right: 80, bottom: 70, left: 80 });
    }

    /** Returns the view into a room, framed with room for the selection card at the bottom left. */
    function frameRoom(room) {
      var st = room.storey;
      var x = room.x0 - (room.shifted || 0) + (room.grown ? 0 : 0);
      var w = room.grown ? room.width : room.width - (room.grows || 0);
      return fitBox(x - 0.2, x + w + 0.2, st.y - SLAB * 0.6, st.y + CLEAR, -DEPTH, 0, 8, { top: 60, right: 90, bottom: 150, left: 90 });
    }

    /** Returns a named view: a team's room, a storey, the penthouse and its lift, or the whole building. */
    function findView(name) {
      if (!scene || !name) return null;
      var parts = String(name).split(":");
      if (parts[0] === "room") {
        var room = scene.rooms.filter(function (r) {
          return r.team.id === parts[1];
        })[0];
        return room ? frameRoom(room) : null;
      }
      if (parts[0] === "storey") return frameStorey(scene.layout.storeys[Number(parts[1])]);
      if (parts[0] === "queue") {
        var top = scene.layout.storeys[scene.layout.storeys.length - 1];
        return fitBox(top.deskX - 1.2, top.queueLine.x1 + 0.6, top.y - 0.2, top.y + CLEAR, -DEPTH, 0, 9, { top: 60, right: 90, bottom: 120, left: 90 });
      }
      if (parts[0] === "lift") {
        var pent = scene.layout.storeys[scene.layout.storeys.length - 1];
        return fitBox(pent.deskX - 1.4, scene.shaftX1 + PIER + 0.2, pent.y - PITCH * 1.2, pent.y + CLEAR + 0.3, -DEPTH, 0, 8, { top: 50, right: 90, bottom: 60, left: 90 });
      }
      return overview;
    }

    /**
     * Lines the floor nameplates up in one column for the whole-building view. Perspective makes a
     * vertical line in the scene lean a few pixels on screen, so each nameplate's point is moved
     * along the camera's right until it projects to the same x as the middle storey's.
     */
    function alignFloorLabels(view) {
      if (!scene || !scene.floorAnchors) return;
      var saved = { target: controls.target.clone(), position: camera.position.clone() };
      stage.view(view);
      camera.updateMatrixWorld();
      var anchors = scene.floorAnchors;
      anchors.forEach(function (a) {
        a.position.copy(a.userData.home);
      });
      var ref = anchors[Math.floor(anchors.length / 2)].position.clone().project(camera).x;
      var right = new T.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      var tanX = Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
      anchors.forEach(function (a) {
        var ndc = a.position.clone().project(camera).x;
        var depth = a.position.clone().applyMatrix4(camera.matrixWorldInverse).z;
        a.position.addScaledVector(right, (ref - ndc) * tanX * -depth);
      });
      controls.target.copy(saved.target);
      camera.position.copy(saved.position);
      camera.lookAt(controls.target);
      controls.update();
    }

    function flyToView(view, seconds) {
      if (reduced) {
        stage.view(view);
        return Promise.resolve();
      }
      return stage.flyTo(view.target, view.distance, { azimuth: view.azimuth, elevation: view.elevation, seconds: seconds || 0.9 });
    }

    /** Keeps the camera's target inside the building, so a drag never loses it. */
    function clampTarget() {
      if (!scene) return;
      var t = controls.target;
      // Into the building's frame.
      var lx = t.x * cosF - t.z * sinF + centreX;
      var lz = t.x * sinF + t.z * cosF;
      var cx = clamp(lx, scene.x0 - 4, scene.x1 + 4);
      var cy = clamp(t.y, scene.bottom, scene.crownTop);
      var cz = clamp(lz, -DEPTH - 2, 6);
      if (cx === lx && cy === t.y && cz === lz) return;
      var p = toWorld(cx, cy, cz);
      var dx = p.x - t.x;
      var dy = p.y - t.y;
      var dz = p.z - t.z;
      t.add(new T.Vector3(dx, dy, dz));
      camera.position.add(new T.Vector3(dx, dy, dz));
    }

    /** Returns how many CSS pixels one metre at the target covers now. */
    function measureScale() {
      var d = camera.position.distanceTo(controls.target);
      return host.clientHeight / 2 / (d * Math.tan((camera.fov * Math.PI) / 360));
    }

    var lod = "";
    var lastScale = 0;
    /** Picks the labels' level of detail from the scale: far shows floors and plaques, near shows the beans' tags. */
    function updateLevelOfDetail() {
      var scale = measureScale();
      var next = scale < 24 ? "tiny" : scale < 52 ? "far" : scale < 105 ? "mid" : "near";
      if (Math.abs(scale - lastScale) / Math.max(1, lastScale) > 0.03 || next !== lod) {
        lastScale = scale;
        container.style.setProperty("--tfo-ppm", scale.toFixed(2));
        foldCrampedPlaques(scale, next);
      }
      if (next !== lod) {
        container.classList.remove("tfo-lod-" + lod);
        lod = next;
        container.classList.add("tfo-lod-" + lod);
      }
      updateLiftPanel();
      hideRemoteTags();
    }

    var remoteAt = NaN;
    /**
     * Close up, shows the name tags of the storey in view and the next one only: a tag from a
     * storey cut off at the canvas edge is clutter. Runs when the camera's height changes.
     */
    function hideRemoteTags() {
      if (!scene) return;
      var y = controls.target.y;
      if (Math.abs(y - remoteAt) < 0.25) return;
      remoteAt = y;
      Object.keys(scene.beans).forEach(function (id) {
        var entry = scene.beans[id];
        var by = entry.bean.position.y + 1.0;
        entry.tag.classList.toggle("is-remote", Math.abs(by - y) > PITCH * 0.8);
      });
    }

    /**
     * Folds a plaque to its light and count when its room is too narrow for its name at this
     * scale, rather than showing a stub cut to three letters. Estimates the width from the
     * number of letters, so it reads no layout.
     */
    function foldCrampedPlaques(scale, level) {
      if (!scene) return;
      var perChar = level === "far" ? 5.5 : 6.1;
      scene.plaques.forEach(function (label) {
        var el = label.element.querySelector(".tfo-plaque");
        if (!el) return;
        var name = el.querySelector(".tfo-plaque__name");
        var width = parseFloat(el.style.getPropertyValue("--w")) || 0;
        var news = el.querySelector(".tfo-plaque__news");
        var needed = 24 + (name ? name.textContent.length * perChar : 0) + (el.querySelector(".tfo-plaque__count") ? 14 : 0) + (news ? news.textContent.length * 6 + 14 : 0);
        el.classList.toggle("is-cramped", level !== "near" && needed > width * scale - 6);
      });
    }

    /* -------------------------------------------------------------- the HUD: the lift panel and the legend */

    var panel = document.createElement("nav");
    panel.className = "tfo-lift";
    panel.setAttribute("aria-label", "Floors");
    hud.appendChild(panel);
    var legend = document.createElement("div");
    legend.className = "tfo-legend";
    legend.innerHTML =
      '<span><i class="tfo-legend__light is-waiting"></i>waiting on you</span>' +
      '<span><i class="tfo-legend__light is-working"></i>working</span>' +
      '<span><i class="tfo-legend__light is-quiet"></i>quiet</span>';
    hud.appendChild(legend);
    // In a portrait container the nameplates fold to numbers, so the whole-building view shows
    // the building's directory above it, as a lobby has one; each row rides to its floor.
    var directory = document.createElement("nav");
    directory.className = "tfo-directory";
    directory.setAttribute("aria-label", "Directory");
    hud.appendChild(directory);
    var caption = document.createElement("div");
    caption.className = "tfo-caption";
    caption.hidden = true;
    hud.appendChild(caption);

    function drawLiftPanel() {
      var s = scene;
      var buttons = '<button type="button" class="tfo-lift__all" data-tfo-floor="all" title="The whole building (0)"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
      s.layout.storeys
        .slice()
        .reverse()
        .forEach(function (st, i) {
          var index = s.layout.storeys.length - 1 - i;
          var title = st.kind === "project" ? st.name + (st.part ? " (" + st.part + ")" : "") : { cafe: "Basement · Café", runs: "Ground floor · Runs", secretariat: "Mezzanine · Secretariat", penthouse: "Penthouse · Your office" }[st.kind];
          var badge = st.kind === "penthouse" && s.plan.queue.length ? '<span class="tfo-lift__badge">' + s.plan.queue.length + "</span>" : "";
          var waits = st.kind === "project" && st.rooms.some(function (r) { return r.team.status === "waiting"; });
          buttons += '<button type="button" class="tfo-lift__btn' + (waits ? " has-wait" : "") + '" data-tfo-floor="' + index + '" title="' + escapeHtml(title) + '"><span>' + escapeHtml(st.number) + "</span>" + badge + "</button>";
        });
      panel.innerHTML = buttons;
      var rows = s.layout.storeys
        .slice()
        .reverse()
        .map(function (st, i) {
          var index = s.layout.storeys.length - 1 - i;
          var label = s.storeyLabels[index];
          var meta = label ? label.element.querySelector(".tfo-floor__meta").textContent : "";
          var name = st.kind === "project" ? st.name : { cafe: "Café des Égarés", runs: "Runs", secretariat: "Secretariat", penthouse: "Your office" }[st.kind];
          return (
            '<button type="button" class="tfo-directory__row' + (st.kind === "penthouse" && s.plan.queue.length ? " is-you" : "") + '" data-tfo-floor="' + index + '">' +
            '<span class="tfo-directory__num">' + escapeHtml(st.number) + "</span>" +
            '<b class="tfo-directory__name">' + (st.tint ? '<i class="tfo-floor__tint proj--' + st.tint + '"></i>' : "") + escapeHtml(name) + "</b>" +
            '<span class="tfo-directory__meta">' + escapeHtml(meta) + "</span></button>"
          );
        })
        .join("");
      directory.innerHTML = '<div class="tfo-directory__head"><span class="tfo-directory__firm">Rogier &amp; Co.</span><span>Directory</span></div>' + rows;
    }

    var litFloor = -1;
    function updateLiftPanel() {
      if (!scene) return;
      var y = controls.target.y;
      var best = -1;
      var whole = measureScale() < 40;
      if (!whole) {
        var bestD = Infinity;
        scene.layout.storeys.forEach(function (st, i) {
          var d = Math.abs(st.y + 1.2 - y);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
      }
      if (best === litFloor) return;
      litFloor = best;
      panel.querySelectorAll("[data-tfo-floor]").forEach(function (b) {
        var f = b.getAttribute("data-tfo-floor");
        b.classList.toggle("is-lit", f === "all" ? best === -1 : Number(f) === best);
      });
    }

    directory.addEventListener("click", function (e) {
      var b = e.target.closest("[data-tfo-floor]");
      if (b && scene) flyToView(frameStorey(scene.layout.storeys[Number(b.getAttribute("data-tfo-floor"))]));
    });

    panel.addEventListener("click", function (e) {
      var b = e.target.closest("[data-tfo-floor]");
      if (!b || !scene) return;
      var f = b.getAttribute("data-tfo-floor");
      if (f === "all") flyToView(overview);
      else flyToView(frameStorey(scene.layout.storeys[Number(f)]));
    });

    /* -------------------------------------------------------------- picking and selecting */

    var lastPick = { id: null, at: 0 };
    var stopPick = null;

    function wirePicking(s) {
      if (stopPick) stopPick();
      var targets = [];
      Object.keys(s.beans).forEach(function (id) {
        targets.push(s.beans[id].bean);
      });
      // A room is picked through an invisible sheet over its back wall, behind its people.
      s.rooms.forEach(function (room) {
        var sheet = new T.Mesh(new T.PlaneGeometry(1, CLEAR), pickMaterial);
        sheet.userData.room = room;
        s.liveBody.add(sheet);
        room.sheet = sheet;
        placeSheet(room);
        targets.push(sheet);
      });
      s.layout.storeys[1].benches.forEach(function (bench) {
        var sheet = new T.Mesh(new T.PlaneGeometry(bench.width, CLEAR), pickMaterial);
        sheet.position.set(bench.x + bench.width / 2, s.layout.storeys[1].y + CLEAR / 2, -DEPTH + 0.05);
        sheet.userData.bench = bench;
        s.liveBody.add(sheet);
        targets.push(sheet);
      });
      stopPick = stage.onPick(targets, function (object) {
        if (object.userData.room) return flyToView(frameRoom(object.userData.room));
        if (object.userData.bench) {
          var bench = object.userData.bench;
          var st = s.layout.storeys[1];
          return flyToView(fitBox(bench.x - 0.6, bench.x + bench.width + 0.6, st.y - SLAB * 0.6, st.y + CLEAR, -DEPTH, 0, 8, { top: 60, right: 90, bottom: 150, left: 90 }));
        }
        var id = object.colleagueId;
        var now = performance.now();
        if (lastPick.id === id && now - lastPick.at < 450) {
          lastPick.at = 0;
          if (api.onOpen) api.onOpen(id);
          return;
        }
        lastPick = { id: id, at: now };
        select(id, true);
        if (api.onSelect) api.onSelect(id);
      });
    }

    function placeSheet(room) {
      var st = room.storey;
      var w = room.grown || !room.grows ? room.width : room.width - room.grows;
      room.sheet.scale.x = w;
      room.sheet.position.set(room.x0 - (room.shifted || 0) + w / 2, st.y + CLEAR / 2, -DEPTH + 0.05);
    }

    /** Resolves an id the window may pass: a session, an assistant's name, or a run (its current session). */
    function resolveId(id) {
      if (!id || !scene) return null;
      if (scene.beans[id]) return id;
      var run = W.runs.filter(function (r) { return r.id === id; })[0];
      if (run) {
        var step = run.steps.filter(function (x) { return x.sessionId && scene.beans[x.sessionId]; })[0];
        return step ? step.sessionId : null;
      }
      return null;
    }

    /** Highlights a bean and glides the camera to it; null clears and flies back to the whole building. */
    function select(id, fromPick) {
      var resolved = resolveId(id);
      if (selectedId && scene && scene.beans[selectedId]) {
        scene.beans[selectedId].bean.rig.setSelected(false);
        scene.beans[selectedId].tag.classList.remove("is-selected");
      }
      selectedId = resolved;
      if (!resolved) {
        if (!fromPick && overview && id === null) flyToView(overview);
        return;
      }
      var entry = scene.beans[resolved];
      entry.bean.rig.setSelected(true);
      entry.tag.classList.add("is-selected");
      // Fly close, a little up and to the right of the bean, so the window's card at the bottom left stays clear.
      var p = entry.bean.getWorldPosition(new T.Vector3());
      var ly = p.y;
      var lx = p.x * cosF - p.z * sinF + centreX;
      var view = fitBox(lx - 1.7, lx + 2.3, ly - 0.7, ly + 2.3, -DEPTH, 0, 9, { top: 40, right: 80, bottom: 170, left: 300 });
      flyToView(view, 0.85);
      stage.requestRender();
    }

    /* -------------------------------------------------------------- hover */

    var raycaster = new T.Raycaster();
    var hovered = null;
    var hoverFrame = 0;
    var hoverAt = null;
    function onPointerMove(e) {
      if (e.buttons !== 0 || e.pointerType !== "mouse" || !scene) return;
      var r = host.getBoundingClientRect();
      hoverAt = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
      if (!hoverFrame) hoverFrame = requestAnimationFrame(decideHover);
    }
    function decideHover() {
      hoverFrame = 0;
      if (!hoverAt || !scene) return;
      raycaster.setFromCamera(new T.Vector2(hoverAt.x, hoverAt.y), camera);
      var list = Object.keys(scene.beans).map(function (id) {
        return scene.beans[id].bean;
      });
      var hit = raycaster.intersectObjects(list, true)[0];
      var found = null;
      if (hit) {
        for (var o = hit.object; o; o = o.parent) {
          if (o.colleagueId && scene.beans[o.colleagueId]) {
            found = scene.beans[o.colleagueId];
            break;
          }
        }
      }
      if (found === hovered) return;
      if (hovered) {
        hovered.bean.rig.setHovered(false);
        hovered.tag.classList.remove("is-hovered");
      }
      hovered = found;
      if (hovered) {
        hovered.bean.rig.setHovered(true);
        hovered.tag.classList.add("is-hovered");
      }
      stage.requestRender();
    }
    function onPointerLeave() {
      hoverAt = null;
      if (hovered) {
        hovered.bean.rig.setHovered(false);
        hovered.tag.classList.remove("is-hovered");
        hovered = null;
        stage.requestRender();
      }
    }
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerleave", onPointerLeave);

    /* -------------------------------------------------------------- riding up and down */

    // The wheel rides the camera up and down the building like the lift; a pinch (ctrl + wheel on
    // a trackpad) still zooms as the app's camera does.
    var ride = 0;
    function onWheel(e) {
      if (e.ctrlKey || e.metaKey || !scene) return;
      e.preventDefault();
      e.stopPropagation();
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      var metresPerPx = 1 / measureScale();
      ride += -dy * metresPerPx * 0.9;
      stage.requestRender();
    }
    container.addEventListener("wheel", onWheel, { capture: true, passive: false });

    function onKey(e) {
      if (!scene || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowUp" || e.key === "PageUp") ride += PITCH;
      else if (e.key === "ArrowDown" || e.key === "PageDown") ride -= PITCH;
      else if (e.key === "0" || e.key === "Home") flyToView(overview);
      else return;
      e.preventDefault();
      stage.requestRender();
    }
    container.addEventListener("keydown", onKey);

    var stopFrame = stage.onFrame(function (frame) {
      var moving = false;
      if (Math.abs(ride) > 0.002) {
        var step = ride * (1 - Math.exp(-frame.dt * 10));
        if (reduced) step = ride;
        ride -= step;
        controls.target.y += step;
        camera.position.y += step;
        moving = true;
      } else ride = 0;
      clampTarget();
      updateLevelOfDetail();
      if (scene) {
        for (var i = scene.animations.length - 1; i >= 0; i--) {
          var a = scene.animations[i];
          a.t += frame.dt;
          var done = a.step(Math.min(1, a.t / a.seconds), frame.dt) === false || a.t >= a.seconds;
          if (done && a.t >= a.seconds) {
            scene.animations.splice(i, 1);
            if (a.done) a.done();
          }
          moving = true;
        }
      }
      return moving;
    });

    /** Runs `step(progress)` over `seconds`, then `done()`. Returns a promise for its end. */
    function animate(seconds, step, done) {
      return new Promise(function (resolve) {
        if (reduced || seconds <= 0) {
          step(1, 0);
          if (done) done();
          resolve();
          return;
        }
        scene.animations.push({
          t: 0,
          seconds: seconds,
          step: step,
          done: function () {
            if (done) done();
            resolve();
          },
        });
        stage.requestRender();
      });
    }

    function wait(seconds) {
      return animate(seconds, function () {});
    }

    /* -------------------------------------------------------------- theme */

    /** Lights the night: door lights glow, pendants and doors light up, the city's windows come on. */
    function applyTheme() {
      if (!scene) return;
      var dark = K.isDarkTheme();
      nightLight.intensity = dark ? 1.0 : 0;
      scene.halos.forEach(function (halo) {
        var st = halo.userData.status;
        var color = st === "waiting" ? K.readColor("you") : st === "working" ? K.readColor("ok") : null;
        halo.visible = dark && !!color;
        if (color) halo.material.color.copy(color);
        halo.material.opacity = st === "waiting" ? 0.95 : 0.6;
      });
      scene.pendants.forEach(function (p) {
        p.material = dark ? K.paint("room-paper", "glow", { dl: 0.02, dc: 0.05 }) : K.paint("room-paper", "satin");
      });
      scene.glassDoors.forEach(function (m) {
        writeColor(m.color, dark ? "oklch(0.62 0.05 80)" : "oklch(0.9 0.012 200)");
        writeColor(m.emissive, "oklch(0.75 0.09 78)");
        m.emissiveIntensity = dark ? 0.55 : 0;
      });
      canvases.forEach(function (entry) {
        entry.redraw();
      });
      stage.requestRender();
    }

    var probe = document.createElement("canvas").getContext("2d");
    probe.canvas.width = probe.canvas.height = 1;
    /** Writes a CSS colour into a three.js colour through a canvas, so oklch() works. */
    function writeColor(target, css) {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = css;
      probe.fillRect(0, 0, 1, 1);
      var d = probe.getImageData(0, 0, 1, 1).data;
      target.setRGB(d[0] / 255, d[1] / 255, d[2] / 255, T.SRGBColorSpace);
    }

    // At night the rooms' own lights are on: a warm fill over the whole building, cheap as light
    // goes (one ambient term, no per-light loop), and off by day.
    var nightLight = new T.AmbientLight(0xffdcae, 0);
    stage.scene.add(nightLight);

    var stopPalette = K.subscribePalette(applyTheme);
    if (document.fonts && document.fonts.load) {
      Promise.all([document.fonts.load('640 40px "Bricolage Grotesque"'), document.fonts.load('40px "Limelight"')]).then(function () {
        if (disposed || !scene) return;
        canvases.forEach(function (entry) {
          entry.redraw();
        });
        stage.requestRender();
      });
    }

    /* -------------------------------------------------------------- the states' moments */

    /** Plays what a state shows beyond the everyday building: the spawn, the exchange, the stand-up, the return. */
    function direct(s) {
      caption.hidden = true;
      if (s.state === "spawn") playSpawn(s);
      else if (s.state === "exchange") playExchange(s);
      else if (s.state === "standup") playStandup(s);
      else if (s.state === "away") showAway(s);
    }

    function findRoom(s, teamId) {
      return s.rooms.filter(function (r) {
        return r.team.id === teamId;
      })[0];
    }

    /**
     * Runs a moment's steps in order. Each step gets `instant`: true under Reduce Motion, or for
     * the steps up to `api.moment` (office.html passes it, to freeze a moment for a capture). An
     * instant step puts things where the step ends at once and returns nothing; otherwise it
     * returns a promise for its end. A moment stops when the scene is rebuilt.
     */
    function runMoment(s, steps) {
      var names = steps.map(function (step) {
        return step.name;
      });
      var seek = api.moment ? names.indexOf(api.moment) : -1;
      var index = 0;
      function next() {
        if (scene !== s || index >= steps.length) return;
        var at = index++;
        var instant = reduced || at <= seek;
        var result = steps[at].run(instant);
        if (at === seek) return;
        if (instant) next();
        else Promise.resolve(result).then(next);
      }
      next();
    }

    /** Animates `step` over `seconds`, or jumps to its end when `instant`. */
    function animateStep(instant, seconds, step) {
      if (instant) {
        step(1, 0);
        return null;
      }
      return animate(seconds, step);
    }

    /** Walks a bean along points of the building's frame ([x, z] each), or puts it at the last at once. */
    function walkPath(instant, bean, points, facing) {
      if (instant) {
        var last = points[points.length - 1];
        standAt(bean, last[0], bean.position.y, last[1], facing);
        return null;
      }
      return points.reduce(function (promise, point, i) {
        return promise.then(function () {
          return walkTo(bean, point[0], point[1], i === points.length - 1 ? facing : null);
        });
      }, Promise.resolve());
    }

    /** Flies to a view, or places the camera there at once. */
    function viewStep(instant, view, seconds) {
      if (instant) {
        stage.view(view);
        return null;
      }
      return flyToView(view, seconds);
    }

    /** Returns the view of a team's room and the floor around it, for a moment. */
    function frameMoment(room, extraRight) {
      var st = room.storey;
      var x = room.x0 - (room.shifted || 0);
      return fitBox(x - 0.3, (extraRight || x + room.width) + 0.3, st.y - SLAB * 0.7, st.y + CLEAR + 0.15, -DEPTH, 0, 9, { top: 60, right: 90, bottom: 150, left: 90 });
    }

    /**
     * The spawn state: Rotate staging secrets starts its first partner. The room's wall slides to
     * make it a two-desk room, a new desk is set, and the partner comes up in the lift, steps
     * out along the floor and takes the desk; then its lead briefs it. Phases, for api.moment:
     * start, grow, ride, open, walk, seated.
     */
    function playSpawn(s) {
      var room = findRoom(s, W.spawn.lead);
      if (!room) return;
      var st = room.storey;
      var thread = W.spawn.thread;
      var grow = room.grows;
      var later = s.rooms.filter(function (r) {
        return r.storey === st && r.x0 > room.x0;
      });
      var from = {};
      later.forEach(function (r) {
        from[r.team.id] = { group: r.group.position.x, wall: r.rightWall.position.x, halo: r.halo ? r.halo.position.x : 0, beans: {} };
        Object.keys(r.desks).forEach(function (id) {
          if (s.beans[id]) from[r.team.id].beans[id] = s.beans[id].bean.position.clone();
        });
      });
      var wallFrom = room.rightWall.position.x;
      var plaqueFrom = room.plaqueAnchor.position.x;
      var desk = K.buildDesk();
      desk.object.rotation.y = Math.PI + 0.16;
      var deskX = room.newDeskX;
      var deskZ = -DEPTH + 1.18;
      desk.object.position.set(deskX, st.y, deskZ);
      desk.object.visible = false;
      room.group.add(desk.object);
      var below = s.layout.storeys[s.layout.storeys.indexOf(st) - 1];
      var lift = s.lift;
      var entry = addBean(s, thread.id, "thread", "working", { name: thread.role, state: describe(thread).provider + " · new", always: true });
      entry.record = thread;
      entry.room = room;
      var leadEntry = s.beans[W.spawn.lead];
      var view = fitBox(room.x0 - 0.3, s.shaftX1 + 0.5, st.y - SLAB * 0.9, st.y + CLEAR + 0.15, -DEPTH, 0, 9, { top: 60, right: 90, bottom: 150, left: 90 });

      runMoment(s, [
        {
          name: "start",
          run: function (instant) {
            placeCar(s, below.y);
            setGate(s, 0);
            standAt(entry.bean, lift.x, below.y, -DEPTH + 1.15, -Math.PI / 2);
            return viewStep(instant, view, 1.1);
          },
        },
        {
          name: "grow",
          run: function (instant) {
            // The wall slides; the rooms beyond it and the landing make way; the new desk is set.
            var slide = function (t) {
              var e = ease(t);
              room.rightWall.position.x = wallFrom + grow * e;
              room.plaqueAnchor.position.x = plaqueFrom + (grow / 2) * e;
              later.forEach(function (r) {
                var f = from[r.team.id];
                r.group.position.x = f.group + grow * e;
                r.rightWall.position.x = f.wall + grow * e;
                if (r.halo) r.halo.position.x = f.halo + grow * e;
                var shift = toWorld(grow * e, 0, 0).sub(toWorld(0, 0, 0));
                Object.keys(f.beans).forEach(function (id) {
                  var b = s.beans[id].bean;
                  b.position.x = f.beans[id].x + shift.x;
                  b.position.z = f.beans[id].z + shift.z;
                });
              });
            };
            var settle = function () {
              room.grown = true;
              later.forEach(function (r) {
                r.shifted = 0;
                placeSheet(r);
              });
              placeSheet(room);
              room.plaque.setContent(drawPlaque(s, room));
              foldCrampedPlaques(lastScale, lod);
              desk.object.visible = true;
            };
            if (instant) {
              slide(1);
              settle();
              return null;
            }
            return wait(0.6)
              .then(function () {
                return animate(1.4, slide);
              })
              .then(function () {
                settle();
                desk.object.scale.set(1, 0.02, 1);
                return animate(0.45, function (t) {
                  desk.object.scale.y = 0.02 + 0.98 * ease(t);
                });
              });
          },
        },
        {
          name: "ride",
          run: function (instant) {
            return animateStep(instant, 1.6, function (t) {
              var yy = below.y + (st.y - below.y) * ease(t);
              placeCar(s, yy);
              entry.bean.position.y = yy;
            });
          },
        },
        {
          name: "open",
          run: function (instant) {
            return animateStep(instant, 0.5, function (t) {
              setGate(s, ease(t));
            });
          },
        },
        {
          name: "walk",
          run: function (instant) {
            // Out through the landing, along the front of the floor, to beside the new desk.
            var x = room.x0 + deskX;
            return walkPath(instant, entry.bean, [
              [s.layout.inner - 0.75, -DEPTH + 1.15],
              [s.layout.inner - 0.75, -0.66],
              [x + 0.95, -0.66],
              [x + 0.95, deskZ - 0.2],
            ], -Math.PI / 2);
          },
        },
        {
          name: "seated",
          run: function () {
            entry.bean.sitAt(desk);
            entry.home = { desk: desk };
            entry.label.remove();
            entry.tag.classList.add("tfo-tag--desk");
            entry.label = stage.label(deskAnchor(desk), entry.tag);
            if (leadEntry) speak(s, W.spawn.lead, '<span class="tfo-bubble__head">lead briefs verify · ' + W.spawn.exchange.at + "</span>" + escapeHtml(W.spawn.exchange.text), { cls: "is-brief" });
            room.board.entry.redraw();
            wirePicking(s);
            stage.requestRender();
            return null;
          },
        },
      ]);
    }

    /**
     * The exchange state: the newest report between two threads in view. The cart refactor's tests
     * partner walks to its lead's desk and tells it what it found; the lead stands to listen.
     * Phases: start, walk, talk.
     */
    function playExchange(s) {
      var ex = W.exchanges.filter(function (e) {
        return e.kind === "report" && s.beans[e.from] && s.beans[e.to] && s.beans[e.to].room;
      });
      var last = ex[ex.length - 1];
      if (!last) return;
      var from = s.beans[last.from];
      var to = s.beans[last.to];
      var room = to.room;
      var st = room.storey;
      var spot = room.desks[last.to];
      var rx = room.x0 - (room.shifted || 0);
      runMoment(s, [
        {
          name: "start",
          run: function (instant) {
            return viewStep(instant, frameMoment(room), 1.0);
          },
        },
        {
          name: "walk",
          run: function (instant) {
            // The lead steps out in front of its desk; the partner comes round its own desk to face it.
            tagOverHead(to);
            tagOverHead(from);
            var px = rx + room.desks[last.from].x;
            var lx = rx + spot.x;
            var walks = [
              walkPath(instant, to.bean, [[lx - 0.95, spot.z], [lx - 0.95, spot.z + 0.8], [lx - 0.3, spot.z + 0.86]], 0.95),
              walkPath(instant, from.bean, [[px + 0.95, room.desks[last.from].z], [px + 0.95, spot.z + 0.86], [lx + 0.62, spot.z + 0.86]], -1.1),
            ];
            if (instant) {
              to.bean.play("listen");
              return null;
            }
            return Promise.all(walks).then(function () {
              to.bean.play("listen");
            });
          },
        },
        {
          name: "talk",
          run: function () {
            from.bean.play("talk");
            speak(s, last.from, '<span class="tfo-bubble__head">' + escapeHtml(from.record.role || "") + " reports to the lead · " + last.at + "</span>" + escapeHtml(last.text));
            stage.requestRender();
            return null;
          },
        },
      ]);
    }

    /**
     * The stand-up: the 3-D Secure team gathers at its whiteboard and each member says where it
     * stands, in its own words (the window's FIRM.standup lines, or its latest headline). The lead
     * comes down from your desk for it with its hand still up: it still waits on you.
     * Phases: start, gather, speak.
     */
    function playStandup(s) {
      var room = findRoom(s, "t3ds");
      if (!room) return;
      var st = room.storey;
      var rx = room.x0 - (room.shifted || 0);
      var lead = room.team.lead;
      var order = [room.team.members[1], lead, room.team.members[2]].filter(Boolean);
      var spots = [room.centre - 1.15, room.centre, room.centre + 1.15];
      var line = function (m) {
        if (FIRM && FIRM.standup && FIRM.standup[m.id]) return FIRM.standup[m.id];
        var hl = W.headlines[m.id];
        return hl && hl.length ? hl[hl.length - 1].text : m.result || "";
      };
      var upstairs = s.beans[lead.id];
      var down = addBean(s, lead.id + "::standup", "thread", "waiting", { name: "lead", state: lead.askShort || "waiting", look: K.buildSessionLook(lead.id, "thread") });
      down.alias = lead.id;
      down.record = lead;
      down.bean.visible = false;
      runMoment(s, [
        {
          name: "start",
          run: function (instant) {
            return viewStep(instant, frameMoment(room), 1.0);
          },
        },
        {
          name: "gather",
          run: function (instant) {
            if (upstairs) upstairs.bean.visible = false;
            if (room.desks[lead.id] && room.desks[lead.id].upstairs) room.desks[lead.id].upstairs.remove();
            var walks = order.map(function (m, i) {
              var x = rx + spots[i];
              var z = -1.0 + (m === lead ? 0.12 : 0);
              var facing = m === lead ? 0 : i === 0 ? 0.42 : -0.42;
              var who = m === lead ? down : s.beans[m.id];
              if (!who) return null;
              tagOverHead(who);
              if (m === lead) {
                down.bean.visible = true;
                standAt(down.bean, rx + DOOR_X, st.y, -DEPTH + 0.4, 0);
              }
              return walkPath(instant, who.bean, [[x, z]], facing);
            });
            return instant ? null : Promise.all(walks);
          },
        },
        {
          name: "speak",
          run: function (instant) {
            order.forEach(function (m, i) {
              var id = m === lead ? down.id : m.id;
              var who = s.beans[id];
              if (!who) return;
              if (m !== lead) who.bean.play(i === 0 ? "listen" : "talk");
              var say = function () {
                if (scene !== s) return;
                speak(s, id, '<span class="tfo-bubble__head">' + escapeHtml(m === lead ? "lead · waits on you" : m.role) + "</span>" + escapeHtml(line(m)), { cls: m === lead ? "is-you" : "" });
                stage.requestRender();
              };
              if (instant) say();
              else setTimeout(say, 300 + i * 700);
            });
            return null;
          },
        },
      ]);
    }

    /**
     * The away state: Rogier is back at 09:41 after 40 minutes. Each plaque marks its team: "new"
     * if it started while he was away, "+n" if it gained partners, "news" if a turn ended that he
     * has not read. The caption sums it up in the same terms.
     */
    function showAway(s) {
      var left = H.minutes(W.away.left);
      var fresh = 0;
      var grew = 0;
      s.rooms.forEach(function (r) {
        if (H.minutes(r.team.lead.started) > left) fresh++;
        else if (r.team.members.some(function (m) { return m !== r.team.lead && H.minutes(m.started) > left; })) grew++;
      });
      caption.hidden = false;
      caption.innerHTML =
        "<b>Back at " + W.away.back + "</b><span>away 40m · " + fresh + " new teams · " + grew + " grew · " + s.plan.queue.length + " wait on you</span>";
    }

    /* -------------------------------------------------------------- mount */

    function build(state) {
      clearScene();
      var s = buildScene(state);
      drawLiftPanel();
      wirePicking(s);
      litFloor = -2;
      remoteAt = NaN;
      overview = frameBuilding();
      alignFloorLabels(overview);
      container.dataset.state = state;
      return s;
    }

    var currentState = STATES.indexOf(api.state) >= 0 ? api.state : "everyday";
    var s0 = build(currentState);
    stage.view(overview);
    updateLevelOfDetail();
    if (api.selected) {
      select(api.selected);
    }
    direct(s0);

    // Refit the establishing shot when the container changes shape, unless the user has moved.
    var lastSize = host.clientWidth + "x" + host.clientHeight;
    var resizeObserver = new ResizeObserver(function () {
      var size = host.clientWidth + "x" + host.clientHeight;
      if (size === lastSize || !scene) return;
      lastSize = size;
      var atOverview = overview && controls.target.distanceTo(new T.Vector3().fromArray(overview.target)) < 0.5;
      overview = frameBuilding();
      alignFloorLabels(overview);
      if (atOverview && !selectedId) stage.view(overview);
      stage.requestRender();
    });
    resizeObserver.observe(host);

    return {
      select: function (id) {
        select(id || null);
      },
      setState: function (state) {
        if (STATES.indexOf(state) < 0) state = "everyday";
        currentState = state;
        var keep = selectedId;
        var s = build(state);
        if (keep && s.beans[keep]) select(keep);
        direct(s);
      },
      resize: function () {
        stage.requestRender();
      },
      pause: function () {
        stage.pause();
      },
      resume: function () {
        stage.resume();
      },
      dispose: function () {
        disposed = true;
        stopFrame();
        if (stopPick) stopPick();
        stopPalette();
        resizeObserver.disconnect();
        container.removeEventListener("wheel", onWheel, { capture: true });
        container.removeEventListener("keydown", onKey);
        clearScene();
        stage.dispose();
        container.innerHTML = "";
        container.classList.remove("ov-the-firm-office");
      },
      // For scripted checks, captures and the browser console: places the camera at once on
      // "room:<lead id>", "storey:<index from the basement>", "lift" or "all".
      show: function (name) {
        var view = findView(name);
        if (view) stage.view(view);
        stage.requestRender();
      },
      debug: function () {
        return { stage: stage, scene: scene, overview: overview, fly: flyToView, frameRoom: frameRoom, frameStorey: frameStorey };
      },
    };
  }
})();
