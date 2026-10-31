/**
 * The parts a first-run step is drawn from: marked rows and cards, numbered
 * steps, a device code to copy, a wait line, a warning and a labelled field.
 * The provider login and the New project form draw them too, both in the
 * first run's card and in their dialogs in New thread, and Settings >
 * Connections draws its forms with the labelled field, and the add-account
 * sheet draws a kind's credentials as Connections does. Every part is
 * presentational: it takes values and callbacks and reads nothing.
 */
import { useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import type { CredentialField } from "@hercule/client-core";
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

/** Renders a green check followed by `children`, such as "Signed in", at a row's end. */
export function DoneMark({ children }: { readonly children?: ReactNode }): JSX.Element {
  return (
    <span className="hx-ok">
      <CheckIcon size={14} />
      {children}
    </span>
  );
}

/** Renders step `number` of a numbered list of things to do, with `children` as its text and controls. */
export function NumberedStep({
  number,
  children,
}: {
  readonly number: number;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="hx-step">
      <b>{number}</b>
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
 * Renders the two steps of a sign-in with a device code: copy `code`, then
 * open the sign-in page. `openText` is the second step's text and `openLabel`
 * its button's label; `onOpen` runs when that button is pressed. `end` goes
 * under the two steps, such as a `WaitLine`.
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
      <NumberedStep number={1}>
        Copy this code.
        <span className="code">
          <b ref={codeRef}>{code}</b>
          <CopyButton targetRef={codeRef} />
        </span>
      </NumberedStep>
      <NumberedStep number={2}>
        {openText}
        <br />
        {/* The button that asked for the code is gone, and the focus with it, so
            the focus moves to the next thing to do. */}
        <button type="button" className="btn btn--sm" onClick={onOpen} autoFocus>
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
 * Renders a warning: `icon`, then `children`, which describe what stands in the
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
 * Renders a labelled field in the book's form style (`.fl`): `label` above
 * `children`, then `hint` under them, then `error` when there is one. `aside`
 * sits at the label's far end, such as "optional". The hint stays visible
 * beside an error, because the hint explains the field and the error says
 * what is wrong with its value; both can hold markup. The error is an alert,
 * so a screen reader reads it out when it appears.
 *
 * It draws no field box of its own, so `children` can be any control: a text
 * field, a select, a list of fields or a list of checkboxes. How the label
 * names the control follows from the ids given:
 *
 * - With `inputId`, the label is a `<label>` for the control with that id.
 * - With only `labelId`, the label is plain text with that id, and a control
 *   group among `children` names itself with `aria-labelledby={labelId}`.
 * - With neither, a `<label>` holds the label and `children`, and names the
 *   first control among them.
 *
 * The aside, the hint and the error stay outside every `<label>`, so a
 * control's accessible name is the label alone. The aside stays out for a
 * second reason: a label belongs to the first control inside it, so a button
 * in the aside would take the label from the control. The stylesheet draws
 * the aside in the label's row.
 *
 * With `labelId`, the hint has the id `buildHintId(labelId)`, so a control
 * can name it in `aria-describedby`.
 */
export function LabelledField({
  labelId,
  inputId,
  label,
  aside,
  hint,
  error,
  children,
}: {
  readonly labelId?: string | undefined;
  readonly inputId?: string | undefined;
  readonly label: string;
  readonly aside?: ReactNode;
  readonly hint?: ReactNode;
  /** The error under the field; `null` and `undefined` both mean there is none. */
  readonly error?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="fl">
      {inputId === undefined && labelId === undefined ? (
        <label>
          <span className="fl-label">{label}</span>
          {children}
        </label>
      ) : (
        <>
          <span className="fl-label" id={labelId}>
            {inputId === undefined ? label : <label htmlFor={inputId}>{label}</label>}
          </span>
          {children}
        </>
      )}
      {aside === undefined ? null : <span className="fl-aside">{aside}</span>}
      {hint === undefined ? null : (
        <span className="fl-hint" id={labelId === undefined ? undefined : buildHintId(labelId)}>
          {hint}
        </span>
      )}
      {error === undefined || error === null ? null : (
        <span className="fl-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Returns the id of the hint of the `LabelledField` whose label has the id `labelId`. */
export const buildHintId = (labelId: string): string => `${labelId}-hint`;

/**
 * Renders a `LabelledField` whose control sits in the book's field box:
 * `children` are an `<input>`, and anything drawn after it. The `<label>`
 * holds the label and the box, so the input needs no id. A field with an
 * `error` draws a red edge; `error` is `null` when there is none.
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
    <LabelledField label={label} aside={aside} hint={hint} error={error}>
      <span className={error === null ? "field" : "field is-bad"}>{children}</span>
    </LabelledField>
  );
}

/**
 * Renders a masked, monospace field for each of `fields`, one under the other:
 * the field's label, `help` as its hint, and `errors[field.name]` under it
 * when there is one. `values` holds what has been typed, by field name.
 * Nothing is read back from the controller, so a field is never prefilled.
 * The first field takes the focus when the form opens. With `readOnly`, the
 * fields cannot be edited, so what was sent stays on screen while it is sent.
 */
export function CredentialFields({
  fields,
  values,
  errors,
  readOnly,
  onChange,
}: {
  readonly fields: ReadonlyArray<CredentialField>;
  readonly values: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly readOnly: boolean;
  readonly onChange: (name: string, value: string) => void;
}): JSX.Element {
  return (
    <div className="credential-fields">
      {fields.map((field, index) => (
        <FormField
          key={field.name}
          label={field.label}
          hint={field.help}
          error={errors[field.name] ?? null}
        >
          <input
            // A pasted credential is never read back, so it is never prefilled.
            type="password"
            className="mono"
            value={values[field.name] ?? ""}
            onChange={(event) => onChange(field.name, event.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoFocus={index === 0}
            readOnly={readOnly}
          />
        </FormField>
      ))}
    </div>
  );
}
