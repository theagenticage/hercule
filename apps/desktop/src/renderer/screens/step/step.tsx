/**
 * The parts a first-run step is drawn from: marked rows and cards, numbered
 * steps, a device code to copy, a wait line, a warning and a labelled field.
 * The provider login and the New project form draw them too, both in the
 * first run's card and in their dialogs in New thread. Every part is
 * presentational: it takes values and callbacks and reads nothing.
 */
import { useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import { CheckIcon } from "../../icons/check";
import { ExternalIcon } from "../../icons/external";
import "./step.css";

/** Renders a framed list of `MarkedRow`s. */
export function MarkedRows({ children }: { readonly children: ReactNode }): JSX.Element {
  return <div className="hx">{children}</div>;
}

/**
 * Renders one row of a `MarkedRows` list: `mark` in a sunken square, `name`
 * over `detail`, and `end` at the right, such as the row's action. A
 * `detailMono` detail is drawn in the code font, for a path. `children`, when
 * given, go under the head, past the mark, such as a login's steps.
 */
export function MarkedRow({
  mark,
  name,
  detail,
  detailMono = false,
  end,
  children,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly detail: string;
  readonly detailMono?: boolean;
  readonly end: ReactNode;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className="hx-row">
      <div className="hx-head">
        <span className="hx-mark">{mark}</span>
        <span className="hx-name">
          <b>{name}</b>
          <span className={detailMono ? "mono" : undefined}>{detail}</span>
        </span>
        {end}
      </div>
      {children === undefined || children === null ? null : (
        <div className="hx-more">{children}</div>
      )}
    </div>
  );
}

/**
 * Renders one record on a card: `mark` in a sunken square, `name` over
 * `detail`, and `end` at the right. A plain-text `name` is drawn bold; pass
 * your own element to style it otherwise, such as a `<b className="mono">`
 * for a folder.
 */
export function MarkedCard({
  mark,
  name,
  detail,
  end,
}: {
  readonly mark: ReactNode;
  readonly name: ReactNode;
  readonly detail: ReactNode;
  readonly end: ReactNode;
}): JSX.Element {
  return (
    <div className="card">
      <span className="hx-mark">{mark}</span>
      <span className="card-text">
        {typeof name === "string" ? <b>{name}</b> : name}
        <span>{detail}</span>
      </span>
      {end}
    </div>
  );
}

/** Renders a green check followed by `children`, such as "Logged in", at a row's end. */
export function DoneMark({ children }: { readonly children?: ReactNode }): JSX.Element {
  return (
    <span className="hx-ok">
      <CheckIcon size={14} />
      {children}
    </span>
  );
}

/** Renders step `n` of a numbered list of things to do, with `children` as its text and controls. */
export function NumberedStep({
  n,
  children,
}: {
  readonly n: number;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="hx-step">
      <b>{n}</b>
      <span>{children}</span>
    </div>
  );
}

/**
 * Copies the text of `element` to the clipboard by selecting it and running
 * the browser's copy command, then clears the selection. Returns true when
 * the copy happened, and false when there is no element or the browser
 * refused.
 *
 * Why not `navigator.clipboard.writeText`: main grants the renderer no
 * permission at all (spec 17, Security), and Chromium refuses that call
 * without the `clipboard-sanitized-write` permission. The copy command needs
 * no permission, only the click that runs it. It selects the code where it
 * is drawn, rather than in a scratch element added to the page, because
 * inside a modal dialog everything outside the dialog is inert and could
 * not be selected.
 */
function copyElementText(element: HTMLElement | null): boolean {
  const selection = window.getSelection();
  if (element === null || selection === null) return false;
  selection.selectAllChildren(element);
  const copied = document.execCommand("copy");
  selection.removeAllRanges();
  return copied;
}

/**
 * Renders a Copy button that puts the text of the element in `targetRef` on
 * the clipboard. Its label then reads "Copied", or "Copy failed" when the
 * copy did not happen, so the user knows to select the text by hand.
 */
export function CopyButton({
  targetRef,
}: {
  readonly targetRef: RefObject<HTMLElement | null>;
}): JSX.Element {
  const [label, setLabel] = useState<"Copy" | "Copied" | "Copy failed">("Copy");
  return (
    <button
      type="button"
      className="btn btn--sm btn--quiet"
      onClick={() => setLabel(copyElementText(targetRef.current) ? "Copied" : "Copy failed")}
    >
      {label}
    </button>
  );
}

/**
 * Renders the two steps of a device-code sign-in: copy `code`, then open the
 * sign-in page. `openText` is the second step's text and `openLabel` its
 * button's label; `onOpen` runs when that button is pressed. `end` goes under
 * the two steps, such as a `WaitLine`.
 */
export function DeviceCodeSteps({
  code,
  openText,
  openLabel,
  onOpen,
  end,
}: {
  readonly code: string;
  readonly openText: string;
  readonly openLabel: string;
  readonly onOpen: () => void;
  readonly end?: ReactNode;
}): JSX.Element {
  const codeRef = useRef<HTMLElement>(null);
  return (
    <>
      <NumberedStep n={1}>
        Copy this code.
        <span className="code">
          <b ref={codeRef}>{code}</b>
          <CopyButton targetRef={codeRef} />
        </span>
      </NumberedStep>
      <NumberedStep n={2}>
        {openText}
        <br />
        <button type="button" className="btn btn--sm" onClick={onOpen}>
          <ExternalIcon size={14} />
          {openLabel}
        </button>
      </NumberedStep>
      {end}
    </>
  );
}

/** Renders `text` after a spinner, for a wait the user started and cannot speed up. */
export function WaitLine({ text }: { readonly text: string }): JSX.Element {
  return (
    <span className="wait" role="status">
      <span className="spin" />
      {text}
    </span>
  );
}

/**
 * Renders a warning: `icon`, then `children`, which say what stands in the
 * way and what to do about it. A button among the children sits under the
 * text.
 */
export function Warning({
  icon,
  children,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="warn">
      {icon}
      <span>{children}</span>
    </div>
  );
}

/**
 * Renders a labelled field: `label` above the field box, which holds
 * `children` (an `<input>`, and anything drawn after it), and under the box
 * either `error` or `hint`. `aside` sits at the label's far end, such as
 * "optional". A field with an `error` draws a red edge. `error` is `null`
 * when there is none. The hint and the error can hold
 * markup, such as a command set in monospace.
 *
 * The `<label>` holds the label and the field but not the aside, the hint
 * or the error, so the input's accessible name is the label alone. The aside
 * stays out for a second reason: a label belongs to the first control inside
 * it, so a button in the aside would take the label from the input. The
 * stylesheet draws the aside in the label's row. The error is an
 * alert, so a screen reader reads it out when it appears.
 */
export function FormField({
  label,
  aside,
  hint,
  error = null,
  children,
}: {
  readonly label: string;
  readonly aside?: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="fl">
      <label>
        <span className="fl-label">{label}</span>
        <span className={error === null ? "field" : "field is-bad"}>{children}</span>
      </label>
      {aside === undefined ? null : <span className="fl-aside">{aside}</span>}
      {error !== null ? (
        <span className="fl-err" role="alert">
          {error}
        </span>
      ) : hint === undefined ? null : (
        <span className="fl-hint">{hint}</span>
      )}
    </div>
  );
}
