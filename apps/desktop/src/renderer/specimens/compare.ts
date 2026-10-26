/**
 * The comparison page for the font sheet (#858) and the dark examples sheet
 * (#863). It shows the real specimen pages at real size, in an iframe of
 * exactly 1440 x 900 CSS pixels, and lets Rogier swap fonts and dark variants
 * with a select or a key. Nothing is ever scaled: a scaled page would show
 * different pixels on the 1x and the 2x monitors.
 *
 * The page loads `compare/fonts.css` and `compare/dark.css` into each
 * specimen and switches them with attributes on the specimen's `<html>`:
 * - `data-ui-font`: `inter`, `plex` or `geist`; absent means Bricolage Grotesque.
 * - `data-title-font`: `bricolage`; absent means titles use the UI font.
 * - `data-code-font`: `recursive-casl0`, `jetbrains` or `geist-mono`; absent
 *   means Recursive CASL 0.5.
 * - `data-dark`: `b`, `c` or `d`; absent means variant (a), Orient Express as it is.
 *
 * Changing a font, the titles or the dark variant sets those attributes in the
 * running specimen, so its scroll position stays. Changing the screen, the
 * theme or the view loads the specimens again. The whole state lives in the
 * page's URL, so a link carries a pick.
 *
 * The page imports nothing from the app.
 */

/** A choice in a select: the value in the URL, the text in the bar, and the key that picks it. */
interface Choice {
  readonly value: string;
  readonly label: string;
  readonly key?: string;
}

const SCREENS = [
  { value: "sidebar", label: "sidebar", path: "sidebar.html" },
  { value: "thread", label: "thread", path: "thread.html" },
  { value: "thread-long", label: "thread (long)", path: "thread.html?state=long" },
  { value: "draft", label: "draft", path: "draft.html" },
  { value: "intake", label: "intake", path: "intake.html" },
  {
    value: "tracking",
    label: "tracking",
    path: "intake.html?scene=tracking-pane-needs-you",
  },
  { value: "settings", label: "settings", path: "settings-appearance.html" },
] as const;

const THEMES: readonly Choice[] = [
  { value: "whitehaven", label: "Whitehaven" },
  { value: "orient-express", label: "Orient Express" },
];

const UI_FONTS: readonly Choice[] = [
  { value: "bricolage", label: "Bricolage (today)", key: "1" },
  { value: "inter", label: "Inter", key: "2" },
  { value: "plex", label: "IBM Plex Sans", key: "3" },
  { value: "geist", label: "Geist", key: "4" },
];

const TITLE_FONTS: readonly Choice[] = [
  { value: "ui", label: "UI font" },
  { value: "bricolage", label: "Bricolage" },
];

const CODE_FONTS: readonly Choice[] = [
  { value: "recursive", label: "Recursive (today)", key: "5" },
  { value: "casl0", label: "Recursive CASL 0", key: "6" },
  { value: "jetbrains", label: "JetBrains Mono", key: "7" },
  { value: "geist-mono", label: "Geist Mono", key: "8" },
];

const DARK_VARIANTS: readonly Choice[] = [
  { value: "a", label: "(a) today", key: "q" },
  { value: "b", label: "(b) retuned", key: "w" },
  { value: "c", label: "(c) Ocean steps", key: "e" },
  { value: "d", label: "(d) Blue Train", key: "r" },
];

/** What each choice means, in words, for the "Values" line. */
const UI_FONT_WORDS: Readonly<Record<string, string>> = {
  bricolage: "Bricolage Grotesque (today)",
  inter: "Inter 4 (cv05 cv08 zero, tnum on numbers)",
  plex: "IBM Plex Sans",
  geist: "Geist",
};
const CODE_FONT_WORDS: Readonly<Record<string, string>> = {
  recursive: "Recursive CASL 0.5 (today)",
  casl0: "Recursive CASL 0",
  jetbrains: "JetBrains Mono",
  "geist-mono": "Geist Mono",
};
const DARK_WORDS: Readonly<Record<string, string>> = {
  a: "(a) Orient Express as it is",
  b: "(b) retuned",
  c: "(c) retuned with Ocean's layer steps",
  d: "(d) Blue Train",
};

