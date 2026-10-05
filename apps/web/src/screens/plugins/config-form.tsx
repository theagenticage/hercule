import { useState, type FormEvent, type JSX } from "react";
import { Button, Checkbox, Field, FormSection, Input, Select, StringList } from "@hercule/ui";
import {
  buildConfigDraft,
  buildConfigPayload,
  type ConfigDraft,
  type ConfigField,
  type ConfigIssues,
  type ConfigJson,
  type ConfigValue,
} from "@hercule/client-core";

/**
 * The form generated from a plugin's config schema. Before the save, the form
 * checks only that each number field's text can be read as a number, because
 * nothing could be sent for it otherwise; that error is shown under the field
 * and nothing is sent. Every other rule belongs to the schema, which lives in
 * the plugin and which only the controller can apply, so a second check in
 * the browser could disagree with the controller about the same value. Those
 * errors come back from the save and are shown under the field they belong to.
 */
export function ConfigForm({
  id,
  fields,
  config,
  issues,
  saving,
  onEdit,
  onSave,
}: {
  /** A prefix for input ids, unique per plugin, because several plugins' forms share one page. */
  readonly id: string;
  readonly fields: ReadonlyArray<ConfigField>;
  readonly config: unknown;
  /** The errors of the last save. Errors that belong to no field are the parent's to show. */
  readonly issues: ConfigIssues;
  readonly saving: boolean;
  /** Called on every edit, so the parent can clear the result of the last save. */
  readonly onEdit: () => void;
  readonly onSave: (config: ConfigJson) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<ConfigDraft>(() => buildConfigDraft(fields, config));
  // The number fields whose text cannot be read as a number, found when the
  // user pressed Save. Nothing is sent until every field can be read.
  const [unreadable, setUnreadable] = useState<Readonly<Record<string, string>>>({});

  const setField = (name: string, value: ConfigValue): void => {
    onEdit();
    setUnreadable({});
    setDraft((current) => ({ ...current, [name]: value }));
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const reading = buildConfigPayload(fields, draft, config);
    if ("errors" in reading) {
      setUnreadable(reading.errors);
      return;
    }
    onSave(reading.config);
  };

  return (
    <form className="flex flex-col gap-3 border-t border-line-soft pt-3" onSubmit={submit}>
      {/* The settings get a rule above them inside the plugin's card; without
          it they look like part of the plugin's contributions. */}
      <FormSection heading="Configuration">
        {fields.map((field) => (
          <ConfigFieldRow
            key={field.name}
            inputId={`${id}-${field.name}`}
            field={field}
            value={draft[field.name] ?? ""}
            error={unreadable[field.name] ?? issues.perField[field.name]}
            entryErrors={issues.perEntry[field.name]}
            onChange={(value) => {
              setField(field.name, value);
            }}
          />
        ))}
      </FormSection>
      <div>
        <Button type="submit" variant="form" disabled={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** The setting's description from the schema, shown under its name. */
function Description({ field }: { readonly field: ConfigField }): JSX.Element | null {
  if (field.description === undefined) return null;
  return <p className="text-fine text-faint">{field.description}</p>;
}

/**
 * One setting, rendered with the widget for its kind. A boolean shows its
 * name beside the checkbox, so it is the only kind not placed under a label.
 *
 * Exported because a connection's settings use the same generated fields
 * inside another form, which also holds the label and the topic. That form
 * renders these rows rather than a second `ConfigForm`.
 */
export function ConfigFieldRow({
  inputId,
  field,
  value,
  error,
  entryErrors,
  onChange,
}: {
  readonly inputId: string;
  readonly field: ConfigField;
  readonly value: ConfigValue;
  /** The error about the setting as a whole, shown under the field. */
  readonly error: string | undefined;
  /** For a list setting, the error of each entry by position, shown under that entry. */
  readonly entryErrors: Readonly<Record<number, string>> | undefined;
  readonly onChange: (value: ConfigValue) => void;
}): JSX.Element {
  if (field.kind === "boolean") {
    return (
      <div className="flex flex-col gap-1.5">
        <Checkbox
          id={inputId}
          label={field.label}
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <Description field={field} />
        <FieldError error={error} />
      </div>
    );
  }

  return (
    <Field id={field.kind === "stringList" ? undefined : inputId} label={field.label} error={error}>
      {/* The description goes above the input, so an error appears directly under the input. */}
      <Description field={field} />
      <ConfigWidget
        inputId={inputId}
        field={field}
        value={value}
        entryErrors={entryErrors}
        onChange={onChange}
      />
    </Field>
  );
}

/** The error message `Field` would show, for the boolean kind, which has its own label. */
function FieldError({ error }: { readonly error: string | undefined }): JSX.Element | null {
  if (error === undefined) return null;
  return (
    <p className="text-fine text-fail" role="alert">
      {error}
    </p>
  );
}

function ConfigWidget({
  inputId,
  field,
  value,
  entryErrors,
  onChange,
}: {
  readonly inputId: string;
  readonly field: ConfigField;
  readonly value: ConfigValue;
  readonly entryErrors: Readonly<Record<number, string>> | undefined;
  readonly onChange: (value: ConfigValue) => void;
}): JSX.Element {
  // Announced with `aria-required` but not enforced with `required`. If the
  // browser blocked a value, it would be a second check of a schema only the
  // controller holds.
  const required = field.required ? true : undefined;

  if (field.kind === "enum") {
    return (
      // A list of short options needs no more width than its longest option.
      <div className="w-[220px]">
        <Select
          id={inputId}
          aria-required={required}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          {/* An optional setting needs an empty choice, so the user can unset it. */}
          {field.required ? null : <option value="">Not set</option>}
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </div>
    );
  }

  if (field.kind === "stringList") {
    return (
      <StringList
        required={field.required}
        label={field.label}
        values={Array.isArray(value) ? value : []}
        errors={entryErrors}
        onChange={onChange}
      />
    );
  }

  return (
    <Input
      id={inputId}
      aria-required={required}
      // A number needs only a few characters, so a number field is as narrow
      // as a feed's poll interval field; only text can be arbitrarily long.
      className={field.kind === "string" ? undefined : "w-[140px]"}
      // A text field even for a number, like the poll interval fields. For
      // text the browser cannot read as a number, a number field hands over
      // an empty value or blocks the save with a popup of its own, so the
      // form could not say under the field what is wrong. Unlike a poll
      // interval, a number here may be negative, and the numeric and decimal
      // keypads on iOS have no minus key, so the field keeps the full keyboard.
      placeholder={field.defaultValue}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}
