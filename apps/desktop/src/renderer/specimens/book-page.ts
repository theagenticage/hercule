/**
 * What the reference pages share when they edit a Bureau book page to show a
 * fixture's data: finding the book's elements, failing loudly when the book
 * no longer has them, and replacing a control's text.
 *
 * Each finder fails rather than returning nothing, because an edit that
 * silently misses its element would only show up as differing pixels.
 */
import { INTAKE_ICON_OUTLINES } from "../icons/intake-outlines";
import { readCrew } from "./sheet-page";

/** Returns the first element inside `scope` that matches `selector`. Fails when there is none. */
export function findElement(scope: ParentNode, selector: string): Element {
  const element = scope.querySelector(selector);
  if (element === null) throw new Error(`The book's page has no ${selector}.`);
  return element;
}

/**
 * Returns every element inside `scope` that matches `selector`. Fails when
 * the count is not `count`, because each edit pairs the book's elements with
 * the fixture's records one to one.
 */
export function findElements(scope: ParentNode, selector: string, count: number): Element[] {
  const elements = [...scope.querySelectorAll(selector)];
  if (elements.length !== count) {
    throw new Error(
      `The book's page has ${String(elements.length)} ${selector}, and the fixture ${String(count)}.`,
    );
  }
  return elements;
}

/** Returns the element inside `scope` that matches `selector` and whose text is `text`. Fails when there is none. */
export function findElementByText(scope: ParentNode, selector: string, text: string): Element {
  const element = [...scope.querySelectorAll(selector)].find(
    (each) => each.textContent.trim() === text,
  );
  if (element === undefined) throw new Error(`The book's page has no ${selector} "${text}".`);
  return element;
}

/**
 * Replaces the text of a control that starts with an icon, such as a
 * `.pick`, with `text`, and keeps the icon. Fails when the control has no
 * icon.
 */
export function replaceTextAfterIcon(control: Element, text: string): void {
  control.replaceChildren(findElement(control, "svg"), text);
}

/**
 * Adds an Intake row after Threads in the book's settings list. The book
 * predates Settings > Intake, so its list has no such row, and the app's
 * list does. The new row is a copy of the Threads row with its own label
 * and icon, so it is laid out the way the book lays out every row. Fails
 * when the book's list has no Threads row.
 */
export function insertIntakeSettingsRow(scope: ParentNode): void {
  const threads = findElementByText(scope, ".set-nav .nav-row", "Threads");
  const row = threads.cloneNode(true) as Element;
  findElement(row, "svg").replaceChildren(
    ...INTAKE_ICON_OUTLINES.map((outline) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", outline);
      return path;
    }),
  );
  findElement(row, "span").textContent = "Intake";
  row.classList.remove("is-on");
  row.setAttribute("href", "#");
  threads.after(row);
}

/**
 * The look of the code block with its header row, from the book's tokens: the
 * book's own `.codeblock` card (the margin, the fill, the rim, the corners and
 * the type of its code), a slim header row inside it, and the wrapped text
 * below. The header is 4px from the top, 6px from the right and 14px from the
 * left, with 2px between its items. The language is 11px mono in `--faint`
 * and ends in an ellipsis. The buttons are `--faint`, `--ink` while hovered
 * or pressed, and a pressed button has the `--selected` tint, which the book
 * has no rule for. The code has 4px above it and 12px below, wraps at the
 * card's edge, and breaks a token that has no break in it.
 */
const CODE_BLOCK_STYLE = `
  .code-block {
    margin: 10px 0; border-radius: var(--r-md); background: var(--sunken);
    box-shadow: inset 0 0 0 1px var(--line-soft);
  }
  .code-block-header {
    display: flex; align-items: center; justify-content: flex-end; gap: 2px;
    padding: 4px 6px 0 14px;
  }
  .code-block-language {
    flex: 1 1 auto; min-width: 0; margin-right: 8px; overflow: hidden;
    color: var(--faint); font-family: var(--font-mono);
    font-variation-settings: var(--mono-axes); font-size: var(--t-11);
    text-overflow: ellipsis; white-space: nowrap;
  }
  .code-block-header .icon-btn { color: var(--faint); }
  .code-block-header .icon-btn:is(:hover, .is-on) { color: var(--ink); }
  .code-block-header .icon-btn.is-on { background: var(--selected); }
  .code-block .code-block-text {
    margin: 0; padding: 4px 14px 12px; border-radius: 0 0 var(--r-md) var(--r-md);
    font-family: var(--font-mono); font-variation-settings: var(--mono-axes);
    font-size: 12.5px; line-height: 1.6;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .code-block .code-block-text code {
    padding: 0; border-radius: 0; background: none; font-size: inherit;
  }`;