/** The attribute value on the specimen's `<html>` for each choice. Absent means today's look. */
const UI_ATTRIBUTE: Readonly<Record<string, string | null>> = {
  bricolage: null,
  inter: "inter",
  plex: "plex",
  geist: "geist",
};
const CODE_ATTRIBUTE: Readonly<Record<string, string | null>> = {
  recursive: null,
  casl0: "recursive-casl0",
  jetbrains: "jetbrains",
  "geist-mono": "geist-mono",
};

/** The fonts and the dark variant: what a swap or an A/B toggle changes without a reload. */
interface Look {
  readonly ui: string;
  readonly titles: string;
  readonly code: string;
  readonly dark: string;
}

interface State extends Look {
  readonly screen: string;
  readonly theme: string;
  readonly view: "single" | "side";
}

const TODAY: Look = { ui: "bricolage", titles: "ui", code: "recursive", dark: "a" };
const START: State = { ...TODAY, screen: "sidebar", theme: "whitehaven", view: "single" };

const FRAME_WIDTH = 1440;
const FRAME_HEIGHT = 900;
const STYLESHEETS = [
  { name: "fonts", href: "/specimens/compare/fonts.css" },
  { name: "dark", href: "/specimens/compare/dark.css" },
];

/** The three excerpts of the side-by-side view: a column of a screen, cut at real size. */
const SIDE_BY_SIDE = [
  { screen: "sidebar", left: 0, width: 272 },
  { screen: "thread", left: 272, width: 760 },
  { screen: "intake", left: 272, width: 760 },
];

interface Pane {
  readonly box: HTMLElement;
  readonly frame: HTMLIFrameElement;
  screen: string;
  /** How far the frame is shifted left to show its column, in pixels. */
  readonly left: number;
  /** Counts refreshes, so that a refresh superseded by a newer one stops before it shows the frame. */
  generation: number;
}

/** Returns the choice with the given value, or undefined. */
function findChoice(choices: readonly Choice[], value: string | null): Choice | undefined {
  return choices.find((each) => each.value === value);
}

/**
 * Reads the state from the page's URL. A value that is missing or unknown
 * falls back to the start state, and the second element lists each unknown
 * value so the bar can tell Rogier.
 */
function readState(search: string): [State, string[]] {
  const params = new URLSearchParams(search);
  const problems: string[] = [];
  const pick = (name: string, valid: readonly string[], fallback: string): string => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (valid.includes(value)) return value;
    problems.push(`${name}=${value}`);
    return fallback;
  };
  const view = pick("view", ["single", "side"], START.view);
  const state: State = {
    screen: pick(
      "screen",
      SCREENS.map((each) => each.value),
      START.screen,
    ),
    theme: pick(
      "theme",
      THEMES.map((each) => each.value),
      START.theme,
    ),
    ui: pick(
      "ui",
      UI_FONTS.map((each) => each.value),
      START.ui,
    ),
    titles: pick(
      "titles",
      TITLE_FONTS.map((each) => each.value),
      START.titles,
    ),
    code: pick(
      "code",
      CODE_FONTS.map((each) => each.value),
      START.code,
    ),
    dark: pick(
      "dark",
      DARK_VARIANTS.map((each) => each.value),
      START.dark,
    ),
    view: view === "side" ? "side" : "single",
  };
  return [state, problems];
}

/** Returns the query string that holds the whole state. `view` is left out in the single view. */
function writeStateQuery(state: State): string {
  const params = new URLSearchParams({
    screen: state.screen,
    theme: state.theme,
    ui: state.ui,
    titles: state.titles,
    code: state.code,
    dark: state.dark,
  });
  if (state.view === "side") params.set("view", "side");
  return `?${params.toString()}`;
}

/**
 * Returns the URL, relative to this page, of a screen in a theme. The theme
 * is merged into the screen's own query, such as `?state=steps`. The URL also
 * turns Follow the system off in the specimen's Settings > Appearance, so the
 * pressed theme card is the theme the page is painted in.
 */
function buildScreenUrl(screen: string, theme: string): string {
  const entry = SCREENS.find((each) => each.value === screen);
  if (entry === undefined) throw new Error(`Unknown screen "${screen}".`);
  const url = new URL(entry.path, location.href);
  url.searchParams.set("theme", theme);
  url.searchParams.set("follow", "0");
  return `${url.pathname}${url.search}`;
}

function sameLook(left: Look, right: Look): boolean {
  return (
    left.ui === right.ui &&
    left.titles === right.titles &&
    left.code === right.code &&
    left.dark === right.dark
  );
}

