import type { JSX } from "react";
import { buildChoiceOptions, type ConfigField, type ConfigValue } from "@hercule/client-core";
import type { ConfigChoice } from "@hercule/contract";
import { CloseIcon } from "../../../icons/close";
import { PlusIcon } from "../../../icons/plus";
import { ChoicePicker } from "./choice-picker";
import { describeHintId, LabelledField } from "./labelled-field";
import "./config-field.css";

/**
 * Where the choices of a setting that loads them from an account stand. The
 * caller reads them; a setting without `loadsChoices` takes none.
 */
export type FieldChoices =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly choices: ReadonlyArray<ConfigChoice> }
  | { readonly status: "failed"; readonly message: string };

/**
 * Renders one setting of a plugin's config schema, as `buildConfigFields`
 * describes it, with the widget for its kind:
 *
 * - `string`: a text field; `number` and `integer`: a narrow text field;
 * - `boolean`: a switch, with the setting's name beside it;
 * - `enum`: a select, with "Not set" first when the setting is optional;
 * - `stringList`: one text field per entry, each with its own error, and Add.
 *
 * A setting with `loadsChoices` is drawn from `choices` instead: a disabled
 * select while they load, and a `ChoicePicker` once they have loaded. When
 * they cannot be loaded, the reason sits above the plain widget, so the user
 * can still type the value.
 *
 * A number is typed into a text field, not a number field. For text the
 * browser cannot read as a number, a number field hands over an empty value,
 * so the form could not say what is wrong. The caller reads the text with
 * `buildConfigPayload` and passes its error back as `error`.
 *
 * Presentational and generic: it knows plugin settings, not what they belong
 * to, so a Connection's form and a plugin's form can both draw it.
 */
