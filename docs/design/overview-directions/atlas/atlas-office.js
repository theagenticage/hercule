// PROTOTYPE - Atlas's Office mode: the City.
//
// Each repository is a small city on its own plinth: folders are districts, files are buildings.
// A building is as tall as its file is long, its windows are lit by the lines changed today, its
// roof trim takes the colour of every thread that changed it, scaffolding stands round it while
// those changes have not landed, and a crane stands over the big refactor. Each thread's bean
// works on the roof of the file it is in now. Two threads that change one file get a ring round
// it: tomato and dashed when a dry-run merge of their branches conflicts, brass when it is only an
// Edit Overlap. Threads that only read sit in the Library; what waits on you queues on the steps of
// the Town hall, which is your desk.
//
// It draws with the desktop app's own Office kit (../vendor/office-kit.js, OFFICE-KIT.md) and reads
// the shared morning (WORLD with world-plus). It exposes window.OfficeModes.atlas, the Office module
// contract in ../BUILDERS.md, plus one extra: handle.show(view) flies to a named view
// ("home", "webshop", "payments-api", "ops", "crossing", "refactor", "landed").
(function () {
  "use strict";

  /** The kit's globals, read when the module mounts. */
  var K = null;
  var T = null;

  /* ------------------------------------------------------------------ sizes, in metres */

  /** The distance between two building centres in a district. */
  var CELL = 2.5;
  /** The smallest and largest footprint of a building. */
  var FOOT_MIN = 1.4;
  var FOOT_MAX = 1.95;
  /** The pavement between a district's outer buildings and its kerb. */
  var MARGIN = 0.7;
  /** The street between two districts of one city. */
  var STREET = 2.0;
  /** The park between a city and the square, with a boulevard across it. */
  var BOULEVARD = 3.6;
  /** The pavement round a city's districts, inside its plinth. */
  var PAD = 0.9;
  /** The top of a city's plinth (its streets) and of a district's pavement, above the board. */
  var PLINTH_TOP = 0.2;
  var BLOCK_TOP = 0.3;
  /** A building's dark base, the pitch of its floors, and the parapet over its roof. */
  var SOCLE = 0.3;
  var FLOOR = 0.42;
  var PARAPET = 0.15;
  var PARAPET_THICK = 0.11;
  /** The square in the middle: the Town hall and the Library stand on it. */
  var SQUARE_W = 23;
  /** The lens, in degrees: longer than the app's 28, so the city reads as a model seen from afar. */
  var LENS = 22;
  /** Beyond this visible height the city shows its map labels; below NEAR it shows everything. */
  var FAR = 42;
  var NEAR = 13;
  /** How the camera looks at the city: from the south-east, as the app's Office does. */
  var AZIMUTH = 28;
  var ELEVATION = 41;

  /*
   * How each repository's folders are laid out: rows of districts from north to south, and which
   * side of the rows lines up with the square. Webshop lies east of the square, nearest the camera,
   * because the morning's conflict is in it; its rows line up on the west. Ops lies west, its rows
   * lined up on the east; payments-api lies north and is centred.
   */
  var CITY_PLAN = {
    webshop: {
      side: "east",
      align: "west",
      rows: [["src/i18n", "src/catalog", "e2e"], ["src/cart", "src/lib"], ["src/checkout", "styles"]],
    },
    "payments-api": {
      side: "north",
      align: "center",
      rows: [["docs", "test", "db/migrations"], ["src/webhooks", "src/refunds", "src/platform"], ["src/result", "src/payouts", "src/reports"]],
    },
    ops: {
      side: "west",
      align: "east",
      rows: [["terraform", "grafana/alerts", "grafana/legacy"], ["hosts", "grafana/dashboards"], ["postgres", "backups", "secrets/staging"]],
    },
  };

  /*
   * The few districts whose order matters, row by row from north to south and west to east. Any
   * other district puts its tallest files at the back. In these, the two crossings of the morning
   * stand where both threads can be seen: payment.ts faces totals.ts across the street, and
   * card-form.module.css faces checkout.css. "crane" is the lot the crane stands on.
   */
  var DISTRICT_GRIDS = {
    "webshop:src/checkout": [
      ["payment.ts", "payment.test.ts", "payment-errors.ts", "checkout-page.tsx", "address-form.tsx"],
      ["3ds-modal.tsx", "apple-pay.ts", "sepa.ts", "card-form.tsx", "card-form.module.css"],
    ],
    "webshop:src/cart": [
      ["coupon.ts", "discounts.ts", "cart-store.ts", "cart-page.tsx"],
      ["totals.ts", "totals.property.test.ts", "totals.test.ts", null],
    ],
    "webshop:styles": [
      [null, "catalog.css", "base.css"],
      ["checkout.css", "cart.css", "buttons.css"],
    ],
    "payments-api:src/payouts": [
      ["payouts.service.ts", "payout-list.ts", "payout-schedule.ts", "payout-export.ts", "payout-filters.ts"],
      ["payout-error.ts", "payouts.controller.ts", "payouts.routes.ts", null, "crane"],
    ],
  };

  /** How long after a click on a bean a second click counts as a double-click, in ms. */
  var DOUBLE_CLICK_MS = 500;
  /** A refactor that changes at least this many files gets the crane. */
  var CRANE_FILES = 20;

  /* ------------------------------------------------------------------ small helpers */

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  /** Hashes text to an unsigned 32-bit integer, the way crew.js and the kit hash a seed. */
  function hashText(text) {
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 13;
    h = Math.imul(h, 2246822507);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /** Returns a seeded random number generator: each call returns the next number in [0, 1). */
  function createRandom(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6d2b79f5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function baseName(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function find(list, test) {
    for (var i = 0; i < list.length; i++) if (test(list[i])) return list[i];
    return null;
  }

  /** Returns "+21 −9" as HTML, the added lines in ok green and the removed ones in tomato. */
  function drawDiff(plus, minus) {
    return (
      '<span class="ov-atlas-office__mono ov-atlas-office__plus">+' + plus + "</span> " +
      '<span class="ov-atlas-office__mono ov-atlas-office__minus">−' + minus + "</span>"
    );
  }

  /** Returns a tint token's name for a repository: the tokens say "payments", not "payments-api". */
  function tintOf(repo) {
    return repo === "payments-api" ? "payments" : repo;
  }

  /* ------------------------------------------------------------------ looks */

  /**
   * Returns the kit look of a colleague named `name`: the hue, shape and accessories crew.js gives
   * the same name, so a bean in the City matches its face in the sidebar and the selection card.
   * Without crew.js, the kit's own hash of the name (the same hash) decides.
   */
  function decideLook(name, kind) {
    var cast = window.Crew && window.Crew.lookFor ? window.Crew.lookFor(name) : null;
    if (cast === null) {
      var h = hashText(name);
      var wardrobe = ["none", "homburg", "bowtie", "tache", "monocle", "watch", "glasses", "tache+bowtie"];
      cast = { hue: K.HUES[h % 8], shape: K.SHAPES[(h >>> 4) % 4], acc: wardrobe[(h >>> 8) % 8] };
    }
    var hats = ["cloche", "beret", "headset"];
    var headwear = null;
    var accessories = (cast.acc === "none" ? [] : cast.acc.split("+")).filter(function (each) {
      if (hats.indexOf(each) !== -1) {
        headwear = each;
        return false;
      }
      return true;
    });
    // One head wears one hat: a run's visor replaces a homburg, as in the app.
    if (kind === "run") accessories = accessories.filter(function (each) { return each !== "homburg"; });
    var look = { hue: cast.hue, shape: cast.shape, accessories: accessories };
    if (headwear !== null) look.headwear = headwear;
    return look;
  }

  /* ------------------------------------------------------------------ the model of one state */

  /**
   * Returns every session the City draws in `state`: the morning's threads, the threads assistants
   * started, the run steps' sessions and the assistants, plus the swarm's threads in "swarm". Each
   * record carries what the City needs and nothing else.
   */
  function collectSessions(W, state) {
    var out = [];
    function addThread(t, swarm) {
      out.push({
        id: t.id,
        title: t.title,
        lookName: t.title,
        kind: "thread",
        pose: t.pose,
        project: t.project,
        workspace: t.workspace,
        lead: t.lead || null,
        role: t.role || null,
        last: t.last,
        ask: t.askShort || null,
        files: W.files[t.id] || null,
        swarm: swarm,
      });
    }
    W.threads.forEach(function (t) { addThread(t, false); });
    (W.assistantThreads || []).forEach(function (t) { addThread(t, false); });
    if (state === "swarm") W.swarm.threads.forEach(function (t) { addThread(t, true); });
    Object.keys(W.runSessions || {}).forEach(function (id) {
      var rs = W.runSessions[id];
      var run = find(W.runs, function (r) { return r.id === rs.run; });
      var waiting = find(W.waitingRuns || [], function (r) { return r.id === id; });
      out.push({
        id: id,
        title: rs.title,
        lookName: run ? run.title : rs.title,
        kind: "run",
        pose: rs.pose,
        project: rs.project,
        workspace: null,
        lead: null,
        role: null,
        last: rs.last,
        ask: waiting ? waiting.ask : rs.ask || null,
        files: W.files[id] || null,
        swarm: false,
      });
    });
    (W.assistants || []).forEach(function (a) {
      out.push({
        id: "assistant-" + a.name, title: a.name, lookName: a.name, kind: "assistant", pose: a.pose,
        project: null, workspace: null, lead: null, role: null, last: null, ask: null, files: null, swarm: false,
      });
    });
    return out;
  }

  /** Returns true when a session changed at least one file (a reverted edit counts: it was recorded). */
  function hasEdits(session) {
    return !!session.files && session.files.touched.some(function (f) { return f.how === "edit"; });
  }

  /**
   * Builds what the City shows in `state`: the sessions, the file each was in, the lines each file
   * changed today and by whom, the crossings, and what landed or changed while Rogier was away.
   */
  function buildModel(W, state) {
    var sessions = collectSessions(W, state);
    var byId = {};
    sessions.forEach(function (s) { byId[s.id] = s; });
    // In the land state, Tidy checkout CSS has merged PR #1281 into main: its changes have landed.
    var landed = state === "land" ? { tCss: true } : {};
    // In the away state, Rogier left at 09:01 and is back at 09:41. A session's edits count as made
    // while he was away when one of its turns ran in that window: the edit watch does not stamp
    // each edit with a time yet.
    var awayIds = {};
    if (state === "away" && W.away && W.turns) {
      var left = W.helpers.minutes(W.away.left);
      var back = W.helpers.minutes(W.away.back);
      sessions.forEach(function (s) {
        (W.turns[s.id] || []).forEach(function (span) {
          var from = W.helpers.minutes(span.from);
          var to = span.to == null ? back : W.helpers.minutes(span.to);
          if (from < back && to > left) awayIds[s.id] = true;
        });
      });
    }

    var files = {};
    function statOf(key) {
      return files[key] || (files[key] = { key: key, edits: [], reads: [], heat: 0, unlanded: 0, away: false });
    }
    sessions.forEach(function (s) {
      if (!s.files || !s.project || !W.repos[s.project]) return;
      s.files.touched.forEach(function (f) {
        var stat = statOf(s.project + ":" + f.path);
        if (f.how === "edit") {
          stat.edits.push({ id: s.id, plus: f.plus, minus: f.minus });
          stat.heat += f.plus + f.minus;
          if (!landed[s.id]) stat.unlanded += f.plus + f.minus;
          if (awayIds[s.id] && f.plus + f.minus > 0) stat.away = true;
        } else {
          stat.reads.push(s.id);
        }
      });
    });

    var crossings = (W.crossings || []).filter(function (c) {
      if (c.swarm && state !== "swarm") return false;
      if (!byId[c.a] || !byId[c.b]) return false;
      return !landed[c.a] && !landed[c.b];
    }).map(function (c) {
      return { a: c.a, b: c.b, kind: c.kind, note: c.note, key: byId[c.a].project + ":" + c.path, path: c.path };
    });

    // The workspaces whose branches exist in this state, for the files that are new on a branch.
    var workspaces = {};
    sessions.forEach(function (s) { if (s.workspace) workspaces[s.workspace] = true; });

    var awayFiles = 0;
    Object.keys(files).forEach(function (key) { if (files[key].away) awayFiles++; });

    return {
      state: state,
      sessions: sessions,
      byId: byId,
      files: files,
      crossings: crossings,
      landed: landed,
      workspaces: workspaces,
      awayFiles: awayFiles,
    };
  }

  /* ------------------------------------------------------------------ the layout of the cities */

  /** Returns how tall a building stands for a file of `lines` lines: a square root, clamped. */
  function decideHeight(lines) {
    return clamp(0.9 + 0.16 * Math.sqrt(lines), 1.5, 6.2);
  }

  /** Returns a building's footprint for a file of `lines` lines. */
  function decideFootprint(lines) {
    return clamp(1.4 + 0.2 * Math.log2(Math.max(1, lines) / 100), FOOT_MIN, FOOT_MAX);
  }

  /** Returns true for a test file, which gets a chequered roof. */
  function isTestFile(name, folder) {
    return /\.(test|spec)\./.test(name) || folder === "test" || folder === "e2e";
  }

  /** Returns the grid of one district: rows of file names (or null for an empty lot). */
  function decideGrid(repo, folder) {
    var fixed = DISTRICT_GRIDS[repo + ":" + folder.path];
    if (fixed) return fixed;
    var names = folder.files.slice().sort(function (a, b) { return b.lines - a.lines; }).map(function (f) { return f.name; });
    var cols = Math.ceil(names.length / 2);
    if (names.length <= 2) return names.map(function (n) { return [n]; });
    return [names.slice(0, cols), names.slice(cols)];
  }

  /**
   * Lays out every repository as a city round the square at the origin. Returns the cities, each
   * with its districts and buildings in world coordinates, and the square's size.
   */
  function layoutWorld(W) {
    var cities = {};
    Object.keys(CITY_PLAN).forEach(function (repo) {
      var plan = CITY_PLAN[repo];
      var folders = {};
      W.repos[repo].folders.forEach(function (f) { folders[f.path] = f; });
      var rows = plan.rows.map(function (paths) {
        var districts = paths.map(function (path) {
          var folder = folders[path];
          var grid = decideGrid(repo, folder);
          var cols = 0;
          grid.forEach(function (row) { cols = Math.max(cols, row.length); });
          return {
            key: repo + ":" + path,
            repo: repo,
            path: path,
            folder: folder,
            grid: grid,
            cols: cols,
            rows: grid.length,
            width: 2 * MARGIN + FOOT_MAX + (cols - 1) * CELL,
            depth: 2 * MARGIN + FOOT_MAX + (grid.length - 1) * CELL,
          };
        });
        var width = STREET * (districts.length - 1);
        var depth = 0;
        districts.forEach(function (d) {
          width += d.width;
          depth = Math.max(depth, d.depth);
        });
        return { districts: districts, width: width, depth: depth };
      });
      var width = 0;
      var depth = STREET * (rows.length - 1);
      rows.forEach(function (row) {
        width = Math.max(width, row.width);
        depth += row.depth;
      });
      cities[repo] = { repo: repo, plan: plan, rows: rows, width: width, depth: depth, districts: [] };
    });

    var squareD = cities.webshop.depth + 2 * PAD;
    var square = { width: SQUARE_W, depth: squareD };
    // Where each city's north-west corner (inside its pad) lands.
    var origins = {
      ops: [-SQUARE_W / 2 - BOULEVARD - PAD - cities.ops.width, squareD / 2 - PAD - cities.ops.depth],
      webshop: [SQUARE_W / 2 + BOULEVARD + PAD, squareD / 2 - PAD - cities.webshop.depth],
      "payments-api": [-cities["payments-api"].width / 2, -squareD / 2 - BOULEVARD - PAD - cities["payments-api"].depth],
    };

    var buildings = [];
    Object.keys(cities).forEach(function (repo) {
      var city = cities[repo];
      var ox = origins[repo][0];
      var oz = origins[repo][1];
      city.x0 = ox - PAD;
      city.z0 = oz - PAD;
      city.x1 = ox + city.width + PAD;
      city.z1 = oz + city.depth + PAD;
      var z = oz;
      city.rows.forEach(function (row) {
        var x = ox;
        if (city.plan.align === "east") x = ox + city.width - row.width;
        else if (city.plan.align === "center") x = ox + (city.width - row.width) / 2;
        row.districts.forEach(function (d) {
          d.x0 = x;
          d.z0 = z + row.depth - d.depth;
          d.x1 = x + d.width;
          d.z1 = d.z0 + d.depth;
          d.buildings = [];
          var lines = {};
          d.folder.files.forEach(function (f) { lines[f.name] = f; });
          d.grid.forEach(function (gridRow, r) {
            gridRow.forEach(function (name, c) {
              var bx = d.x0 + MARGIN + FOOT_MAX / 2 + c * CELL;
              var bz = d.z0 + MARGIN + FOOT_MAX / 2 + r * CELL;
              if (name === "crane") {
                d.craneLot = { x: bx, z: bz };
                return;
              }
              if (name === null || !lines[name]) return;
              var file = lines[name];
              var b = {
                index: buildings.length,
                key: repo + ":" + d.path + "/" + name,
                repo: repo,
                district: d,
                path: d.path + "/" + name,
                name: name,
                lines: file.lines,
                newIn: file.newIn || null,
                x: bx,
                z: bz,
                y0: BLOCK_TOP,
                foot: decideFootprint(file.lines),
                height: decideHeight(file.lines),
                test: isTestFile(name, d.path),
                row: r,
                lastRow: r === d.grid.length - 1,
              };
              buildings.push(b);
              d.buildings.push(b);
            });
          });
          city.districts.push(d);
          x += d.width + STREET;
        });
        z += row.depth + STREET;
      });
    });

    var byKey = {};
    buildings.forEach(function (b) { byKey[b.key] = b; });
    var x0 = Infinity;
    var x1 = -Infinity;
    var z0 = Infinity;
    var z1 = -Infinity;
    Object.keys(cities).forEach(function (repo) {
      var c = cities[repo];
      x0 = Math.min(x0, c.x0);
      x1 = Math.max(x1, c.x1);
      z0 = Math.min(z0, c.z0);
      z1 = Math.max(z1, c.z1);
    });
    return {
      cities: cities,
      square: square,
      buildings: buildings,
      byKey: byKey,
      bounds: { x0: x0, x1: x1, z0: z0, z1: Math.max(z1, squareD / 2) },
    };
  }

  /* ------------------------------------------------------------------ geometry helpers */

  /** Returns a box geometry `w` x `h` x `d` whose bottom sits at `y`, centred on x and z. */
  function box(w, h, d, x, y, z) {
    return new T.BoxGeometry(w, h, d).translate(x || 0, (y || 0) + h / 2, z || 0);
  }

  /** Merges geometries into one non-indexed geometry with positions, normals and uvs. */
  function mergeGeometries(list) {
    var count = 0;
    var parts = list.map(function (g) {
      var flat = g.index ? g.toNonIndexed() : g;
      count += flat.attributes.position.count;
      return flat;
    });
    var position = new Float32Array(count * 3);
    var normal = new Float32Array(count * 3);
    var uv = new Float32Array(count * 2);
    var at = 0;
    parts.forEach(function (g) {
      var n = g.attributes.position.count;
      position.set(g.attributes.position.array, at * 3);
      if (g.attributes.normal) normal.set(g.attributes.normal.array, at * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, at * 2);
      at += n;
      g.dispose();
    });
    var merged = new T.BufferGeometry();
    merged.setAttribute("position", new T.BufferAttribute(position, 3));
    merged.setAttribute("normal", new T.BufferAttribute(normal, 3));
    merged.setAttribute("uv", new T.BufferAttribute(uv, 2));
    merged.computeBoundingSphere();
    return merged;
  }

  /** Collects geometries per material, then builds one mesh per material. */
  function createBatch() {
    var groups = [];
    return {
      add: function (material, geometry, shadow) {
        var group = find(groups, function (g) { return g.material === material && g.shadow === (shadow !== false); });
        if (!group) groups.push((group = { material: material, shadow: shadow !== false, parts: [] }));
        group.parts.push(geometry);
      },
      build: function (name) {
        var root = new T.Group();
        root.name = name;
        groups.forEach(function (g) {
          var mesh = new T.Mesh(mergeGeometries(g.parts), g.material);
          mesh.castShadow = g.shadow;
          mesh.receiveShadow = true;
          root.add(mesh);
        });
        return root;
      },
    };
  }

  /* ------------------------------------------------------------------ colours that follow the theme */

  /**
   * Materials and colours the kit's palette does not paint itself: each is repainted by `paint`
   * whenever the theme changes (the kit calls back after it repaints its own).
   */
  function createTones() {
    var tones = [];
    function readOklch(token, dl, dc, dh) {
      var o = K.readToken(token);
      return { l: o.l + (dl || 0), c: Math.max(0, o.c + (dc || 0)), h: o.h + (dh || 0) };
    }
    return {
      /** Returns a material whose colour `decide(dark)` returns as OKLCH. */
      material: function (options, decide) {
        var material = new T.MeshStandardMaterial(options);
        tones.push({ material: material, decide: decide });
        K.writeOklch(material.color, decide(K.isDarkTheme()));
        return material;
      },
      /** Calls `repaint(dark)` now and after every change of theme. */
      watch: function (repaint) {
        tones.push({ repaint: repaint });
        repaint(K.isDarkTheme());
      },
      oklch: readOklch,
      color: function (token, dl, dc) {
        return K.writeOklch(new T.Color(), readOklch(token, dl, dc));
      },
      hue: function (hue, dl, dc) {
        var o = K.readHue(hue, "body");
        return K.writeOklch(new T.Color(), { l: o.l + (dl || 0), c: Math.max(0, o.c + (dc || 0)), h: o.h });
      },
      paint: function () {
        var dark = K.isDarkTheme();
        tones.forEach(function (t) {
          if (t.material) K.writeOklch(t.material.color, t.decide(dark));
          else t.repaint(dark);
        });
      },
    };
  }

  /** Returns the CSS colour of a token, for text drawn on a canvas. */
  function cssColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue("--" + name).trim() || "#888";
  }

  /**
   * Builds a flat sign lying on the ground (or standing, with `upright`): text drawn on a canvas
   * texture that redraws with the theme and when the typeface has loaded. `draw(context, w, h)`
   * paints it. Returns the mesh.
   */
  function buildCanvasSign(tones, width, height, pixelsPerMetre, draw, upright) {
    var canvas = document.createElement("canvas");
    canvas.width = Math.min(2048, Math.round(width * pixelsPerMetre));
    canvas.height = Math.max(8, Math.round(height * pixelsPerMetre));
    var texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    texture.anisotropy = 8;
    var material = new T.MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.9, metalness: 0, depthWrite: false });
    var geometry = new T.PlaneGeometry(width, height);
    if (!upright) geometry.rotateX(-Math.PI / 2);
    var mesh = new T.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    function redraw() {
      var context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      draw(context, canvas.width, canvas.height);
      texture.needsUpdate = true;
    }
    tones.watch(redraw);
    if (document.fonts) document.fonts.ready.then(redraw);
    return mesh;
  }

  /* ------------------------------------------------------------------ the still city */

  /**
   * Builds what never changes with the state: the board, the cities' plinths and streets, the
   * districts' pavements and their painted names, each city's name sign, the square with its
   * fountain, palms, benches and lamps, the boulevards, the street lamps and the trees. Returns
   * { group, districtMeshes, cityMeshes }: the meshes a click on a district or a city lands on.
   */
  function buildGround(layout, tones) {
    var batch = createBatch();
    var dark = function (light, evening) {
      return function (isDark) { return isDark ? evening() : light(); };
    };
    // The board is the card of an architect's model: pale in the morning, dark in the evening.
    var road = tones.material({ roughness: 0.96, metalness: 0 }, dark(
      function () { var o = tones.oklch("sunken", -0.035, 0.004); return o; },
      function () { return tones.oklch("sunken", 0.015, 0.002); }
    ));
    var boardSide = K.paint("room-inlay-2", "lacquer");
    var brass = K.paint("brass", "brass");
    var b = layout.bounds;
    var bx0 = b.x0 - 2.4;
    var bx1 = b.x1 + 2.4;
    var bz0 = b.z0 - 2.4;
    var bz1 = b.z1 + 4.2;
    var boardW = bx1 - bx0;
    var boardD = bz1 - bz0;
    var cx = (bx0 + bx1) / 2;
    var cz = (bz0 + bz1) / 2;
    // The board: its top is every boulevard; its lacquered edge carries a brass line.
    var board = new T.Mesh(new T.BoxGeometry(boardW, 0.7, boardD).translate(cx, -0.35, cz), [boardSide, boardSide, road, boardSide, boardSide, boardSide]);
    board.receiveShadow = true;
    board.castShadow = true;
    batch.add(brass, box(boardW + 0.04, 0.035, 0.05, cx, -0.14, bz1 + 0.005), false);
    batch.add(brass, box(boardW + 0.04, 0.035, 0.05, cx, -0.14, bz0 - 0.005), false);
    batch.add(brass, box(0.05, 0.035, boardD + 0.04, bx0 - 0.005, -0.14, cz), false);
    batch.add(brass, box(0.05, 0.035, boardD + 0.04, bx1 + 0.005, -0.14, cz), false);

    var districtMeshes = [];
    var cityMeshes = [];
    var group = new T.Group();
    group.name = "atlas-ground";
    group.add(board);

    Object.keys(layout.cities).forEach(function (repo) {
      var city = layout.cities[repo];
      var tint = "proj-" + tintOf(repo);
      var street = tones.material({ roughness: 0.92, metalness: 0 }, function (isDark) {
        var proj = tones.oklch(tint);
        return isDark ? { l: proj.l - 0.17, c: proj.c * 0.4, h: proj.h } : { l: proj.l - 0.045, c: proj.c * 0.62, h: proj.h };
      });
      var side = tones.material({ roughness: 0.6, metalness: 0 }, function (isDark) {
        return tones.oklch(tint, isDark ? -0.1 : -0.12, isDark ? 0 : 0.01);
      });
      var pave = tones.material({ roughness: 0.82, metalness: 0 }, function (isDark) {
        return tones.oklch(tint, isDark ? -0.07 : 0.045, isDark ? -0.02 : -0.012);
      });
      var kerb = tones.material({ roughness: 0.7, metalness: 0 }, function (isDark) {
        return tones.oklch(tint, isDark ? 0.05 : -0.05, isDark ? -0.01 : -0.01);
      });
      var w = city.x1 - city.x0;
      var d = city.z1 - city.z0;
      var plinth = new T.Mesh(new T.BoxGeometry(w, PLINTH_TOP, d).translate((city.x0 + city.x1) / 2, PLINTH_TOP / 2, (city.z0 + city.z1) / 2), [side, side, street, side, side, side]);
      plinth.receiveShadow = true;
      plinth.castShadow = true;
      plinth.userData.atlasCity = repo;
      group.add(plinth);
      cityMeshes.push(plinth);
      // A brass line along the plinth's top edge.
      batch.add(brass, box(w + 0.02, 0.02, 0.03, (city.x0 + city.x1) / 2, PLINTH_TOP - 0.02, city.z1 + 0.005), false);
      batch.add(brass, box(w + 0.02, 0.02, 0.03, (city.x0 + city.x1) / 2, PLINTH_TOP - 0.02, city.z0 - 0.005), false);
      batch.add(brass, box(0.03, 0.02, d + 0.02, city.x0 - 0.005, PLINTH_TOP - 0.02, (city.z0 + city.z1) / 2), false);
      batch.add(brass, box(0.03, 0.02, d + 0.02, city.x1 + 0.005, PLINTH_TOP - 0.02, (city.z0 + city.z1) / 2), false);

      city.districts.forEach(function (dist) {
        var dw = dist.x1 - dist.x0;
        var dd = dist.z1 - dist.z0;
        var mx = (dist.x0 + dist.x1) / 2;
        var mz = (dist.z0 + dist.z1) / 2;
        var block = new T.Mesh(new T.BoxGeometry(dw, BLOCK_TOP - PLINTH_TOP, dd).translate(mx, (PLINTH_TOP + BLOCK_TOP) / 2, mz), pave);
        block.receiveShadow = true;
        block.userData.atlasDistrict = dist.key;
        group.add(block);
        districtMeshes.push(block);
        // The kerb: a slightly darker edge round the pavement.
        batch.add(kerb, box(dw + 0.06, 0.035, 0.07, mx, BLOCK_TOP - 0.05, dist.z1), false);
        batch.add(kerb, box(dw + 0.06, 0.035, 0.07, mx, BLOCK_TOP - 0.05, dist.z0), false);
        batch.add(kerb, box(0.07, 0.035, dd, dist.x0, BLOCK_TOP - 0.05, mz), false);
        batch.add(kerb, box(0.07, 0.035, dd, dist.x1, BLOCK_TOP - 0.05, mz), false);
        // The district's name, painted on the street in front of it.
        var label = dist.path;
        var sign = buildCanvasSign(tones, Math.min(dw, 0.36 * label.length + 0.8), 0.62, 200, function (context, cw, ch) {
          context.font = "560 " + Math.round(ch * 0.62) + "px 'Bricolage Grotesque', sans-serif";
          context.letterSpacing = Math.round(ch * 0.05) + "px";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.globalAlpha = K.isDarkTheme() ? 0.62 : 0.55;
          context.fillStyle = cssColor(K.isDarkTheme() ? "muted" : "faint");
          context.fillText(label, cw / 2, ch * 0.54, cw);
        });
        sign.position.set(mx, PLINTH_TOP + 0.004, dist.z1 + STREET / 2);
        group.add(sign);
      });

      // The city's name on a lacquered Deco sign at its front, in brass display letters.
      var cityName = repo.toUpperCase();
      var signW = cityName.length * 0.5 + 1.2;
      var signX = (city.x0 + city.x1) / 2;
      var signZ = city.z1 - PAD / 2;
      batch.add(boardSide, box(signW, 0.62, 0.16, signX, PLINTH_TOP + 0.1, signZ));
      batch.add(brass, box(signW + 0.06, 0.04, 0.2, signX, PLINTH_TOP + 0.72, signZ));
      batch.add(brass, box(0.12, 0.1, 0.12, signX - signW / 2 + 0.4, PLINTH_TOP, signZ));
      batch.add(brass, box(0.12, 0.1, 0.12, signX + signW / 2 - 0.4, PLINTH_TOP, signZ));
      var face = buildCanvasSign(tones, signW - 0.08, 0.54, 260, function (context, cw, ch) {
        context.strokeStyle = cssColor("brass");
        context.lineWidth = Math.max(2, ch * 0.025);
        context.strokeRect(ch * 0.07, ch * 0.09, cw - ch * 0.14, ch - ch * 0.18);
        context.font = Math.round(ch * 0.56) + "px Limelight, serif";
        context.letterSpacing = Math.round(ch * 0.1) + "px";
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillStyle = cssColor("brass");
        context.fillText(cityName, cw / 2, ch * 0.55, cw * 0.9);
      }, true);
      face.position.set(signX, PLINTH_TOP + 0.41, signZ + 0.081);
      face.material.transparent = false;
      face.material.depthWrite = true;
      face.material.metalness = 0.2;
      group.add(face);
    });

    // The square: stone paving on a low plinth.
    var sq = layout.square;
    var squareSide = K.paint("room-inlay", "matte", { dl: -0.08 });
    batch.add(squareSide, box(sq.width, PLINTH_TOP - 0.01, sq.depth, 0, 0, 0));
    // Its floor: large pale slabs with faint joints, and brass rings round the fountain.
    var slabCanvas = document.createElement("canvas");
    slabCanvas.width = slabCanvas.height = 128;
    var slabTexture = new T.CanvasTexture(slabCanvas);
    slabTexture.colorSpace = T.SRGBColorSpace;
    slabTexture.wrapS = slabTexture.wrapT = T.RepeatWrapping;
    slabTexture.repeat.set(sq.width / 2.4, sq.depth / 2.4);
    slabTexture.anisotropy = 8;
    var slabs = new T.MeshStandardMaterial({ map: slabTexture, roughness: 0.7, metalness: 0 });
    tones.watch(function (isDark) {
      var context = slabCanvas.getContext("2d");
      var stoneTone = K.readToken("room-floor");
      context.fillStyle = "oklch(" + (isDark ? stoneTone.l + 0.02 : stoneTone.l - 0.025) + " " + stoneTone.c + " " + stoneTone.h + ")";
      context.fillRect(0, 0, 128, 128);
      context.fillStyle = "oklch(" + (isDark ? stoneTone.l - 0.05 : stoneTone.l - 0.09) + " " + stoneTone.c + " " + stoneTone.h + ")";
      context.fillRect(0, 0, 128, 2);
      context.fillRect(0, 0, 2, 128);
      slabTexture.needsUpdate = true;
    });
    var floorMesh = new T.Mesh(new T.PlaneGeometry(sq.width, sq.depth).rotateX(-Math.PI / 2), slabs);
    floorMesh.position.set(0, PLINTH_TOP - 0.008, 0);
    floorMesh.receiveShadow = true;
    group.add(floorMesh);

    // Boulevards across the parks, from the square to each city, and a promenade along the front.
    [-1, 1].forEach(function (side) {
      var path = K.buildPath(4.0, BOULEVARD + 0.3);
      path.rotation.y = Math.PI / 2;
      path.position.set(side * (SQUARE_W / 2 + BOULEVARD / 2), 0, 1.5);
      group.add(path);
    });
    var north = K.buildPath(4.0, BOULEVARD + 0.3);
    north.position.set(0, 0, -sq.depth / 2 - BOULEVARD / 2);
    group.add(north);
    var promenadeZ = b.z1 + 2.0;
    var promenade = K.buildPath(2.4, boardW - 1.2);
    promenade.rotation.y = Math.PI / 2;
    promenade.position.set(cx, 0, promenadeZ);
    group.add(promenade);

    // The fountain in the middle of the plaza, a stepped Deco basin.
    var fz = sq.depth / 2 - 5.0;
    var stone = K.paint("room-wall", "gloss", { dl: -0.04 });
    var water = tones.material({ roughness: 0.06, metalness: 0.25 }, function (isDark) {
      return isDark ? { l: 0.3, c: 0.03, h: 210 } : { l: 0.66, c: 0.05, h: 205 };
    });
    var basin = new T.LatheGeometry([
      new T.Vector2(0, 0), new T.Vector2(2.3, 0), new T.Vector2(2.3, 0.42), new T.Vector2(2.08, 0.42), new T.Vector2(2.08, 0.3), new T.Vector2(0, 0.3),
    ], 56).translate(0, PLINTH_TOP, fz);
    batch.add(stone, basin);
    batch.add(brass, new T.RingGeometry(3.6, 3.68, 64).rotateX(-Math.PI / 2).translate(0, PLINTH_TOP - 0.002, fz), false);
    batch.add(brass, new T.RingGeometry(3.85, 3.89, 64).rotateX(-Math.PI / 2).translate(0, PLINTH_TOP - 0.002, fz), false);
    batch.add(water, new T.CylinderGeometry(2.08, 2.08, 0.02, 56).translate(0, PLINTH_TOP + 0.33, fz), false);
    batch.add(stone, new T.CylinderGeometry(0.62, 0.8, 0.5, 8).translate(0, PLINTH_TOP + 0.55, fz));
    batch.add(stone, new T.CylinderGeometry(0.34, 0.44, 0.7, 8).translate(0, PLINTH_TOP + 1.15, fz));
    batch.add(brass, new T.CylinderGeometry(0.5, 0.5, 0.05, 24).translate(0, PLINTH_TOP + 0.82, fz));
    batch.add(brass, new T.SphereGeometry(0.2, 20, 12).translate(0, PLINTH_TOP + 1.65, fz));

    // Palms in planters, benches and lamps round the plaza and along the promenade.
    var palms = [[-SQUARE_W / 2 + 1.0, sq.depth / 2 - 1.0], [SQUARE_W / 2 - 1.0, sq.depth / 2 - 1.0], [-4.3, fz], [4.3, fz]];
    palms.forEach(function (p) {
      var palm = K.buildPlant("tall");
      palm.position.set(p[0], PLINTH_TOP - 0.01, p[1]);
      group.add(palm);
    });
    var edge = SQUARE_W / 2 - 0.5;
    var lamps = [
      [-edge, sq.depth / 2 - 0.5], [edge, sq.depth / 2 - 0.5], [-edge, -sq.depth / 2 + 0.5], [edge, -sq.depth / 2 + 0.5],
      [-2.9, fz + 2.7], [2.9, fz + 2.7],
      [-SQUARE_W / 2 - BOULEVARD / 2, 4.1], [SQUARE_W / 2 + BOULEVARD / 2, 4.1], [2.6, -sq.depth / 2 - BOULEVARD / 2],
      [bx0 + 9, promenadeZ - 1.6], [-15, promenadeZ - 1.6], [15, promenadeZ - 1.6], [bx1 - 9, promenadeZ - 1.6],
    ];
    var pools = [];
    lamps.forEach(function (p) {
      var lamp = K.buildLamppost();
      var onSquare = Math.abs(p[0]) <= SQUARE_W / 2 && Math.abs(p[1]) <= sq.depth / 2;
      lamp.position.set(p[0], onSquare ? PLINTH_TOP - 0.01 : 0, p[1]);
      group.add(lamp);
      pools.push([p[0], (onSquare ? PLINTH_TOP : 0) + 0.006, p[1], 2.6]);
    });

    // Street lamps at the crossings of each city's streets: a slim post and a globe, lit in the
    // evening. They hold no light of their own (a light per lamp would cost every frame); a pool of
    // lamplight painted on the street stands in for it.
    var spots = [];
    Object.keys(layout.cities).forEach(function (repo) {
      var city = layout.cities[repo];
      city.districts.forEach(function (d) {
        [[d.x0, d.z0], [d.x1, d.z0], [d.x0, d.z1], [d.x1, d.z1]].forEach(function (corner) {
          var x = clamp(corner[0] + (corner[0] === d.x0 ? -1 : 1) * (STREET / 2), city.x0 + 0.35, city.x1 - 0.35);
          var z = clamp(corner[1] + (corner[1] === d.z0 ? -1 : 1) * (STREET / 2), city.z0 + 0.35, city.z1 - 0.35);
          if (!spots.some(function (q) { return Math.hypot(q[0] - x, q[1] - z) < 2.2; })) spots.push([x, z]);
        });
      });
    });
    var postMesh = new T.InstancedMesh(new T.CylinderGeometry(0.022, 0.03, 1.5, 6).translate(0, 0.75, 0), K.paint("room-inlay-2", "satin", { dl: -0.04 }), spots.length);
    var globeMaterial = tones.material({ roughness: 0.4, metalness: 0 }, function (isDark) {
      return isDark ? { l: 0.93, c: 0.08, h: 85 } : tones.oklch("room-paper", -0.04, 0);
    });
    tones.watch(function (isDark) {
      globeMaterial.emissive.copy(isDark ? K.writeOklch(new T.Color(), { l: 0.8, c: 0.1, h: 82 }) : new T.Color(0, 0, 0));
    });
    var globeMesh = new T.InstancedMesh(new T.SphereGeometry(0.075, 10, 8).translate(0, 1.55, 0), globeMaterial, spots.length);
    var m4 = new T.Matrix4();
    spots.forEach(function (p, i) {
      m4.makeTranslation(p[0], PLINTH_TOP, p[1]);
      postMesh.setMatrixAt(i, m4);
      globeMesh.setMatrixAt(i, m4);
      pools.push([p[0], PLINTH_TOP + 0.004, p[1], 1.9]);
    });
    postMesh.castShadow = true;
    globeMesh.castShadow = false;
    postMesh.computeBoundingSphere();
    globeMesh.computeBoundingSphere();
    group.add(postMesh, globeMesh);

    // Trees on the card between the cities, the round ones of an architect's model: a slim trunk
    // and a ball of foliage, in rows along the parks' edges.
    var trees = [];
    function plant(x, z, size) {
      var near = function (q) { return Math.hypot(q[0] - x, q[1] - z) < 1.6; };
      var inCity = Object.keys(layout.cities).some(function (repo) {
        var c = layout.cities[repo];
        return x > c.x0 - 0.9 && x < c.x1 + 0.9 && z > c.z0 - 0.9 && z < c.z1 + 0.9;
      });
      var onSquare = Math.abs(x) < SQUARE_W / 2 + 0.9 && Math.abs(z) < sq.depth / 2 + 0.9;
      var onWalk = (Math.abs(z - 1.5) < 2.6 && Math.abs(x) > SQUARE_W / 2 && Math.abs(x) < SQUARE_W / 2 + BOULEVARD + 1) || (Math.abs(x) < 2.6 && z < -sq.depth / 2) || Math.abs(z - promenadeZ) < 1.6;
      if (inCity || onSquare || onWalk || trees.some(near) || x < bx0 + 0.8 || x > bx1 - 0.8 || z < bz0 + 0.8 || z > bz1 - 0.8) return;
      trees.push([x, z, size]);
    }
    var treeRandom = createRandom(hashText("trees"));
    for (var tx = bx0 + 1.2; tx < bx1 - 1; tx += 2.1) {
      for (var tz = bz0 + 1.2; tz < bz1 - 1; tz += 2.1) {
        if (treeRandom() < 0.4) plant(tx + (treeRandom() - 0.5) * 0.9, tz + (treeRandom() - 0.5) * 0.9, 0.75 + treeRandom() * 0.5);
      }
    }
    var trunkMesh = new T.InstancedMesh(new T.CylinderGeometry(0.035, 0.05, 1, 6).translate(0, 0.5, 0), K.paint("room-wood", "matte", { dl: -0.08 }), trees.length);
    var crownMaterial = tones.material({ roughness: 0.85, metalness: 0 }, function (isDark) {
      return isDark ? tones.oklch("room-lawn", -0.04, -0.01) : tones.oklch("room-lawn", 0.07, -0.015);
    });
    var crownMesh = new T.InstancedMesh(new T.IcosahedronGeometry(0.5, 2), crownMaterial, trees.length);
    trees.forEach(function (t, i) {
      m4.makeScale(1, t[2] * 0.9, 1).setPosition(t[0], 0, t[1]);
      trunkMesh.setMatrixAt(i, m4);
      m4.makeScale(t[2] * 1.15, t[2] * 1.25, t[2] * 1.15).setPosition(t[0], t[2] * 0.9 + t[2] * 0.45, t[1]);
      crownMesh.setMatrixAt(i, m4);
    });
    [trunkMesh, crownMesh].forEach(function (mesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    });

    var poolCanvas = document.createElement("canvas");
    poolCanvas.width = poolCanvas.height = 64;
    var poolContext = poolCanvas.getContext("2d");
    var poolGradient = poolContext.createRadialGradient(32, 32, 0, 32, 32, 32);
    poolGradient.addColorStop(0, "rgba(255,255,255,1)");
    poolGradient.addColorStop(0.4, "rgba(255,255,255,0.45)");
    poolGradient.addColorStop(1, "rgba(255,255,255,0)");
    poolContext.fillStyle = poolGradient;
    poolContext.fillRect(0, 0, 64, 64);
    var poolMaterial = new T.MeshBasicMaterial({ map: new T.CanvasTexture(poolCanvas), transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0.32 });
    var poolMesh = new T.InstancedMesh(new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolMaterial, pools.length);
    pools.forEach(function (p, i) {
      m4.makeScale(p[3] * 2, 1, p[3] * 2).setPosition(p[0], p[1], p[2]);
      poolMesh.setMatrixAt(i, m4);
    });
    poolMesh.castShadow = false;
    poolMesh.renderOrder = 1;
    poolMesh.computeBoundingSphere();
    tones.watch(function (isDark) {
      poolMesh.visible = isDark;
      K.writeOklch(poolMaterial.color, { l: 0.78, c: 0.08, h: 86 });
    });
    group.add(poolMesh);
    [-1, 1].forEach(function (x) {
      var bench = K.buildBench(2);
      bench.object.position.set(x * 3.4, PLINTH_TOP - 0.01, fz + 3.1);
      bench.object.rotation.y = Math.PI + x * 0.35;
      group.add(bench.object);
    });

    group.add(batch.build("atlas-ground-trim"));
    return { group: group, districtMeshes: districtMeshes, cityMeshes: cityMeshes };
  }

  /* ------------------------------------------------------------------ the Town hall */

  /**
   * Builds the Town hall: your desk under a cut-away roof, the "Now serving" sign behind it, the
   * assistants' writing desks along the west wall, a stepped Deco tower with a clock, and the steps
   * the queue stands on. Its origin is the middle of its room's floor at square level; it faces
   * south. Returns { object, nowServing, desks, queueSpots }.
   */
  function buildTownHall(tones) {
    var hall = new T.Group();
    hall.name = "town-hall";
    var ROOM_W = 7.2;
    var ROOM_D = 5.4;
    var PODIUM = 0.45;
    var stone = K.paint("room-wall", "matte", { dl: -0.035, dc: 0.008 });
    var dark = K.paint("room-inlay-2", "lacquer");
    var brass = K.paint("brass", "brass");
    var fins = K.paint("room-inlay-2", "lacquer", { dl: 0.08 });
    var batch = createBatch();
    // The podium and its three steps.
    batch.add(stone, box(ROOM_W + 0.8, PODIUM, ROOM_D + 1.0, 0, 0, 0.1));
    batch.add(dark, box(ROOM_W + 0.84, 0.08, ROOM_D + 1.04, 0, 0, 0.1));
    for (var s = 0; s < 2; s++) {
      batch.add(stone, box(4.6, PODIUM - (s + 1) * 0.15, 0.42, 0, 0, ROOM_D / 2 + 0.6 + 0.42 * (s + 0.5)));
    }
    var room = K.buildRoom({ width: ROOM_W, depth: ROOM_D, tint: null, windows: true, door: { wall: "south", at: 0, width: 1.8 } });
    room.position.y = PODIUM;
    hall.add(room);

    // The tower behind the room, stepping back the Deco way, with a clock and lit windows.
    var tz = -ROOM_D / 2 - 1.35;
    var tiers = [[4.0, 0, 5.4, 2.6], [3.0, 5.4, 7.9, 2.0], [2.1, 7.9, 9.7, 1.4]];
    tiers.forEach(function (t) {
      batch.add(stone, box(t[0], t[2] - t[1], t[3], 0, t[1], tz));
      batch.add(dark, box(t[0] + 0.08, 0.12, t[3] + 0.08, 0, t[2] - 0.12, tz));
      // Lacquer fins at the corners of the south face.
      [-1, 1].forEach(function (side) {
        batch.add(fins, box(0.14, t[2] - t[1] - 0.12, 0.1, side * (t[0] / 2 - 0.07), t[1], tz + t[3] / 2 + 0.03));
      });
    });
    batch.add(brass, new T.CylinderGeometry(0.26, 0.4, 0.55, 8).translate(0, 9.7, tz));
    batch.add(brass, new T.CylinderGeometry(0.02, 0.12, 1.3, 8).translate(0, 10.25, tz));
    // Tall windows on the tower, lit in the evening.
    var towerGlass = tones.material({ roughness: 0.3, metalness: 0 }, function (isDark) {
      return isDark ? { l: 0.84, c: 0.08, h: 84 } : tones.oklch("room-screen", 0.02, 0);
    });
    tones.watch(function (isDark) {
      towerGlass.emissive.copy(isDark ? K.writeOklch(new T.Color(), { l: 0.62, c: 0.09, h: 80 }) : new T.Color(0, 0, 0));
    });
    [-0.9, 0, 0.9].forEach(function (x) {
      batch.add(towerGlass, box(0.32, 1.5, 0.04, x, 3.5, tz + 1.31), false);
      batch.add(towerGlass, box(0.04, 3.6, 0.32, 2.01, 1.3, tz + x * 0.8), false);
    });
    [-0.5, 0.5].forEach(function (x) {
      batch.add(towerGlass, box(0.28, 1.0, 0.04, x, 8.2, tz + 0.71), false);
      batch.add(towerGlass, box(0.04, 1.0, 0.28, 1.06, 8.2, tz + x * 0.6), false);
    });
    hall.add(batch.build("town-hall-stone"));

    var clock = K.buildWallClock();
    clock.scale.setScalar(2.0);
    clock.position.set(0, 6.65, tz + 1.0 + 0.002);
    hall.add(clock);

    // Your desk, the bell and the in-tray, and the sign of how many wait on you.
    var desk = K.buildYourDesk();
    desk.object.position.set(0.4, PODIUM, -0.9);
    hall.add(desk.object);
    var nowServing = K.buildNowServing();
    nowServing.object.position.set(0.4, PODIUM + 1.36, -ROOM_D / 2 + K.WALL_THICKNESS / 2 + 0.002);
    hall.add(nowServing.object);
    var rug = K.buildRug(3.2, 2.0, { medallion: true });
    rug.position.set(0.4, PODIUM + 0.001, 0.75);
    hall.add(rug);
    [[-ROOM_W / 2 + 0.45, -ROOM_D / 2 + 0.45], [ROOM_W / 2 - 0.45, -ROOM_D / 2 + 0.45]].forEach(function (p) {
      var lamp = K.buildFloorLamp();
      lamp.object.position.set(p[0], PODIUM, p[1]);
      hall.add(lamp.object);
    });
    var palm = K.buildPlant("small");
    palm.position.set(ROOM_W / 2 - 0.55, PODIUM, 1.9);
    hall.add(palm);
    // The assistants' writing desks along the west wall: Ada, Milo and Juno work for you here.
    var desks = [-1.35, 0.05, 1.45].map(function (z) {
      var writing = K.buildWritingDesk();
      writing.object.rotation.y = -Math.PI / 2;
      writing.object.position.set(-ROOM_W / 2 + 0.85, PODIUM, z);
      hall.add(writing.object);
      return writing;
    });

    // Where the queue stands: on the landing, down the steps, then out over the square, oldest first.
    var queueSpots = [];
    var stepZ = ROOM_D / 2 + 0.6;
    var spots = [[-0.55, PODIUM, ROOM_D / 2 + 0.28], [0.25, PODIUM - 0.15, stepZ + 0.21], [1.0, PODIUM - 0.3, stepZ + 0.63], [1.7, 0, stepZ + 1.25]];
    spots.forEach(function (p) { queueSpots.push(p); });
    for (var q = 0; q < 8; q++) queueSpots.push([2.2 + q * 0.32, 0, stepZ + 1.75 + q * 0.62]);
    return { object: hall, nowServing: nowServing, desks: desks, queueSpots: queueSpots };
  }

  /* ------------------------------------------------------------------ the Library */

  /**
   * Builds the Library: a round reading room under a brass-ribbed glass dome on a ring of columns,
   * bookcases round its north side, and armchairs for the threads that only read. Its origin is
   * the middle of its floor at square level. Returns { object, seats, floorY }.
   */
  function buildLibrary(tones) {
    var lib = new T.Group();
    lib.name = "library";
    var R = 4.0;
    var FLOOR_Y = 0.32;
    var COLUMN_H = 2.9;
    var stone = K.paint("room-wall", "gloss", { dl: -0.03 });
    var brass = K.paint("brass", "brass");
    var dark = K.paint("room-inlay-2", "lacquer");
    var floorTone = K.paint("room-floor", "gloss", { dl: -0.02 });
    var batch = createBatch();
    batch.add(stone, new T.CylinderGeometry(R + 0.55, R + 0.6, 0.16, 64).translate(0, 0.08, 0));
    batch.add(stone, new T.CylinderGeometry(R + 0.25, R + 0.3, 0.16, 64).translate(0, 0.24, 0));
    batch.add(floorTone, new T.CylinderGeometry(R + 0.02, R + 0.02, 0.012, 64).translate(0, FLOOR_Y + 0.006, 0), false);
    batch.add(brass, new T.RingGeometry(2.9, 2.96, 64).rotateX(-Math.PI / 2).translate(0, FLOOR_Y + 0.014, 0), false);
    batch.add(brass, new T.RingGeometry(1.2, 1.24, 48).rotateX(-Math.PI / 2).translate(0, FLOOR_Y + 0.014, 0), false);
    var columns = 12;
    for (var i = 0; i < columns; i++) {
      var a = (i / columns) * Math.PI * 2 + Math.PI / columns;
      var x = Math.sin(a) * R;
      var z = Math.cos(a) * R;
      batch.add(stone, new T.CylinderGeometry(0.15, 0.17, COLUMN_H, 14).translate(x, FLOOR_Y + COLUMN_H / 2, z));
      batch.add(brass, new T.CylinderGeometry(0.22, 0.22, 0.08, 14).translate(x, FLOOR_Y + COLUMN_H - 0.08, z));
      batch.add(dark, new T.CylinderGeometry(0.24, 0.24, 0.12, 14).translate(x, FLOOR_Y, z));
    }
    // The entablature ring, lacquered with a brass line, under the dome.
    var ringY = FLOOR_Y + COLUMN_H;
    var ring = new T.LatheGeometry([new T.Vector2(R - 0.45, 0), new T.Vector2(R + 0.42, 0), new T.Vector2(R + 0.42, 0.42), new T.Vector2(R - 0.45, 0.42), new T.Vector2(R - 0.45, 0)], 64).translate(0, ringY, 0);
    batch.add(stone, ring);
    batch.add(dark, new T.CylinderGeometry(R + 0.44, R + 0.44, 0.1, 64, 1, true).translate(0, ringY + 0.2, 0));
    batch.add(brass, new T.CylinderGeometry(R + 0.46, R + 0.46, 0.025, 64, 1, true).translate(0, ringY + 0.29, 0));
    // The dome's brass ribs and rings, and a lantern on top.
    var domeY = ringY + 0.42;
    var DOME_R = R + 0.1;
    var DOME_H = 2.2;
    var ribs = 16;
    for (var r = 0; r < ribs; r++) {
      var angle = (r / ribs) * Math.PI * 2;
      var points = [];
      for (var k = 0; k <= 14; k++) {
        var t = (k / 14) * (Math.PI / 2) * 0.93;
        points.push(new T.Vector3(Math.cos(t) * DOME_R * Math.sin(angle), domeY + Math.sin(t) * DOME_H, Math.cos(t) * DOME_R * Math.cos(angle)));
      }
      batch.add(brass, new T.TubeGeometry(new T.CatmullRomCurve3(points), 18, 0.035, 5, false));
    }
    [0.35, 0.68].forEach(function (f) {
      var t = Math.asin(f);
      batch.add(brass, new T.TorusGeometry(Math.cos(t) * DOME_R, 0.03, 6, 64).rotateX(Math.PI / 2).translate(0, domeY + f * DOME_H, 0));
    });
    var crownY = domeY + DOME_H * 0.995;
    batch.add(brass, new T.CylinderGeometry(0.62, 0.7, 0.16, 24).translate(0, crownY - 0.08, 0));
    batch.add(stone, new T.CylinderGeometry(0.44, 0.5, 0.5, 12).translate(0, crownY + 0.08, 0));
    batch.add(brass, new T.ConeGeometry(0.5, 0.4, 12).translate(0, crownY + 0.78, 0));
    batch.add(brass, new T.SphereGeometry(0.1, 12, 8).translate(0, crownY + 1.04, 0));
    lib.add(batch.build("library-stone"));

    // The glass of the dome: green-tinted, see-through, casting no shadow.
    var glass = tones.material({ roughness: 0.1, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false, side: T.DoubleSide }, function (isDark) {
      return isDark ? tones.oklch("room-lamp", -0.12, -0.04) : tones.oklch("room-lamp", 0.1, -0.03);
    });
    var domeGeometry = new T.SphereGeometry(DOME_R - 0.02, 48, 14, 0, Math.PI * 2, 0.08, Math.PI / 2 - 0.08);
    domeGeometry.scale(1, DOME_H / DOME_R, 1);
    var dome = new T.Mesh(domeGeometry.translate(0, domeY, 0), glass);
    dome.castShadow = false;
    dome.renderOrder = 2;
    lib.add(dome);

    // Bookcases round the north half, facing in, each with its books.
    var bookParts = createBatch();
    var bookTones = [
      K.paint("room-fabric", "satin"), K.paint("room-wood", "satin", { dl: 0.06 }), K.paint("room-paper", "paper", { dl: -0.06 }),
      K.paint("room-inlay-2", "satin", { dl: 0.1 }), K.paint("room-panel", "satin"), K.paint("room-cork", "paper", { dl: -0.04 }),
    ];
    var cases = 9;
    for (var c = 0; c < cases; c++) {
      var ca = Math.PI * (0.62 + (c / (cases - 1)) * 0.76);
      var cx = Math.sin(ca) * (R - 0.62);
      var cz = Math.cos(ca) * (R - 0.62);
      var bookcase = K.buildBookcase();
      bookcase.position.set(cx, FLOOR_Y, cz);
      bookcase.rotation.y = ca + Math.PI;
      lib.add(bookcase);
      var random = createRandom(hashText("books" + c));
      for (var shelf = 0; shelf < 4; shelf++) {
        var bx = -0.34;
        var y = FLOOR_Y + 0.105 + shelf * 0.325;
        while (bx < 0.33) {
          var bw = 0.026 + random() * 0.026;
          var bh = 0.18 + random() * 0.09;
          if (bx + bw > 0.35) break;
          var geometry = box(bw - 0.003, bh, 0.2, bx + bw / 2, 0, 0.02);
          geometry.applyMatrix4(new T.Matrix4().makeRotationY(ca + Math.PI));
          geometry.translate(cx, y, cz);
          bookParts.add(bookTones[Math.floor(random() * bookTones.length)], geometry, false);
          bx += bw + (random() < 0.12 ? 0.04 : 0);
        }
      }
    }
    lib.add(bookParts.build("library-books"));
    var rug = K.buildRug(4.2, 3.0, { medallion: true });
    rug.position.set(0, FLOOR_Y + 0.013, 0.5);
    lib.add(rug);
    [[-2.7, -1.6], [2.7, -1.6]].forEach(function (p) {
      var lamp = K.buildFloorLamp();
      lamp.object.position.set(p[0], FLOOR_Y, p[1]);
      lib.add(lamp.object);
    });

    // Armchairs in rows, front rows first, all turned toward the camera's side so each reader
    // shows its face and its newspaper.
    var seats = [];
    [[2.3, [-1.2, 0, 1.2]], [1.1, [-2.3, -1.15, 0, 1.15, 2.3]], [-0.1, [-2.5, -1.25, 0, 1.25, 2.5]], [-1.3, [-1.8, -0.6, 0.6, 1.8]]].forEach(function (row) {
      row[1].forEach(function (x) { seats.push([x, row[0], 0.42 + x * 0.05]); });
    });
    return { object: lib, seats: seats, floorY: FLOOR_Y };
  }

  /* ------------------------------------------------------------------ the crane */

  /**
   * Builds the tower crane over a big refactor: a lattice mast, a jib pointing at the file the
   * refactor's thread is in now, its counter-jib and weights, the cab, and a hook with a load of
   * beams hanging over that file's roof. `to` is the point the hook hangs over. Returns the object.
   */
  function buildCrane(at, to, hookY) {
    var paint = K.paint("room-fabric", "lacquer", { dl: 0.02 });
    var brass = K.paint("brass", "brass");
    var weight = K.paint("room-wall", "matte", { dl: -0.16 });
    var wood = K.paint("room-wood", "satin");
    var batch = createBatch();
    var H = 11.2;
    var S = 0.66;
    var bar = 0.055;
    var y0 = BLOCK_TOP;
    function rod(a, b, thickness) {
      var dir = new T.Vector3().subVectors(b, a);
      var length = dir.length();
      var geometry = new T.BoxGeometry(thickness, thickness, length);
      var m = new T.Matrix4().lookAt(new T.Vector3(0, 0, 0), dir, new T.Vector3(0, 1, 0));
      if (Math.abs(dir.clone().normalize().y) > 0.99) m.lookAt(new T.Vector3(0, 0, 0), dir, new T.Vector3(1, 0, 0));
      geometry.applyMatrix4(m);
      geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
      return geometry;
    }
    // The base and the mast.
    batch.add(weight, box(1.5, 0.3, 1.5, at.x, y0, at.z));
    var corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    corners.forEach(function (c) {
      batch.add(paint, box(bar, H, bar, at.x + c[0] * S / 2, y0 + 0.3, at.z + c[1] * S / 2));
    });
    for (var y = y0 + 0.3; y < y0 + H; y += S) {
      for (var side = 0; side < 4; side++) {
        var c1 = corners[side];
        var c2 = corners[(side + 1) % 4];
        var p1 = new T.Vector3(at.x + c1[0] * S / 2, y, at.z + c1[1] * S / 2);
        var p2 = new T.Vector3(at.x + c2[0] * S / 2, y + S, at.z + c2[1] * S / 2);
        batch.add(paint, rod(p1, new T.Vector3(p2.x, y, p2.z), bar * 0.7));
        batch.add(paint, rod(p1, p2, bar * 0.55));
      }
    }
    // The jib toward `to`, the counter-jib behind, and the tower head over the mast.
    var top = y0 + H + 0.3;
    var dir = new T.Vector3(to.x - at.x, 0, to.z - at.z);
    var reach = dir.length() + 1.7;
    dir.normalize();
    var across = new T.Vector3(-dir.z, 0, dir.x);
    var jibTip = new T.Vector3(at.x + dir.x * reach, top, at.z + dir.z * reach);
    var back = new T.Vector3(at.x - dir.x * 3.4, top, at.z - dir.z * 3.4);
    function chord(from, to2, offsetAcross, offsetY) {
      var a = from.clone().addScaledVector(across, offsetAcross);
      a.y += offsetY;
      var b = to2.clone().addScaledVector(across, offsetAcross);
      b.y += offsetY;
      return rod(a, b, bar);
    }
    batch.add(paint, chord(back, jibTip, -0.3, 0));
    batch.add(paint, chord(back, jibTip, 0.3, 0));
    batch.add(paint, chord(new T.Vector3(at.x, top, at.z), jibTip, 0, 0.55));
    var steps = Math.floor(reach / 0.7);
    for (var i = 0; i <= steps; i++) {
      var f = i / steps;
      var p = new T.Vector3(at.x + dir.x * reach * f, top, at.z + dir.z * reach * f);
      var l = p.clone().addScaledVector(across, -0.3);
      var r = p.clone().addScaledVector(across, 0.3);
      var u = p.clone();
      u.y += 0.55 * (1 - f * 0.1);
      batch.add(paint, rod(l, r, bar * 0.6));
      if (i % 2 === 0) {
        batch.add(paint, rod(l, u, bar * 0.5));
        batch.add(paint, rod(r, u, bar * 0.5));
      }
    }
    var head = new T.Vector3(at.x, top + 2.1, at.z);
    batch.add(paint, rod(new T.Vector3(at.x - across.x * 0.3, top, at.z - across.z * 0.3), head, bar));
    batch.add(paint, rod(new T.Vector3(at.x + across.x * 0.3, top, at.z + across.z * 0.3), head, bar));
    batch.add(brass, rod(head, new T.Vector3(jibTip.x, top + 0.55, jibTip.z), 0.022));
    batch.add(brass, rod(head, back, 0.022));
    // The counterweights and the cab.
    batch.add(weight, box(1.0, 0.9, 1.0, back.x + dir.x * 0.5, top - 0.9, back.z + dir.z * 0.5));
    batch.add(weight, box(1.0, 0.9, 1.0, back.x + dir.x * 1.35, top - 0.9, back.z + dir.z * 1.35));
    var cabX = at.x + dir.x * 0.75 + across.x * 0.62;
    var cabZ = at.z + dir.z * 0.75 + across.z * 0.62;
    batch.add(brass, box(0.8, 0.85, 0.8, cabX, top - 0.95, cabZ));
    batch.add(K.paint("room-screen", "gloss"), box(0.82, 0.38, 0.6, cabX, top - 0.55, cabZ), false);
    // The trolley, the cable and the hook with its load of beams.
    batch.add(brass, box(0.5, 0.18, 0.5, to.x, top - 0.12, to.z));
    batch.add(K.paint("room-inlay-2", "satin"), box(0.02, top - hookY - 0.65, 0.02, to.x, hookY + 0.5, to.z), false);
    batch.add(brass, new T.TorusGeometry(0.11, 0.03, 6, 14, Math.PI * 1.4).translate(to.x, hookY + 0.42, to.z));
    for (var beam = 0; beam < 3; beam++) {
      batch.add(wood, box(1.3, 0.09, 0.12, to.x, hookY + beam * 0.095, to.z - 0.13 + beam * 0.13 * (beam === 1 ? 0 : 1)));
    }
    var crane = batch.build("crane");
    return { object: crane, top: top + 2.3, jibTip: jibTip };
  }

  /* ------------------------------------------------------------------ the buildings of one state */

  /**
   * The window material: dark glass, lit by its instance colour, pulsing for "changed while away".
   * The instance colour feeds the glow, not the glass: three.js names it vColor in the fragment
   * shader and defines USE_COLOR there, not USE_INSTANCING_COLOR.
   */
  function buildWindowMaterial(tones, pulse, dim) {
    var material = tones.material({ roughness: 0.18, metalness: 0.1 }, function (isDark) {
      return isDark ? tones.oklch("room-screen", 0.03, 0) : { l: 0.56, c: 0.025, h: 215 };
    });
    material.onBeforeCompile = function (shader) {
      shader.uniforms.uPulse = pulse;
      shader.uniforms.uDim = dim;
      shader.vertexShader = "attribute float aAway;\nvarying float vAway;\n" + shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vAway = aAway;");
      shader.fragmentShader = "uniform float uPulse;\nuniform float uDim;\nvarying float vAway;\n" + shader.fragmentShader
        .replace("#include <color_fragment>", "")
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\n  totalEmissiveRadiance = vColor.rgb * mix(uDim, 1.0 + uPulse, vAway);\n#endif");
    };
    material.customProgramCacheKey = function () { return "atlas-window"; };
    return material;
  }

  /** Builds the chequered deck a test file's roof wears, as a texture that follows the theme. */
  function buildCheckMaterial(tones) {
    var canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    var texture = new T.CanvasTexture(canvas);
    texture.colorSpace = T.SRGBColorSpace;
    texture.magFilter = T.NearestFilter;
    var material = new T.MeshStandardMaterial({ map: texture, roughness: 0.6 });
    tones.watch(function () {
      var context = canvas.getContext("2d");
      context.fillStyle = cssColor("room-paper");
      context.fillRect(0, 0, 64, 64);
      context.fillStyle = cssColor("room-inlay-2");
      for (var y = 0; y < 4; y++) for (var x = 0; x < 4; x++) if ((x + y) % 2 === 0) context.fillRect(x * 16, y * 16, 16, 16);
      texture.needsUpdate = true;
    });
    return material;
  }

  /**
   * Plans the scaffolding round every file whose changes have not landed: brass poles and ledgers,
   * wooden boards on the faces toward the camera, and a brace. It rises with the share of the
   * file being changed, and stands full height on a file that is new on a branch. Returns
   * { poles, boards }, each a list of bars { x, y, z, sx, sy, sz, key, roll?, pitch? }.
   */
  function planScaffolding(list, model) {
    var poles = [];
    var boards = [];
    list.forEach(function (b) {
      var stat = model.files[b.key];
      if (!stat || stat.unlanded === 0) return;
      var share = b.newIn ? 1 : clamp(0.38 + 1.25 * stat.unlanded / b.lines, 0.38, 1);
      var hs = Math.max(1.1, (b.height + (b.newIn ? 0.45 : 0)) * share);
      var off = b.foot / 2 + 0.16;
      var sides = b.foot > 1.65 ? [-off, 0, off] : [-off, off];
      sides.forEach(function (px) {
        sides.forEach(function (pz) {
          if (Math.abs(px) < off && Math.abs(pz) < off) return;
          poles.push({ x: b.x + px, y: b.y0 + hs / 2, z: b.z + pz, sx: 0.034, sy: hs, sz: 0.034, key: b.key });
        });
      });
      for (var y = b.y0 + 0.5; y <= b.y0 + hs + 0.01; y += 0.5) {
        poles.push({ x: b.x, y: y, z: b.z + off, sx: 2 * off + 0.04, sy: 0.024, sz: 0.024, key: b.key });
        poles.push({ x: b.x, y: y, z: b.z - off, sx: 2 * off + 0.04, sy: 0.024, sz: 0.024, key: b.key });
        poles.push({ x: b.x + off, y: y, z: b.z, sx: 0.024, sy: 0.024, sz: 2 * off + 0.04, key: b.key });
        poles.push({ x: b.x - off, y: y, z: b.z, sx: 0.024, sy: 0.024, sz: 2 * off + 0.04, key: b.key });
        if (Math.round((y - b.y0) / 0.5) % 2 === 0) {
          boards.push({ x: b.x, y: y + 0.02, z: b.z + off + 0.06, sx: 2 * off, sy: 0.022, sz: 0.2, key: b.key });
          boards.push({ x: b.x + off + 0.06, y: y + 0.02, z: b.z, sx: 0.2, sy: 0.022, sz: 2 * off, key: b.key });
        }
      }
      var diag = Math.sqrt(4 * off * off + hs * hs);
      var tilt = Math.atan2(hs, 2 * off);
      poles.push({ x: b.x, y: b.y0 + hs / 2, z: b.z + off + 0.02, sx: diag, sy: 0.022, sz: 0.022, key: b.key, roll: tilt });
      poles.push({ x: b.x + off + 0.02, y: b.y0 + hs / 2, z: b.z, sx: 0.022, sy: 0.022, sz: diag, key: b.key, pitch: -tilt });
    });
    return { poles: poles, boards: boards };
  }

  /**
   * Builds the buildings of one state as instanced meshes: bodies, socles, cornices, fins and
   * parapets in the still building (they cast shadows), and windows, test decks and scaffolding
   * in the scene (they move or glow, and cast none). Returns { still, live, bodies, list,
   * windows, recolour(), scaffoldFor(keys) }.
   */
  function buildBlocks(layout, model, tones, shared) {
    var list = layout.buildings.filter(function (b) { return !b.newIn || model.workspaces[b.newIn]; });
    var matrix = new T.Matrix4();
    var q = new T.Quaternion();
    var v = new T.Vector3();
    var s = new T.Vector3();
    function place(mesh, index, x, y, z, sx, sy, sz, rotY) {
      q.setFromAxisAngle(new T.Vector3(0, 1, 0), rotY || 0);
      matrix.compose(v.set(x, y, z), q, s.set(sx, sy, sz));
      mesh.setMatrixAt(index, matrix);
    }
    var unit = new T.BoxGeometry(1, 1, 1);

    var bodies = new T.InstancedMesh(unit, K.paint("room-wall", "matte", { dl: -0.025, dc: 0.006 }), list.length);
    var socles = new T.InstancedMesh(unit, K.paint("room-inlay-2", "satin"), list.length);
    var cornices = new T.InstancedMesh(unit, K.paint("room-inlay-2", "lacquer", { dl: 0.05 }), list.length);
    var parapetMaterial = new T.MeshStandardMaterial({ roughness: 0.5, metalness: 0 });
    var parapets = new T.InstancedMesh(unit, parapetMaterial, list.length * 4);
    var bands = new T.InstancedMesh(unit, K.paint("brass", "brass"), list.length);
    var tests = list.filter(function (b) { return b.test; });
    var decks = new T.InstancedMesh(new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shared.check, Math.max(1, tests.length));
    decks.count = tests.length;

    // Each building's look comes from its file; its jitter from its name, so it never changes.
    var ownersOf = {};
    list.forEach(function (b, i) {
      var top = b.y0 + b.height;
      place(bodies, i, b.x, b.y0 + SOCLE + (b.height - SOCLE) / 2, b.z, b.foot, b.height - SOCLE, b.foot);
      bodies.setColorAt(i, new T.Color(1, 1, 1).multiplyScalar(0.955 + (hashText(b.key) % 1000) / 1000 * 0.045));
      place(socles, i, b.x, b.y0 + SOCLE / 2, b.z, b.foot + 0.06, SOCLE, b.foot + 0.06);
      place(bands, i, b.x, b.y0 + SOCLE + 0.012, b.z, b.foot + 0.035, 0.024, b.foot + 0.035);
      place(cornices, i, b.x, top - 0.05, b.z, b.foot + 0.07, 0.07, b.foot + 0.07);
      var half = b.foot / 2 - PARAPET_THICK / 2;
      var py = top + PARAPET / 2;
      // North, west, south, east: the first owner takes south and east, which face the camera.
      place(parapets, i * 4, b.x, py, b.z - half, b.foot + 0.004, PARAPET, PARAPET_THICK);
      place(parapets, i * 4 + 1, b.x - half, py, b.z, PARAPET_THICK, PARAPET, b.foot - 2 * PARAPET_THICK);
      place(parapets, i * 4 + 2, b.x, py, b.z + half, b.foot + 0.004, PARAPET, PARAPET_THICK);
      place(parapets, i * 4 + 3, b.x + half, py, b.z, PARAPET_THICK, PARAPET, b.foot - 2 * PARAPET_THICK);
      var stat = model.files[b.key];
      ownersOf[b.key] = stat ? stat.edits.map(function (e) { return e.id; }).filter(function (id, n, all) { return all.indexOf(id) === n; }) : [];
    });
    tests.forEach(function (b, i) {
      place(decks, i, b.x, b.y0 + b.height + 0.012, b.z, b.foot - 2 * PARAPET_THICK, 1, b.foot - 2 * PARAPET_THICK);
    });

    // The windows, the Deco way: tall ribbons of black glass up each face, one pane per floor in
    // each. A pane is lit when its file changed today: the more lines, the more panes and the
    // brighter. The dark ribbon round a lit pane is what makes it read as lit in daylight.
    var ribbons = [];
    var panes = [];
    var angles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    var faceX = [0, 1, 0, -1];
    var faceZ = [1, 0, -1, 0];
    var alongX = [1, 0, -1, 0];
    var alongZ = [0, -1, 0, 1];
    list.forEach(function (b) {
      var stat = model.files[b.key];
      var heat = stat ? stat.heat : 0;
      var share = heat === 0 ? 0 : clamp(0.25 + 0.75 * Math.log(1 + heat) / Math.log(1 + 260), 0.25, 1);
      var glow = heat === 0 ? 0 : 0.6 + 0.4 * share;
      var random = createRandom(hashText(b.key + "windows"));
      var usable = b.foot - 0.3;
      var cols = clamp(Math.floor(usable / 0.34), 2, 4);
      var bottom = b.y0 + SOCLE + 0.1;
      var top = b.y0 + b.height - 0.2;
      var floors = Math.max(1, Math.floor((top - bottom) / FLOOR));
      var pitch = (top - bottom) / floors;
      for (var face = 0; face < 4; face++) {
        for (var c = 0; c < cols; c++) {
          var u = -usable / 2 + (c + 0.5) * (usable / cols);
          ribbons.push({ b: b, face: face, u: u, y: (bottom + top) / 2, h: top - bottom });
          for (var f = 0; f < floors; f++) {
            var lit = share > 0 && random() < share;
            panes.push({ b: b, face: face, u: u, y: bottom + (f + 0.5) * pitch, h: pitch - 0.1, lit: lit ? glow : 0, away: lit && stat && stat.away ? 1 : 0 });
          }
        }
      }
    });
    var ribbonMesh = new T.InstancedMesh(unit, K.paint("room-inlay-2", "satin", { dl: 0.04 }), ribbons.length);
    ribbons.forEach(function (r, i) {
      var o = r.b.foot / 2 + 0.004;
      place(ribbonMesh, i, r.b.x + faceX[r.face] * o + alongX[r.face] * r.u, r.y, r.b.z + faceZ[r.face] * o + alongZ[r.face] * r.u, 0.22, r.h, 0.016, angles[r.face]);
    });
    ribbonMesh.castShadow = false;
    ribbonMesh.receiveShadow = true;
    var windowGeometry = new T.PlaneGeometry(1, 1);
    windowGeometry.setAttribute("aAway", new T.InstancedBufferAttribute(new Float32Array(panes.length), 1));
    var windows = new T.InstancedMesh(windowGeometry, shared.windowMaterial, panes.length);
    windows.receiveShadow = true;
    windows.castShadow = false;
    var awayAttr = windowGeometry.getAttribute("aAway");
    panes.forEach(function (p, i) {
      var o = p.b.foot / 2 + 0.0135;
      place(windows, i, p.b.x + faceX[p.face] * o + alongX[p.face] * p.u, p.y, p.b.z + faceZ[p.face] * o + alongZ[p.face] * p.u, 0.15, p.h, 1, angles[p.face]);
      awayAttr.setX(i, p.away);
    });

    var scaffold = planScaffolding(list, model);
    var poles = scaffold.poles;
    var boards = scaffold.boards;
    function buildBars(items, material) {
      var mesh = new T.InstancedMesh(unit, material, Math.max(1, items.length));
      mesh.count = items.length;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      var e = new T.Euler();
      items.forEach(function (it, i) {
        e.set(it.pitch || 0, 0, it.roll || 0);
        q.setFromEuler(e);
        matrix.compose(v.set(it.x, it.y, it.z), q, s.set(it.sx, it.sy, it.sz));
        mesh.setMatrixAt(i, matrix);
      });
      mesh.userData.items = items;
      mesh.computeBoundingSphere();
      return mesh;
    }
    var poleMesh = buildBars(poles, K.paint("brass", "brass"));
    var boardMesh = buildBars(boards, K.paint("room-wood", "satin", { dl: 0.04 }));

    var still = new T.Group();
    still.name = "atlas-buildings";
    [bodies, socles, bands, cornices, parapets].forEach(function (mesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      still.add(mesh);
    });
    var live = new T.Group();
    live.name = "atlas-buildings-live";
    [ribbonMesh, windows, decks, poleMesh, boardMesh].forEach(function (mesh) {
      mesh.computeBoundingSphere();
      live.add(mesh);
    });
    decks.receiveShadow = true;

    /** Paints the parapets in their owners' hues, and the lit windows in lamplight, for the theme. */
    function recolour(isDark, hueOf) {
      var lacquer = tones.color("room-inlay-2", isDark ? 0.06 : 0.04);
      list.forEach(function (b, i) {
        var owners = ownersOf[b.key];
        // In the evening the trims are lamplit paint, not neon: a shade darker.
        var first = owners.length > 0 ? tones.hue(hueOf(owners[0]), isDark ? -0.14 : -0.02, isDark ? -0.02 : 0) : lacquer;
        var second = owners.length > 1 ? tones.hue(hueOf(owners[1]), isDark ? -0.14 : -0.02, isDark ? -0.02 : 0) : first;
        parapets.setColorAt(i * 4, second);
        parapets.setColorAt(i * 4 + 1, second);
        parapets.setColorAt(i * 4 + 2, first);
        parapets.setColorAt(i * 4 + 3, first);
      });
      parapets.instanceColor.needsUpdate = true;
      var lamp = K.writeOklch(new T.Color(), isDark ? { l: 0.86, c: 0.1, h: 80 } : { l: 0.9, c: 0.135, h: 95 });
      var black = new T.Color(0, 0, 0);
      var strength = isDark ? 1.25 : 0.78;
      panes.forEach(function (p, i) {
        windows.setColorAt(i, p.lit > 0 ? lamp.clone().multiplyScalar(p.lit * strength) : black);
      });
      windows.instanceColor.needsUpdate = true;
    }

    return {
      still: still,
      live: live,
      bodies: bodies,
      list: list,
      ownersOf: ownersOf,
      poles: poleMesh,
      boards: boardMesh,
      recolour: recolour,
      dispose: function () {
        [bodies, socles, bands, cornices, parapets, ribbonMesh, windows, decks, poleMesh, boardMesh].forEach(function (mesh) {
          if (mesh.geometry !== unit && mesh.geometry !== windowGeometry) mesh.geometry.dispose();
          mesh.dispose();
        });
        windowGeometry.dispose();
        unit.dispose();
        parapetMaterial.dispose();
      },
    };
  }

  /**
   * Builds the rings of the crossings: a dashed tomato ring and a soft glow round a file two
   * branches would conflict in, a thin brass ring round an Edit Overlap. Returns the group.
   */
  function buildRings(layout, model, tones, shared) {
    var group = new T.Group();
    group.name = "atlas-rings";
    var dashes = [];
    var crowns = [];
    var lines = [];
    model.crossings.forEach(function (c) {
      var b = layout.byKey[c.key];
      if (!b) return;
      var half = b.foot / 2 + 0.42;
      if (c.kind === "conflict") {
        var per = 6;
        for (var side = 0; side < 4; side++) {
          for (var n = 0; n < per; n++) {
            var t = -half + (n + 0.5) * (2 * half / per);
            var horizontal = side % 2 === 0;
            var sign = side < 2 ? 1 : -1;
            dashes.push({ x: b.x + (horizontal ? t : sign * half), z: b.z + (horizontal ? sign * half : t), sx: horizontal ? 0.26 : 0.1, sz: horizontal ? 0.1 : 0.26 });
          }
        }
        // The same dashed ring round the roof, where it shows from any height.
        var roofHalf = b.foot / 2 + 0.16;
        for (var rs = 0; rs < 4; rs++) {
          for (var rn = 0; rn < 5; rn++) {
            var rt = -roofHalf + (rn + 0.5) * (2 * roofHalf / 5);
            var across = rs % 2 === 0;
            var rsign = rs < 2 ? 1 : -1;
            crowns.push({ x: b.x + (across ? rt : rsign * roofHalf), z: b.z + (across ? rsign * roofHalf : rt), sx: across ? 0.2 : 0.07, sz: across ? 0.07 : 0.2, y: b.y0 + b.height + PARAPET + 0.04 });
          }
        }
        var pool = new T.Mesh(new T.PlaneGeometry(b.foot + 3.2, b.foot + 3.2).rotateX(-Math.PI / 2), shared.poolMaterial);
        pool.position.set(b.x, BLOCK_TOP + 0.006, b.z);
        pool.renderOrder = 1;
        group.add(pool);
      } else {
        lines.push({ x: b.x, z: b.z + half, sx: 2 * half + 0.06, sz: 0.06 });
        lines.push({ x: b.x, z: b.z - half, sx: 2 * half + 0.06, sz: 0.06 });
        lines.push({ x: b.x + half, z: b.z, sx: 0.06, sz: 2 * half });
        lines.push({ x: b.x - half, z: b.z, sx: 0.06, sz: 2 * half });
      }
    });
    var unit = new T.BoxGeometry(1, 1, 1);
    var matrix = new T.Matrix4();
    function bars(items, material, y) {
      if (items.length === 0) return;
      var mesh = new T.InstancedMesh(unit, material, items.length);
      items.forEach(function (it, i) {
        matrix.makeScale(it.sx, it.y ? 0.05 : 0.016, it.sz).setPosition(it.x, it.y || y, it.z);
        mesh.setMatrixAt(i, matrix);
      });
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    bars(dashes, shared.failMaterial, BLOCK_TOP + 0.012);
    bars(crowns, shared.failMaterial, 0);
    bars(lines, K.paint("brass", "brass", { dl: 0.04 }), BLOCK_TOP + 0.01);
    return group;
  }

  /* ------------------------------------------------------------------ the tilt-shift pass */

  /**
   * Adds two passes to the stage's composer, between its scene pass and its output pass, that blur
   * the top and bottom of the picture and keep a band across the middle sharp: the tilt-shift
   * photograph of a model city. They cost two full-screen draws per frame, so they run only in the
   * far view (`setAmount(0)` turns them off). Returns { setAmount(pixels) } or null when the
   * stage's composer cannot take passes.
   */
  function addTiltShift(stage) {
    var composer = stage.stage && stage.stage.composer;
    if (!composer || typeof composer.insertPass !== "function") return null;
    var camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var geometry = new T.PlaneGeometry(2, 2);
    var amount = { value: 0 };
    var focus = { value: 0.47 };
    var band = { value: 0.16 };
    function makePass(dx, dy) {
      var material = new T.ShaderMaterial({
        uniforms: { tDiffuse: { value: null }, uDir: { value: new T.Vector2(dx, dy) }, uTexel: { value: new T.Vector2(1, 1) }, uAmount: amount, uFocus: focus, uBand: band },
        vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
        fragmentShader: [
          "uniform sampler2D tDiffuse; uniform vec2 uDir; uniform vec2 uTexel; uniform float uAmount; uniform float uFocus; uniform float uBand;",
          "varying vec2 vUv;",
          "void main() {",
          "  float d = max(0.0, abs(vUv.y - uFocus) - uBand) / (0.5 - uBand);",
          "  vec2 stepUv = uDir * uTexel * uAmount * d * d * 0.25;",
          "  vec4 sum = texture2D(tDiffuse, vUv) * 0.1633;",
          "  sum += (texture2D(tDiffuse, vUv + stepUv) + texture2D(tDiffuse, vUv - stepUv)) * 0.1531;",
          "  sum += (texture2D(tDiffuse, vUv + stepUv * 2.0) + texture2D(tDiffuse, vUv - stepUv * 2.0)) * 0.12245;",
          "  sum += (texture2D(tDiffuse, vUv + stepUv * 3.0) + texture2D(tDiffuse, vUv - stepUv * 3.0)) * 0.0918;",
          "  sum += (texture2D(tDiffuse, vUv + stepUv * 4.0) + texture2D(tDiffuse, vUv - stepUv * 4.0)) * 0.051;",
          "  gl_FragColor = sum;",
          "}",
        ].join("\n"),
        depthTest: false,
        depthWrite: false,
      });
      var quad = new T.Mesh(geometry, material);
      quad.frustumCulled = false;
      return {
        enabled: false,
        needsSwap: true,
        clear: false,
        renderToScreen: false,
        setSize: function (w, h) {
          material.uniforms.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
        },
        render: function (renderer, writeBuffer, readBuffer) {
          material.uniforms.tDiffuse.value = readBuffer.texture;
          renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
          renderer.render(quad, camera);
        },
        dispose: function () {
          material.dispose();
        },
      };
    }
    var horizontal = makePass(1, 0);
    var vertical = makePass(0, 1);
    var at = composer.passes.length - 1;
    composer.insertPass(horizontal, at);
    composer.insertPass(vertical, at + 1);
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    return {
      setAmount: function (pixels) {
        amount.value = pixels * ratio;
        horizontal.enabled = vertical.enabled = pixels > 0.2;
      },
    };
  }

  /* ------------------------------------------------------------------ the module */

  function mount(container, api) {
    K = window.OfficeKit;
    T = window.THREE;
    if (!K || !T) throw new Error("atlas-office.js: load ../vendor/office-kit.js before it.");
    var W = api.world || window.WORLD;
    if (!W || !W.repos || !W.files) throw new Error("atlas-office.js: the City needs WORLD with world-plus.js (repos, files, crossings).");

    K.setAmbientMotion(!api.reducedMotion);
    container.classList.add("ov-atlas-office");
    var stage = K.stage.create(container, { camera: "perspective" });
    stage.camera.fov = LENS;
    // The whole board must fit from afar: the kit's limits are set for one Bureau, a tenth the size.
    stage.controls.maxDistance = 1100;
    stage.camera.near = 1;
    stage.camera.far = 1600;
    stage.camera.updateProjectionMatrix();
    var tones = createTones();
    var unsubscribe = K.subscribePalette(function () { tones.paint(); });
    // The away state: windows changed while Rogier was away pulse, the others' lit windows dim.
    var pulse = { value: 0 };
    var dim = { value: 1 };
    var shared = {
      windowMaterial: buildWindowMaterial(tones, pulse, dim),
      check: buildCheckMaterial(tones),
      failMaterial: tones.material({ roughness: 0.5, metalness: 0 }, function () { return tones.oklch("fail", 0, 0); }),
      poolMaterial: null,
    };
    tones.watch(function () {
      shared.failMaterial.emissive.copy(K.isDarkTheme() ? tones.color("fail", -0.18, -0.02) : new T.Color(0, 0, 0));
    });
    // The soft tomato glow on the pavement round a file that would conflict.
    (function () {
      var canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      var texture = new T.CanvasTexture(canvas);
      var material = new T.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 1 });
      tones.watch(function (isDark) {
        var context = canvas.getContext("2d");
        context.clearRect(0, 0, 128, 128);
        var gradient = context.createRadialGradient(64, 64, 14, 64, 64, 64);
        var fail = cssColor("fail");
        gradient.addColorStop(0, fail);
        gradient.addColorStop(1, "transparent");
        context.globalAlpha = isDark ? 0.5 : 0.34;
        context.fillStyle = gradient;
        context.fillRect(0, 0, 128, 128);
        texture.needsUpdate = true;
      });
      texture.colorSpace = T.SRGBColorSpace;
      shared.poolMaterial = material;
    })();

    var layout = layoutWorld(W);
    var ground = buildGround(layout, tones);
    stage.add(ground.group);

    // The Town hall on the square's north-east, nearest webshop's checkout; the Library on its north-west.
    var sq = layout.square;
    var hall = buildTownHall(tones);
    hall.object.position.set(5.2, PLINTH_TOP - 0.01, -sq.depth / 2 + 6.4);
    stage.add(hall.object);
    var library = buildLibrary(tones);
    library.object.position.set(-5.9, PLINTH_TOP - 0.01, -sq.depth / 2 + 5.3);
    stage.add(library.object);

    // The crane over the big refactor: the lead thread that changed the most files, if it is big enough.
    var craneOwner = null;
    Object.keys(W.output || {}).forEach(function (id) {
      var out = W.output[id];
      if (out && out.files >= CRANE_FILES && (!craneOwner || out.files > W.output[craneOwner].files)) craneOwner = id;
    });
    var crane = null;
    var craneLot = null;
    Object.keys(layout.cities).forEach(function (repo) {
      layout.cities[repo].districts.forEach(function (d) { if (d.craneLot) craneLot = d.craneLot; });
    });

    var keyOpen = api.keyOpen === true;
    var ui = {
      haze: document.createElement("div"),
      top: document.createElement("div"),
      key: document.createElement("div"),
      note: document.createElement("div"),
    };
    ui.haze.className = "ov-atlas-office__haze";
    var labelLayer = container.querySelector(".office-kit-labels");
    container.insertBefore(ui.haze, labelLayer);
    ui.top.className = "ov-atlas-office__hud ov-atlas-office__hud--top";
    ui.key.className = "ov-atlas-office__hud ov-atlas-office__hud--key";
    ui.note.className = "ov-atlas-office__hud ov-atlas-office__hud--note";
    container.append(ui.top, ui.key, ui.note);

    var tilt = addTiltShift(stage);
    tones.watch(function (isDark) {
      if (current && current.blocks) current.blocks.recolour(isDark, hueOf);
    });

    var current = {
      model: null,
      blocks: null,
      rings: null,
      props: [],
      beans: {},
      tags: {},
      labels: [],
      picker: null,
      selected: null,
      cardFor: null,
      card: null,
      hover: null,
      hoverBean: null,
      flag: null,
      keyOpen: keyOpen,
      lastClick: { id: null, at: 0 },
    };

    /** Returns a point of an unturned group in world space: its position plus the local point. */
    function toWorld(object, x, y, z) {
      return new T.Vector3(x, y, z).add(object.position);
    }

    /** Returns a session's hue: the look it was given. */
    function hueOf(id) {
      var s = current.model && current.model.byId[id];
      return decideLook(s ? s.lookName : id, s ? s.kind : "thread").hue;
    }

    /* -------------------------------------------------------------- where each bean goes */

    /** Returns the file a session changed most today, as a building key, or null. */
    function findHome(s) {
      if (!s.files || !s.project) return null;
      var best = null;
      s.files.touched.forEach(function (f) {
        if (f.how !== "edit") return;
        var key = s.project + ":" + f.path;
        if (!layout.byKey[key]) return;
        if (!best || f.plus + f.minus > best.n) best = { key: key, n: f.plus + f.minus };
      });
      return best ? best.key : null;
    }

    /**
     * Decides where every session stands: at the Town hall's queue when it waits on you, in the
     * Library when it only reads, on the roof of the file it is in now when it works, on a bench
     * at the door of the file it changed most when it rests, and at its writing desk when it is an
     * assistant. Returns a list of { session, place, building, index }.
     */
    function placeSessions(model) {
      var placed = [];
      var roofs = {};
      var queue = [];
      var readers = [];
      var assistants = [];
      var benches = {};
      var leadsFirst = model.sessions.slice().sort(function (a, b) {
        return (a.lead ? 1 : 0) - (b.lead ? 1 : 0) || (a.kind === "run" ? 1 : 0) - (b.kind === "run" ? 1 : 0);
      });
      leadsFirst.forEach(function (s) {
        if (s.kind === "assistant") {
          assistants.push(s);
          return;
        }
        if (s.pose === "waiting") {
          queue.push(s);
          return;
        }
        var now = s.files && s.files.now && s.project ? s.project + ":" + s.files.now : null;
        if (!s.files || s.files.library || !hasEdits(s) || !s.project) {
          readers.push(s);
          return;
        }
        if (s.pose === "working" && now && layout.byKey[now]) {
          if (!roofs[now]) {
            roofs[now] = s.id;
            placed.push({ session: s, place: "roof", building: layout.byKey[now] });
          } else {
            placed.push({ session: s, place: "door", building: layout.byKey[now] });
          }
          return;
        }
        var home = findHome(s);
        if (!home) {
          readers.push(s);
          return;
        }
        benches[home] = (benches[home] || 0) + 1;
        placed.push({ session: s, place: "bench", building: layout.byKey[home], index: benches[home] - 1 });
      });
      var minutes = W.helpers.minutes;
      queue.sort(function (a, b) { return minutes(a.last) - minutes(b.last) || (a.id < b.id ? -1 : 1); });
      queue.forEach(function (s, i) {
        var home = hasEdits(s) ? findHome(s) : null;
        placed.push({ session: s, place: "queue", index: i, building: home && !roofs[home] ? layout.byKey[home] : null });
        if (home) roofs[home] = roofs[home] || "note:" + s.id;
      });
      readers.forEach(function (s, i) { placed.push({ session: s, place: "library", index: i }); });
      assistants.forEach(function (s, i) { placed.push({ session: s, place: "hall", index: i }); });
      return placed;
    }

    /** Returns the words under a bean's name: the file it is in, what it asks, or how long it rested. */
    function describeState(s, place) {
      if (s.pose === "waiting") return { text: s.ask || "waiting on you", mono: false };
      if (s.kind === "assistant") return { text: s.pose === "working" ? "working" : s.pose === "asleep" ? "asleep" : "idle", mono: false };
      if (s.pose === "asleep") return { text: "asleep", mono: false };
      var now = s.files && s.files.now;
      if (place === "library") {
        if (s.pose === "working") return now ? { text: "reading " + baseName(now), mono: false } : { text: "reading", mono: false };
        return { text: "idle " + W.helpers.ago(s.last), mono: false };
      }
      if (s.pose === "working" && now) return { text: baseName(now), mono: true };
      if (s.pose === "working") return { text: "working", mono: false };
      return { text: "idle " + W.helpers.ago(s.last), mono: false };
    }

    /* -------------------------------------------------------------- drawing a state */

    function clearState() {
      crowd = [];
      Object.keys(current.tags).forEach(function (id) { current.tags[id].label.remove(); });
      current.tags = {};
      current.labels.forEach(function (l) { l.remove(); });
      current.labels = [];
      current.props.forEach(function (p) { stage.remove(p); });
      current.props = [];
      if (current.blocks) {
        stage.remove(current.blocks.still);
        stage.scene.remove(current.blocks.live);
        current.blocks.dispose();
        current.blocks = null;
      }
      if (current.rings) {
        stage.scene.remove(current.rings);
        current.rings = null;
      }
      if (current.flag) {
        stage.scene.remove(current.flag);
        current.flag = null;
      }
      if (crane) {
        stage.remove(crane.object);
        crane = null;
      }
      if (current.picker) current.picker();
      current.picker = null;
      closeCard();
    }

    /** Draws the City for `state`: its buildings, rings, beans, labels and HUD. */
    function drawState(state, animate) {
      var previous = current.model;
      clearState();
      var model = buildModel(W, state);
      current.model = model;
      container.toggleAttribute("data-swarm", state === "swarm");
      container.removeAttribute("data-focus");

      var blocks = buildBlocks(layout, model, tones, shared);
      current.blocks = blocks;
      stage.add(blocks.still);
      stage.scene.add(blocks.live);
      blocks.recolour(K.isDarkTheme(), hueOf);
      current.rings = buildRings(layout, model, tones, shared);
      stage.scene.add(current.rings);

      // The crane, over the file the big refactor's thread is in now.
      if (craneOwner && model.byId[craneOwner] && craneLot) {
        var owner = model.byId[craneOwner];
        var nowKey = owner.files && owner.files.now ? owner.project + ":" + owner.files.now : null;
        var target = nowKey && layout.byKey[nowKey];
        if (target) {
          // The load hangs a little behind and above the bean at its desk, so it never hides it.
          crane = buildCrane(craneLot, { x: target.x, z: target.z - 0.85 }, target.y0 + target.height + 2.5);
          stage.add(crane.object);
          crane.over = target;
        }
      }

      // The beans.
      var placed = placeSessions(model);
      var keep = {};
      placed.forEach(function (p) { keep[p.session.id] = true; });
      Object.keys(current.beans).forEach(function (id) {
        if (!keep[id]) {
          stage.remove(current.beans[id]);
          delete current.beans[id];
        }
      });
      var queueCount = 0;
      placed.forEach(function (p) {
        var s = p.session;
        var bean = current.beans[s.id];
        if (!bean) {
          bean = K.colleague({ id: s.id, kind: s.kind, pose: s.pose === "away" ? "away" : s.pose, look: decideLook(s.lookName, s.kind) });
          bean.userData.atlasBean = s.id;
          current.beans[s.id] = bean;
          stage.add(bean);
        } else if (bean.pose !== s.pose) {
          bean.setPose(s.pose);
        }
        seatBean(bean, p);
        if (p.place === "queue") queueCount++;
        var words = describeState(s, p.place);
        var tag = K.tag({ name: s.title, state: words.text, hue: decideLook(s.lookName, s.kind).hue, waiting: s.pose === "waiting" });
        if (words.mono) tag.querySelector(".office-tag__state").classList.add("ov-atlas-office__mono");
        var classes = ["ov-atlas-office__tag"];
        if (p.place === "roof" || p.place === "door" || p.place === "bench") classes.push("is-city");
        if (p.place === "queue") classes.push("is-queue");
        if (p.place === "library" || p.place === "hall") classes.push("is-inside");
        if (model.crossings.some(function (c) { return c.a === s.id || c.b === s.id; })) classes.push("is-crosser");
        var label = stage.label(bean, tag, { className: classes.join(" ") });
        current.tags[s.id] = { tag: tag, label: label, place: p };
        var rank = p.place === "queue" ? 3 + p.index * 0.01 : s.pose === "working" ? 5 : p.place === "library" || p.place === "hall" ? 8 : 7;
        addCrowdTag(label, bean, rank);
      });
      hall.nowServing.setNumber(queueCount);

      drawLabels(model);
      drawHud(model);
      registerPicking();
      if (current.selected) markSelected(current.selected, true);
      unsettled = true;

      // The land state: the merged branch's flag, and its scaffolding coming down.
      if (state === "land") {
        drawFlag();
        var lander = current.beans.tCss;
        if (lander && !api.reducedMotion) setTimeout(function () { lander.play("hop"); }, animate ? 1300 : 200);
        if (animate && previous && !previous.landed.tCss) sinkScaffolding(previous);
      }
      stage.requestRender();
    }

    /** Puts a bean where the placement says, with its desk, bench or armchair. */
    function seatBean(bean, p) {
      var s = p.session;
      var b = p.building;
      if (p.place === "roof") {
        var desk = K.buildDesk();
        desk.object.rotation.y = Math.PI;
        var roof = b.y0 + b.height;
        desk.object.position.set(b.x, roof, b.z - 0.05);
        if (b.foot < 1.55) desk.object.scale.set(0.86, 1, 0.86);
        stage.add(desk.object);
        current.props.push(desk.object);
        bean.sitAt(desk);
        return;
      }
      if (p.place === "door") {
        var dz = b.lastRow ? b.z + b.foot / 2 + 0.38 : b.z + CELL / 2;
        bean.position.y = BLOCK_TOP;
        bean.standAt(b.x + 0.42, dz, Math.PI / 5);
        return;
      }
      if (p.place === "bench") {
        if (b.lastRow) {
          var bench = K.buildBench(1);
          bench.object.position.set(b.x - 0.25 + p.index * 0.75, BLOCK_TOP, b.z + b.foot / 2 + 0.36);
          stage.add(bench.object);
          current.props.push(bench.object);
          bean.sitAt(bench, 0);
        } else {
          bean.position.y = BLOCK_TOP;
          bean.standAt(b.x - 0.3 + p.index * 0.6, b.z + CELL / 2, Math.PI / 6);
        }
        return;
      }
      if (p.place === "queue") {
        var spot = hall.queueSpots[Math.min(p.index, hall.queueSpots.length - 1)];
        var world = toWorld(hall.object, spot[0], spot[1], spot[2]);
        bean.position.y = world.y;
        bean.standAt(world.x, world.z, Math.PI / 4);
        // The waiting thread's desk stays on its roof, a marigold note on it: it went to ask you.
        if (p.building) {
          var left = K.buildDesk();
          left.object.rotation.y = Math.PI;
          left.object.position.set(p.building.x, p.building.y0 + p.building.height, p.building.z - 0.05);
          if (p.building.foot < 1.55) left.object.scale.set(0.86, 1, 0.86);
          left.setNote(true);
          stage.add(left.object);
          current.props.push(left.object);
        }
        return;
      }
      if (p.place === "library") {
        var seat = library.seats[p.index % library.seats.length];
        var chair = K.buildArmchair();
        chair.object.rotation.y = seat[2];
        chair.object.position.copy(toWorld(library.object, seat[0], library.floorY, seat[1]));
        stage.add(chair.object);
        current.props.push(chair.object);
        bean.sitAt(chair);
        return;
      }
      if (p.place === "hall") {
        bean.sitAt(hall.desks[p.index % hall.desks.length]);
      }
    }

    /* -------------------------------------------------------------- labels */

    function addLabel(point, html, className, offset) {
      var label = stage.label(point, html, { className: className, offset: offset });
      current.labels.push(label);
      return label;
    }

    /*
     * The labels that compete for room, in the order they win a place. A far label that would
     * overlap one that matters more is hidden; a name tag that would is folded to a pin in its
     * colour, which its full tag replaces again under the pointer. `anchor` says where a label sits
     * against its point, as its CSS translate puts it: "center", "above", "below" or "tag" (the
     * app's tag hangs a little right of the head).
     */
    var crowd = [];
    function addMapLabel(point, html, className, priority, anchor, everyZoom) {
      var label = addLabel(point, html, className, 0);
      var at = new T.Vector3(point[0], point[1], point[2]);
      crowd.push({ el: label.element, read: function () { return at; }, priority: priority, anchor: anchor, far: true, always: everyZoom === true });
      return label;
    }
    function addCrowdLabel(label, point, priority, anchor) {
      var at = new T.Vector3(point[0], point[1], point[2]);
      crowd.push({ el: label.element, read: function () { return at; }, priority: priority, anchor: anchor, far: false });
    }
    function addCrowdTag(label, bean, priority) {
      var head = new T.Vector3();
      crowd.push({
        el: label.element,
        read: function () {
          bean.getWorldPosition(head);
          head.y += bean.headHeight + 0.14;
          return head;
        },
        priority: priority,
        anchor: "tag",
        tag: true,
      });
    }

    /** Sorts out the labels that would overlap. Runs when the camera comes to rest, never while it moves. */
    function declutter() {
      var far = container.dataset.zoom === "far";
      var width = container.clientWidth;
      var height = container.clientHeight;
      var active = crowd.filter(function (c) { return c.always || (far ? c.far : !c.far); });
      crowd.forEach(function (c) { c.el.classList.remove("is-cluttered", "is-pip"); });
      // One layout for all the sizes, then no more reads.
      active.forEach(function (c) {
        c.w = c.el.offsetWidth;
        c.h = c.el.offsetHeight;
      });
      stage.camera.updateMatrixWorld();
      var placed = [];
      var p = new T.Vector3();
      active
        .filter(function (c) { return c.w > 0; })
        .map(function (c) {
          var list = c.el.classList;
          var lead = list.contains("is-selected") || list.contains("is-hovered") || list.contains("is-focus") ? -1 : c.priority;
          return { c: c, rank: lead };
        })
        .sort(function (a, b) { return a.rank - b.rank; })
        .forEach(function (entry) {
          var c = entry.c;
          p.copy(c.read()).project(stage.camera);
          if (p.z > 1) return;
          var x = ((p.x + 1) / 2) * width;
          var y = ((1 - p.y) / 2) * height;
          var left = c.anchor === "tag" ? x - 0.38 * c.w : c.anchor === "left" ? x - c.w - 8 : x - c.w / 2;
          var top = c.anchor === "above" || c.anchor === "tag" ? y - c.h : c.anchor === "below" ? y : y - c.h / 2;
          var r = [left - 2, top - 1, left + c.w + 2, top + c.h + 1];
          // A label cut by the edge of the canvas waits too, unless it is selected or in focus.
          var cut = r[0] < 4 || r[1] < 4 || r[2] > width - 4 || r[3] > height - 4;
          var hit = entry.rank >= 0 && (cut || placed.some(function (q) { return r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]; }));
          if (hit) {
            c.el.classList.add(c.tag ? "is-pip" : "is-cluttered");
            if (c.tag) placed.push([x - 6, y - 12, x + 6, y]);
          } else {
            placed.push(r);
          }
        });
    }

    /** Returns the hue dots of the threads in `ids`, as HTML. */
    function drawDots(ids) {
      return '<span class="ov-atlas-office__dots">' + ids.map(function (id) {
        return '<i style="--hue:var(--hue-' + hueOf(id) + ')"></i>';
      }).join("") + "</span>";
    }

    function drawLabels(model) {
      var sessionsIn = {};
      model.sessions.forEach(function (s) { if (s.project) (sessionsIn[s.project] = sessionsIn[s.project] || []).push(s); });
      Object.keys(layout.cities).forEach(function (repo) {
        var city = layout.cities[repo];
        var live = (sessionsIn[repo] || []).filter(function (s) { return s.kind === "thread"; }).length;
        var conflicts = model.crossings.filter(function (c) { return c.kind === "conflict" && c.key.indexOf(repo + ":") === 0; }).length;
        var html = '<b><i class="ov-atlas-office__diamond" style="--rug:var(--proj-' + tintOf(repo) + ')"></i>' + escapeHtml(repo) + "</b><span>" + live + " threads" +
          (conflicts ? ' · <span class="is-fail">' + conflicts + " would conflict</span>" : "") + "</span>";
        // Over the back of the city, where its quiet districts are: the front is busy enough.
        addMapLabel([(city.x0 + city.x1) / 2, 7.2, city.z0 + 2.4], html, "ov-atlas-office__city", 3, "above");
        city.districts.forEach(function (d) {
          var plus = 0;
          var minus = 0;
          var who = [];
          d.buildings.forEach(function (b) {
            var stat = model.files[b.key];
            if (!stat) return;
            stat.edits.forEach(function (e) {
              plus += e.plus;
              minus += e.minus;
              if (who.indexOf(e.id) === -1) who.push(e.id);
            });
          });
          var changed = plus + minus;
          if (changed === 0 && who.length === 0) return;
          var lit = changed === 0 ? 0 : clamp(Math.ceil(Math.log(1 + changed) / Math.log(1 + 400) * 4), 1, 4);
          var heat = '<span class="ov-atlas-office__heat">' + [0, 1, 2, 3].map(function (n) { return '<i class="' + (n < lit ? "is-lit" : "") + '"></i>'; }).join("") + "</span>";
          var dhtml = '<span class="ov-atlas-office__mono">' + escapeHtml(d.path) + "</span>" + heat + drawDots(who.slice(0, 4));
          addMapLabel([(d.x0 + d.x1) / 2, BLOCK_TOP + 0.1, (d.z0 + d.z1) / 2], dhtml, "ov-atlas-office__district", 10 - Math.min(4, Math.log(1 + changed)) / 2, "center");
        });
      });

      // The Town hall and the Library.
      var waiting = model.sessions.filter(function (s) { return s.pose === "waiting"; });
      var threadsWaiting = waiting.filter(function (s) { return s.kind === "thread"; }).length;
      var runsWaiting = waiting.length - threadsWaiting;
      var hallFront = toWorld(hall.object, -1.9, 0.2, 6.0);
      var waitTitle = threadsWaiting + " threads" + (runsWaiting ? " and " + runsWaiting + " run step" : "") + " wait on you";
      addMapLabel([hallFront.x, hallFront.y, hallFront.z], '<b>Town hall</b><span class="ov-atlas-office__count is-you">' + waiting.length + '</span><span title="' + waitTitle + '">wait on you</span>', "ov-atlas-office__civic is-you is-below", 1, "below", true);
      var readers = model.sessions.filter(function (s) { return s.kind !== "assistant" && s.pose !== "waiting" && (!s.files || s.files.library || !hasEdits(s) || !s.project); });
      var libFront = toWorld(library.object, 0, 0.2, 5.0);
      addMapLabel([libFront.x, libFront.y, libFront.z], "<b>Library</b><span>only read</span><span class=\"ov-atlas-office__count\">" + readers.length + "</span>", "ov-atlas-office__civic is-below", 4, "below", true);

      // The crossings.
      model.crossings.forEach(function (c, i) {
        var b = layout.byKey[c.key];
        if (!b) return;
        var conflict = c.kind === "conflict";
        var html = drawDots([c.a, c.b]) + "<b>2 threads</b> · " + '<span class="ov-atlas-office__mono">' + escapeHtml(baseName(c.path)) + "</span> · <em>" + (conflict ? "would conflict" : "edit overlap") + "</em>" +
          '<span class="ov-atlas-office__cross-note">' + escapeHtml(c.note) + "</span>";
        var at = [b.x, b.y0 + b.height + (conflict ? 1.9 : 1.6), b.z];
        var label;
        if (conflict) {
          // To the left of the file, over the street, so it never hides the buildings it is about.
          at = [b.x - b.foot / 2 - 0.4, b.y0 + b.height * 0.75, b.z];
          label = addMapLabel(at, html, "ov-atlas-office__cross is-conflict is-left", 2, "left");
          addCrowdLabel(label, at, 2, "left");
        } else {
          label = addLabel(at, html, "ov-atlas-office__cross", 0);
          addCrowdLabel(label, at, 6.5, "above");
        }
        c.label = label;
        c.index = i;
      });

      // The crane's sign.
      if (crane && W.output[craneOwner]) {
        var out = W.output[craneOwner];
        var ownerTitle = model.byId[craneOwner].title;
        var craneAt = crane.jibTip.clone().setY(crane.top - 2.0);
        addMapLabel([craneAt.x, craneAt.y, craneAt.z], '<i class="ov-atlas-office__dot" style="--hue:var(--hue-' + hueOf(craneOwner) + ')"></i><b>' + escapeHtml(ownerTitle) + "</b><span>" + out.files + " files</span>" + drawDiff(out.plus, out.minus), "ov-atlas-office__crane", 2.5, "above");
      }
    }

    /** Draws the flag of the branch that landed, on the roof of its biggest file. */
    function drawFlag() {
      var b = layout.byKey["webshop:styles/checkout.css"];
      if (!b) return;
      var group = new T.Group();
      var roof = b.y0 + b.height;
      var pole = new T.Mesh(new T.CylinderGeometry(0.025, 0.03, 1.5, 8).translate(0, 0.75, 0), K.paint("brass", "brass"));
      var shape = new T.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(0.78, -0.2);
      shape.lineTo(0, -0.42);
      shape.lineTo(0, 0);
      var pennant = new T.Mesh(new T.ShapeGeometry(shape).translate(0.03, 1.48, 0), K.paintHue(hueOf("tCss"), "body", "satin"));
      pennant.material.side = T.DoubleSide;
      group.add(pole, pennant);
      group.position.set(b.x + 0.45, roof, b.z + 0.45);
      group.rotation.y = -0.5;
      stage.scene.add(group);
      current.flag = group;
      addLabel([b.x + 0.45, roof + 1.62, b.z + 0.45], '<b>Merged</b><span class="ov-atlas-office__mono">#1281</span>', "ov-atlas-office__flag", 0.1);
    }

    /** Shows the scaffolding of the files that just landed sinking into the pavement, then gone. */
    function sinkScaffolding(previous) {
      var plan = planScaffolding(layout.buildings, previous);
      var gone = function (it) {
        var now = current.model.files[it.key];
        return !now || now.unlanded === 0;
      };
      var geometry = new T.BoxGeometry(1, 1, 1);
      var group = new T.Group();
      [[plan.poles.filter(gone), K.paint("brass", "brass")], [plan.boards.filter(gone), K.paint("room-wood", "satin", { dl: 0.04 })]].forEach(function (part) {
        if (part[0].length === 0) return;
        var mesh = new T.InstancedMesh(geometry, part[1], part[0].length);
        mesh.userData.items = part[0];
        mesh.frustumCulled = false;
        group.add(mesh);
      });
      stage.scene.add(group);
      var started = null;
      var m = new T.Matrix4();
      var q = new T.Quaternion();
      var e = new T.Euler();
      var at = new T.Vector3();
      var size = new T.Vector3();
      var stop = stage.onFrame(function (frame) {
        if (started === null) started = frame.time;
        var t = clamp((frame.time - started) / 1.4, 0, 1);
        var ease = t * t;
        group.children.forEach(function (mesh) {
          mesh.userData.items.forEach(function (it, i) {
            e.set(it.pitch || 0, 0, it.roll || 0);
            q.setFromEuler(e);
            at.set(it.x, BLOCK_TOP + (it.y - BLOCK_TOP) * (1 - ease), it.z);
            size.set(it.sx, it.sy > 0.1 ? Math.max(0.001, it.sy * (1 - ease)) : it.sy, it.sz);
            mesh.setMatrixAt(i, m.compose(at, q, size));
          });
          mesh.instanceMatrix.needsUpdate = true;
        });
        if (t < 1) return true;
        stage.scene.remove(group);
        group.children.forEach(function (mesh) { mesh.dispose(); });
        geometry.dispose();
        stop();
        return false;
      });
    }

    /* -------------------------------------------------------------- the HUD */

    function drawHud(model) {
      var conflicts = model.crossings.filter(function (c) { return c.kind === "conflict"; }).length;
      var overlaps = model.crossings.length - conflicts;
      ui.top.innerHTML =
        '<div class="ov-atlas-office__seg" role="group" aria-label="Fly to">' +
        '<button type="button" data-view="home" aria-pressed="false">All cities</button>' +
        Object.keys(layout.cities).map(function (repo) {
          return '<button type="button" data-view="' + repo + '" aria-pressed="false"><i class="ov-atlas-office__diamond" style="--rug:var(--proj-' + tintOf(repo) + ')"></i>' + escapeHtml(repo) + "</button>";
        }).join("") +
        "</div>" +
        (model.crossings.length
          ? '<button type="button" class="ov-atlas-office__chip" data-view="crossing" title="Fly to the next crossing"><i class="ov-atlas-office__ring"></i><b>' + model.crossings.length + " crossings</b><span>" +
            (conflicts ? conflicts + " would conflict" : "") + (conflicts && overlaps ? " · " : "") + (overlaps ? overlaps + " overlap" + (overlaps > 1 ? "s" : "") : "") + "</span></button>"
          : "");
      var open = current.keyOpen === true;
      ui.key.innerHTML =
        '<div class="ov-atlas-office__key"' + (open ? "" : " hidden") + ">" +
        '<div class="ov-atlas-office__key-h">How to read the City<button type="button" data-key="close">Hide</button></div><ul>' +
        '<li><i class="ov-atlas-office__sw-tower"></i>A building is a file; its height, the file’s lines</li>' +
        '<li><i class="ov-atlas-office__sw-lit"></i>Lit windows: lines changed today</li>' +
        '<li><i class="ov-atlas-office__sw-trim" style="--hue:var(--hue-grape)"></i>Roof trim: the thread that changed it</li>' +
        '<li><i class="ov-atlas-office__sw-scaffold"></i>Scaffolding: changes not landed yet</li>' +
        '<li><i class="ov-atlas-office__sw-check"></i>Chequered roof: a test file</li>' +
        '<li><i class="ov-atlas-office__sw-conflict"></i>Dashed red: a merge would conflict</li>' +
        '<li><i class="ov-atlas-office__sw-overlap"></i>Brass ring: two threads edited it</li>' +
        '<li><i class="ov-atlas-office__sw-hand"></i>Town hall: waits on you</li>' +
        '<li><i class="ov-atlas-office__sw-dome"></i>Library: threads that only read</li>' +
        '</ul><div class="ov-atlas-office__key-foot">Files come from the edit watch, which is best effort.</div></div>' +
        (open ? "" : '<button type="button" class="ov-atlas-office__chip" data-key="open">How to read the City</button>');
      if (model.state === "away") {
        ui.note.innerHTML = '<div class="ov-atlas-office__note"><i class="ov-atlas-office__pulse"></i><b>Back at ' + escapeHtml(W.away.back) + "</b><span>" + model.awayFiles + " files changed while you were away, " + escapeHtml(W.away.left) + "-" + escapeHtml(W.away.back) + (api.reducedMotion ? ". Their windows are the bright ones." : ". Their windows pulse.") + "</span></div>";
      } else if (model.state === "land") {
        ui.note.innerHTML = '<div class="ov-atlas-office__note"><span class="is-ok">Landed</span><b>Tidy checkout CSS</b><span>PR #1281 is merged; the scaffolding on its 4 files came down.</span></div>';
      } else {
        ui.note.innerHTML = "";
      }
      markView(null);
    }

    function markView(name) {
      ui.top.querySelectorAll("[data-view]").forEach(function (button) {
        if (button.getAttribute("aria-pressed") !== null) button.setAttribute("aria-pressed", String(button.dataset.view === name));
      });
    }

    var crossingCursor = -1;
    function onHudClick(event) {
      var target = event.target.closest("button");
      if (!target) return;
      if (target.dataset.key === "close") {
        current.keyOpen = false;
        drawHud(current.model);
      } else if (target.dataset.key === "open") {
        current.keyOpen = true;
        drawHud(current.model);
      } else if (target.dataset.view === "crossing") {
        crossingCursor = (crossingCursor + 1) % current.model.crossings.length;
        flyToCrossing(current.model.crossings[crossingCursor]);
      } else if (target.dataset.view) {
        show(target.dataset.view);
      }
    }
    ui.top.addEventListener("click", onHudClick);
    ui.key.addEventListener("click", onHudClick);

    /* -------------------------------------------------------------- the camera */

    var fovTan = Math.tan((LENS * Math.PI) / 360);

    /**
     * Returns the view that fits a box (x0, x1, y0, y1, z0, z1) in the canvas from `azimuth` and
     * `elevation`, leaving `pad` of the canvas free round it.
     */
    function fitBox(bounds, azimuth, elevation, pad, shift) {
      var az = (azimuth * Math.PI) / 180;
      var el = (elevation * Math.PI) / 180;
      var back = new T.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      var right = new T.Vector3(0, 1, 0).cross(back).normalize();
      var up = back.clone().cross(right).normalize();
      var target = new T.Vector3((bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2, (bounds.z0 + bounds.z1) / 2);
      var aspect = Math.max(0.5, container.clientWidth / Math.max(1, container.clientHeight));
      var tanY = fovTan * (1 - (pad || 0.08));
      var tanX = tanY * aspect;
      var distance = 0;
      for (var i = 0; i < 8; i++) {
        var corner = new T.Vector3(i & 1 ? bounds.x1 : bounds.x0, i & 2 ? bounds.y1 : bounds.y0, i & 4 ? bounds.z1 : bounds.z0).sub(target);
        var toward = corner.dot(back);
        distance = Math.max(distance, toward + Math.abs(corner.dot(right)) / tanX, toward + Math.abs(corner.dot(up)) / tanY);
      }
      if (shift) {
        // Moves the framed box on the canvas: shift[0] of the half-width right, shift[1] of the half-height up.
        var halfH = distance * fovTan;
        target.addScaledVector(right, -shift[0] * halfH * aspect).addScaledVector(up, -shift[1] * halfH);
      }
      return { target: [target.x, target.y, target.z], distance: distance, azimuth: azimuth, elevation: elevation };
    }

    function fly(view, seconds) {
      if (api.reducedMotion || seconds === 0) {
        stage.view(view);
        return Promise.resolve();
      }
      return stage.flyTo(view.target, view.distance, { azimuth: view.azimuth, elevation: view.elevation, seconds: seconds || 1.1 });
    }

    function boundsOf(points, pad) {
      var b = { x0: Infinity, x1: -Infinity, y0: 0, y1: 0, z0: Infinity, z1: -Infinity };
      points.forEach(function (p) {
        b.x0 = Math.min(b.x0, p[0] - pad);
        b.x1 = Math.max(b.x1, p[0] + pad);
        b.y1 = Math.max(b.y1, p[1]);
        b.z0 = Math.min(b.z0, p[2] - pad);
        b.z1 = Math.max(b.z1, p[2] + pad);
      });
      b.y0 = BLOCK_TOP;
      return b;
    }

    function homeView() {
      var b = layout.bounds;
      return fitBox({ x0: b.x0 + 2, x1: b.x1 - 2, y0: 0, y1: 3, z0: b.z0 + 1, z1: b.z1 + 2.5 }, 18, 40, 0.02, [0, 0.04]);
    }

    function cityView(repo) {
      var c = layout.cities[repo];
      return fitBox({ x0: c.x0, x1: c.x1, y0: 0, y1: 4, z0: c.z0, z1: c.z1 }, AZIMUTH, ELEVATION + 4, 0.1, [0, 0.04]);
    }

    function districtView(key) {
      var d = null;
      Object.keys(layout.cities).forEach(function (repo) {
        layout.cities[repo].districts.forEach(function (each) { if (each.key === key) d = each; });
      });
      if (!d) return homeView();
      return fitBox({ x0: d.x0 - 1, x1: d.x1 + 1, y0: BLOCK_TOP, y1: 5, z0: d.z0 - 1, z1: d.z1 + 1.5 }, AZIMUTH, ELEVATION + 2, 0.12, [0.12, 0]);
    }

    /** Returns where a bean stands, as a point. */
    function pointOf(id) {
      var bean = current.beans[id];
      if (!bean) return null;
      var p = bean.getWorldPosition(new T.Vector3());
      return [p.x, p.y + 0.9, p.z];
    }

    /**
     * Returns the view of a crossing: its file a little right of the middle, and the beans of both
     * threads in the frame when they are within 16 metres of it.
     */
    function crossingView(c) {
      var b = layout.byKey[c.key];
      var near = [c.a, c.b].map(pointOf).filter(function (p) { return p && Math.hypot(p[0] - b.x, p[2] - b.z) < 16; });
      var aim = new T.Vector3(b.x, 1.6, b.z);
      near.forEach(function (p) { aim.add(new T.Vector3(p[0], 1.6, p[2]).sub(new T.Vector3(b.x, 1.6, b.z)).multiplyScalar(0.3)); });
      var spread = 6;
      near.forEach(function (p) { spread = Math.max(spread, Math.hypot(p[0] - b.x, p[2] - b.z)); });
      var visible = clamp(spread * 1.05, 11, 22);
      return { target: [aim.x, aim.y, aim.z], distance: visible / (2 * fovTan), azimuth: 20, elevation: 33 };
    }

    function refactorView() {
      if (!crane) return homeView();
      var over = crane.over;
      var d = over.district;
      var points = [[d.x0, 4, d.z0], [d.x1, 4, d.z1], [craneLot.x, crane.top, craneLot.z]];
      return fitBox(boundsOf(points, 1.0), 22, 54, 0.06, [0.12, -0.05]);
    }

    function landedView() {
      var keys = ["webshop:styles/checkout.css", "webshop:src/checkout/card-form.module.css", "webshop:styles/cart.css"];
      var points = keys.map(function (k) { var b = layout.byKey[k]; return [b.x, b.y0 + b.height + 2, b.z]; });
      return fitBox(boundsOf(points, 4.6), AZIMUTH - 6, ELEVATION - 4, 0.1, [0.1, 0.02]);
    }

    function flyToCrossing(c, seconds) {
      if (!c) return Promise.resolve();
      current.model.crossings.forEach(function (each) { if (each.label) each.label.element.classList.toggle("is-open", each === c); });
      return fly(crossingView(c), seconds);
    }

    /**
     * Flies to a named view: "home", a repository's name, "crossing" (the payment.ts crossing),
     * "refactor" (the crane) or "landed" (the merged CSS branch). With `instant`, it cuts there.
     */
    function show(name, instant) {
      var seconds = instant ? 0 : undefined;
      markView(name);
      if (name === "home") return fly(homeView(), seconds);
      if (layout.cities[name]) return fly(cityView(name), seconds);
      if (name === "crossing") {
        var c = find(current.model.crossings, function (each) { return each.kind === "conflict"; }) || current.model.crossings[0];
        return flyToCrossing(c, seconds);
      }
      if (name === "refactor") return fly(refactorView(), seconds);
      if (name === "landed") return fly(landedView(), seconds);
      return Promise.resolve();
    }

    /* -------------------------------------------------------------- selection and picking */

    function markSelected(id, on) {
      var bean = current.beans[id];
      if (bean) bean.rig.setSelected(on);
      var entry = current.tags[id];
      if (entry) entry.label.element.classList.toggle("is-selected", on);
    }

    /** Selects a bean and glides to it, keeping it clear of the window's selection card. */
    function select(id, fromPick) {
      if (id === current.selected && !fromPick) return;
      if (current.selected) markSelected(current.selected, false);
      current.selected = id && current.beans[id] ? id : null;
      if (!current.selected) return;
      markSelected(current.selected, true);
      var p = pointOf(current.selected);
      var view = fitBox(boundsOf([p], 5.2), AZIMUTH, ELEVATION - 3, 0.1, [0.22, 0.1]);
      fly(view, 0.9);
    }

    function registerPicking() {
      var beans = Object.keys(current.beans).map(function (id) { return current.beans[id]; });
      var objects = beans.concat([current.blocks.bodies], ground.districtMeshes, ground.cityMeshes, [hall.object, library.object]);
      current.picker = stage.onPick(objects, function (object, hit) {
        var now = performance.now();
        if (object.userData.atlasBean) {
          var id = object.userData.atlasBean;
          if (current.lastClick.id === id && now - current.lastClick.at < DOUBLE_CLICK_MS) return;
          current.lastClick = { id: id, at: now };
          select(id, true);
          if (api.onSelect) api.onSelect(id);
          return;
        }
        // The second click of a double-click on a bean lands wherever the glide has moved the
        // scene to; it opens the thread (see onDoubleClick), never what it happens to hit.
        if (now - current.lastClick.at < DOUBLE_CLICK_MS) return;
        if (object === current.blocks.bodies) {
          var b = current.blocks.list[hit.instanceId];
          if (!b) return;
          if (container.dataset.zoom === "far") fly(districtView(b.district.key));
          else openCard(b);
          return;
        }
        if (object.userData.atlasDistrict) {
          closeCard();
          fly(districtView(object.userData.atlasDistrict));
          return;
        }
        if (object.userData.atlasCity) {
          closeCard();
          if (container.dataset.zoom === "far") show(object.userData.atlasCity);
          return;
        }
        if (object === hall.object) {
          closeCard();
          var hp = hall.object.position;
          fly(fitBox(boundsOf([[hp.x, 4, hp.z - 3], [hp.x + 4, 1, hp.z + 6]], 2), AZIMUTH, ELEVATION, 0.1, [0.15, 0]));
          return;
        }
        if (object === library.object) {
          closeCard();
          var lp = library.object.position;
          fly(fitBox(boundsOf([[lp.x, 6, lp.z]], 5.6), AZIMUTH, ELEVATION + 8, 0.1, [0.12, 0]));
        }
      });
    }

    /* -------------------------------------------------------------- the file card */

    function closeCard() {
      if (current.card) current.card.remove();
      current.card = null;
      current.cardFor = null;
    }

    /** Opens the small card of a file: its size, who changed it today and by how much, and its crossing. */
    function openCard(b) {
      closeCard();
      var model = current.model;
      var stat = model.files[b.key] || { edits: [], reads: [] };
      var rows = stat.edits.map(function (e) {
        var s = model.byId[e.id];
        return '<button type="button" class="ov-atlas-office__card-row" data-select="' + e.id + '"><i class="ov-atlas-office__dot" style="--hue:var(--hue-' + hueOf(e.id) + ')"></i><span>' + escapeHtml(s ? s.title : e.id) + "</span>" +
          (e.plus + e.minus === 0 ? '<span class="ov-atlas-office__mono" style="grid-column: span 2; color: var(--faint)">reverted</span>' : drawDiff(e.plus, e.minus).replace("</span> <span", "</span><span")) + "</button>";
      }).join("");
      var readers = stat.reads.map(function (id) { var s = model.byId[id]; return s ? escapeHtml(s.title) : id; });
      var crossing = find(model.crossings, function (c) { return c.key === b.key; });
      var newNote = b.newIn ? " · new on " + escapeHtml(W.workspaces[b.newIn] ? W.workspaces[b.newIn].branch : "a branch") : "";
      var html =
        '<div class="ov-atlas-office__card-h"><b class="ov-atlas-office__mono">' + escapeHtml(b.name) + '</b><button type="button" class="ov-atlas-office__x" aria-label="Close" data-close>×</button></div>' +
        '<div class="ov-atlas-office__card-sub"><span class="ov-atlas-office__mono">' + escapeHtml(b.district.path) + "</span> · " + b.lines + " lines" + newNote + "</div>" +
        (rows ? '<div class="ov-atlas-office__card-sec">Changed today</div>' + rows : '<div class="ov-atlas-office__card-sec">Not changed today</div>') +
        (readers.length ? '<div class="ov-atlas-office__card-sec">Read today by</div><div class="ov-atlas-office__card-reads">' + readers.join(", ") + "</div>" : "") +
        (crossing
          ? '<div class="ov-atlas-office__card-warn' + (crossing.kind === "conflict" ? " is-conflict" : "") + '"><b>' + (crossing.kind === "conflict" ? "Would conflict if both land" : "Edit overlap") + "</b>" + escapeHtml(crossing.note) + "</div>"
          : stat.unlanded > 0
            ? '<div class="ov-atlas-office__card-foot">Scaffolding: ' + stat.unlanded + " changed lines have not landed on main.</div>"
            : "");
      var label = stage.label([b.x, b.y0 + b.height + 0.4, b.z], html, { className: "ov-atlas-office__card" });
      label.element.addEventListener("click", function (event) {
        var row = event.target.closest("[data-select]");
        if (row) {
          var id = row.getAttribute("data-select");
          if (current.beans[id]) {
            select(id, true);
            if (api.onSelect) api.onSelect(id);
          }
          return;
        }
        if (event.target.closest("[data-close]")) closeCard();
      });
      label.element.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
      current.card = label;
      current.cardFor = b.key;
      stage.requestRender();
    }

    function onKey(event) {
      if (event.key === "Escape" && current.card) closeCard();
    }
    document.addEventListener("keydown", onKey);

    /** Opens the thread of the bean the first click of a double-click picked. */
    function onDoubleClick() {
      if (current.lastClick.id && performance.now() - current.lastClick.at < DOUBLE_CLICK_MS && api.onOpen) api.onOpen(current.lastClick.id);
    }
    stage.renderer.domElement.addEventListener("dblclick", onDoubleClick);

    /* -------------------------------------------------------------- hovering */

    var raycaster = new T.Raycaster();
    var pointer = new T.Vector2();
    var hoverAt = null;
    var hoverFrame = 0;
    var hoverLabel = null;
    function decideHover() {
      hoverFrame = 0;
      if (!hoverAt || !current.blocks) return;
      var rect = stage.renderer.domElement.getBoundingClientRect();
      pointer.set(((hoverAt.x - rect.left) / rect.width) * 2 - 1, -((hoverAt.y - rect.top) / rect.height) * 2 + 1);
      stage.camera.updateMatrixWorld();
      raycaster.setFromCamera(pointer, stage.camera);
      var beans = Object.keys(current.beans).map(function (id) { return current.beans[id]; });
      var hits = raycaster.intersectObjects(beans.concat([current.blocks.bodies]), true);
      var beanId = null;
      var building = null;
      if (hits.length) {
        var hit = hits[0];
        for (var node = hit.object; node; node = node.parent) {
          if (node.userData && node.userData.atlasBean) {
            beanId = node.userData.atlasBean;
            break;
          }
        }
        if (!beanId && hit.object === current.blocks.bodies) building = current.blocks.list[hit.instanceId];
      }
      if (beanId !== current.hoverBean) {
        if (current.hoverBean && current.beans[current.hoverBean]) {
          current.beans[current.hoverBean].rig.setHovered(false);
          if (current.tags[current.hoverBean]) current.tags[current.hoverBean].label.element.classList.remove("is-hovered");
        }
        current.hoverBean = beanId;
        if (beanId) {
          current.beans[beanId].rig.setHovered(true);
          if (current.tags[beanId]) current.tags[beanId].label.element.classList.add("is-hovered");
        }
        stage.requestRender();
      }
      var hoverKey = building && container.dataset.zoom !== "far" && current.cardFor !== building.key ? building.key : null;
      if (hoverKey !== current.hover) {
        if (hoverLabel) hoverLabel.remove();
        hoverLabel = null;
        current.hover = hoverKey;
        if (building && hoverKey) {
          hoverLabel = stage.label([building.x, building.y0 + building.height + 0.3, building.z], '<span class="ov-atlas-office__mono">' + escapeHtml(building.name) + "</span> <span>" + building.lines + " lines</span>", { className: "ov-atlas-office__hover" });
        }
        stage.requestRender();
      }
    }
    function onPointerMove(event) {
      if (event.buttons !== 0 || event.pointerType !== "mouse") return;
      hoverAt = { x: event.clientX, y: event.clientY };
      if (!hoverFrame) hoverFrame = requestAnimationFrame(decideHover);
    }
    function onPointerLeave() {
      hoverAt = { x: -9999, y: -9999 };
      if (!hoverFrame) hoverFrame = requestAnimationFrame(decideHover);
    }
    stage.renderer.domElement.addEventListener("pointermove", onPointerMove);
    stage.renderer.domElement.addEventListener("pointerleave", onPointerLeave);

    /* -------------------------------------------------------------- every frame */

    var zoom = null;
    var lastEye = new T.Vector3(Infinity, 0, 0);
    var unsettled = true;
    var stopFrames = stage.onFrame(function (frame) {
      var distance = stage.camera.position.distanceTo(stage.controls.target);
      var visible = 2 * distance * fovTan;
      var next = visible > FAR ? "far" : visible < NEAR ? "near" : "mid";
      if (next !== zoom) {
        zoom = next;
        container.dataset.zoom = zoom;
        if (zoom === "far") closeCard();
        unsettled = true;
      }
      // The far labels are sorted out once the camera rests, never while it moves.
      if (stage.camera.position.distanceToSquared(lastEye) > 1e-6) {
        lastEye.copy(stage.camera.position);
        unsettled = true;
      } else if (unsettled) {
        unsettled = false;
        declutter();
      }
      if (tilt) tilt.setAmount(visible > FAR ? clamp((visible - FAR) / 18, 0, 1) * 5.5 : 0);
      var away = current.model && current.model.state === "away";
      dim.value = away ? 0.38 : 1;
      if (away && !api.reducedMotion) {
        pulse.value = 0.25 + 0.75 * (0.5 - 0.5 * Math.cos(frame.time * (Math.PI * 2) / 2.6));
        return true;
      }
      pulse.value = away ? 0.7 : 0;
      return false;
    });

    /* -------------------------------------------------------------- start */

    var state = api.state || "everyday";
    drawState(state, false);
    stage.view(homeView());
    if (state === "crossing") {
      container.dataset.focus = "crossing";
      stage.view(crossingView(current.model.crossings[0]));
      focusCrossing(current.model.crossings[0]);
    } else if (state === "land") {
      stage.view(landedView());
    }
    var initial = api.selected || (state === "open" ? "t3ds" : null);
    if (initial) select(initial);

    /** In the crossing state, only the two threads that cross, and their crossing, speak. */
    function focusCrossing(c) {
      if (!c) return;
      container.dataset.focus = "crossing";
      [c.a, c.b].forEach(function (id) {
        var entry = current.tags[id];
        if (entry) entry.label.element.classList.add("is-focus", "is-crossing");
      });
      if (c.label) c.label.element.classList.add("is-focus", "is-open");
    }

    var paused = false;
    return {
      select: function (id) {
        select(id || null);
      },
      setState: function (next) {
        var before = current.model ? current.model.state : null;
        state = next || "everyday";
        drawState(state, true);
        if (state === "crossing") {
          focusCrossing(current.model.crossings[0]);
          fly(crossingView(current.model.crossings[0]));
        } else if (state === "land") {
          fly(landedView());
        } else if (state === "open") {
          select("t3ds");
        } else if (before === "crossing" || before === "land") {
          fly(homeView());
        }
      },
      show: show,
      /** For the browser console and scripted checks: the stage and what is drawn. */
      debug: { stage: stage, current: current, layout: layout },
      resize: function () {
        stage.requestRender();
      },
      pause: function () {
        paused = true;
        stage.pause();
      },
      resume: function () {
        if (!paused) return;
        paused = false;
        stage.resume();
      },
      dispose: function () {
        stopFrames();
        unsubscribe();
        document.removeEventListener("keydown", onKey);
        stage.renderer.domElement.removeEventListener("pointermove", onPointerMove);
        stage.renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
        stage.renderer.domElement.removeEventListener("dblclick", onDoubleClick);
        cancelAnimationFrame(hoverFrame);
        clearState();
        Object.keys(current.beans).forEach(function (id) { stage.remove(current.beans[id]); });
        current.beans = {};
        stage.dispose();
        [ui.haze, ui.top, ui.key, ui.note].forEach(function (el) { el.remove(); });
        container.classList.remove("ov-atlas-office");
        container.removeAttribute("data-zoom");
        container.removeAttribute("data-focus");
        container.removeAttribute("data-swarm");
      },
    };
  }

  window.OfficeModes = window.OfficeModes || {};
  window.OfficeModes.atlas = { mount: mount };
})();