function pickLook(state: State): Look {
  return { ui: state.ui, titles: state.titles, code: state.code, dark: state.dark };
}

/** Returns the current choice in words, such as "UI: Inter 4 (...) / titles: Bricolage / code: ...". */
function describeState(state: State): string {
  const titles = state.titles === "bricolage" ? "Bricolage (from 18px up)" : "the UI font";
  const dark =
    state.theme === "orient-express"
      ? DARK_WORDS[state.dark]
      : `${DARK_WORDS[state.dark]}, no effect in Whitehaven`;
  return [
    `Theme: ${findChoice(THEMES, state.theme)?.label}`,
    `UI: ${UI_FONT_WORDS[state.ui]}`,
    `titles: ${titles}`,
    `code: ${CODE_FONT_WORDS[state.code]}`,
    `dark: ${dark}`,
  ].join(" / ");
}

/**
 * Returns true when the key event's target is a field that takes typed text.
 * Checks `nodeType` instead of `instanceof Element`, because an element in a
 * specimen's iframe belongs to the iframe's window and is not an instance of
 * this window's `Element`.
 */
function isEditable(target: EventTarget | null): boolean {
  if (target === null || (target as Node).nodeType !== Node.ELEMENT_NODE) return false;
  // A focused select takes the keys for itself, to move through its options.
  return (
    (target as Element).closest(
      "input, textarea, select, [contenteditable]:not([contenteditable=false])",
    ) !== null
  );
}

function nextFrame(window: Window): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The loading of each stylesheet in each document, so every refresh waits for the same load. */
const stylesheetLoads = new WeakMap<Document, Map<string, Promise<void>>>();

/**
 * Returns a promise that resolves when the stylesheet link has loaded and
 * rejects with a plain message when it fails to load.
 */
function waitForStylesheet(link: HTMLLinkElement, href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener(
      "error",
      () => reject(new Error(`The stylesheet ${href} did not load.`)),
      { once: true },
    );
  });
}

/**
 * Appends the two stylesheets to the end of the document's head, once per
 * document, and returns when both have loaded. A second call while a link is
 * still loading waits for the same load. Fails when a stylesheet does not
 * load; the failed link is removed, so the next call tries again.
 */
async function ensureStylesheets(doc: Document): Promise<void> {
  let loads = stylesheetLoads.get(doc);
  if (loads === undefined) {
    loads = new Map();
    stylesheetLoads.set(doc, loads);
  }
  const pending: Promise<void>[] = [];
  for (const sheet of STYLESHEETS) {
    let load = loads.get(sheet.name);
    if (load === undefined) {
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      const known = loads;
      load = waitForStylesheet(link, sheet.href).catch((error: unknown) => {
        known.delete(sheet.name);
        link.remove();
        throw error;
      });
      loads.set(sheet.name, load);
      doc.head.append(link);
    }
    pending.push(load);
  }
  await Promise.all(pending);
}

/** The font families the look draws with, as the page's CSS names them. */
function listFamilies(look: Look): string[] {
  const ui = {
    bricolage: "Bricolage Grotesque",
    inter: "Inter Compare",
    plex: "IBM Plex Sans Compare",
    geist: "Geist Compare",
  }[look.ui];
  const code = {
    recursive: "Recursive",
    casl0: "Recursive",
    jetbrains: "JetBrains Mono Compare",
    "geist-mono": "Geist Mono Compare",
  }[look.code];
  const families = [ui, code];
  if (look.titles === "bricolage") families.push("Bricolage Grotesque");
  return families.filter((each): each is string => each !== undefined);
}

/**
 * Loads the font files of the look's families and returns when each one is
 * usable. Fails, naming the family, when a family has no font face or its
 * file did not load. `fonts.ready` alone does not guarantee this: it also
 * resolves when a face failed.
 */
async function loadFamilies(doc: Document, look: Look): Promise<void> {
  for (const family of listFamilies(look)) {
    const query = `13px "${family}"`;
    let faces: FontFace[] = [];
    try {
      faces = await doc.fonts.load(query);
    } catch {
      // The failure is reported below.
    }
    if (faces.length === 0 || !doc.fonts.check(query)) {
      throw new Error(`The font ${family} did not load.`);
    }
  }
}

/** Sets or removes one attribute on the document's `<html>`. */
function setAttribute(doc: Document, name: string, value: string | null): void {
  if (value === null) doc.documentElement.removeAttribute(name);
  else doc.documentElement.setAttribute(name, value);
}