/**
 * Draws each of the book's code blocks as the app draws a fence: a card that
 * holds a header row, then the code. The book's block has no header, and its
 * syntax colours are sample highlighting that the app, which loads no
 * highlighter, does not draw. So each block becomes a `.code-block` with the
 * block's text, plain, and a header with `language` on the left, the wrap
 * toggle (pressed, because lines wrap by default) and the copy button on the
 * right. The book has no wrap or copy icon, so both are drawn here from the
 * app's shapes.
 *
 * The card, header and text are styled by `CODE_BLOCK_STYLE`, a definition of
 * the approved look that is written out here and not read from the app's
 * `code-block.css`, so that a change to the app's styles shows in the
 * comparison. The book's `.icon-btn` and `.icon-btn--sm` are the rules of the
 * buttons themselves. Fails when the page has no code block.
 */
export function drawCodeBlocksWithHeader(language: string): void {
  const blocks = document.querySelectorAll(".codeblock");
  if (blocks.length === 0) throw new Error("The book's page has no .codeblock.");
  const style = document.createElement("style");
  style.textContent = CODE_BLOCK_STYLE;
  document.head.append(style);
  for (const block of blocks) {
    const wrap = buildBookElement(
      "button",
      "icon-btn icon-btn--sm is-on",
      drawIcon(WRAP_ICON_SHAPES),
    );
    wrap.title = "Wrap lines";
    const copy = buildBookElement("button", "icon-btn icon-btn--sm", drawIcon(COPY_ICON_SHAPES));
    copy.title = "Copy code";
    const code = buildBookElement("code", "", block.textContent);
    const text = buildBookElement("pre", "code-block-text", code);
    block.replaceWith(
      buildBookElement(
        "div",
        "code-block",
        buildBookElement(
          "div",
          "code-block-header",
          buildBookElement("span", "code-block-language", language),
          wrap,
          copy,
        ),
        text,
      ),
    );
  }
}

/**
 * The shapes of the app's wrap icon (`icons/wrap.tsx`) and copy icon
 * (`icons/copy.tsx`), written out again here. The book has neither icon, and
 * a module that a book page imports cannot import a `.tsx` file, because the
 * dev server's React refresh runtime is not loaded in the book's page. The
 * comparison is what keeps these in step with the icons: a drawing that
 * drifts shows as differing pixels in the code block's buttons.
 */
const WRAP_ICON_SHAPES: ReadonlyArray<Shape> = [
  ["path", { d: "M2.5 4h11" }],
  ["path", { d: "M2.5 8h8.5a2.25 2.25 0 0 1 0 4.5H8" }],
  ["path", { d: "M9.5 11L8 12.5 9.5 14" }],
  ["path", { d: "M2.5 12.5H5" }],
];
const COPY_ICON_SHAPES: ReadonlyArray<Shape> = [
  ["rect", { x: "5.6", y: "5.6", width: "7.8", height: "7.8", rx: "1.6" }],
  [
    "path",
    {
      d: "M10.4 3.6v-.2a1.4 1.4 0 0 0-1.4-1.4H3.6a1.4 1.4 0 0 0-1.4 1.4V9a1.4 1.4 0 0 0 1.4 1.4h.2",
    },
  ],
];

/** One SVG element of an icon: its tag and its attributes. */
type Shape = readonly [tag: "path" | "rect", attributes: Readonly<Record<string, string>>];

/**
 * Returns the book's 14px icon frame, as crew.js draws every icon, holding
 * `shapes`, the elements of an icon the book does not have.
 */
function drawIcon(shapes: ReadonlyArray<Shape>): Element {
  const holder = buildBookElement("span", "", buildBookIconPlaceholder("check", 14));
  readCrew().drawPlaceholders(holder);
  const frame = findElement(holder, "svg");
  frame.replaceChildren(
    ...shapes.map(([tag, attributes]) => {
      const shape = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
      return shape;
    }),
  );
  return frame;
}

