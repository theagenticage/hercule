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
 * Replaces each syntax-coloured span in the book's code blocks with its text.
 * The colours are sample highlighting, and the app loads no highlighter, so
 * its code blocks are plain.
 */
export function removeCodeHighlighting(): void {
  for (const span of document.querySelectorAll(".codeblock span")) {
    span.replaceWith(span.textContent);
  }
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