function applyLook(doc: Document, look: Look): void {
  setAttribute(doc, "data-ui-font", UI_ATTRIBUTE[look.ui] ?? null);
  setAttribute(doc, "data-title-font", look.titles === "bricolage" ? "bricolage" : null);
  setAttribute(doc, "data-code-font", CODE_ATTRIBUTE[look.code] ?? null);
  setAttribute(doc, "data-dark", look.dark === "a" ? null : look.dark);
}

const READY_TIMEOUT_MILLISECONDS = 30_000;

let state: State;
/** The look before the last change, for the A/B key. Null until the first change. */
let previousLook: Look | null = null;
const panes: Pane[] = [];

const bar = document.getElementById("bar") as HTMLElement;
const stage = document.getElementById("stage") as HTMLElement;

/** The bar's controls, kept so a key press can bring the selects up to date. */
const selects = new Map<keyof State, HTMLSelectElement>();
const buttons = new Map<string, HTMLButtonElement>();
const warningText = document.createElement("span");
const valuesText = document.createElement("span");
const infoText = document.createElement("span");
const errorText = document.createElement("span");
/** Why each covered pane cannot be shown, such as a stylesheet that did not load. */
const loadErrors = new Map<Pane, string>();
let statusMessage: { text: string; until: number } | null = null;

function createSelect(
  key: keyof State,
  label: string,
  hint: string,
  choices: readonly { value: string; label: string; key?: string }[],
): HTMLLabelElement {
  const wrapper = document.createElement("label");
  wrapper.append(`${label} `);
  const hintElement = document.createElement("span");
  hintElement.textContent = hint;
  hintElement.style.color = "#666";
  wrapper.append(hintElement);
  const select = document.createElement("select");
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.key === undefined ? choice.label : `${choice.key}  ${choice.label}`;
    select.append(option);
  }
  select.addEventListener("change", () => {
    commit({ ...state, [key]: select.value });
    // A focused select would take the next key presses for itself.
    select.blur();
  });
  selects.set(key, select);
  wrapper.append(select);
  return wrapper;
}

function createButton(name: string, text: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", () => {
    onClick();
    button.blur();
  });
  buttons.set(name, button);
  return button;
}

function buildBar(): void {
  const first = document.createElement("div");
  first.className = "bar-row";
  first.append(
    createSelect("screen", "Screen", "[ ]", SCREENS),
    createSelect("theme", "Theme", "t", THEMES),
    createSelect("ui", "UI font", "1-4", UI_FONTS),
    createSelect("titles", "Titles", "b", TITLE_FONTS),
    createSelect("code", "Code", "5-8", CODE_FONTS),
    createSelect("dark", "Dark", "q w e r", DARK_VARIANTS),
    createButton("view", "v  Side by side", toggleView),
    createButton("swap", "x  A/B", swapLooks),
    createButton("reset", "0  Reset", resetLook),
  );
  warningText.className = "bar-warning";
  valuesText.className = "bar-values";
  infoText.className = "bar-info";
  const second = document.createElement("div");
  second.className = "bar-row";
  errorText.className = "bar-warning";
  second.append(warningText, errorText, valuesText, infoText);
  bar.append(first, second);
}

/** Brings the selects, the pressed button and the Values line up to date with the state. */
function showState(): void {
  for (const [key, select] of selects) select.value = String(state[key]);
  const screenSelect = selects.get("screen");
  if (screenSelect !== undefined) screenSelect.disabled = state.view === "side";
  buttons.get("view")?.setAttribute("aria-pressed", String(state.view === "side"));
  showValues();
}

function showValues(): void {
  const now = Date.now();
  const message = statusMessage !== null && statusMessage.until > now ? statusMessage.text : null;
  const text = message ?? describeState(state);
  valuesText.textContent = `Values: ${text}`;
  valuesText.title = text;
}

/** Shows a short message in the Values line for a few seconds. */
function say(text: string): void {
  statusMessage = { text, until: Date.now() + 3000 };
  showValues();
  setTimeout(showValues, 3100);
}

