import { useState, type JSX } from "react";
import {
  buildRunInputDraft,
  buildRunInputs,
  UNREADABLE_NUMBER,
  type RunInputDraft,
  type RunInputField,
  type RunInputIssues,
  type RunInputValue,
} from "@hercule/client-core";
import type { RunInputs } from "@hercule/contract";
import { Button, Checkbox, Input, Label, Select, Textarea } from "@hercule/ui";

/**
 * Renders the run form's fields: one per input the workflow declares, then Cancel and
 * Start. It sits inside the caller's `<form>`, whose own submit it ignores:
 * pressing Enter in a field clicks Start, which starts the run.
 *
 * Its errors come from two places:
 * - a number or JSON text the form cannot read is refused here, on its field;
 * - everything else is checked by the controller, whose issues come back in
 *   `issues`, each on the field its path names, and the rest above the
 *   buttons.
 *
 * The fields hold the values while the user edits them, starting from the
 * inputs' defaults. The caller keys them on the workflow, so another
 * workflow's fields start from its own defaults.
 */
export function RunFormFields({
  fields,
  issues,
  isStarting,
  isFirstFieldFocused,
  onStart,
  onCancel,
}: {
  readonly fields: ReadonlyArray<RunInputField>;
  readonly issues: RunInputIssues;
  readonly isStarting: boolean;
  /**
   * Whether the first field takes the focus when it appears. It does when the
   * form opens on one workflow; with a picker above, the picker keeps it.
   */
  readonly isFirstFieldFocused: boolean;
  readonly onStart: (inputs: RunInputs) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<RunInputDraft>(() => buildRunInputDraft(fields));
  const [unreadable, setUnreadable] = useState<Readonly<Record<string, string>>>({});

  const start = (): void => {
    const reading = buildRunInputs(fields, draft);
    if ("errors" in reading) {
      setUnreadable(reading.errors);
      return;
    }
    setUnreadable({});
    onStart(reading.inputs);
  };

  return (
    <>
      {fields.length === 0 ? (
        <p className="text-fine text-faint">This workflow declares no inputs.</p>
      ) : null}
      {fields.map((field, index) => (
        <RunInputRow
          key={field.name}
          isFocused={isFirstFieldFocused && index === 0}
          field={field}
          value={draft[field.name]}
          error={unreadable[field.name] ?? issues.perField[field.name]}
          onChange={(value) => {
            setDraft((current) => ({ ...current, [field.name]: value }));
          }}
        />
      ))}
      <RunFormSummary issues={issues} />
      <RunFormButtons isStartDisabled={isStarting} onStart={start} onCancel={onCancel} />
    </>
  );
}

/**
 * Renders the errors of a refused run that belong to no field: why it was refused,
 * and each issue with its path, such as a problem in a workflow that no
 * longer validates.
 */
export function RunFormSummary({
  issues,
}: {
  readonly issues: RunInputIssues;
}): JSX.Element | null {
  if (issues.summary === undefined) return null;
  return (
    <div role="alert" className="flex flex-col gap-1 text-fine text-fail">
      <p>{issues.summary}</p>
      {issues.general.map((issue) => (
        <p key={issue} className="font-mono">
          {issue}
        </p>
      ))}
    </div>
  );
}

/**
 * Renders the run form's buttons: Cancel first and Start last, as every pair in the
 * app. Start is `aria-disabled` rather than `disabled`, so it keeps the focus
 * while the run starts.
 */
export function RunFormButtons({
  isStartDisabled,
  onStart,
  onCancel,
}: {
  readonly isStartDisabled: boolean;
  readonly onStart: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  return (
    <div className="flex justify-end gap-1.5">
      <Button onClick={onCancel}>Cancel</Button>
      <Button type="submit" variant="form" aria-disabled={isStartDisabled} onClick={onStart}>
        Start
      </Button>
    </div>
  );
}

/** The id of an input's control, unique on the page. */
const buildControlId = (field: RunInputField): string => `run-input-${field.name}`;

/**
 * Renders one input: its name, marked when required, its description, its control,
 * and its error under the control. A checkbox carries its name beside it, so
 * it is the one control not placed under a label.
 */
function RunInputRow({
  isFocused,
  field,
  value,
  error,
  onChange,
}: {
  readonly isFocused: boolean;
  readonly field: RunInputField;
  readonly value: RunInputValue;
  readonly error: string | undefined;
  readonly onChange: (value: RunInputValue) => void;
}): JSX.Element {
  const id = buildControlId(field);
  const description =
    field.description === undefined ? null : (
      <p className="text-fine text-faint">{field.description}</p>
    );
  const errorLine =
    error === undefined ? null : (
      <p className="text-fine text-fail" role="alert">
        {error}
      </p>
    );

  if (field.kind === "boolean") {
    return (
      <div className="flex flex-col gap-1.5">
        <Checkbox
          id={id}
          autoFocus={isFocused}
          label={field.name}
          aria-required={field.required ? true : undefined}
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        {description}
        {errorLine}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="flex items-baseline gap-2">
        <span className="font-mono">{field.name}</span>
        {/* The space keeps the name and the mark two words for a screen reader. */}
        {field.required ? (
          <>
            {" "}
            <span className="text-fine font-normal text-faint">required</span>
          </>
        ) : null}
      </Label>
      {description}
      <RunInputControl
        id={id}
        isFocused={isFocused}
        field={field}
        text={typeof value === "string" ? value : ""}
        onChange={onChange}
      />
      {errorLine}
    </div>
  );
}

/** The control of an input that is not a checkbox: a select, JSON text, a number or text. */
function RunInputControl({
  id,
  isFocused,
  field,
  text,
  onChange,
}: {
  readonly id: string;
  readonly isFocused: boolean;
  readonly field: Exclude<RunInputField, { readonly kind: "boolean" }>;
  readonly text: string;
  readonly onChange: (value: RunInputValue) => void;
}): JSX.Element {
  // Announced with `aria-required` but not enforced with `required`: the
  // controller checks for a missing value, and its issue shows on the field.
  const required = field.required ? true : undefined;
  const sharedControlProps = { id, autoFocus: isFocused, "aria-required": required } as const;

  switch (field.kind) {
    case "enum":
    case "connection": {
      const choices =
        field.kind === "enum"
          ? field.options.map((option) => ({ id: option, label: option, disabled: false }))
          : field.connections.map((choice) => ({
              ...choice,
              label: choice.disabled ? `${choice.label} (disabled)` : choice.label,
            }));
      return (
        <>
          <Select
            {...sharedControlProps}
            value={text}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          >
            {/* The empty choice: none picked yet, or an optional input left unset. */}
            <option value="">
              {field.kind === "connection" ? "Choose a Connection" : "Not set"}
            </option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id} disabled={choice.disabled}>
                {choice.label}
              </option>
            ))}
          </Select>
          {field.kind === "connection" && field.connections.length === 0 ? (
            <p className="text-fine text-faint">
              {`There is no ${field.connectionType} Connection yet. Add one under Connections.`}
            </p>
          ) : null}
        </>
      );
    }
    case "json":
      return (
        <Textarea
          {...sharedControlProps}
          spellCheck={false}
          className="font-mono text-meta"
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
    case "number":
      return (
        <Input
          {...sharedControlProps}
          type="number"
          step="any"
          className="w-[140px]"
          value={text}
          onChange={(event) => {
            // The browser reports text it cannot read as a number, such as
            // `1.2.3`, as an empty value. `badInput` is true only for such
            // text, so an unreadable number is not taken for an empty field.
            onChange(event.target.validity.badInput ? UNREADABLE_NUMBER : event.target.value);
          }}
        />
      );
    case "text":
      return (
        <Input
          {...sharedControlProps}
          type="text"
          value={text}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      );
  }
}