export function ConfigFieldRow({
  inputId,
  field,
  value,
  error,
  entryErrors,
  choices,
  onChange,
}: {
  /** The id of the setting's control. It must be unique in the document. */
  readonly inputId: string;
  readonly field: ConfigField;
  readonly value: ConfigValue;
  /** The error about the setting as a whole, shown under it. */
  readonly error: string | undefined;
  /** For a list setting, the error of each entry by position, shown under that entry. */
  readonly entryErrors: Readonly<Record<number, string>> | undefined;
  /** Where the choices stand, for a setting with `loadsChoices`. */
  readonly choices?: FieldChoices | undefined;
  readonly onChange: (value: ConfigValue) => void;
}): JSX.Element {
  const labelId = `${inputId}-label`;
  const hintId = field.description === undefined ? undefined : describeHintId(labelId);

  if (field.kind === "boolean") {
    return (
      <div className="config-switch-field">
        <div className="config-switch">
          <div className="config-switch-text">
            <b id={labelId}>{field.label}</b>
            {field.description === undefined ? null : <span id={hintId}>{field.description}</span>}
          </div>
          <button
            id={inputId}
            type="button"
            className="toggle"
            role="switch"
            aria-checked={value === true}
            aria-labelledby={labelId}
            aria-describedby={hintId}
            onClick={() => {
              onChange(value !== true);
            }}
          />
        </div>
        {error === undefined ? null : (
          <span className="fl-err" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }

  // A list of checkboxes or of fields has no one control the label can point at.
  const isGroup =
    field.kind === "stringList" && (choices === undefined || choices.status !== "loading");

  return (
    <LabelledField
      labelId={labelId}
      inputId={isGroup ? undefined : inputId}
      label={field.label}
      hint={field.description}
      error={error}
    >
      {choices?.status === "loading" ? (
        // Holds the place of the picker, so the dialog keeps its height when
        // the choices arrive.
        <span className="field field--select">
          <select id={inputId} disabled value="">
            <option value="">Loading choices…</option>
          </select>
        </span>
      ) : null}
      {choices?.status === "failed" ? (
        <span className="fl-err" role="alert">
          {`Could not load the choices: ${choices.message}`}
        </span>
      ) : null}
      {choices?.status === "loaded" ? (
        <ChoicePicker
          inputId={inputId}
          labelId={labelId}
          hintId={hintId}
          label={field.label}
          options={buildChoiceOptions(choices.choices, value)}
          value={value}
          multiple={field.kind === "stringList"}
          required={field.required}
          onChange={onChange}
        />
      ) : null}
      {choices === undefined || choices.status === "failed" ? (
        <ConfigWidget
          inputId={inputId}
          labelId={labelId}
          hintId={hintId}
          field={field}
          value={value}
          invalid={error !== undefined}
          entryErrors={entryErrors}
          onChange={onChange}
        />
      ) : null}
    </LabelledField>
  );
}

/** Renders the plain widget of a setting that is not a boolean. */
function ConfigWidget({
  inputId,
  labelId,
  hintId,
  field,
  value,
  invalid,
  entryErrors,
  onChange,
}: {
  readonly inputId: string;
  readonly labelId: string;
  readonly hintId: string | undefined;
  readonly field: ConfigField;
  readonly value: ConfigValue;
  /** Whether the setting has an error, which draws the field's red edge. */
  readonly invalid: boolean;
  readonly entryErrors: Readonly<Record<number, string>> | undefined;
  readonly onChange: (value: ConfigValue) => void;
}): JSX.Element {
  // Announced with `aria-required` but not enforced with `required`. If the
  // browser blocked a value, it would be a second check of a schema only the
  // controller holds.
  const required = field.required ? true : undefined;

  if (field.kind === "stringList") {
    return (
      <StringListWidget
        labelId={labelId}
        hintId={hintId}
        label={field.label}
        required={field.required}
        values={Array.isArray(value) ? value : []}
        entryErrors={entryErrors ?? {}}
        onChange={onChange}
      />
    );
  }

  if (field.kind === "enum") {
    return (
      <span className={invalid ? "field field--select is-bad" : "field field--select"}>
        <select
          id={inputId}
          aria-describedby={hintId}
          aria-required={required}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {field.required ? null : <option value="">Not set</option>}
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </span>
    );
  }

  // A number needs only a few characters; only text can be arbitrarily long.
  const width = field.kind === "string" ? "" : " config-field-narrow";
  return (
    <span className={`field${width}${invalid ? " is-bad" : ""}`}>
      <input
        id={inputId}
        aria-describedby={hintId}
        aria-required={required}
        aria-invalid={invalid ? true : undefined}
        placeholder={field.defaultValue}
        spellCheck={false}
        autoComplete="off"
        value={typeof value === "string" ? value : ""}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </span>
  );
}

/**
 * Renders a list of short texts, one field per entry with Remove, and Add
 * under them. An empty list shows no field, because a blank field would look
 * like an entry already started. One comma-separated field could not hold a
 * value that contains a comma.
 */
function StringListWidget({
  labelId,
  hintId,
  label,
  required,
  values,
  entryErrors,
  onChange,
}: {
  readonly labelId: string;
  readonly hintId: string | undefined;
  readonly label: string;
  readonly required: boolean;
  readonly values: ReadonlyArray<string>;
  /** The error of each entry, by position, shown under that entry. */
  readonly entryErrors: Readonly<Record<number, string>>;
  readonly onChange: (values: ReadonlyArray<string>) => void;
}): JSX.Element {
  const buildEntryName = (index: number): string => `${label} entry ${String(index + 1)}`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      aria-required={required ? true : undefined}
      className="config-list"
    >
      {values.map((value, index) => {
        const error = entryErrors[index];
        return (
          // Entries have no identity of their own, so the position is the key;
          // the list is short and only ever edited in place.
          <div key={index} className="config-list-entry">
            <div className="config-list-row">
              <span className={error === undefined ? "field" : "field is-bad"}>
                <input
                  aria-label={buildEntryName(index)}
                  aria-invalid={error === undefined ? undefined : true}
                  spellCheck={false}
                  autoComplete="off"
                  value={value}
                  onChange={(event) => {
                    onChange(values.map((each, at) => (at === index ? event.target.value : each)));
                  }}
                />
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${buildEntryName(index)}`}
                onClick={() => {
                  onChange(values.filter((_, at) => at !== index));
                }}
              >
                <CloseIcon size={14} />
              </button>
            </div>
            {error === undefined ? null : (
              <span className="fl-err" role="alert">
                {error}
              </span>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn--quiet btn--sm config-list-add"
        aria-label={`Add to ${label}`}
        onClick={() => {
          onChange([...values, ""]);
        }}
      >
        <PlusIcon size={13} />
        Add
      </button>
    </div>
  );
}