/** Shows the window's size and pixel ratio, and warns when the screen is cut or the browser is zoomed. */
function showWindow(): void {
  const root = document.documentElement;
  const cut = root.scrollWidth > root.clientWidth || root.scrollHeight > root.clientHeight;
  const ratio = window.devicePixelRatio;
  const zoomed = ratio !== 1 && ratio !== 2;
  const warnings: string[] = [];
  if (cut) {
    warnings.push(
      state.view === "side"
        ? "Window too small: the row is cut and scrolls sideways. Make the window larger; do not zoom."
        : "Window too small: the screen is cut. Make the window larger; do not zoom.",
    );
  }
  if (zoomed) warnings.push(`DPR ${ratio}: the browser is zoomed or scaled. Press Ctrl+0.`);
  warningText.textContent = warnings.join(" ");
  infoText.textContent = `Window ${window.innerWidth} x ${window.innerHeight}, DPR ${ratio} (1 on the HP, 2 on Retina; any other value means browser zoom)`;
}

/** Shows or clears (with null) the reason a pane stays covered, in red in the bar. */
function showLoadError(pane: Pane, message: string | null): void {
  if (message === null) loadErrors.delete(pane);
  else loadErrors.set(pane, message);
  errorText.textContent = [...loadErrors.values()].join(" ");
}

function writeUrl(): void {
  history.replaceState(null, "", `${location.pathname}${writeStateQuery(state)}`);
}

/**
 * Resolves once the pane's specimen has set `data-ready`, or after a timeout.
 * Returns false when it timed out or when a newer refresh took over.
 */
async function waitUntilReady(pane: Pane, generation: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (pane.generation !== generation) return false;
    const root = pane.frame.contentDocument?.documentElement;
    if (root?.hasAttribute("data-ready") === true) return true;
    await sleep(50);
  }
  return false;
}

/**
 * Puts the grey cover over the pane and the frame at the box's left edge.
 * The specimen's readiness check (`waitForPresentedFrame`) waits for a marker
 * at the frame's top-left corner to be painted, and the browser never paints
 * a marker the box clips away. So while the specimen loads, the frame is not
 * shifted.
 */
function coverPane(pane: Pane): void {
  pane.box.dataset.loading = "";
  pane.frame.style.marginLeft = "0";
}

/** Shifts the frame to its column and removes the cover. */
function uncoverPane(pane: Pane): void {
  pane.frame.style.marginLeft = `${-pane.left}px`;
  delete pane.box.dataset.loading;
}

/**
 * Applies the look to the pane's specimen and shows it. A grey cover stays
 * over the frame until the specimen is drawn and its fonts have loaded, so a
 * fallback font never shows. Nothing is reloaded, so the scroll position
 * stays.
 *
 * The cover is not `visibility: hidden` on the frame: the specimen sets
 * `data-ready` only after the browser has presented a frame of it, and a
 * hidden frame is never presented.
 */