/** Returns a new element named `tag`, with the class `className`, holding `children`. */
function buildBookElement(
  tag: string,
  className: string,
  ...children: ReadonlyArray<Node | string>
): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.append(...children);
  return element;
}

/** Returns the `<i data-i>` placeholder of the book's icon `name`, which crew.js replaces with the icon. */
function buildBookIconPlaceholder(name: string, size: number): HTMLElement {
  const placeholder = document.createElement("i");
  placeholder.dataset.i = name;
  placeholder.dataset.size = String(size);
  return placeholder;
}

/**
 * Returns the pill that holds the side pane's toggle, drawn as the app draws
 * it: the book has no side pane, and the app's thread header has this toggle
 * before its Done button, with the sidebar's icon mirrored because the pane
 * opens on the right (spec 17 §Thread, Subagents). The book has no
 * `.pane-toggle-icon` rule, so the mirror is an inline style.
 */
export function buildSidePaneTogglePill(): HTMLElement {
  const icon = buildBookElement("span", "", buildBookIconPlaceholder("sidebar", 16));
  Object.assign(icon.style, { display: "inline-flex", transform: "scaleX(-1)" });
  const toggle = buildBookElement("button", "icon-btn", icon);
  toggle.title = "Show the side pane";
  const pill = buildBookElement("span", "pill", toggle);
  readCrew().drawPlaceholders(pill);
  return pill;
}

/**
 * Returns the pill with the Done button, drawn as the app's thread header
 * draws it: the check and "Done" in the book's `.pill-btn`, which the book's
 * "Changes" and "Commit" and the drawing's "Finish" use too.
 */
export function buildDonePill(): HTMLElement {
  const pill = buildBookElement(
    "span",
    "pill",
    buildBookElement("button", "pill-btn", buildBookIconPlaceholder("check", 14), "Done"),
  );
  readCrew().drawPlaceholders(pill);
  return pill;
}

/**
 * Returns the work's name as the app's header draws it, a `.work-name`
 * holding `text` in a `.work-name-text`. It is styled by
 * `addWorkNameStyle`, which the page must also call.
 */
export function buildWorkName(text: string): HTMLElement {
  return buildBookElement("span", "work-name", buildBookElement("span", "work-name-text", text));
}

/** Returns the separator between the work's name and the tabs, a `.thread-tabs-sep`, styled by `addWorkNameStyle`. */
export function buildWorkNameSeparator(): HTMLElement {
  return buildBookElement("span", "thread-tabs-sep");
}

/**
 * Adds the style of the work's name and of the separator after it in a pill
 * (`.work-name`, `.work-name-text` and `.thread-tabs-sep`), the same as the
 * app's thread-header.css. The app's header and the Workbench, refined
 * drawing's put the same pixels in the same places: the slash 8px after the
 * project, the name's text cut at 272px with an ellipsis, and the line after
 * it. Only the markup differs, in two ways:
 *
 * - The slash is the first part of the name, not the crumb's last, so that it
 *   goes with the name when the name shrinks away. The crumb before the name
 *   draws no slash and no right padding.
 * - The space after the name's text is the separator's padding, not the
 *   name's padding and the separator's margin, so that each part's width
 *   holds the space the app's fit counts.
 */
export function addWorkNameStyle(): void {
  const style = document.createElement("style");
  style.textContent = `
    .pill-crumb:has(+ .work-name) { padding-right: 0; }
    .pill-crumb:has(+ .work-name)::after { content: none; }
    .work-name {
      display: flex; flex: 0 1 auto; min-width: 0; overflow: hidden;
      color: var(--ink); font-weight: var(--w-bold);
    }
    .work-name::before {
      content: "/"; flex: none; margin: 0 8px 0 6px;
      color: var(--faint); font-weight: var(--w-regular);
    }
    .work-name-text {
      min-width: 0; max-width: 272px; overflow: hidden;
      white-space: nowrap; text-overflow: ellipsis;
    }
    .thread-tabs-sep {
      flex: none; box-sizing: content-box; width: 1px; height: 18px; padding: 0 6px 0 8px;
      background: var(--line); background-clip: content-box;
    }`;
  document.head.append(style);
}