async function refreshPane(pane: Pane): Promise<void> {
  pane.generation += 1;
  const generation = pane.generation;
  coverPane(pane);
  showLoadError(pane, null);
  const ready = await waitUntilReady(pane, generation);
  if (pane.generation !== generation) return;
  const doc = pane.frame.contentDocument;
  const view = pane.frame.contentWindow;
  if (doc === null || view === null) return;
  if (!ready) say(`${pane.screen} never set data-ready; showing it as it is.`);
  try {
    await ensureStylesheets(doc);
    if (pane.generation !== generation) return;
    applyLook(doc, state);
    // Font files load when a layout first needs them. Forcing the layout now
    // makes `fonts.ready` wait for them.
    doc.documentElement.getBoundingClientRect();
    await loadFamilies(doc, state);
    await doc.fonts.ready;
  } catch (error) {
    // The cover stays on: a fallback font must never look like a candidate.
    if (pane.generation === generation) {
      showLoadError(pane, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  await nextFrame(view);
  if (pane.generation !== generation) return;
  uncoverPane(pane);
}

/** Handles a key press from the bar's page or from inside a specimen. */
function onKeyDown(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
  const key = event.key.toLowerCase();
  const handled = handleKey(key, event.repeat);
  if (handled) event.preventDefault();
}

function handleKey(key: string, repeat: boolean): boolean {
  if (key === "[" || key === "]") {
    if (state.view === "side") return true;
    const index = SCREENS.findIndex((each) => each.value === state.screen);
    const step = key === "]" ? 1 : -1;
    const next = SCREENS[(index + step + SCREENS.length) % SCREENS.length];
    if (next !== undefined) commit({ ...state, screen: next.value });
    return true;
  }
  if (repeat) return false;
  const byKey = (choices: readonly Choice[]): string | undefined =>
    choices.find((each) => each.key === key)?.value;
  const ui = byKey(UI_FONTS);
  if (ui !== undefined) return (commit({ ...state, ui }), true);
  const code = byKey(CODE_FONTS);
  if (code !== undefined) return (commit({ ...state, code }), true);
  const dark = byKey(DARK_VARIANTS);
  if (dark !== undefined) return (commit({ ...state, dark }), true);
  switch (key) {
    case "b":
      commit({ ...state, titles: state.titles === "bricolage" ? "ui" : "bricolage" });
      return true;
    case "t":
      commit({
        ...state,
        theme: state.theme === "whitehaven" ? "orient-express" : "whitehaven",
      });
      return true;
    case "v":
      toggleView();
      return true;
    case "x":
      swapLooks();
      return true;
    case "0":
      resetLook();
      return true;
    default:
      return false;
  }
}

function toggleView(): void {
  commit({ ...state, view: state.view === "side" ? "single" : "side" });
}

/** Swaps the current look with the one before the last change, keeping the screen. */
function swapLooks(): void {
  if (previousLook === null) {
    say("A/B: nothing to swap yet. Change a font or a dark variant first.");
    return;
  }
  const current = pickLook(state);
  const target = previousLook;
  commit({ ...state, ...target }, false);
  previousLook = current;
}

/** Puts every font, the titles, the dark variant and the theme back to today's look. Keeps the screen and the view. */
function resetLook(): void {
  commit({ ...state, ...TODAY, theme: START.theme });
}

/** Returns the panes the state asks for, each with the screen it draws. */
function wantedScreens(next: State): string[] {
  return next.view === "side" ? SIDE_BY_SIDE.map((each) => each.screen) : [next.screen];
}

function createPane(screen: string, left: number, width: number): Pane {
  const box = document.createElement("div");
  box.className = "pane";
  box.style.width = `${width}px`;
  const frame = document.createElement("iframe");
  frame.width = String(FRAME_WIDTH);
  frame.height = String(FRAME_HEIGHT);
  frame.title = screen;
  box.dataset.loading = "";
  box.append(frame);
  const pane: Pane = { box, frame, screen, left, generation: 0 };
  // Runs on every load of the frame: the first, a screen or theme change, and
  // a full reload by the dev server.
  frame.addEventListener("load", () => {
    frame.contentDocument?.addEventListener("keydown", onKeyDown);
    void refreshPane(pane);
  });
  return pane;
}

function buildPanes(): void {
  panes.length = 0;
  loadErrors.clear();
  errorText.textContent = "";
  stage.replaceChildren();
  const layout =
    state.view === "side" ? SIDE_BY_SIDE : [{ screen: state.screen, left: 0, width: FRAME_WIDTH }];
  for (const entry of layout) {
    const pane = createPane(entry.screen, entry.left, entry.width);
    panes.push(pane);
    stage.append(pane.box);
    pane.frame.src = buildScreenUrl(entry.screen, state.theme);
  }
}

/**
 * Makes the page show `next`: updates the URL and the bar, then reloads each
 * specimen whose address changed and only swaps the look in the others.
 * `track` is false for the A/B swap, which sets the previous look itself.
 */
function commit(next: State, track = true): void {
  const before = state;
  state = next;
  if (track && !sameLook(pickLook(before), pickLook(next))) previousLook = pickLook(before);
  writeUrl();
  showState();
  if (before.view !== next.view) {
    buildPanes();
  } else {
    const screens = wantedScreens(next);
    panes.forEach((pane, index) => {
      const screen = screens[index];
      if (screen === undefined) return;
      if (screen !== pane.screen || before.theme !== next.theme) {
        pane.screen = screen;
        pane.generation += 1;
        coverPane(pane);
        pane.frame.contentWindow?.location.replace(buildScreenUrl(screen, next.theme));
      } else {
        void refreshPane(pane);
      }
    });
  }
  requestAnimationFrame(showWindow);
}

const [initial, problems] = readState(location.search);
state = initial;
buildBar();
document.addEventListener("keydown", onKeyDown);
window.addEventListener("resize", showWindow);
writeUrl();
showState();
buildPanes();
requestAnimationFrame(showWindow);
if (problems.length > 0) say(`Unknown in the URL, using today's: ${problems.join(", ")}`);
